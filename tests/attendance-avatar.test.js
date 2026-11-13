import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { base, db, client, createUser } from './helpers/account-api.js'

process.env.COMPREFACE_URL = 'http://attendance-face.test'
process.env.COMPREFACE_API_KEY = 'test'
const realFetch = globalThis.fetch
let subject, registeredBytes, mode = 'match', registrations = 0, changeDuringRecognition
const jpeg = Buffer.from([255,216,255,3,4])
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(process.env.COMPREFACE_URL)) return realFetch(url, options)
  const u = new URL(url)
  if (mode === 'outage') return Response.json({}, { status: 503 })
  if (options.method === 'DELETE') return Response.json({})
  if (u.pathname.endsWith('/faces')) {
    registrations++; subject = u.searchParams.get('subject')
    registeredBytes = Buffer.from(await options.body.get('file').arrayBuffer())
    return Response.json({ subject, image_id: 'registered' })
  }
  if (changeDuringRecognition) { const fn = changeDuringRecognition; changeDuringRecognition = null; await fn() }
  return Response.json({ result: [{ subjects: [{ subject: mode === 'other' ? 'someone-else' : subject, similarity: .99 }] }] })
}
after(() => { globalThis.fetch = realFetch })

test('Android-only attendance uses approved avatar, complete roster, updates, failures and finalization', async () => {
  const admin = client(), teacher = client(), web = client(), android = client(), otherTeacher = client()
  await admin.login('admin', process.env.ADMIN_PASSWORD)
  await createUser('attendance_teacher', 'Password123', 'teacher')
  await teacher.login('attendance_teacher')
  await createUser('other_attendance_teacher', 'Password123', 'teacher'); await otherTeacher.login('other_attendance_teacher')
  const uid = await createUser('attendance_student', 'Password123', 'student')
  await createUser('attendance_missing', 'Password123', 'student')
  await web.login('attendance_student')
  await android.request('/android/auth/login', 'POST', { username: 'attendance_student', password: 'Password123', code: await android.captcha() })
  const tid = (await db.get('SELECT id FROM teachers WHERE user_id=(SELECT id FROM users WHERE username=?)', ['attendance_teacher'])).id
  const sid = (await db.get('SELECT id FROM students WHERE user_id=?', [uid])).id
  const missing = (await db.get('SELECT id FROM students WHERE user_id=(SELECT id FROM users WHERE username=?)', ['attendance_missing'])).id
  const course = await admin.request('/courses', 'POST', { course_code: 'FACE1', course_name: '人脸签到课' }, 201)
  const cls = await admin.request('/teaching-classes', 'POST', { course_id: course.id, teacher_id: tid, term: '2026秋', name: '签到班' }, 201)
  for (const student_id of [sid, missing]) await teacher.request(`/teaching-classes/${cls.id}/enrollments`, 'POST', { student_id }, 201)
  async function task() { return teacher.request('/attendance-tasks', 'POST', { teaching_class_id: cls.id, start_at: new Date(Date.now()-1000).toISOString(), late_at: new Date(Date.now()+30000).toISOString(), end_at: new Date(Date.now()+60000).toISOString() }, 201) }
  async function check(c, taskId, expected) {
    const body = new FormData(); body.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'live.jpg')
    const response = await realFetch(`${base}/attendance-tasks/${taskId}/check-in`, { method: 'POST', headers: { Cookie: c.cookie, 'X-Client-Type': 'android' }, body })
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  async function approve(bytes) {
    const img = await db.run('INSERT INTO avatar_images(user_id,mime_type,image_data) VALUES (?,?,?)', [uid, 'image/jpeg', bytes])
    const req = await db.run("INSERT INTO change_requests(user_id,kind,payload,created_at) VALUES (?,'avatar_change',?,?)", [uid, JSON.stringify({ imageId: img.insertId }), new Date().toISOString()])
    await admin.request(`/requests/${req.insertId}`, 'PATCH', { status: 'approved', note: '核对本人头像' })
    return img.insertId
  }
  const t = await task()
  let roster = await teacher.request(`/attendance-tasks/${t.id}/records`)
  assert.equal(roster.total, 2); assert.equal(roster.counts.unrecorded, 2)
  await otherTeacher.request(`/attendance-tasks/${t.id}/records`, 'GET', undefined, 403)
  assert.equal((await check(web, t.id, 403)).code, 'ANDROID_REQUIRED')
  assert.equal((await check(android, t.id, 403)).code, 'CONSENT_REQUIRED')
  await android.request('/faces/consent', 'POST', { decision: 'agree', policy_version: 'face-v1' })
  assert.equal((await check(android, t.id, 409)).code, 'AVATAR_REQUIRED')
  const approved = Buffer.from([255,216,255,9,9]); await approve(approved)
  // A client-supplied registration file must not replace the approved reference.
  const malicious = new FormData(); malicious.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'another-face.jpg')
  const registration = await realFetch(base + '/faces/register', { method: 'POST', headers: { Cookie: android.cookie }, body: malicious })
  assert.equal(registration.status, 201)
  assert.ok(registeredBytes.equals(approved))
  assert.equal((await android.request('/faces/me')).ready, true)
  await check(android, t.id, 201); await check(android, t.id, 409)
  roster = await teacher.request(`/attendance-tasks/${t.id}/records`)
  assert.equal(roster.counts.present, 1); assert.equal(roster.counts.unrecorded, 1)
  const replacement = Buffer.from([255,216,255,8,8]); await approve(replacement)
  assert.equal((await android.request('/faces/me')).ready, false)
  const second = await task(); await check(android, second.id, 201)
  assert.ok(registeredBytes.equals(replacement)); assert.equal(registrations, 2)
  mode = 'other'; const bad = await task(); assert.equal((await check(android, bad.id, 202)).status, 'exception')
  mode = 'outage'; const outage = await task(); await check(android, outage.id, 503)
  assert.equal(await db.get('SELECT id FROM attendance_records WHERE task_id=?', [outage.id]), undefined)
  mode = 'match'; await check(android, outage.id, 201)
  const race = await task(); changeDuringRecognition = () => approve(Buffer.from([255,216,255,7,7]))
  assert.equal((await check(android, race.id, 409)).code, 'AVATAR_CHANGED')
  assert.equal(await db.get('SELECT id FROM attendance_records WHERE task_id=?', [race.id]), undefined)
  await teacher.request(`/attendance-tasks/${t.id}/end`, 'POST', {})
  roster = await teacher.request(`/attendance-tasks/${t.id}/records`)
  assert.equal(roster.counts.absent, 1); assert.equal(roster.counts.present, 1)
  await check(android, t.id, 409)
})
