# 安卓签到联调说明

基于 main 8d4c415，网页和后端新增完整名单与审核头像绑定。所有接口前缀为 /api，使用同一个持久 CookieJar；不要上传角色、学生 ID、相似度或客户端类型来决定权限。

## 调用顺序

1. GET /captcha；POST /android/auth/login，JSON {username,password,code}。必须使用此入口取得 Android 会话，Web 会话不能签到。
2. GET /faces/me，返回 consent、approvedAvatar、ready、profile。approvedAvatar=false 时提示先在网页提交头像并等待管理员批准。
3. 用户明确同意人脸识别后，POST /faces/consent，JSON {decision:"agree",policy_version:"face-v1"}。上传头像时的同意与此授权分开记录。
4. GET /attendance-tasks/available 获取可签到任务。自行刷新或轮询即可，不依赖推送。
5. 使用相机现场拍照，POST /attendance-tasks/{id}/check-in，multipart/form-data 单张图片字段 file，JPEG/PNG，最大 5 MiB。不要手动指定不含 boundary 的 Content-Type。首次同步头像可能需要多次服务调用，安卓建议将签到上传请求的读取超时设置为至少 30 秒。
6. GET /attendance/me 查看个人结果。

## 识别基准

后端只读取当前登录学生审核通过的头像。首次签到或批准新头像后，自动将对应头像同步到识别服务，再比对现场照片。未配置或同步失败返回 503，不写考勤记录，可重试。ready=false 且 approvedAvatar=true、consent=true 时，下一次签到会自动尝试同步，无需另传登记照片。

POST /faces/register 可选，JSON {} 即可主动准备审核头像资料；旧 multipart 请求仍可接受，但客户端提交的照片不再用作登记基准。禁止引导学生另外上传一张人脸登记照片。

## 返回结果与异常

- 201：status=present 或 late，表示签到成功。
- 202：status=exception，人脸不匹配、无人脸或多人脸等，表示待教师复核，不能显示签到成功。当前规则下该任务已有异常记录，重复签到返回 409；请提示联系教师。
- 403 ANDROID_REQUIRED：使用安卓专用入口重新登录，伪造请求字段或 Header 无效。
- 403 CONSENT_REQUIRED：尚未同意或已撤回独立人脸授权。
- 409 AVATAR_REQUIRED：没有可用的审核头像。
- 409 AVATAR_CHANGED：识别过程中头像更换，重新拍照提交。
- 409 TASK_INACTIVE / DUPLICATE_CHECK_IN：任务关闭、过期或已经提交。
- 403 NOT_ENROLLED：不是本班学生。
- 503 FACE_UNAVAILABLE：服务暂不可用，允许重试。

## 教师网页

“控制面板 → 发起人脸考勤”，设置班级、时长和迟到时间；“考勤记录 → 记录 / 复核”展示全班名单、状态汇总、搜索和筛选，每 5 秒刷新，隐藏页面时暂停请求。未签到状态为 unrecorded；结束签到后补记 absent。保留原来的 items 数组，并额外返回 total、counts；无记录的学生 id、checked_at、source、similarity 为 null，student_id 始终为学生资料 ID。人工登记通过专用接口，不能把学生 ID 当作考勤记录 ID。

任务结束使用当时有效选课名单，保留已有历史记录；未实现名单快照。人脸匹配不包含活体检测，真机与真实 CompreFace 的识别效果仍需联合验收。
