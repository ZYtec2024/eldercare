import { http, type ApiEnvelope } from '@/services/http'
import type { AdminUserRow, AlertItem, AwardRequestItem, DashboardMetric, HourReviewItem, Role } from '@/types/domain'
import type { DispatchRoute } from '@/features/dispatch/dispatch-types'

export interface ServiceRecordItem {
  orderId: number
  elderName: string
  volunteerName?: string
  volunteerId?: number
  serviceType: string
  address?: string
  regionAdcode?: string
  serviceLng?: number
  serviceLat?: number
  serviceTime: string
  arrivedAt: string
  serviceStartedAt: string
  serviceEndedAt: string
  durationMinutes?: number
  notes?: string
  volunteerStartLng?: number
  volunteerStartLat?: number
  volunteerStartAddress?: string
  actualDistanceKm?: number
  route?: DispatchRoute
}

export async function fetchServiceRecords(page = 1, pageSize = 30, orderId?: number) {
  const response = await http.get<ApiEnvelope<{ items: Array<Record<string, unknown>>; total: number }>>(
    '/admin/service-records',
    { params: { page, page_size: pageSize, order_id: orderId } },
  )
  const payload = response.data.data
  return {
    total: Number(payload?.total ?? 0),
    items: (payload?.items ?? []).map((row): ServiceRecordItem => ({
      orderId: Number(row.order_id),
      elderName: String(row.elder_name ?? ''),
      volunteerName: row.volunteer_name ? String(row.volunteer_name) : undefined,
      volunteerId: row.volunteer_id == null ? undefined : Number(row.volunteer_id),
      serviceType: String(row.service_type ?? ''),
      address: row.address ? String(row.address) : undefined,
      regionAdcode: row.region_adcode ? String(row.region_adcode) : undefined,
      serviceLng: row.service_lng == null ? undefined : Number(row.service_lng),
      serviceLat: row.service_lat == null ? undefined : Number(row.service_lat),
      serviceTime: String(row.service_time ?? ''),
      arrivedAt: String(row.arrived_at ?? ''),
      serviceStartedAt: String(row.service_started_at ?? ''),
      serviceEndedAt: String(row.service_ended_at ?? ''),
      durationMinutes: row.duration_minutes == null ? undefined : Number(row.duration_minutes),
      notes: row.notes ? String(row.notes) : undefined,
      volunteerStartLng: row.volunteer_start_lng == null ? undefined : Number(row.volunteer_start_lng),
      volunteerStartLat: row.volunteer_start_lat == null ? undefined : Number(row.volunteer_start_lat),
      volunteerStartAddress: row.volunteer_start_address ? String(row.volunteer_start_address) : undefined,
      actualDistanceKm: row.actual_distance_km == null ? undefined : Number(row.actual_distance_km),
      route: row.route as DispatchRoute | undefined,
    })),
  }
}

export interface LoginAuditItem {
  auditId: number
  userId?: number
  username: string
  role?: Role
  maskedIp: string
  loginSuccess: boolean
  createdAt: string
}

export async function fetchLoginAudits(adminUserId: number, page = 1, pageSize = 30) {
  const response = await http.get<ApiEnvelope<{ items: Array<Record<string, unknown>>; total: number }>>(
    '/admin/login-audits',
    { params: { admin_user_id: adminUserId, page, page_size: pageSize } },
  )
  const payload = response.data.data
  return {
    total: Number(payload?.total ?? 0),
    items: (payload?.items ?? []).map((row): LoginAuditItem => ({
      auditId: Number(row.audit_id ?? row.auditId),
      userId: row.user_id == null && row.userId == null ? undefined : Number(row.user_id ?? row.userId),
      username: String(row.username ?? ''),
      role: row.role ? String(row.role) as Role : undefined,
      maskedIp: String(row.masked_ip ?? row.maskedIp ?? 'unknown'),
      loginSuccess: Boolean(row.login_success ?? row.loginSuccess),
      createdAt: String(row.created_at ?? row.createdAt ?? ''),
    })),
  }
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toMetricDataset(dataset: unknown): Array<{ label: string; value: number }> {
  if (!Array.isArray(dataset)) {
    return []
  }

  return dataset
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const record = item as Record<string, unknown>
      const label = String(record.label ?? record.type ?? '-')
      const value = toNumber(record.value ?? record.count)
      return { label, value }
    })
    .filter((item): item is { label: string; value: number } => item !== null)
}

function formatDateTime(value: unknown) {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Date) {
    return value.toLocaleString('zh-CN', { hour12: false })
  }

  return ''
}

function mapAlertType(type: unknown): AlertItem['category'] {
  return String(type) === 'sos' ? 'sos' : 'health_abnormal'
}

function mapPriority(alert: Record<string, unknown>): AlertItem['priority'] {
  const type = String(alert.alert_type ?? alert.category ?? '')
  return type === 'sos' ? 'high' : 'medium'
}

function mapUserRow(row: Record<string, unknown>): AdminUserRow {
  const rawStatus = String(row.status ?? 'active')
  const normalizedStatus = rawStatus === 'pending' ? 'pending_review' : rawStatus
  const relatedRaw = Array.isArray(row.related_elders)
    ? row.related_elders
    : Array.isArray(row.relatedElders)
      ? row.relatedElders
      : []
  const relatedElders = relatedRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      elderId: toNumber(item.elderId ?? item.elder_id),
      name: String(item.name ?? ''),
      address: typeof item.address === 'string' ? item.address : undefined,
      relationType: item.relation_type == null && item.relationType == null
        ? undefined
        : String(item.relationType ?? item.relation_type),
      regionAdcode: item.region_adcode == null && item.regionAdcode == null
        ? undefined
        : String(item.regionAdcode ?? item.region_adcode),
      regionName: item.region_name == null && item.regionName == null
        ? undefined
        : String(item.regionName ?? item.region_name),
      inAdminScope: item.in_admin_scope == null && item.inAdminScope == null
        ? undefined
        : Boolean(item.inAdminScope ?? item.in_admin_scope),
    }))
  const regionAdcodes = Array.isArray(row.region_adcodes)
    ? row.region_adcodes.map(String)
    : Array.isArray(row.regionAdcodes)
      ? row.regionAdcodes.map(String)
      : []
  const regionNames = Array.isArray(row.region_names)
    ? row.region_names.map(String)
    : Array.isArray(row.regionNames)
      ? row.regionNames.map(String)
      : []
  return {
    userId: toNumber(row.userId ?? row.user_id),
    username: String(row.username ?? ''),
    role: String(row.role ?? 'family') as Role,
    name: String(row.name ?? row.real_name ?? ''),
    phone: String(row.phone ?? ''),
    email: typeof row.email === 'string' ? row.email : undefined,
    status: normalizedStatus as AdminUserRow['status'],
    regionAdcodes,
    regionNames,
    address: typeof row.address === 'string' ? row.address : undefined,
    skillsDescription: typeof row.skills_description === 'string'
      ? row.skills_description
      : typeof row.skillsDescription === 'string'
        ? row.skillsDescription
        : undefined,
    verifiedSkills: Array.isArray(row.verified_skills)
      ? row.verified_skills.map(String)
      : Array.isArray(row.verifiedSkills)
        ? row.verifiedSkills.map(String)
        : [],
    relatedElders,
  }
}

export async function fetchAdminDashboard(
  adminUserId: number,
  geo?: { regionAdcode?: string; provinceName?: string; cityName?: string },
) {
  const response = await http.get<ApiEnvelope<DashboardMetric[] | Record<string, unknown>>>(
    '/admin/dashboard/stats', {
      params: {
        admin_user_id: adminUserId,
        region_adcode: geo?.regionAdcode,
        province_name: geo?.provinceName,
        city_name: geo?.cityName,
      },
    },
  )

  const payload = response.data.data
  if (Array.isArray(payload)) {
    return payload
  }

  const source = (payload ?? {}) as Record<string, unknown>
  const totalUsers = toNumber(source.total_users_count ?? source.totalUsers ?? source.total_users)
  const totalServiceHours = toNumber(
    source.total_service_hours ?? source.totalServiceHours ?? source.service_hours,
  )
  const serviceTypeDistribution = toMetricDataset(
    source.service_type_distribution ?? source.serviceTypeDistribution,
  )

  const metrics: DashboardMetric[] = [
    {
      metricId: 'total_users',
      label: '平台注册用户',
      value: totalUsers,
      comparisonText: '累计用户总数',
      visualType: 'stat',
      datasetPreview: [],
    },
    {
      metricId: 'services_completed',
      label: '累计服务时长',
      value: totalServiceHours,
      comparisonText: '志愿服务累计小时',
      visualType: 'stat',
      datasetPreview: [],
    },
    {
      metricId: 'service_type_distribution',
      label: '服务类型分布',
      value: serviceTypeDistribution.reduce((sum, item) => sum + item.value, 0),
      comparisonText: '按服务类型聚合',
      visualType: 'pie',
      datasetPreview: serviceTypeDistribution,
    },
  ]

  return metrics
}

export async function fetchAdminUsers(filters: {
  adminUserId: number
  role?: Role | 'all'
  keyword?: string
  regionAdcode?: string
  provinceName?: string
  cityName?: string
  page?: number
  pageSize?: number
}) {
  const response = await http.get<
    ApiEnvelope<{ items: AdminUserRow[]; total: number } | { list: Record<string, unknown>[]; total: number }>
  >('/admin/users/list', {
    params: {
      role: filters.role && filters.role !== 'all' ? filters.role : undefined,
      keyword: filters.keyword || undefined,
      region_adcode: filters.regionAdcode || undefined,
      province_name: filters.provinceName || undefined,
      city_name: filters.cityName || undefined,
      page: filters.page ?? 1,
      limit: filters.pageSize ?? 10,
      admin_user_id: filters.adminUserId,
    },
  })

  const payload = response.data.data
  if (payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)) {
    const typed = payload as { items: AdminUserRow[]; total: number }
    return {
      items: typed.items.map((row) => mapUserRow(row as unknown as Record<string, unknown>)),
      total: toNumber(typed.total),
    }
  }

  const legacy = payload as { list?: Record<string, unknown>[]; total?: number }
  const items = Array.isArray(legacy?.list) ? legacy.list.map(mapUserRow) : []
  return {
    items,
    total: toNumber(legacy?.total, items.length),
  }
}

export async function fetchAdminAlerts(
  adminUserId: number,
  geo?: { regionAdcode?: string; provinceName?: string; cityName?: string },
) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/alerts', {
    params: {
      admin_user_id: adminUserId,
      region_adcode: geo?.regionAdcode,
      province_name: geo?.provinceName,
      city_name: geo?.cityName,
    },
  })
  const payload = response.data.data

  if (!Array.isArray(payload)) {
    return []
  }

  return payload.map((alert) => ({
    alertId: toNumber(alert.alertId ?? alert.alert_id),
    category: mapAlertType(alert.alert_type ?? alert.category),
    priority: mapPriority(alert),
    createdAt: formatDateTime(alert.created_at ?? alert.createdAt),
    status: (alert.incident_status === 'acknowledged'
      ? 'acknowledged'
      : alert.incident_status === 'dispatching'
        ? 'dispatching'
        : alert.incident_status === 'awaiting_admin_close'
          ? 'dispatching'
          : alert.is_handled || alert.incident_status === 'resolved'
            ? 'handled'
            : 'new') as AlertItem['status'],
    sourceLabel: String(alert.elder_name ?? alert.sourceLabel ?? '老人告警'),
    linkedEntityId: toNumber(alert.linkedEntityId ?? alert.elder_id),
    resolutionSummary: typeof alert.resolution_summary === 'string'
      ? alert.resolution_summary
      : typeof alert.description === 'string' ? alert.description : undefined,
    incidentId: alert.emergency_incident_id == null ? null : toNumber(alert.emergency_incident_id),
    incidentStatus: typeof alert.incident_status === 'string' ? alert.incident_status : null,
    conversationId: alert.conversation_id == null ? null : toNumber(alert.conversation_id),
    linkedOrderId: alert.linked_order_id == null ? null : toNumber(alert.linked_order_id),
    linkedOrderStatus: typeof alert.linked_order_status === 'string' ? alert.linked_order_status : null,
    linkedVolunteerName: typeof alert.linked_volunteer_name === 'string' ? alert.linked_volunteer_name : null,
    acknowledgedAt: typeof alert.acknowledged_at === 'string' ? alert.acknowledged_at : undefined,
    resolvedAt: typeof alert.resolved_at === 'string' ? alert.resolved_at : undefined,
    lastMessage: typeof alert.last_message === 'string' ? alert.last_message : null,
    lastMessageAt: typeof alert.last_message_at === 'string' ? alert.last_message_at : formatDateTime(alert.last_message_at) || null,
    regionAdcode: alert.region_adcode == null ? null : String(alert.region_adcode),
    regionName: typeof alert.region_name === 'string' ? alert.region_name : null,
    provinceName: typeof alert.province_name === 'string' ? alert.province_name : null,
    cityName: typeof alert.city_name === 'string' ? alert.city_name : null,
  }))
}

export async function auditVolunteer(
  userId: number,
  action: 'approve' | 'reject',
  adminUserId: number,
  skillTags: string[] = [],
) {
  const response = await http.post<ApiEnvelope<{ review_status: string; verified_skills: string[] }>>(
    '/admin/volunteers/audit',
    {
      user_id: userId,
      action,
      admin_user_id: adminUserId,
      skill_tags: skillTags,
    },
  )
  return response.data
}

export async function deleteAdminUser(userId: number, adminUserId: number) {
  const response = await http.post<ApiEnvelope<null>>('/admin/users/delete', {
    user_id: userId,
    admin_user_id: adminUserId,
  })
  return response.data
}

export async function handleAdminAlert(
  alertId: number,
  adminUserId: number,
  action: 'acknowledge' | 'close' = 'acknowledge',
  resolutionSummary?: string,
) {
  const response = await http.post<ApiEnvelope<{ status: string }>>(
    '/admin/alerts/handle',
    {
      alert_id: alertId,
      admin_user_id: adminUserId,
      action,
      resolution_summary: resolutionSummary,
    },
  )
  return response.data
}

export async function runWeeklySettlement(adminUserId: number) {
  const response = await http.post<
    ApiEnvelope<{ winners: string[]; reset_count: number }>
  >('/admin/weekly-settlement', { admin_user_id: adminUserId })
  return response.data
}

export async function fetchHourReviews(adminUserId: number) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/hour-reviews', { params: { admin_user_id: adminUserId } })
  const payload = response.data.data

  if (!Array.isArray(payload)) {
    return []
  }

  return payload.map((item) => ({
    reviewId: toNumber(item.reviewId ?? item.review_id),
    orderId: toNumber(item.orderId ?? item.order_id),
    volunteerId: toNumber(item.volunteerId ?? item.volunteer_id),
    volunteerName: String(item.volunteerName ?? item.volunteer_name ?? ''),
    familyUserId: toNumber(item.familyUserId ?? item.family_user_id),
    familyName: String(item.familyName ?? item.family_name ?? ''),
    serviceType: String(item.serviceType ?? item.service_type ?? ''),
    serviceTime: formatDateTime(item.serviceTime ?? item.service_time),
    expectedHours: toNumber(item.expectedHours ?? item.expected_hours),
    declaredHours: toNumber(item.declaredHours ?? item.declared_hours),
    maxAutoHours: toNumber(item.maxAutoHours ?? item.max_auto_hours),
    reviewStatus: String(item.reviewStatus ?? item.review_status ?? 'pending_admin') as HourReviewItem['reviewStatus'],
    approvedHours:
      item.approvedHours === null || item.approved_hours === null
        ? null
        : toNumber(item.approvedHours ?? item.approved_hours),
    reviewNote: typeof item.reviewNote === 'string' ? item.reviewNote : typeof item.review_note === 'string' ? item.review_note : undefined,
    createdAt: formatDateTime(item.createdAt ?? item.created_at),
    reviewedAt: formatDateTime(item.reviewedAt ?? item.reviewed_at),
  }))
}

export async function fetchAwardRequests(adminUserId: number, status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/award-requests', {
    params: { status, admin_user_id: adminUserId },
  })

  const payload = response.data.data
  if (!Array.isArray(payload)) {
    return []
  }

  return payload.map((item) => ({
    requestId: toNumber(item.requestId ?? item.request_id),
    volunteerId: toNumber(item.volunteerId ?? item.volunteer_id),
    volunteerName: String(item.volunteerName ?? item.volunteer_name ?? ''),
    awardTitle: String(item.awardTitle ?? item.award_title ?? ''),
    reason: typeof item.reason === 'string' ? item.reason : undefined,
    status: String(item.status ?? 'pending') as AwardRequestItem['status'],
    reviewNote: typeof item.reviewNote === 'string' ? item.reviewNote : typeof item.review_note === 'string' ? item.review_note : undefined,
    createdAt: formatDateTime(item.createdAt ?? item.created_at),
    reviewedAt: formatDateTime(item.reviewedAt ?? item.reviewed_at),
  }))
}

export async function reviewAwardRequest(payload: {
  adminUserId: number
  requestId: number
  action: 'approve' | 'reject'
  reviewNote?: string
}) {
  const response = await http.post<ApiEnvelope<{ status: string }>>('/admin/award-requests/review', {
    request_id: payload.requestId,
    action: payload.action,
    review_note: payload.reviewNote ?? '',
    admin_user_id: payload.adminUserId,
  })
  return response.data
}

export async function reviewHourRequest(payload: {
  adminUserId: number
  reviewId: number
  action: 'approve' | 'reject'
  approvedHours?: number
  reviewNote?: string
}) {
  const response = await http.post<ApiEnvelope<{ status: string }>>('/admin/hour-reviews/review', {
    review_id: payload.reviewId,
    action: payload.action,
    approved_hours: payload.approvedHours,
    review_note: payload.reviewNote ?? '',
    admin_user_id: payload.adminUserId,
  })
  return response.data
}
