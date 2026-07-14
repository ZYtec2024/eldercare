import { http, type ApiEnvelope } from '@/services/http'
import type { AdminUserRow, AlertItem, AwardRequestItem, DashboardMetric, HourReviewItem, Role } from '@/types/domain'

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
  return {
    userId: toNumber(row.userId ?? row.user_id),
    username: String(row.username ?? ''),
    role: String(row.role ?? 'family') as Role,
    name: String(row.name ?? row.real_name ?? ''),
    phone: String(row.phone ?? ''),
    email: typeof row.email === 'string' ? row.email : undefined,
    status: normalizedStatus as AdminUserRow['status'],
  }
}

export async function fetchAdminDashboard() {
  const response = await http.get<ApiEnvelope<DashboardMetric[] | Record<string, unknown>>>(
    '/admin/dashboard/stats',
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
  role?: Role | 'all'
  keyword?: string
  page?: number
  pageSize?: number
}) {
  const response = await http.get<
    ApiEnvelope<{ items: AdminUserRow[]; total: number } | { list: Record<string, unknown>[]; total: number }>
  >('/admin/users/list', {
    params: {
      role: filters.role && filters.role !== 'all' ? filters.role : undefined,
      keyword: filters.keyword || undefined,
      page: filters.page ?? 1,
      limit: filters.pageSize ?? 10,
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

export async function fetchAdminAlerts() {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/alerts')
  const payload = response.data.data

  if (!Array.isArray(payload)) {
    return []
  }

  return payload.map((alert) => ({
    alertId: toNumber(alert.alertId ?? alert.alert_id),
    category: mapAlertType(alert.alert_type ?? alert.category),
    priority: mapPriority(alert),
    createdAt: formatDateTime(alert.created_at ?? alert.createdAt),
    status: (alert.is_handled ? 'handled' : 'new') as AlertItem['status'],
    sourceLabel: String(alert.elder_name ?? alert.sourceLabel ?? '老人告警'),
    linkedEntityId: toNumber(alert.linkedEntityId ?? alert.elder_id),
    resolutionSummary: typeof alert.description === 'string' ? alert.description : undefined,
  }))
}

export async function auditVolunteer(userId: number, action: 'approve' | 'reject') {
  const response = await http.post<ApiEnvelope<{ review_status: string }>>(
    '/admin/volunteers/audit',
    {
      user_id: userId,
      action,
    },
  )
  return response.data
}

export async function deleteAdminUser(userId: number) {
  const response = await http.post<ApiEnvelope<null>>('/admin/users/delete', {
    user_id: userId,
  })
  return response.data
}

export async function handleAdminAlert(alertId: number) {
  const response = await http.post<ApiEnvelope<{ status: string }>>(
    '/admin/alerts/handle',
    {
      alert_id: alertId,
    },
  )
  return response.data
}

export async function runWeeklySettlement() {
  const response = await http.post<
    ApiEnvelope<{ winners: string[]; reset_count: number }>
  >('/admin/weekly-settlement')
  return response.data
}

export async function fetchHourReviews() {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/hour-reviews')
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

export async function fetchAwardRequests(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/admin/award-requests', {
    params: { status },
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
  requestId: number
  action: 'approve' | 'reject'
  reviewNote?: string
}) {
  const response = await http.post<ApiEnvelope<{ status: string }>>('/admin/award-requests/review', {
    request_id: payload.requestId,
    action: payload.action,
    review_note: payload.reviewNote ?? '',
  })
  return response.data
}

export async function reviewHourRequest(payload: {
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
  })
  return response.data
}
