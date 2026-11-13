# 后端接口与附录对应关系

所有路径以 `/api` 为前缀。JSON 写请求使用 `Content-Type: application/json`；图片接口使用 `multipart/form-data`，字段 `file`，最多一张 JPEG/PNG，最大 5 MiB。服务不保留上传临时文件。CompreFace 凭据只从服务端环境变量读取。

Web 使用 `credentials: 'include'`；Android 使用持久 CookieJar。认证采用 HttpOnly `connect.sid` Cookie，**不返回或接受客户端自报角色作为授权依据**。刷新接口轮换 Session ID，旧 Cookie 立即失效。业务接口每次检查数据库会话、账户状态、角色和资源归属。

响应：列表 `{items: [...]}`，新建 `{id}`，普通写入 `{success:true}`；错误 `{success:false,message,code?}`。常见状态码：400 参数错误，401 未登录，403 越权，404 不存在，409 重复/状态冲突，413 上传过大，422 无法识别图片，429 限流，503 人脸服务不可用。人脸异常考勤返回 202，表示已记为 exception、等待复核，不代表签到成功。

## 登录与账户

| 方法 | 路径 | 请求或用途 |
|---|---|---|
| GET | `/captcha` | 返回 `{image}`（SVG data URL），验证码 5 分钟有效，一次性使用，与 Cookie 绑定 |
| POST | `/auth/register` | `{username,password,role,code,name,student_no?/teacher_no?}`；role 为 student/teacher；教师为 pending；新注册、重复账号与重复学号 / 工号统一返回 202 和相同受理话术，requiresApproval 仅取决于提交的角色，不表示已创建账号 |
| POST | `/auth/login` | `{username,password,code,client_type?:web}`，返回 `{success,user}`；新登录替换旧 Web 会话，此入口不接受 Android 类型；待处理密码重置返回 403 / PASSWORD_RESET_PENDING |
| GET | `/auth/me` | 当前用户的 id、username、role、avatar |
| POST | `/android/auth/login` | `{username,password,code,client_type?:android}`，返回 `{success,user}` 及会话 Cookie；复用 `/captcha`，新登录仅替换旧 Android 会话；账号限制、验证码及限流与 Web 一致 |
| POST | `/auth/logout` | 空请求体或 `{}` 均支持，销毁会话并清 Cookie；重复调用可成功 |
| POST | `/auth/refresh` | `{}`；轮换 Cookie，返回 `{success,user}` |
| PATCH | `/auth/password` | `{currentPassword,password}`；注销此用户的全部会话，随后重新登录 |
| GET | `/users` | 管理员查询未移除用户，不返回密码哈希 |
| PATCH | `/users/{id}` | 管理员提交 `{status:"active"或"disabled"}`；审核教师或停用账户；不能操作管理员或已移除用户 |
| DELETE | `/users/{id}` | 管理员移除学生 / 教师，撤销全部会话并拒绝其待办；学生退出选课，教师的有效教学班归档、考勤结束并通知学生；管理员不能被移除，已移除返回 404 |

旧的 `/user/login`、`/user/register`、`/user/me`、`/user/logout` 保留兼容。注册账号 3–24 位文字、数字、下划线或短横线。注册密码和初始管理员密码均须至少 8 位、最多 72 个 UTF-8 字节，并包含数字和非数字字符。初始管理员密码通过 `.env` 的 `ADMIN_PASSWORD` 设置，见[本地启动](../README.md#本地启动)。

## 审批、排课、资料与通知

教师课程变更返回 `202 {requestId,requiresApproval:true}`，批准前不修改有效课表；管理员直接修改返回 200。审批生效和通知写入在同一事务内，失败回滚。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/profile` | 查询本人资料（管理员返回 null） |
| POST | `/profile/name-request` | 学生 / 教师提交 `{name}`，返回 202 |
| GET | `/requests` | 管理员看全部申请，其他人仅看本人；payload 为解析后的对象 |
| PATCH | `/requests/{id}` | 管理员提交 `{status: approved/rejected,note}`；重置密码申请可拒绝，批准须走专用重设密码接口 |
| POST | `/auth/reset-request` | 无需登录，提交 `{username,role,number,name,code}`；role 仅 student/teacher；资料匹配后返回 202，撤销所有会话并阻止原密码登录；每账号 24 小时限一次（429） |
| POST | `/users/{id}/reset-password` | 管理员提交 `{password}`，仅限存在 pending 密码重置申请的学生 / 教师；否则 409，已移除返回 404；重设密码、解禁、完成申请并撤销全部会话 |
| GET | `/schedule` | 按角色和选课关系查询课程与课次 |
| POST | `/scheduled-courses` | 教师提交 `{course_name,english_name,name,term,schedule}` |
| PUT | `/scheduled-courses/{id}` | 教师申请 / 管理员直接替换后续安排，上述字段加必填 reason |
| PATCH | `/course-sessions/{id}` | 教师申请 / 管理员直接调单次课，提交 `{date,start,end,location,reason}`（北京时间） |
| POST | `/scheduled-courses/{id}/cancel` | 教师申请 / 管理员直接取消整个教学班，提交 `{reason}` |
| GET | `/student-candidates?q=...` | 教师 / 管理员按部分学号或姓名模糊查询最多 20 个有效学生；空查询不返回候选，通配符按普通字符处理；返回 id、student_no、name |
| POST | `/scheduled-courses/{id}/students` | 教师 / 管理员按 `{student_no}` 添加学生；教师仅限本人课程 |
| GET | `/notifications` | 学生查询本人所有未关闭课程通知 |
| PATCH | `/notifications/{id}/close` | 学生手动关闭本人通知，无需 body |

schedule 字段为 `{date,start,end,location,repeat,interval?,weekdays?,until?}`；repeat 为 once / daily / weekly，日期为 YYYY-MM-DD、时间为 HH:mm，weekdays 使用 0–6（周日–周六），统一北京时间。Web 新建课程默认 weekly，单次调课仍为 once；API 仍须明确提交 repeat。

申请状态为 pending / approved / rejected；审核须填写说明，已处理申请不能重复审核。批准课程申请时重新检查权限、有效状态、未来时间及冲突。密码重置申请不影响管理员通过 `PATCH /users/{id}` 独立启用或停用账号。

## 基础资料

| 方法 | 路径 | 权限与请求 |
|---|---|---|
| GET | `/students`、`/teachers` | 管理员查询未移除人员；附带 username、status、number_conflict（历史重号）、reset_requested（存在待处理重置申请），后二者为 0/1；编号在师生间统一唯一 |
| PATCH | `/students/{id}` | 管理员：`{name?,class_name?,student_no?}`；仅历史重号允许修正学号，新编号须全局唯一，否则 409；正常编号不可修改（400） |
| PATCH | `/teachers/{id}` | 管理员：`{name?,teacher_no?}`；仅历史重号允许修正工号，新编号须全局唯一，否则 409；正常编号不可修改（400） |
| GET | `/courses` | 管理员、教师 |
| POST | `/courses` | 管理员：`{course_code,course_name,credit?}` |
| PATCH | `/courses/{id}` | 管理员：`{course_code?,course_name?,credit?,status?}`，status 为 active/archived |
| DELETE | `/courses/{id}` | 管理员：归档，保留历史数据 |
| GET | `/teaching-classes` | 管理员全部、教师本人、学生有效选课 |
| POST | `/teaching-classes` | 管理员：`{course_id,teacher_id,term,name}` |
| PATCH | `/teaching-classes/{id}` | 管理员：`{name?,term?,status?}` |
| DELETE | `/teaching-classes/{id}` | 管理员：归档，停止该班签到，同步结束开放或暂停中的考勤 |
| GET | `/teaching-classes/{id}/student-candidates` | 管理员或对应教师：完整有效学生列表；`q` 按学号 / 姓名模糊搜索，空查询列出全部；`page` 默认 1，`page_size` 默认 20、最大 100；返回 items、total、page、page_size，学生字段为 id、student_no、name、class_name、enrolled（是否已加入本班） |
| POST | `/teaching-classes/{id}/enrollments/batch` | 管理员或对应教师：`{student_ids:[学生ID,...]}`，1–500 项；去重后批量加入，已在班中跳过、已退课恢复，返回 `{success:true,added,skipped}`；包含无效学生返回 409 并整批回滚 |
| GET | `/teaching-classes/{id}/enrollments` | 管理员或对应教师查看当前学生；含 student_no、name、class_name、removal_pending |
| POST | `/teaching-classes/{id}/enrollments` | 管理员或对应教师：`{student_id}`；重复选课返回 409 |
| DELETE | `/enrollments/{id}` | `{reason}`；教师申请返回 202，管理员直接移除返回 200；在 `/requests` 审批 enrollment_remove，保留历史考勤 |
| PATCH | `/enrollments/{id}` | 管理员或对应教师：`{status:"active"或"withdrawn",reason?}`；withdrawn 同样须原因，教师须审批，不能绕过；active 校验有效学生 |

不物理删除用户、课程、教学班和历史考勤，避免级联删除审计数据。停用使用 `PATCH /users/{id}`，移除使用 DELETE 并置为 deleted，不可恢复；历史资料、账号和编号保留。恢复普通退课关系使用 PATCH，不重新插入；已移除学生不能重新加入。

教学班归档（包括 PATCH 设置 archived、课程取消获批和移除教师）会在同一事务中结束未结束的考勤任务，保留已有记录，不自动补记缺勤。重新启用教学班不会重新开启已结束的考勤。

## 考勤与统计

| 方法 | 路径 | 权限与请求 |
|---|---|---|
| POST | `/attendance-tasks` | 对应教师：`{teaching_class_id,start_at,late_at,end_at}` |
| GET | `/attendance-tasks` | 教师本人任务列表 |
| PATCH | `/attendance-tasks/{id}` | 对应教师：`{status:"paused"或"active"}`；已结束/过期不能重开 |
| POST | `/attendance-tasks/{id}/end` | 对应教师：结束，尚无记录的有效成员补记 absent；重复结束不重复插入 |
| GET | `/attendance-tasks/available` | 学生：有效选课、未归档班级、当前开放时间内的任务 |
| POST | `/attendance-tasks/{id}/check-in` | 安卓学生会话：multipart 现场图片；以审核通过头像为识别基准；先校验身份、选课、时段和重复记录，再调用识别；落库前再检查 |
| GET | `/attendance/me` | 学生本人记录 |
| GET | `/attendance-tasks/{id}/records` | 对应教师；完整名单含 unrecorded、total、counts |
| POST | `/attendance-tasks/{id}/manual` | 对应教师：`{student_id,status?,reason}`，非人脸替代流程，status 默认 manual；已有记录则使用 review |
| PATCH | `/attendance-records/{id}/review` | 对应教师：`{status,reason}`，事务写入修改前后状态、操作者和原因，再更新结果 |
| GET | `/attendance-records/{id}/reviews` | 对应教师：完整复核轨迹 |
| GET | `/reports/teaching-classes/{id}` | 对应教师：counts、total、attendanceRate、items；`?format=csv` 导出（含公式注入转义） |
| GET | `/audit-logs` | 管理员；`?limit=100&before=记录ID`，最大 500 条，按 ID 倒序分页 |

时间必须带时区，如 `2026-09-24T08:00:00+08:00`，统一转为 UTC 存储。要求 `start_at ≤ late_at ≤ end_at` 且 start < end；签到区间为 `[start_at,end_at)`，等于 late_at 判迟到。状态包括 present、late、absent、leave、exception、manual。相似度不足、无人脸、多人脸记录为 exception，必须复核；服务故障不写考勤记录，允许重试或人工登记。

出勤率 = `(present + late + manual) / (记录总数 - leave)`；没有分母时为 null。尚未结束的任务未签到者还没有 absent 记录，因此最终统计应先结束任务。超过 end_at 会立即阻止签到，但需要教师调用 end 完成缺勤归档。选课关系采用任务结束时的有效名单，当前版本未做开课名单快照。

## 人脸同意、登记和删除

| 方法 | 路径 | 学生本人请求 |
|---|---|---|
| POST | `/faces/consent` | `{policy_version,decision:"agree"或"withdraw"}`；记录独立决定，撤回立即禁用资料并尝试删除远端样本 |
| POST | `/faces/register` | JSON {}；必须有最近一次 agree；仅登记审核通过头像，旧 multipart 中的照片不再作为基准 |
| GET | `/faces/me` | consent 和 profile 状态，不返回内部 subject_key 或样本 |
| DELETE | `/faces/me` | 删除样本和停用映射，保留业务审计 |

远端删除失败返回 `202 {success:true,deletionPending:true}`，资料状态为 pending_delete，不能签到；服务恢复后重复 DELETE 完成清理。登记中断也保留不透明 subject_key 以便重试清理，不能把数据库删除当成远端已经删除。删除本身不撤回授权，撤回请调用 consent。人脸服务未配置时其他基础业务正常工作。

当前没有自动重试删除的后台任务；部署方需要处理 pending_delete。真实 CompreFace 的安装与识别效果需在 x86-64 目标设备验证。适配接口依据 [CompreFace 官方 REST 文档](https://github.com/exadel-inc/CompreFace/blob/master/docs/Rest-API-description.md)，不包含活体检测实现。

## 一次完整联调

1. GET captcha 保存 Cookie，POST auth/register 注册学生和教师；管理员登录后 GET users，PATCH users/{教师账号ID} 激活。
2. 管理员 GET teachers/students 获取资料 ID，创建 courses、teaching-classes；添加 enrollments。
3. 教师登录，为本人班级创建 attendance-tasks。
4. 学生在网页提交头像并由管理员审核通过；通过安卓入口登录，记录 faces/consent，查询 available 并 check-in（自动登记已审核头像）。
5. 无人脸条件时，教师使用 manual；已有异常用 review 修正，GET reviews 核对留痕。
6. 教师 end 后查询 records、reports 或导出 CSV；管理员核对 audit-logs。
7. POST auth/logout，再用退出前的 Cookie 请求 auth/me 或 auth/refresh，均应为 401。

### 学生头像

| 方法 | 地址 | 说明 |
| --- | --- | --- |
| POST | `/avatar-requests` | 学生会话，`multipart/form-data`。上传单张不超过 5MB 的 JPEG 或 PNG，字段名 `file`。在用户明确同意后发送文本字段 `consent`，值为 `true`。成功返回 202 和 `requestId`。 |
| GET | `/avatar-images/:id` | 图片所有者账号须为正常状态。所有者和管理员可读待审图片，其他登录用户仅可读该学生当前生效的头像。 |

缺少有效同意字段时返回 400 `CONSENT_REQUIRED`，后端不会请求检测服务。检测不通过返回 422，服务不可用返回 503。`/requests` 中的申请类型为 `avatar_change`，管理员使用现有申请审核接口。批准后可通过 `/auth/me` 获取头像路径。删除学生会清除其头像和待审照片。

## 安卓人脸签到更新

见 [安卓签到联调说明](ANDROID-ATTENDANCE.md)，包含端限制、审核头像自动同步、完整名单及状态处理。
