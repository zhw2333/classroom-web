import { Router } from 'express'
import multer from 'multer'
import db from './db/db.js'
import { authenticate, roles, student, id, string, choice, fail, audit, now } from './http.js'
import { faceRequest, recognize } from './compreface.js'

export const faces = Router()
faces.use(authenticate)
const learner = roles('student')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
}).single('file')
function image(req, _res, next) {
  const file = req.file
  if (!file) fail(400, '请上传 JPEG 或 PNG 图片，字段名为 file')
  const png = file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = file.buffer[0] === 255 && file.buffer[1] === 216 && file.buffer[2] === 255
  if (!(png && file.mimetype === 'image/png') && !(jpeg && file.mimetype === 'image/jpeg')) fail(400, '图片内容与文件类型不一致')
  next()
}
async function hasConsent(studentId) {
  const row = await db.get("SELECT decision FROM consent_records WHERE student_id=? AND consent_type='face' ORDER BY id DESC LIMIT 1", [studentId])
  return row?.decision === 'agree'
}
async function removeProfile(req, studentId) {
  return db.transaction(async () => {
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [studentId])
    const profile = await db.get('SELECT * FROM face_profiles WHERE student_id=?', [studentId])
    if (!profile || profile.status === 'deleted') return null
    await db.run("UPDATE face_profiles SET status='pending_delete' WHERE id=?", [profile.id])
    try {
      await faceRequest(`/subjects/${encodeURIComponent(profile.subject_key)}`, null, 'DELETE')
      await db.run("UPDATE face_profiles SET status='deleted',deleted_at=? WHERE id=?", [now(), profile.id])
      await audit(req, 'face.delete', 'face_profiles', profile.id)
      return null
    } catch (error) {
      await audit(req, 'face.delete', 'face_profiles', profile.id, 'pending')
      return error // Commit disabled status even when the external service is down.
    }
  })
}
faces.post('/faces/consent', learner, async (req, res) => {
  const s = await student(req), decision = choice(req.body.decision, ['agree', 'withdraw'], '同意决定')
  const policy = string(req.body.policy_version, '告知版本', 64)
  await db.transaction(async () => {
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    await db.run("INSERT INTO consent_records(student_id,policy_version,consent_type,decision,decided_at) VALUES (?,?,'face',?,?)", [s.id, policy, decision, now()])
    if (decision === 'withdraw') await db.run("UPDATE face_profiles SET status='pending_delete' WHERE student_id=? AND status<>'deleted'", [s.id])
    await audit(req, `consent.${decision}`, 'students', s.id)
  })
  const error = decision === 'withdraw' ? await removeProfile(req, s.id) : null
  res.status(error ? 202 : 200).json({ success: true, decision, deletionPending: !!error })
})
faces.get('/faces/me', learner, async (req, res) => {
  const s = await student(req)
  const profile = await db.get('SELECT subject_key,status,registered_at,deleted_at FROM face_profiles WHERE student_id=?', [s.id])
  const user = await db.get('SELECT id,avatar FROM users WHERE id=?', [req.user.id])
  const approvedAvatar = !!/^\/api\/avatar-images\/\d+$/.test(user.avatar || '')
  const expected = approvedAvatar ? avatarSubject(user).subject : null
  const consent = await hasConsent(s.id)
  res.json({ consent, approvedAvatar, ready: consent && profile?.status === 'active' && profile.subject_key === expected, profile: profile ? { status: profile.status, registered_at: profile.registered_at, deleted_at: profile.deleted_at } : null })
})
faces.delete('/faces/me', learner, async (req, res) => {
  const s = await student(req)
  const error = await removeProfile(req, s.id)
  res.status(error ? 202 : 200).json({ success: true, deletionPending: !!error })
})
// The reference image comes exclusively from the approved avatar, never from the client.
function avatarSubject(user) {
  const match = /^\/api\/avatar-images\/(\d+)$/.exec(user?.avatar || '')
  if (!match) fail(409, '请先上传头像并等待管理员审核通过', 'AVATAR_REQUIRED')
  return { imageId: Number(match[1]), subject: `avatar-${user.id}-${match[1]}` }
}
async function registerApprovedAvatar(req, s) {
  const result = await db.transaction(async () => {
    const user = await db.get('SELECT id,avatar,status FROM users WHERE id=?' + db.lock, [req.user.id])
    if (user?.status !== 'active') fail(403, '账号不可用')
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    if (!await hasConsent(s.id)) fail(403, '请先单独同意人脸信息处理', 'CONSENT_REQUIRED')
    const { imageId, subject } = avatarSubject(user)
    const image = await db.get('SELECT mime_type,image_data FROM avatar_images WHERE id=? AND user_id=?', [imageId, user.id])
    if (!image) fail(409, '审核头像不可用，请重新提交头像申请', 'AVATAR_REQUIRED')
    let profile = await db.get('SELECT * FROM face_profiles WHERE student_id=?', [s.id])
    if (profile?.status === 'active' && profile.subject_key === subject) return { profile }
    const oldSubject = profile?.subject_key
    if (!profile) {
      const row = await db.run("INSERT INTO face_profiles(student_id,subject_key,status) VALUES (?,?,'pending_delete')", [s.id, subject])
      profile = { id: row.insertId }
    } else await db.run("UPDATE face_profiles SET status='pending_delete' WHERE id=?", [profile.id])
    try {
      if (oldSubject && oldSubject !== subject) await faceRequest(`/subjects/${encodeURIComponent(oldSubject)}`, null, 'DELETE')
      await db.run('UPDATE face_profiles SET subject_key=? WHERE id=?', [subject, profile.id])
      await faceRequest(`/subjects/${encodeURIComponent(subject)}`, null, 'DELETE')
      const registered = await faceRequest(`/faces?subject=${encodeURIComponent(subject)}`, { buffer: image.image_data, mimetype: image.mime_type })
      if (registered.subject !== subject || !registered.image_id) fail(503, '人脸服务响应无效', 'FACE_UNAVAILABLE')
      await db.run("UPDATE face_profiles SET status='active',registered_at=?,deleted_at=NULL WHERE id=?", [now(), profile.id])
      await audit(req, 'face.register', 'face_profiles', profile.id)
      return { profile: await db.get('SELECT * FROM face_profiles WHERE id=?', [profile.id]) }
    } catch (error) {
      await audit(req, 'face.register', 'face_profiles', profile.id, 'failed')
      return { error } // Commit disabled state, so stale or partly replaced references cannot be used.
    }
  })
  if (result.error) throw result.error
  return result.profile
}
faces.post('/faces/register', learner, upload, async (req, res) => {
  // Legacy multipart clients remain accepted; their file is deliberately ignored.
  await registerApprovedAvatar(req, await student(req))
  res.status(201).json({ success: true })
})
async function androidOnly(req, _res, next) {
  const session = await db.get('SELECT client_type FROM sessions WHERE sid=? AND expires>?', [req.sessionID, Date.now()])
  if (session?.client_type !== 'android') fail(403, '请使用安卓客户端进行人脸签到', 'ANDROID_REQUIRED')
  next()
}
async function eligible(taskId, studentId, lock = false) {
  const task = await db.get('SELECT * FROM attendance_tasks WHERE id=?' + (lock ? db.lock : ''), [taskId])
  if (!task) fail(404, '考勤任务不存在', 'TASK_NOT_FOUND')
  const time = now()
  if (task.status !== 'active' || time < task.start_at || time >= task.end_at) fail(409, '不在有效签到时段', 'TASK_INACTIVE')
  const classroom = await db.get('SELECT status FROM teaching_classes WHERE id=?', [task.teaching_class_id])
  if (classroom.status !== 'active') fail(409, '教学班已归档', 'TASK_INACTIVE')
  if (!await db.get("SELECT id FROM enrollments WHERE teaching_class_id=? AND student_id=? AND status='active'", [task.teaching_class_id, studentId])) fail(403, '不是本教学班成员', 'NOT_ENROLLED')
  if (await db.get('SELECT id FROM attendance_records WHERE task_id=? AND student_id=?', [taskId, studentId])) fail(409, '已提交签到，请勿重复签到；异常记录请联系教师复核', 'DUPLICATE_CHECK_IN')
  return task
}
faces.post('/attendance-tasks/:id/check-in', learner, androidOnly, upload, image, async (req, res) => {
  const s = await student(req), taskId = id(req.params.id)
  await eligible(taskId, s.id)
  if (!await hasConsent(s.id)) fail(403, '尚未同意或已撤回人脸信息处理', 'CONSENT_REQUIRED')
  const profile = await registerApprovedAvatar(req, s)
  let result, failure
  try { result = await recognize(req.file, profile.subject_key) } catch (error) {
    if (error.status !== 422) throw error // Outages must not consume a student's attempt.
    failure = error
  }
  const record = await db.transaction(async () => {
    const task = await eligible(taskId, s.id, true)
    const user = await db.get('SELECT id,avatar,status FROM users WHERE id=?' + db.lock, [req.user.id])
    if (user?.status !== 'active' || avatarSubject(user).subject !== profile.subject_key) fail(409, '头像已变更，请重新签到', 'AVATAR_CHANGED')
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    const current = await db.get("SELECT id,registered_at FROM face_profiles WHERE id=? AND status='active'", [profile.id])
    if (!await hasConsent(s.id) || !current || current.registered_at !== profile.registered_at) fail(409, '人脸授权或资料已变更，请重新提交')
    const checkedAt = now()
    const status = failure || !result.matched ? 'exception' : checkedAt >= task.late_at ? 'late' : 'present'
    const row = await db.run("INSERT INTO attendance_records(task_id,student_id,status,similarity,source,checked_at) VALUES (?,?,?,?,'face',?)", [taskId, s.id, status, result?.similarity ?? null, checkedAt])
    await audit(req, 'check-in', 'attendance_records', row.insertId, status)
    return { id: row.insertId, status, similarity: result?.similarity ?? null }
  })
  res.status(record.status === 'exception' ? 202 : 201).json({ ...record, code: failure?.code || (record.status === 'exception' ? 'LOW_SIMILARITY' : undefined), message: failure?.message || (record.status === 'exception' ? '相似度不足，已记录异常，请联系教师复核' : '签到成功') })
})
