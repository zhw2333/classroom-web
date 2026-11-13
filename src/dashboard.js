export const roleNames = { admin: '管理员', teacher: '教师', student: '学生' }
export const statusNames = { unrecorded: '未签到', active: '正常', pending: '待审核', disabled: '已停用', present: '正常', late: '迟到', absent: '缺勤', leave: '请假', exception: '待复核', manual: '人工登记', paused: '已暂停', ended: '已结束' }
export const dateKey = (value) => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10)
export const formatTime = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
export const formatDate = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(value))
