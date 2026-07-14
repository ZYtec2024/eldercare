import { delay, http, HttpResponse } from 'msw'

import { type MockAccount } from '@/mocks/fixtures/shared'
import { getMockDatabase } from '@/mocks/mock-db'

function ok<T>(data: T, message = 'ok') {
  return HttpResponse.json({
    code: 200,
    message,
    data,
  })
}

function fail(status: number, message: string, data?: Record<string, unknown>) {
  return HttpResponse.json(
    {
      code: status,
      message,
      ...data,
    },
    { status },
  )
}

function buildTaskActions(
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'unavailable',
): Array<'accept' | 'start' | 'complete'> {
  if (status === 'pending') return ['accept']
  if (status === 'accepted' || status === 'in_progress') return ['complete']
  return []
}

function syncVolunteerTask(orderId: number, status: string, volunteerName?: string) {
  const db = getMockDatabase()
  const task = db.volunteerTasks.find((item) => item.orderId === orderId)
  const request = db.serviceRequests.find((item) => item.requestId === orderId)

  if (task) {
    task.status =
      status === 'cancelled'
        ? 'unavailable'
        : (status as 'pending' | 'accepted' | 'completed')
    task.availableActions = buildTaskActions(
      task.status === 'completed' ? 'completed' : task.status,
    )
  }

  if (request) {
    request.status = status as typeof request.status
    request.assignedVolunteerName = volunteerName ?? request.assignedVolunteerName

    if (status === 'completed') {
      request.hourReviewStatus = 'pending_family'
      request.hourReviewApprovedHours = null
    }

    if (status === 'cancelled') {
      request.hourReviewStatus = undefined
      request.hourReviewApprovedHours = null
    }
  }
}

function syncPendingServices() {
  const db = getMockDatabase()
  db.pendingServices = db.serviceRequests
    .filter((item) => item.elderId === 201)
    .map((item) => ({
      orderId: item.requestId,
      serviceType: item.serviceType,
      time: item.serviceTime,
      volunteerName: item.assignedVolunteerName,
      status: item.status,
      canReview: item.status === 'completed',
      reviewSubmitted: false,
    }))
}

function updateDashboardMetrics() {
  const db = getMockDatabase()
  const activeOrders = db.serviceRequests.filter(
    (item) => item.status === 'pending' || item.status === 'accepted',
  ).length
  const alerts = db.alerts.filter((item) => item.status === 'new').length
  const leaderboard = [...db.volunteerProfiles].sort(
    (left, right) => right.weeklyHours - left.weeklyHours || right.likesCount - left.likesCount || right.totalHours - left.totalHours,
  )

  db.dashboardMetrics = db.dashboardMetrics.map((item) => {
    if (item.metricId === 'orders') {
      return {
        ...item,
        value: activeOrders,
        comparisonText: `当前未完成服务 ${activeOrders} 单`,
      }
    }

    if (item.metricId === 'users') {
      return {
        ...item,
        value: db.accounts.length,
        comparisonText: `当前待审核志愿者 ${db.adminUsers.filter((row) => row.status === 'pending_review').length} 人`,
      }
    }

    if (item.metricId === 'volunteers') {
      return {
        ...item,
        datasetPreview: leaderboard.slice(0, 3).map((profile, index) => ({
          label: index === 0 ? '王佳明' : index === 1 ? '李志强' : '陈小宇',
          value: profile.weeklyHours,
        })),
      }
    }

    if (item.metricId === 'services') {
      return {
        ...item,
        comparisonText: `未处理提醒 ${alerts} 条`,
      }
    }

    return item
  })
}

function createProfileFromAccount(account: MockAccount) {
  const db = getMockDatabase()
  db.profiles[account.userId] = {
    accountId: account.userId,
    role: account.role,
    realName: account.realName,
    phone: account.phone,
    email: account.email,
    medicalHistory: account.role === 'elder' ? '' : undefined,
    alertSysThreshold: account.role === 'elder' ? 140 : undefined,
    skills: account.role === 'volunteer' ? account.skills ?? '' : undefined,
    totalHours: account.role === 'volunteer' ? 0 : undefined,
    weeklyHours: account.role === 'volunteer' ? 0 : undefined,
    awards: account.role === 'volunteer' ? [] : undefined,
    likesCount: account.role === 'volunteer' ? 0 : undefined,
  }
}

export const handlers = [
  http.post('/api/auth/register', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as Record<string, unknown>
    const db = getMockDatabase()

    const username = String(body.username ?? '').trim()
    const phone = String(body.phone ?? '').trim()
    const email = String(body.email ?? '').trim()
    const role = String(body.role ?? '') as MockAccount['role']

    if (!username || !phone || !email || !body.password || !body.real_name) {
      return fail(400, '请填写完整的注册信息')
    }

    if (
      db.accounts.some(
        (item) =>
          item.username === username || item.phone === phone || item.email === email,
      )
    ) {
      return fail(409, '用户名、手机号或邮箱已存在')
    }

    if (role === 'admin' && body.invite_code !== 'SHU2024ADMIN') {
      return fail(403, '管理员邀请码无效')
    }

    if (role === 'elder' && (!body.age || !body.gender || !body.address)) {
      return fail(400, '老人注册需要填写年龄、性别和住址')
    }

    if (role === 'volunteer' && (!body.id_card || !body.skills)) {
      return fail(400, '志愿者注册需要填写身份证和技能说明')
    }

    const userId = db.nextUserId++
    const account: MockAccount = {
      userId,
      username,
      password: String(body.password),
      role,
      realName: String(body.real_name),
      phone,
      email,
      status: role === 'volunteer' ? 'pending_review' : 'active',
      reviewState: role === 'volunteer' ? 'pending_review' : 'none',
      age: body.age ? Number(body.age) : undefined,
      gender: body.gender ? String(body.gender) : undefined,
      address: body.address ? String(body.address) : undefined,
      idCard: body.id_card ? String(body.id_card) : undefined,
      skills: body.skills ? String(body.skills) : undefined,
    }

    db.accounts.unshift(account)
    createProfileFromAccount(account)
    db.adminUsers.unshift({
      userId,
      username,
      role,
      name: account.realName,
      phone,
      email,
      status: account.status,
    })

    if (role === 'elder') {
      db.elders.push({
        elderId: userId,
        name: account.realName,
        age: account.age ?? 70,
        gender: account.gender,
        addressPreview: account.address ?? '待补充地址',
        relationType: '待绑定',
        relationLabel: '待绑定',
        riskLevel: 'normal',
        pendingServiceCount: 0,
        latestAlertSummary: '暂无提醒',
        latestSosStatus: '暂无 SOS',
      })
      db.health[userId] = {
        elderId: userId,
        dateRange: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
        systolicSeries: [128, 128, 129, 129, 130, 130, 129],
        diastolicSeries: [80, 80, 81, 81, 80, 79, 80],
        heartRateSeries: [72, 71, 72, 73, 72, 71, 72],
        abnormalFlag: false,
        annotationText: '尚无显著异常，建议持续记录。',
      }
    }

    if (role === 'volunteer') {
      db.volunteerProfiles.push({
        rank: db.volunteerProfiles.length + 1,
        leaderboardRank: db.volunteerProfiles.length + 1,
        completedCount: 0,
        totalHours: 0,
        weeklyHours: 0,
        likesCount: 0,
        awards: [],
      })
    }

    updateDashboardMetrics()

    return ok({ user_id: userId }, '注册成功')
  }),

  http.post('/api/auth/login', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as {
      username: string
      password: string
    }
    const db = getMockDatabase()
    const account = db.accounts.find(
      (item) =>
        item.username === body.username && item.password === body.password,
    )

    if (!account) {
      return fail(401, '用户名或密码错误')
    }

    return ok(
      {
        user_id: account.userId,
        username: account.username,
        role: account.role,
        real_name: account.realName,
        email: account.email,
        review_status: account.reviewState,
      },
      '登录成功',
    )
  }),

  http.post('/api/auth/forgot-password', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as {
      username: string
      phone: string
      new_password: string
    }
    const db = getMockDatabase()
    const account = db.accounts.find(
      (item) => item.username === body.username && item.phone === body.phone,
    )

    if (!account) {
      return fail(404, '账号与手机号不匹配')
    }

    account.password = body.new_password
    return ok(null, '密码已更新')
  }),

  http.get('/api/profile/info', async ({ request }) => {
    await delay(80)
    const url = new URL(request.url)
    const userId = Number(url.searchParams.get('user_id'))
    const profile = getMockDatabase().profiles[userId]

    if (!profile) {
      return fail(404, '个人资料不存在')
    }

    return ok(profile, '个人资料加载成功')
  }),

  http.post('/api/profile/update', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as Record<string, unknown>
    const db = getMockDatabase()
    const userId = Number(body.user_id)
    const profile = db.profiles[userId]

    if (!profile) {
      return fail(404, '个人资料不存在')
    }

    profile.phone = String(body.phone ?? profile.phone)
    profile.email = String(body.email ?? profile.email)
    profile.medicalHistory =
      body.medical_history !== undefined
        ? String(body.medical_history)
        : profile.medicalHistory
    profile.alertSysThreshold =
      body.alert_sys_threshold !== undefined
        ? Number(body.alert_sys_threshold)
        : profile.alertSysThreshold
    profile.skills =
      body.skills !== undefined ? String(body.skills) : profile.skills

    const account = db.accounts.find((item) => item.userId === userId)
    if (account) {
      account.phone = profile.phone
      account.email = profile.email
      if (profile.skills) {
        account.skills = profile.skills
      }
    }

    return ok(profile, '个人资料已更新')
  }),

  http.get('/api/family/elders', async () => {
    await delay(100)
    return ok(getMockDatabase().elders, '已获取绑定长辈列表')
  }),

  http.post('/api/family/bind-elder', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as {
      elder_phone: string
      relation_type: string
    }
    const db = getMockDatabase()
    const account = db.accounts.find((item) => item.phone === body.elder_phone)

    if (!account || account.role !== 'elder') {
      return fail(404, '未找到对应长辈账号')
    }

    const exists = db.elders.some((item) => item.elderId === account.userId)
    if (exists) {
      return fail(409, '该长辈已绑定，无需重复操作')
    }

    db.elders.unshift({
      elderId: account.userId,
      name: account.realName,
      age: account.age ?? 70,
      gender: account.gender,
      addressPreview: account.address ?? '待补充地址',
      relationType: body.relation_type,
      relationLabel: body.relation_type,
      riskLevel: 'normal',
      pendingServiceCount: 0,
      latestAlertSummary: '暂无提醒',
      latestSosStatus: '暂无 SOS',
    })

    return ok({ relation_id: account.userId }, '绑定成功')
  }),

  http.put('/api/family/bind-elder/relation', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as {
      elder_id: number
      relation_type: string
    }
    const db = getMockDatabase()
    const elder = db.elders.find((item) => item.elderId === body.elder_id)

    if (!elder) {
      return fail(404, '未找到该绑定关系')
    }

    elder.relationType = body.relation_type
    elder.relationLabel = body.relation_type
    return ok(null, '关系修改成功')
  }),

  http.delete('/api/family/bind-elder', async ({ request }) => {
    await delay(120)
    const url = new URL(request.url)
    const elderId = Number(url.searchParams.get('elder_id'))
    const db = getMockDatabase()
    const index = db.elders.findIndex((item) => item.elderId === elderId)

    if (index < 0) {
      return fail(404, '未找到该绑定关系')
    }

    db.elders.splice(index, 1)
    return ok(null, '解绑成功')
  }),

  http.get('/api/family/elder-health-chart/:elderId', async ({ params }) => {
    await delay(120)
    const snapshot = getMockDatabase().health[Number(params.elderId)]

    if (!snapshot) {
      return fail(404, '暂无趋势数据')
    }

    return ok(snapshot, '趋势数据加载成功')
  }),

  http.post('/api/family/orders/publish', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as {
      family_user_id: number
      elder_id: number
      service_type: string
      service_time: string
      service_hours: number
      notes?: string
    }
    const db = getMockDatabase()
    const requestId = db.nextRequestId++
    const elder = db.elders.find((item) => item.elderId === body.elder_id)

    db.serviceRequests.unshift({
      requestId,
      familyUserId: body.family_user_id,
      elderId: body.elder_id,
      elderName: elder?.name,
      serviceType: body.service_type,
      serviceTime: body.service_time,
      serviceHours: body.service_hours,
      notes: body.notes ?? '',
      status: 'pending',
    })

    db.volunteerTasks.unshift({
      orderId: requestId,
      serviceType: body.service_type,
      scheduledTime: body.service_time,
      addressPreview: elder?.addressPreview ?? '待补充地址',
      serviceHours: body.service_hours,
      urgencyLevel: 'medium',
      elderName: elder?.name,
      status: 'pending',
      availableActions: ['accept'],
    })

    if (elder) {
      elder.pendingServiceCount += 1
    }

    syncPendingServices()
    updateDashboardMetrics()

    return ok({ order_id: requestId, status: 'pending' }, '服务需求已提交')
  }),

  http.get('/api/family/orders', async () => {
    await delay(100)
    return ok(getMockDatabase().serviceRequests, '订单列表加载成功')
  }),

  http.post('/api/family/orders/cancel', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as { order_id: number }
    const db = getMockDatabase()
    const order = db.serviceRequests.find((item) => item.requestId === body.order_id)

    if (!order) {
      return fail(404, '订单不存在')
    }

    if (order.status === 'completed' || order.status === 'cancelled') {
      return fail(409, '当前订单状态不可撤销')
    }

    order.status = 'cancelled'
    syncVolunteerTask(order.requestId, 'cancelled')
    syncPendingServices()
    updateDashboardMetrics()

    return ok({ status: 'cancelled' }, '订单已撤销')
  }),

  http.get('/api/elder/my-services', async () => {
    await delay(100)
    syncPendingServices()
    return ok(getMockDatabase().pendingServices, '待办服务加载成功')
  }),

  http.post('/api/elder/health/checkin', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as Record<string, number>
    const db = getMockDatabase()
    const values = [
      body.blood_pressure_sys,
      body.blood_pressure_dia,
      body.heart_rate,
      body.blood_oxygen,
      body.blood_sugar,
      body.temperature,
      body.weight,
    ].filter((item) => item !== undefined)

    if (values.length === 0) {
      return fail(400, '至少填写一项健康指标')
    }

    const trend = db.health[201]
    const alertNeeded = Number(body.blood_pressure_sys ?? 0) >= 140

    if (trend) {
      trend.systolicSeries = [
        ...trend.systolicSeries.slice(1),
        Number(body.blood_pressure_sys ?? trend.systolicSeries.at(-1) ?? 130),
      ]
      trend.diastolicSeries = [
        ...trend.diastolicSeries.slice(1),
        Number(body.blood_pressure_dia ?? trend.diastolicSeries.at(-1) ?? 82),
      ]
      trend.heartRateSeries = [
        ...trend.heartRateSeries.slice(1),
        Number(body.heart_rate ?? trend.heartRateSeries.at(-1) ?? 72),
      ]
      trend.abnormalFlag = alertNeeded
      trend.annotationText = alertNeeded
        ? '今天的血压数据偏高，系统已提醒家属与社区关注。'
        : '今日指标记录成功，整体趋势保持稳定。'
    }

    let alertId: number | null = null
    if (alertNeeded) {
      alertId = db.nextAlertId++
      db.alerts.unshift({
        alertId,
        category: 'health_abnormal',
        priority: 'high',
        createdAt: '2026-03-30 09:20',
        status: 'new',
        sourceLabel: '老人健康打卡触发异常提醒',
        linkedEntityId: 201,
      })
    }

    return ok(
      {
        abnormal: alertNeeded,
        alert_id: alertId,
      },
      '今日健康打卡已记录',
    )
  }),

  http.post('/api/elder/sos', async () => {
    await delay(80)
    const db = getMockDatabase()
    const alertId = db.nextAlertId++
    db.alerts.unshift({
      alertId,
      category: 'sos',
      priority: 'high',
      createdAt: '2026-03-30 10:00',
      status: 'new',
      sourceLabel: '老人一键求助',
      linkedEntityId: 201,
    })
    updateDashboardMetrics()

    return ok({ alert_id: alertId }, '紧急求助已发送，家属和社区会收到提醒')
  }),

  http.post('/api/elder/orders/review', async ({ request }) => {
    await delay(90)
    const body = (await request.json()) as { order_id: number }
    const order = getMockDatabase().serviceRequests.find(
      (item) => item.requestId === body.order_id,
    )

    if (!order || order.status !== 'completed') {
      return fail(409, '当前订单暂不可评价')
    }

    const pending = getMockDatabase().pendingServices.find(
      (item) => item.orderId === body.order_id,
    )
    if (pending) {
      pending.reviewSubmitted = true
      pending.canReview = false
    }

    return ok(null, '服务评价已提交')
  }),

  http.get('/api/volunteer/orders/available', async () => {
    await delay(100)
    return ok(getMockDatabase().volunteerTasks, '任务大厅加载成功')
  }),

  http.get('/api/volunteer/orders/available/:taskId', async ({ params }) => {
    await delay(100)
    const task = getMockDatabase().volunteerTasks.find(
      (item) => item.orderId === Number(params.taskId),
    )

    if (!task) {
      return fail(404, '任务不存在')
    }

    return ok(task, '任务详情加载成功')
  }),

  http.post('/api/volunteer/orders/grab', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as { order_id: number }
    const db = getMockDatabase()
    const task = db.volunteerTasks.find((item) => item.orderId === body.order_id)

    if (!task) {
      return fail(404, '任务不存在')
    }

    if (task.status !== 'pending') {
      return fail(409, '该任务已被其他志愿者领取')
    }

    task.status = 'accepted'
    task.availableActions = ['complete']
    syncVolunteerTask(task.orderId, 'accepted', '王佳明')
    syncPendingServices()

    return ok({ status: 'accepted' }, '抢单成功')
  }),

  http.post('/api/volunteer/like', async ({ request }) => {
    await delay(80)
    const body = (await request.json()) as {
      from_user_id: number
      to_volunteer_id: number
    }
    const db = getMockDatabase()
    const key = `${body.from_user_id}:${body.to_volunteer_id}`
    const targetProfile = db.volunteerProfiles.find((item) => item.userId === body.to_volunteer_id)

    if (db.likePairs.includes(key)) {
      return fail(409, '你已经给这位志愿者点过赞了')
    }

    if (!targetProfile) {
      return fail(404, '志愿者不存在')
    }

    db.likePairs.push(key)
    targetProfile.likesCount += 1

    return ok(null, '点赞成功')
  }),

  http.post('/api/volunteer/orders/update-status', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as {
      order_id: number
      action: string
    }
    const db = getMockDatabase()
    const task = db.volunteerTasks.find((item) => item.orderId === body.order_id)

    if (!task) {
      return fail(404, '任务不存在')
    }

    task.status = 'completed'
    task.availableActions = []
    syncVolunteerTask(task.orderId, 'completed', '王佳明')

    const requestRow = db.serviceRequests.find((item) => item.requestId === body.order_id)
    if (requestRow) {
      requestRow.hourReviewStatus = 'pending_family'
      requestRow.hourReviewApprovedHours = null
    }

    syncPendingServices()
    updateDashboardMetrics()

    return ok(
      {
        status: 'completed',
        total_hours: 0,
        weekly_hours: 0,
      },
      '服务已完成',
    )
  }),

  http.post('/api/family/orders/confirm-hours', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as {
      order_id: number
      family_user_id: number
      actual_hours: number
      review_note?: string
    }
    const db = getMockDatabase()
    const order = db.serviceRequests.find((item) => item.requestId === body.order_id)

    if (!order) {
      return fail(404, '订单不存在')
    }

    if (order.familyUserId !== body.family_user_id) {
      return fail(403, '您无权确认该订单时长')
    }

    if (order.status !== 'completed') {
      return fail(400, '仅已完成订单可确认时长')
    }

    if (order.hourReviewStatus && order.hourReviewStatus !== 'pending_family') {
      return fail(409, '该订单时长已经确认过了，不能重复提交')
    }

    const volunteer = db.volunteerProfiles.find((item) => item.userId === order.assignedVolunteerId)
    if (!volunteer) {
      return fail(400, '该订单未绑定志愿者')
    }

    const expectedHours = order.serviceHours
    const maxAutoHours = expectedHours * 1.5

    if (body.actual_hours > maxAutoHours) {
      order.hourReviewStatus = 'pending_admin'
      order.hourReviewApprovedHours = null
      return ok(null, '已提交家属确认，超过预计时长 1.5 倍，已转管理员审核。')
    }

    order.hourReviewStatus = 'approved'
    order.hourReviewApprovedHours = body.actual_hours
    volunteer.completedCount += 1
    volunteer.totalHours += body.actual_hours
    volunteer.weeklyHours += body.actual_hours
    updateDashboardMetrics()

    return ok(null, '已确认并计入志愿者服务时长')
  }),

  http.get('/api/volunteer/profile/summary', async ({ request }) => {
    await delay(80)
    const url = new URL(request.url)
    const volunteerId = Number(url.searchParams.get('volunteer_id') ?? '302')
    const profile = getMockDatabase().volunteerProfiles.find((item) => item.userId === volunteerId)

    if (!profile) {
      return fail(404, '未找到志愿者成就信息')
    }

    return ok(profile, '个人成就加载成功')
  }),

  http.get('/api/volunteer/leaderboard', async () => {
    await delay(80)
    const leaderboard = [...getMockDatabase().volunteerProfiles].sort(
      (left, right) => right.weeklyHours - left.weeklyHours || right.likesCount - left.likesCount || right.totalHours - left.totalHours,
    )

    leaderboard.forEach((item, index) => {
      item.rank = index + 1
      item.leaderboardRank = index + 1
    })

    return ok(leaderboard, '荣誉墙加载成功')
  }),

  http.get('/api/volunteer/profile/summary', async ({ request }) => {
    await delay(80)
    const url = new URL(request.url)
    const volunteerId = Number(url.searchParams.get('volunteer_id') ?? '302')
    const profile = getMockDatabase().volunteerProfiles.find((item) => item.userId === volunteerId)

    if (!profile) {
      return fail(404, '未找到志愿者成就信息')
    }

    return ok(profile, '个人成就加载成功')
  }),

  http.get('/api/admin/users/list', async ({ request }) => {
    await delay(120)
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    const keyword = url.searchParams.get('keyword')?.trim() ?? ''
    const page = Number(url.searchParams.get('page') ?? '1')
    const limit = Number(url.searchParams.get('limit') ?? '10')
    let rows = getMockDatabase().adminUsers

    if (role) {
      rows = rows.filter((item) => item.role === role)
    }

    if (keyword) {
      rows = rows.filter(
        (item) =>
          item.name.includes(keyword) ||
          item.phone.includes(keyword) ||
          item.username.includes(keyword),
      )
    }

    const start = (page - 1) * limit
    return ok(
      {
        items: rows.slice(start, start + limit),
        total: rows.length,
      },
      '用户列表加载成功',
    )
  }),

  http.post('/api/admin/users/delete', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as { user_id: number }
    const db = getMockDatabase()
    const target = db.accounts.find((item) => item.userId === body.user_id)

    if (!target) {
      return fail(404, '用户不存在')
    }

    if (target.role === 'admin') {
      return fail(403, '管理员账号不能删除')
    }

    db.accounts = db.accounts.filter((item) => item.userId !== body.user_id)
    db.adminUsers = db.adminUsers.filter((item) => item.userId !== body.user_id)
    delete db.profiles[body.user_id]

    if (target.role === 'elder') {
      db.elders = db.elders.filter((item) => item.elderId !== body.user_id)
      db.health = Object.fromEntries(
        Object.entries(db.health).filter(([key]) => Number(key) !== body.user_id),
      )
      db.serviceRequests = db.serviceRequests.filter(
        (item) => item.familyUserId !== body.user_id && item.elderId !== body.user_id,
      )
      db.pendingServices = db.pendingServices.filter((item) => item.orderId !== body.user_id)
      db.alerts = db.alerts.filter((item) => item.linkedEntityId !== body.user_id)
    }

    if (target.role === 'volunteer') {
      db.volunteerProfiles = db.volunteerProfiles.filter((item) => item.rank !== body.user_id)
    }

    updateDashboardMetrics()
    syncPendingServices()

    return ok(null, '用户删除成功')
  }),

  http.post('/api/admin/volunteers/audit', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as {
      user_id: number
      action: 'approve' | 'reject'
    }
    const db = getMockDatabase()
    const user = db.adminUsers.find((item) => item.userId === body.user_id)
    const account = db.accounts.find((item) => item.userId === body.user_id)

    if (!user || !account || user.role !== 'volunteer') {
      return fail(404, '志愿者账号不存在')
    }

    user.status = body.action === 'approve' ? 'active' : 'rejected'
    account.status = body.action === 'approve' ? 'active' : 'rejected'
    account.reviewState = body.action === 'approve' ? 'approved' : 'rejected'

    return ok(
      {
        review_status: account.reviewState,
      },
      body.action === 'approve' ? '审核已通过' : '已驳回志愿者申请',
    )
  }),

  http.get('/api/admin/alerts', async () => {
    await delay(100)
    return ok(getMockDatabase().alerts, '报警中心加载成功')
  }),

  http.post('/api/admin/alerts/handle', async ({ request }) => {
    await delay(90)
    const body = (await request.json()) as { alert_id: number }
    const alert = getMockDatabase().alerts.find(
      (item) => item.alertId === body.alert_id,
    )

    if (!alert) {
      return fail(404, '告警不存在')
    }

    alert.status = 'handled'
    alert.resolutionSummary = '已由社区管理员确认并跟进'
    updateDashboardMetrics()

    return ok({ status: 'handled' }, '报警事项已处理')
  }),

  http.get('/api/admin/dashboard/stats', async () => {
    await delay(100)
    updateDashboardMetrics()
    return ok(getMockDatabase().dashboardMetrics, '总览数据加载成功')
  }),

  http.post('/api/admin/weekly-settlement', async () => {
    await delay(120)
    const db = getMockDatabase()
    const winner = [...db.volunteerProfiles].sort(
      (left, right) => right.weeklyHours - left.weeklyHours,
    )[0]

    if (!winner || winner.weeklyHours <= 0) {
      return ok({ winners: [], reset_count: 0 }, '本周暂无可结算的志愿者')
    }

    winner.awards = [...winner.awards, '本周公益之星']
    db.volunteerProfiles.forEach((item) => {
      item.weeklyHours = 0
    })

    updateDashboardMetrics()

    return ok(
      {
        winners: ['王佳明'],
        reset_count: db.volunteerProfiles.length,
      },
      '每周结算已完成，总服务时长保留，本周时长已清零',
    )
  }),

  http.post('/api/auth/change-password', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as {
      user_id: number
      old_password: string
      new_password: string
    }
    const db = getMockDatabase()
    const account = db.accounts.find((item) => item.userId === body.user_id)

    if (!account) {
      return fail(404, '用户不存在')
    }

    if (account.password !== body.old_password) {
      return fail(403, '当前密码不正确')
    }

    account.password = body.new_password
    return ok(null, '密码修改成功')
  }),

  http.get('/api/volunteer/my-tasks', async ({ request }) => {
    await delay(100)
    const url = new URL(request.url)
    const volunteerId = Number(url.searchParams.get('volunteer_id') ?? '302')
    const db = getMockDatabase()
    const myTasks = db.serviceRequests
      .filter((item) => item.assignedVolunteerId === volunteerId && item.status !== 'pending')
      .map((item) => ({
        orderId: item.requestId,
        serviceType: item.serviceType,
        serviceTime: item.serviceTime,
        serviceHours: item.serviceHours,
        status: item.status,
        elderName: item.elderName,
        addressPreview: item.address,
      }))
    return ok(myTasks, '我的任务加载成功')
  }),

  http.get('/api/volunteer/my-reviews', async ({ request }) => {
    await delay(100)
    const url = new URL(request.url)
    const volunteerId = Number(url.searchParams.get('volunteer_id') ?? '302')
    const db = getMockDatabase()
    const reviews = db.serviceRequests
      .filter((item) => item.status === 'completed' && item.assignedVolunteerId === volunteerId)
      .map((item) => ({
        orderId: item.requestId,
        serviceType: item.serviceType,
        elderName: item.elderName,
        serviceTime: item.serviceTime,
        rating: 4 + Math.round(Math.random()),
        comment: '服务态度很好，非常感谢！',
      }))
    return ok(reviews, '评价列表加载成功')
  }),

  // ── Public Task Hall ──
  http.get('/api/public/tasks', async ({ request }) => {
    await delay(100)
    const url = new URL(request.url)
    const statusFilter = url.searchParams.get('status')
    const db = getMockDatabase()

    let tasks = db.volunteerTasks
      .filter((item) => item.status !== 'unavailable')
      .map((item) => {
        const sr = db.serviceRequests.find((r) => r.requestId === item.orderId)
        return {
          order_id: item.orderId,
          elder_name: item.elderName ?? '',
          service_type: item.serviceType,
          service_time: item.scheduledTime,
          service_hours: item.serviceHours,
          address_preview: item.addressPreview,
          status: item.status === 'accepted' ? 'accepted' : item.status,
          created_at: item.scheduledTime,
          volunteer_name: sr?.assignedVolunteerName ?? null,
        }
      })

    if (statusFilter && statusFilter !== 'all') {
      tasks = tasks.filter((t) => t.status === statusFilter)
    }

    const allTasks = db.volunteerTasks.filter((item) => item.status !== 'unavailable')
    const stats = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      in_progress: allTasks.filter((t) => t.status === 'accepted' || t.status === 'in_progress').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
    }

    return ok({ tasks, stats }, '任务大厅加载成功')
  }),

  http.post('/api/public/tasks/batch-delete', async ({ request }) => {
    await delay(100)
    const body = (await request.json()) as { order_ids: number[] }
    const db = getMockDatabase()
    let deletedCount = 0

    for (const oid of body.order_ids) {
      const taskIdx = db.volunteerTasks.findIndex((t) => t.orderId === oid && t.status === 'completed')
      if (taskIdx >= 0) {
        db.volunteerTasks.splice(taskIdx, 1)
        const srIdx = db.serviceRequests.findIndex((r) => r.requestId === oid)
        if (srIdx >= 0) db.serviceRequests.splice(srIdx, 1)
        deletedCount++
      }
    }

    updateDashboardMetrics()
    return ok(null, `成功删除 ${deletedCount} 个已完成任务`)
  }),
]
