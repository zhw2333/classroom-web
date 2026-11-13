import { captchaDigest } from '../server/captcha.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promisify } from 'node:util'

process.env.DATABASE_PATH = ':memory:'
process.env.ADMIN_PASSWORD = 'Integration-test123'
process.env.SESSION_SECRET = 'integration-test-session-secret-32-characters'
delete process.env.DB_DRIVER
delete process.env.NODE_ENV
delete process.env.COOKIE_SECURE
delete process.env.APP_ORIGINS
const { default: app } = await import('../server/app.js')
const { default: db } = await import('../server/db/db.js')
const { default: Store } = await import('../server/session-store.js')
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api`
let faceMode = 'match', subject, recognitionCalls = 0
const faceServer = createServer(async (req, res) => {
  for await (const _chunk of req) { /* drain multipart */ }
  res.setHeader('Content-Type', 'application/json')
  if (faceMode === 'unavailable') { res.writeHead(503).end('{}'); return }
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'DELETE') return res.end('{}')
  if (url.pathname.endsWith('/faces')) {
    subject = url.searchParams.get('subject')
    return res.end(JSON.stringify({ subject, image_id: 'test-image' }))
  }
  recognitionCalls++
  const face = { subjects: [{ subject, similarity: faceMode === 'low' ? 0.2 : 0.98 }] }
  res.end(JSON.stringify({ result: faceMode === 'none' ? [] : faceMode === 'multiple' ? [face, face] : [face] }))
}).listen(0, '127.0.0.1')
await once(faceServer, 'listening')
process.env.COMPREFACE_URL = `http://127.0.0.1:${faceServer.address().port}`
process.env.COMPREFACE_API_KEY = 'test-only'
after(async () => {
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => faceServer.close(r))])
  await db.close()
})

function client() {
  return {
    cookie: '',
    async request(path, method = 'GET', body, status = 200, extra = {}) {
      const response = await fetch(base + path, { method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) })
      if (response.headers.getSetCookie().length) this.cookie = response.headers.getSetCookie()[0].split(';')[0]
      const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text()
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result
    },
    async captcha() {
      const result = await this.request('/captcha')
      assert.match(result.image, /^data:image\/svg\+xml;base64,/)
      const sid = decodeURIComponent(this.cookie.split('=')[1]).slice(2).split('.')[0]
      assert.match((await db.get('SELECT text FROM captchas WHERE session_id=?', [sid])).text, /^[a-f0-9]{64}$/)
      await db.run('UPDATE captchas SET text=? WHERE session_id=?', [captchaDigest('ABCDE'), sid])
      return 'ABCDE'
    },
    async register(username, role) {
      return this.request('/auth/register', 'POST', { username, role, name: username, student_no: username, teacher_no: username, password: 'Password123', code: await this.captcha() }, 202)
    },
    async login(username, password = 'Password123', status = 200) {
      return this.request('/auth/login', 'POST', { username, password, code: await this.captcha() }, status)
    },
  }
}
function photo(bytes = Buffer.from([255, 216, 255, 224, 0])) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'test.jpg')
  return form
}
const admin = client(), teacher = client(), other = client(), learner = client(), outsider = client()
let classId, teacherId, studentId, taskId
const taskBody = () => ({ teaching_class_id: classId, start_at: new Date(Date.now() - 60000).toISOString(), late_at: new Date(Date.now() + 60000).toISOString(), end_at: new Date(Date.now() + 600000).toISOString() })

test('identity registration, immutable numbers, name approval and password reset blocks old credentials', async () => {
  const manager = client(), person = client(), anonymous = client()
  await manager.login('admin', process.env.ADMIN_PASSWORD)
  await person.request('/auth/register', 'POST', { username: 'profile_test', role: 'student', password: 'Password123', code: await person.captcha() }, 400)
  const registered = await person.request('/auth/register', 'POST', { username: 'profile_test', role: 'student', student_no: 'S2026001', name: '张三', password: 'Password123', code: await person.captcha() }, 202)
  const duplicate = await anonymous.request('/auth/register', 'POST', { username: 'duplicate_test', role: 'student', student_no: 'S2026001', name: '张三', password: 'Password123', code: await anonymous.captcha() }, 202)
  assert.deepEqual(duplicate, registered)
  const duplicateUsername = await anonymous.request('/user/register', 'POST', { username: 'profile_test', role: 'student', student_no: 'OTHER', name: '张三', password: 'Password123', code: await anonymous.captcha() }, 202)
  assert.deepEqual(duplicateUsername, registered)
  assert.equal(await db.get('SELECT id FROM users WHERE username=?', ['duplicate_test']), undefined)
  await person.login('profile_test')
  const profile = (await person.request('/profile')).profile
  await manager.request(`/students/${profile.id}`, 'PATCH', { student_no: 'different' }, 400)
  await person.request(`/students/${profile.id}`, 'PATCH', { name: '绕过审核' }, 403)
  const request = await person.request('/profile/name-request', 'POST', { name: '张小三' }, 202)
  assert.equal((await person.request('/profile')).profile.name, '张三')
  await person.request('/profile/name-request', 'POST', { name: '重复申请' }, 409)
  await manager.request(`/requests/${request.requestId}`, 'PATCH', { status: 'approved', note: '核对证明通过' })
  assert.equal((await person.request('/profile')).profile.name, '张小三')
  const rejected = await person.request('/profile/name-request', 'POST', { name: '不通过' }, 202)
  await manager.request(`/requests/${rejected.requestId}`, 'PATCH', { status: 'rejected', note: '资料不符' })
  assert.equal((await person.request('/profile')).profile.name, '张小三')
  await anonymous.request('/auth/reset-request', 'POST', { username: 'profile_test', role: 'student', number: 'wrong', name: '张小三', code: await anonymous.captcha() }, 400)
  await anonymous.request('/auth/reset-request', 'POST', { username: 'admin', role: 'admin', number: 'admin', name: 'admin', code: await anonymous.captcha() }, 400)
  await anonymous.request('/auth/reset-request', 'POST', { username: 'profile_test', role: 'student', number: 'S2026001', name: '张小三', code: await anonymous.captcha() }, 202)
  await person.request('/auth/me', 'GET', undefined, 401)
  await person.login('profile_test', 'Password123', 403)
  await anonymous.request('/auth/reset-request', 'POST', { username: 'profile_test', role: 'student', number: 'S2026001', name: '张小三', code: await anonymous.captcha() }, 429)
  await manager.request(`/users/${profile.user_id}`, 'PATCH', { status: 'active' })
  const currentCookie = person.cookie
  await manager.request(`/users/${profile.user_id}/reset-password`, 'POST', { password: 'short' }, 400)
  await manager.request(`/users/${profile.user_id}/reset-password`, 'POST', { password: 'New-password123' })
  person.cookie = currentCookie
  await person.request('/auth/me', 'GET', undefined, 401)
  await person.login('profile_test', 'Password123', 401)
  await person.login('profile_test', 'New-password123')
  assert.equal((await person.request('/requests')).items.find(r => r.kind === 'password_reset').status, 'approved')
  await anonymous.request('/auth/reset-request', 'POST', { username: 'profile_test', role: 'student', number: 'S2026001', name: '张小三', code: await anonymous.captcha() }, 429)
})

test('registration, teacher approval, captcha consumption, and live role checks', async () => {
  await admin.login('admin', process.env.ADMIN_PASSWORD)
  assert.equal((await teacher.register('teacher1', 'teacher')).requiresApproval, true)
  await teacher.login('teacher1', 'Password123', 403)
  await other.register('teacher2', 'teacher')
  await learner.register('student1', 'student')
  await outsider.register('student2', 'student')
  for (const user of (await admin.request('/users')).items.filter((u) => u.role === 'teacher')) await admin.request(`/users/${user.id}`, 'PATCH', { status: 'active' })
  await teacher.login('teacher1')
  await other.login('teacher2')
  await learner.request('/android/auth/login', 'POST', { username: 'student1', password: 'Password123', code: await learner.captcha() })
  await outsider.login('student2')
  await learner.request('/users', 'GET', undefined, 403)
  const code = await outsider.captcha()
  await outsider.request('/auth/login', 'POST', { username: 'student2', password: 'wrong', code }, 401)
  await outsider.request('/auth/login', 'POST', { username: 'student2', password: 'Password123', code }, 400)
  await outsider.login('student2')
})
test('teacher reset requests revoke sessions until rejected or completed', async () => {
  const anonymous = client()
  const requestBody = {
    username: 'teacher1', role: 'teacher', number: 'teacher1', name: 'teacher1',
    code: await anonymous.captcha(),
  }
  await anonymous.request('/auth/reset-request', 'POST', requestBody, 202)
  await teacher.request('/auth/me', 'GET', undefined, 401)
  await teacher.login('teacher1', 'Password123', 403)
  const request = (await admin.request('/requests')).items.find(row => row.kind === 'password_reset' && row.username === 'teacher1')
  await admin.request(`/requests/${request.id}`, 'PATCH', { status: 'approved', note: '须专用重置' }, 409)
  await admin.request(`/requests/${request.id}`, 'PATCH', { status: 'rejected', note: '本人未申请，拒绝恶意待办' })
  await teacher.request('/auth/me', 'GET', undefined, 401)
  await teacher.login('teacher1')
  await anonymous.request('/auth/reset-request', 'POST', { ...requestBody, code: await anonymous.captcha() }, 429)
})

test('basic data, ownership, membership and time validation', async () => {
  teacherId = (await admin.request('/teachers')).items.find((t) => t.name === 'teacher1').id
  studentId = (await admin.request('/students')).items.find((s) => s.name === 'student1').id
  const course = await admin.request('/courses', 'POST', { course_code: 'CS101', course_name: '软件工程', credit: 3 }, 201)
  classId = (await admin.request('/teaching-classes', 'POST', { course_id: course.id, teacher_id: teacherId, term: '2026秋', name: '软件一班' }, 201)).id
  await teacher.request(`/teaching-classes/${classId}/enrollments`, 'POST', { student_id: studentId }, 201)
  const duplicate = await teacher.request(`/teaching-classes/${classId}/enrollments`, 'POST', { student_id: studentId }, 409)
  assert.equal(duplicate.code, undefined)
  assert.equal((await learner.request('/teaching-classes')).items.length, 1)
  assert.equal((await other.request('/teaching-classes')).items.length, 0)
  await other.request('/attendance-tasks', 'POST', taskBody(), 403)
  await learner.request('/attendance-tasks', 'POST', taskBody(), 403)
  await teacher.request('/attendance-tasks', 'POST', { ...taskBody(), end_at: 'invalid' }, 400)
  taskId = (await teacher.request('/attendance-tasks', 'POST', taskBody(), 201)).id
  assert.equal((await learner.request('/attendance-tasks/available')).items.length, 1)
  await outsider.request(`/attendance-tasks/${taskId}/check-in`, 'POST', photo(), 403)
  assert.equal(recognitionCalls, 0)
})
test('face consent, upload validation, registration and duplicate concurrency', async () => {
  await learner.request('/faces/register', 'POST', photo(), 403)
  await learner.request('/faces/consent', 'POST', { decision: 'agree', policy_version: 'v1' })
  await learner.request('/faces/register', 'POST', {}, 409)
  const user = await db.get('SELECT user_id FROM students WHERE id=?', [studentId])
  const avatar = await db.run('INSERT INTO avatar_images(user_id,mime_type,image_data) VALUES (?,?,?)', [user.user_id, 'image/jpeg', Buffer.from([255,216,255,1])])
  await db.run('UPDATE users SET avatar=? WHERE id=?', [`/api/avatar-images/${avatar.insertId}`, user.user_id])
  await learner.request('/faces/register', 'POST', photo(Buffer.alloc(5 * 1024 * 1024 + 1)), 413)
  await learner.request('/faces/register', 'POST', photo(), 201)
  const responses = await Promise.all([1, 2].map(() => fetch(`${base}/attendance-tasks/${taskId}/check-in`, { method: 'POST', headers: { Cookie: learner.cookie }, body: photo() })))
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409])
  assert.equal((await learner.request('/attendance/me')).items.length, 1)
  assert.equal((await outsider.request('/attendance/me')).items.length, 0)
  await other.request(`/attendance-tasks/${taskId}/records`, 'GET', undefined, 403)
})
test('exceptions, outages, review trail, manual alternative, finalization and CSV', async () => {
  for (const [mode, code] of [['multiple', 'MULTIPLE_FACES'], ['none', 'NO_FACE'], ['low', 'LOW_SIMILARITY']]) {
    faceMode = mode
    const task = await teacher.request('/attendance-tasks', 'POST', taskBody(), 201)
    const result = await learner.request(`/attendance-tasks/${task.id}/check-in`, 'POST', photo(), 202)
    assert.equal(result.code, code)
    await other.request(`/attendance-records/${result.id}/review`, 'PATCH', { status: 'present', reason: '确认' }, 403)
    await teacher.request(`/attendance-records/${result.id}/review`, 'PATCH', { status: 'present', reason: '' }, 400)
    await teacher.request(`/attendance-records/${result.id}/review`, 'PATCH', { status: 'present', reason: '现场确认本人到场' })
    assert.equal((await db.get('SELECT before_status FROM review_records WHERE attendance_record_id=?', [result.id])).before_status, 'exception')
  }
  faceMode = 'unavailable'
  const task = await teacher.request('/attendance-tasks', 'POST', taskBody(), 201)
  await learner.request(`/attendance-tasks/${task.id}/check-in`, 'POST', photo(), 503)
  assert.equal(await db.get('SELECT id FROM attendance_records WHERE task_id=?', [task.id]), undefined)
  await teacher.request(`/attendance-tasks/${task.id}/manual`, 'POST', { student_id: studentId, reason: '服务故障，现场核对', status: 'manual' }, 201)
  faceMode = 'match'
  const ending = await teacher.request('/attendance-tasks', 'POST', taskBody(), 201)
  await teacher.request(`/attendance-tasks/${ending.id}/end`, 'POST', {})
  await teacher.request(`/attendance-tasks/${ending.id}/end`, 'POST', {})
  await learner.request(`/attendance-tasks/${ending.id}/check-in`, 'POST', photo(), 409)
  assert.equal((await teacher.request(`/attendance-tasks/${ending.id}/records`)).items[0].status, 'absent')
  const csv = await teacher.request(`/reports/teaching-classes/${classId}?format=csv`)
  assert.match(csv, /student1/)
  assert.ok((await teacher.request(`/reports/teaching-classes/${classId}`)).counts.manual >= 1)
  assert.ok((await admin.request('/audit-logs')).items.some((r) => r.action === 'report.export'))
})
test('withdrawal persists during outage, blocks face use, and deletion can be retried', async () => {
  faceMode = 'unavailable'
  assert.equal((await learner.request('/faces/consent', 'POST', { decision: 'withdraw', policy_version: 'v1' }, 202)).deletionPending, true)
  const state = await learner.request('/faces/me')
  assert.equal(state.consent, false)
  assert.equal(state.profile.status, 'pending_delete')
  await learner.request('/faces/register', 'POST', photo(), 403)
  faceMode = 'match'
  await learner.request('/faces/me', 'DELETE')
  assert.equal((await learner.request('/faces/me')).profile.status, 'deleted')
})
test('refresh rotates sessions; logout invalidates replay and cannot be resurrected', async () => {
  const old = client()
  old.cookie = learner.cookie
  await learner.request('/auth/refresh', 'POST', {})
  await old.request('/auth/me', 'GET', undefined, 401)
  const cookie = learner.cookie
  const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]
  const stored = JSON.parse((await db.get('SELECT data FROM sessions WHERE sid=?', [sid])).data)
  await learner.request('/auth/logout', 'POST')
  await learner.request('/auth/me', 'GET', undefined, 401)
  old.cookie = cookie
  await old.request('/auth/me', 'GET', undefined, 401)
  await old.request('/auth/refresh', 'POST', {}, 401)
  const store = new Store()
  await promisify(store.set).call(store, sid, stored)
  assert.equal(await db.get('SELECT sid FROM sessions WHERE sid=?', [sid]), undefined)
  await learner.request('/auth/logout', 'POST')
})
test('cross-site mutations, password change and JSON errors', async () => {
  await teacher.request('/auth/logout', 'POST', {}, 403, { Origin: 'https://untrusted.example' })
  await teacher.request('/auth/me')
  const old = client(); old.cookie = teacher.cookie
  await teacher.request('/auth/password', 'PATCH', { currentPassword: 'Password123', password: 'ChangedPassword123' })
  await old.request('/auth/me', 'GET', undefined, 401)
  await admin.request('/not-found', 'GET', undefined, 404)
  await admin.request('/courses', 'POST', [], 400)
})
test('disabling and re-enabling an account never restores its old session', async () => {
  const user = (await admin.request('/users')).items.find((u) => u.username === 'student2')
  await admin.request(`/users/${user.id}`, 'PATCH', { status: 'disabled' })
  await outsider.request('/auth/me', 'GET', undefined, 401)
  await admin.request(`/users/${user.id}`, 'PATCH', { status: 'active' })
  await outsider.request('/auth/me', 'GET', undefined, 401)
})
test('login accepts a local Vite origin on a different port', async () => {
  const local = client()
  const code = await local.captcha()
  const result = await local.request('/auth/login', 'POST', { username: 'teacher2', password: 'Password123', code }, 200, { Origin: 'http://localhost:5174' })
  assert.equal(result.user.username, 'teacher2')
  await local.request('/auth/logout', 'POST', {}, 200, { Origin: 'http://127.0.0.1:4173' })
  await local.request('/auth/me', 'GET', undefined, 401)
})
