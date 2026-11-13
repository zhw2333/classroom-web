import { Router } from 'express'
import db from './db/db.js'
import { notifyClass } from './requests.js'
import { archiveTeachingClass } from './classroom-lifecycle.js'
import { listEnrollments, removeEnrollment } from './enrollments.js'
import { listStudentCandidates, addStudents } from './student-enrollment.js'
import { authenticate, roles, student, ownedClass, id, string, choice, fail, audit, now } from './http.js'

export const business = Router()
business.use(authenticate)
const admin = roles('admin')
const teacher = roles('teacher')
const learner = roles('student')
const statuses = ['present', 'late', 'absent', 'leave', 'exception', 'manual']
const credit = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(400, '学分须为 0–100 的数字')
  return value
}
const date = (value) => {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, '时间须为带时区的 ISO 8601 格式')
  return new Date(value).toISOString()
}
async function mutation(req, action, type, fn) {
  return db.transaction(async () => {
    const result = await fn()
    if (['update', 'archive'].includes(action) && ['courses', 'teaching_classes'].includes(type)) {
      const classes = type === 'courses' ? await db.all('SELECT id FROM teaching_classes WHERE course_id=?', [id(req.params.id)]) : [{ id: id(req.params.id) }]
      for (const c of classes) await notifyClass(c.id, action === 'archive' ? '课程已取消 / 归档' : '管理员已修改课程信息，请查看最新课程安排')
    }
    await audit(req, action, type, result?.insertId || req.params.id)
    return result
  })
}
business.get('/courses', roles('admin', 'teacher'), async (_req, res) => res.json({ items: await db.all('SELECT * FROM courses ORDER BY id') }))
business.post('/courses', admin, async (req, res) => {
  const result = await mutation(req, 'create', 'courses', () => db.run('INSERT INTO courses(course_code,course_name,credit) VALUES (?,?,?)',
    [string(req.body.course_code, '课程编号', 64), string(req.body.course_name, '课程名称'), credit(req.body.credit ?? 0)]))
  res.status(201).json({ id: result.insertId })
})
business.patch('/courses/:id', admin, async (req, res) => {
  const row = await db.get('SELECT * FROM courses WHERE id=?', [id(req.params.id)])
  if (!row) fail(404, '课程不存在')
  await mutation(req, 'update', 'courses', () => db.run('UPDATE courses SET course_code=?,course_name=?,credit=?,status=? WHERE id=?',
    [string(req.body.course_code ?? row.course_code, '课程编号', 64), string(req.body.course_name ?? row.course_name, '课程名称'), credit(req.body.credit ?? row.credit), choice(req.body.status ?? row.status, ['active', 'archived']), row.id]))
  res.json({ success: true })
})
business.delete('/courses/:id', admin, async (req, res) => {
  if (!await db.get('SELECT id FROM courses WHERE id=?', [id(req.params.id)])) fail(404, '课程不存在')
  await mutation(req, 'archive', 'courses', () => db.run("UPDATE courses SET status='archived' WHERE id=?", [id(req.params.id)]))
  res.json({ success: true })
})
business.get('/teaching-classes', async (req, res) => {
  let sql = 'SELECT c.*,co.course_name,t.name AS teacher_name FROM teaching_classes c JOIN courses co ON co.id=c.course_id JOIN teachers t ON t.id=c.teacher_id'
  const params = []
  if (req.user.role === 'teacher') { sql += ' WHERE t.user_id=?'; params.push(req.user.id) }
  if (req.user.role === 'student') { sql += " JOIN enrollments e ON e.teaching_class_id=c.id JOIN students s ON s.id=e.student_id WHERE s.user_id=? AND e.status='active'"; params.push(req.user.id) }
  res.json({ items: await db.all(sql + ' ORDER BY c.id', params) })
})
business.post('/teaching-classes', admin, async (req, res) => {
  const result = await mutation(req, 'create', 'teaching_classes', () => db.run('INSERT INTO teaching_classes(course_id,teacher_id,term,name) VALUES (?,?,?,?)',
    [id(req.body.course_id), id(req.body.teacher_id), string(req.body.term, '学期', 64), string(req.body.name, '教学班名称')]))
  res.status(201).json({ id: result.insertId })
})
business.patch('/teaching-classes/:id', admin, async (req, res) => {
  const row = await db.get('SELECT * FROM teaching_classes WHERE id=?', [id(req.params.id)])
  if (!row) fail(404, '教学班不存在')
  await mutation(req, 'update', 'teaching_classes', async () => {
    const status = choice(req.body.status ?? row.status, ['active', 'archived'])
    await db.run('UPDATE teaching_classes SET name=?,term=?,status=? WHERE id=?', [
      string(req.body.name ?? row.name, '教学班名称'),
      string(req.body.term ?? row.term, '学期', 64), status, row.id,
    ])
    if (status === 'archived') await archiveTeachingClass(row.id)
  })
  res.json({ success: true })
})
business.delete('/teaching-classes/:id', admin, async (req, res) => {
  if (!await db.get('SELECT id FROM teaching_classes WHERE id=?', [id(req.params.id)])) fail(404, '教学班不存在')
  await mutation(req, 'archive', 'teaching_classes', () => archiveTeachingClass(id(req.params.id)))
  res.json({ success: true })
})
business.get('/teaching-classes/:id/student-candidates', roles('admin', 'teacher'), listStudentCandidates)
business.post('/teaching-classes/:id/enrollments/batch', roles('admin', 'teacher'), addStudents)
business.get('/teaching-classes/:id/enrollments', roles('admin', 'teacher'), listEnrollments)
business.delete('/enrollments/:id', roles('admin', 'teacher'), removeEnrollment)
business.post('/teaching-classes/:id/enrollments', roles('admin', 'teacher'), async (req, res) => {
  if (req.user.role === 'teacher') await ownedClass(req, req.params.id)
  const result = await mutation(req, 'enroll', 'enrollments', async () => {
    const learner = await db.get(`SELECT s.id FROM students s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND u.status='active'` + db.lock, [id(req.body.student_id)])
    if (!learner) fail(404, '有效学生账号不存在')
    return db.run('INSERT INTO enrollments(teaching_class_id,student_id) VALUES (?,?)', [id(req.params.id), learner.id])
  })
  res.status(201).json({ id: result.insertId })
})
business.patch('/enrollments/:id', roles('admin', 'teacher'), async (req, res) => {
  if (req.body.status === 'withdrawn') return removeEnrollment(req, res)
  const row = await db.get('SELECT * FROM enrollments WHERE id=?', [id(req.params.id)])
  if (!row) fail(404, '选课关系不存在')
  if (req.user.role === 'teacher') await ownedClass(req, row.teaching_class_id)
  await mutation(req, 'update', 'enrollments', async () => {
    const status = choice(req.body.status, ['active', 'withdrawn'])
    if (status === 'active') {
      const learner = await db.get(`SELECT s.id FROM students s JOIN users u ON u.id=s.user_id
        WHERE s.id=? AND u.status='active'` + db.lock, [row.student_id])
      if (!learner) fail(404, '有效学生账号不存在')
    }
    await db.run('UPDATE enrollments SET status=?,revision=revision+1 WHERE id=?', [status, row.id])
  })
  res.json({ success: true })
})
business.post('/attendance-tasks', teacher, async (req, res) => {
  const classroom = await ownedClass(req, req.body.teaching_class_id)
  if (classroom.status !== 'active') fail(409, '教学班已归档')
  const start = date(req.body.start_at), late = date(req.body.late_at), end = date(req.body.end_at)
  if (!(start <= late && late <= end && start < end && end > now())) fail(400, '签到时间顺序错误或结束时间已过期')
  const result = await mutation(req, 'create', 'attendance_tasks', () => db.run('INSERT INTO attendance_tasks(teaching_class_id,start_at,late_at,end_at) VALUES (?,?,?,?)', [classroom.id, start, late, end]))
  res.status(201).json({ id: result.insertId })
})
business.get('/attendance-tasks', teacher, async (req, res) => {
  res.json({ items: await db.all('SELECT a.* FROM attendance_tasks a JOIN teaching_classes c ON c.id=a.teaching_class_id JOIN teachers t ON t.id=c.teacher_id WHERE t.user_id=? ORDER BY a.id DESC', [req.user.id]) })
})
export async function taskForTeacher(req, taskId) {
  const task = await db.get('SELECT * FROM attendance_tasks WHERE id=?', [id(taskId)])
  if (!task) fail(404, '考勤任务不存在')
  await ownedClass(req, task.teaching_class_id)
  return task
}
business.post('/attendance-tasks/:id/end', teacher, async (req, res) => {
  await taskForTeacher(req, req.params.id)
  await mutation(req, 'end', 'attendance_tasks', async () => {
    const task = await db.get('SELECT * FROM attendance_tasks WHERE id=?' + db.lock, [id(req.params.id)])
    await db.run("UPDATE attendance_tasks SET status='ended' WHERE id=?", [task.id])
    // Only finalization creates absences. Face failures remain exceptions for review.
    await db.run(`INSERT INTO attendance_records(task_id,student_id,status,source,checked_at)
      SELECT ?,e.student_id,'absent','system',? FROM enrollments e WHERE e.teaching_class_id=? AND e.status='active'
      AND NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.task_id=? AND r.student_id=e.student_id)`, [task.id, now(), task.teaching_class_id, task.id])
  })
  res.json({ success: true })
})
business.patch('/attendance-tasks/:id', teacher, async (req, res) => {
  await taskForTeacher(req, req.params.id)
  const status = choice(req.body.status, ['active', 'paused'])
  await mutation(req, 'status', 'attendance_tasks', async () => {
    const task = await db.get('SELECT * FROM attendance_tasks WHERE id=?' + db.lock, [id(req.params.id)])
    if (task.status === 'ended' || task.end_at <= now()) fail(409, '已结束或过期任务不能重新开启')
    await db.run('UPDATE attendance_tasks SET status=? WHERE id=?', [status, task.id])
  })
  res.json({ success: true })
})
business.get('/attendance-tasks/available', learner, async (req, res) => {
  const s = await student(req), time = now()
  res.json({ items: await db.all(`SELECT t.*,c.name FROM attendance_tasks t JOIN teaching_classes c ON c.id=t.teaching_class_id
    JOIN enrollments e ON e.teaching_class_id=t.teaching_class_id
    WHERE e.student_id=? AND e.status='active' AND c.status='active' AND t.status='active' AND t.start_at<=? AND t.end_at>? ORDER BY t.start_at`, [s.id, time, time]) })
})
business.get('/attendance/me', learner, async (req, res) => {
  const s = await student(req)
  res.json({ items: await db.all('SELECT r.*,t.teaching_class_id,c.name FROM attendance_records r JOIN attendance_tasks t ON t.id=r.task_id JOIN teaching_classes c ON c.id=t.teaching_class_id WHERE r.student_id=? ORDER BY r.id DESC', [s.id]) })
})
business.get('/attendance-tasks/:id/records', teacher, async (req, res) => {
  await taskForTeacher(req, req.params.id)
  const taskId = id(req.params.id)
  const items = await db.all(`SELECT r.id,r.task_id,s.id AS student_id,s.name,s.student_no,
    COALESCE(r.status,'unrecorded') AS status,r.source,r.checked_at,r.similarity
    FROM students s LEFT JOIN attendance_records r ON r.student_id=s.id AND r.task_id=?
    WHERE r.id IS NOT NULL OR EXISTS (SELECT 1 FROM enrollments e
      JOIN attendance_tasks t ON t.teaching_class_id=e.teaching_class_id
      WHERE t.id=? AND t.status<>'ended' AND e.student_id=s.id AND e.status='active')
    ORDER BY s.student_no,s.id`, [taskId, taskId])
  const counts = {}
  for (const row of items) { row.task_id = taskId; counts[row.status] = (counts[row.status] || 0) + 1 }
  res.json({ items, total: items.length, counts })
})
business.patch('/attendance-records/:id/review', teacher, async (req, res) => {
  const after = choice(req.body.status, statuses), reason = string(req.body.reason, '复核原因', 500)
  await mutation(req, 'review', 'attendance_records', async () => {
    const row = await db.get('SELECT * FROM attendance_records WHERE id=?' + db.lock, [id(req.params.id)])
    if (!row) fail(404, '考勤记录不存在')
    await taskForTeacher(req, row.task_id)
    await db.run('INSERT INTO review_records(attendance_record_id,reviewer_id,before_status,after_status,reason,created_at) VALUES (?,?,?,?,?,?)', [row.id, req.user.id, row.status, after, reason, now()])
    await db.run('UPDATE attendance_records SET status=? WHERE id=?', [after, row.id])
  })
  res.json({ success: true })
})
business.get('/attendance-records/:id/reviews', teacher, async (req, res) => {
  const row = await db.get('SELECT task_id FROM attendance_records WHERE id=?', [id(req.params.id)])
  if (!row) fail(404, '考勤记录不存在')
  await taskForTeacher(req, row.task_id)
  res.json({ items: await db.all('SELECT * FROM review_records WHERE attendance_record_id=? ORDER BY id', [id(req.params.id)]) })
})
// Explicit non-biometric alternative, including leave approval and make-up attendance.
business.post('/attendance-tasks/:id/manual', teacher, async (req, res) => {
  const task = await taskForTeacher(req, req.params.id), studentId = id(req.body.student_id)
  const status = choice(req.body.status || 'manual', statuses), reason = string(req.body.reason, '登记原因', 500)
  const result = await mutation(req, 'manual', 'attendance_records', async () => {
    await db.get('SELECT id FROM attendance_tasks WHERE id=?' + db.lock, [task.id])
    if (!await db.get("SELECT id FROM enrollments WHERE teaching_class_id=? AND student_id=? AND status='active'", [task.teaching_class_id, studentId])) fail(403, '学生不是本教学班成员')
    const row = await db.run("INSERT INTO attendance_records(task_id,student_id,status,source,checked_at) VALUES (?,?,?,'manual',?)", [task.id, studentId, status, now()])
    await db.run('INSERT INTO review_records(attendance_record_id,reviewer_id,before_status,after_status,reason,created_at) VALUES (?,?,?,?,?,?)', [row.insertId, req.user.id, 'unrecorded', status, reason, now()])
    return row
  })
  res.status(201).json({ id: result.insertId })
})
business.get('/reports/teaching-classes/:id', teacher, async (req, res) => {
  await ownedClass(req, req.params.id)
  const items = await db.all('SELECT r.*,s.student_no,s.name FROM attendance_records r JOIN attendance_tasks t ON t.id=r.task_id JOIN students s ON s.id=r.student_id WHERE t.teaching_class_id=? ORDER BY r.task_id,r.student_id', [id(req.params.id)])
  const counts = Object.fromEntries(statuses.map((s) => [s, items.filter((r) => r.status === s).length]))
  await audit(req, req.query.format === 'csv' ? 'report.export' : 'report.read', 'teaching_classes', req.params.id)
  if (req.query.format === 'csv') {
    const escape = (value) => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'
    const fields = ['task_id', 'student_no', 'name', 'status', 'source', 'checked_at']
    res.set('Content-Disposition', `attachment; filename="attendance-${id(req.params.id)}.csv"`)
    return res.type('text/csv').send('\ufeff' + [fields.join(','), ...items.map((r) => fields.map((key) => escape(r[key])).join(','))].join('\r\n'))
  }
  const denominator = items.length - counts.leave
  res.json({ counts, total: items.length, attendanceRate: denominator ? (counts.present + counts.late + counts.manual) / denominator : null, items })
})
business.get('/audit-logs', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  if (!Number.isInteger(limit) || limit < 1) fail(400, 'limit 不合法')
  const before = req.query.before ? id(req.query.before) : Number.MAX_SAFE_INTEGER
  res.json({ items: await db.all(`SELECT * FROM audit_logs WHERE id<? ORDER BY id DESC LIMIT ${limit}`, [before]) })
})
