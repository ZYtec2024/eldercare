import { http, type ApiEnvelope } from '@/services/http'
import type { CheckInPayload, HealthTrendSnapshot, PendingService } from '@/types/domain'

type HealthRecordApiRow = {
  record_date?: string
  blood_pressure_sys?: number
  blood_pressure_dia?: number
  heart_rate?: number
  blood_oxygen?: number
  blood_sugar?: number
  temperature?: number
  weight?: number
}

function pickRecordField(row: Record<string, unknown>, snake: string, camel: string) {
  const value = row[snake] ?? row[camel]
  return value === undefined || value === null || value === '' ? undefined : value
}

function normalizeTodayRecord(
  row?: HealthRecordApiRow | Record<string, unknown> | null,
): HealthTrendSnapshot['todayRecord'] {
  if (!row) return null
  const source = row as Record<string, unknown>
  const numberValue = (snake: string, camel: string) => {
    const value = pickRecordField(source, snake, camel)
    return value === undefined ? undefined : Number(value)
  }
  return {
    recordDate: String(pickRecordField(source, 'record_date', 'recordDate') ?? ''),
    bloodPressureSys: numberValue('blood_pressure_sys', 'bloodPressureSys'),
    bloodPressureDia: numberValue('blood_pressure_dia', 'bloodPressureDia'),
    heartRate: numberValue('heart_rate', 'heartRate'),
    bloodOxygen: numberValue('blood_oxygen', 'bloodOxygen'),
    bloodSugar: numberValue('blood_sugar', 'bloodSugar'),
    temperature: numberValue('temperature', 'temperature'),
    weight: numberValue('weight', 'weight'),
  }
}

function normalizeElderHealthTrend(
  elderId: number,
  records: Array<HealthRecordApiRow | Record<string, unknown>>,
  todayRecord?: HealthRecordApiRow | Record<string, unknown> | null,
): HealthTrendSnapshot {
  const rows = records.map((item) => item as Record<string, unknown>)
  return {
    elderId,
    dateRange: rows.map((item) => String(pickRecordField(item, 'record_date', 'recordDate') ?? '')),
    systolicSeries: rows.map((item) => Number(pickRecordField(item, 'blood_pressure_sys', 'bloodPressureSys') ?? 0)),
    diastolicSeries: rows.map((item) => Number(pickRecordField(item, 'blood_pressure_dia', 'bloodPressureDia') ?? 0)),
    heartRateSeries: rows.map((item) => Number(pickRecordField(item, 'heart_rate', 'heartRate') ?? 0)),
    bloodOxygenSeries: rows.map((item) => {
      const value = pickRecordField(item, 'blood_oxygen', 'bloodOxygen')
      return value === undefined ? null : Number(value)
    }),
    bloodSugarSeries: rows.map((item) => {
      const value = pickRecordField(item, 'blood_sugar', 'bloodSugar')
      return value === undefined ? null : Number(value)
    }),
    temperatureSeries: rows.map((item) => {
      const value = pickRecordField(item, 'temperature', 'temperature')
      return value === undefined ? null : Number(value)
    }),
    weightSeries: rows.map((item) => {
      const value = pickRecordField(item, 'weight', 'weight')
      return value === undefined ? null : Number(value)
    }),
    abnormalFlag: false,
    annotationText: rows.length
      ? '近 7 天健康记录'
      : '暂无健康记录，请先完成健康打卡。',
    todayRecord: normalizeTodayRecord(todayRecord),
  }
}

export type EmergencyIncident = {
  incidentId: number
  incidentType: string
  description: string
  status: 'reported' | 'acknowledged' | 'dispatching' | 'resolved' | string
  createdAt: string
  acknowledgedAt?: string
  resolvedAt?: string
  resolutionSummary?: string
  elderName: string
  address?: string
  orderId?: number | null
  orderStatus?: string | null
  conversationId?: number | null
}

export async function fetchPendingServices(userId = 201) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>(
    '/elder/my-services',
    {
      params: { user_id: userId },
    },
  )
  const list = Array.isArray(response.data.data) ? response.data.data : []
  return list.map((row): PendingService => ({
    orderId: Number(row.orderId ?? row.order_id ?? 0),
    serviceType: String(row.serviceType ?? row.service_type ?? ''),
    time: String(row.time ?? ''),
    address: typeof row.address === 'string' ? row.address : undefined,
    status: String(row.status ?? 'pending') as PendingService['status'],
    volunteerId: Number(row.volunteerId ?? row.volunteer_id ?? 0) || undefined,
    volunteerName: typeof (row.volunteerName ?? row.volunteer_name) === 'string'
      ? String(row.volunteerName ?? row.volunteer_name)
      : undefined,
    dispatchState: typeof (row.dispatchState ?? row.dispatch_state) === 'string'
      ? String(row.dispatchState ?? row.dispatch_state)
      : undefined,
    reviewSubmitted: Boolean(row.reviewSubmitted ?? row.review_submitted),
    canReview: Boolean(row.canReview ?? row.can_review),
    canComplete: Boolean(row.canComplete ?? row.can_complete),
    proxyCreatedBy: Number(row.proxyCreatedBy ?? row.proxy_created_by ?? 0) || null,
    proxyFamilyName: typeof (row.proxyFamilyName ?? row.proxy_family_name) === 'string'
      ? String(row.proxyFamilyName ?? row.proxy_family_name)
      : null,
    isFamilyProxy: Boolean(row.isFamilyProxy ?? row.is_family_proxy ?? row.proxyCreatedBy ?? row.proxy_created_by),
  }))
}

export async function submitElderCheckIn(payload: CheckInPayload) {
  const response = await http.post<
    ApiEnvelope<{ abnormal: boolean; alert_id?: number | null; elder_id?: number }>
  >('/elder/health/checkin', {
    user_id: payload.userId ?? 201,
    blood_pressure_sys: payload.bloodPressureSys,
    blood_pressure_dia: payload.bloodPressureDia,
    heart_rate: payload.heartRate,
    blood_oxygen: payload.bloodOxygen,
    blood_sugar: payload.bloodSugar,
    temperature: payload.temperature,
    weight: payload.weight,
  })

  return response.data
}

/** Elder check-in page trend: keyed by login user_id, backend resolves elder_id. */
export async function fetchElderHealthTrend(userId: number): Promise<HealthTrendSnapshot> {
  const response = await http.get<ApiEnvelope<{
    elder_id?: number
    records?: HealthRecordApiRow[]
    today_record?: HealthRecordApiRow | null
  } | HealthRecordApiRow[]>>('/elder/health/chart', {
    params: { user_id: userId },
  })
  const payload = response.data.data
  if (Array.isArray(payload)) {
    return normalizeElderHealthTrend(userId, payload)
  }
  const elderId = Number(payload?.elder_id ?? userId)
  const records = Array.isArray(payload?.records) ? payload.records : []
  return normalizeElderHealthTrend(elderId, records, payload?.today_record)
}

export async function triggerElderSos(userId = 201) {
  const response = await http.post<ApiEnvelope<{ alert_id?: number | null }>>(
    '/elder/sos',
    {
      user_id: userId,
    },
  )
  return response.data
}

export async function createEmergencyIncident(payload: {
  reporterUserId: number
  elderId?: number
  incidentType?: 'general_help' | 'fall' | 'unwell' | 'hospital' | 'lost_risk' | 'other'
  description?: string
  dispatchService?: boolean
  requiredSkills?: string[]
  locationMode?: 'address' | 'current' | 'live'
  addressId?: number
  lng?: number
  lat?: number
  address?: string
}) {
  const locationMode = payload.locationMode === 'live' ? 'current' : (payload.locationMode || 'address')
  const response = await http.post<ApiEnvelope<{ incident_id: number; conversation_id: number; order_id?: number | null }>>(
    '/elder/emergency/incidents',
    {
      reporter_user_id: payload.reporterUserId,
      elder_id: payload.elderId,
      incident_type: payload.incidentType ?? 'general_help',
      description: payload.description ?? '一键紧急求助',
      dispatch_service: payload.dispatchService ?? false,
      required_skills: payload.requiredSkills,
      location_mode: locationMode,
      address_id: payload.addressId,
      lng: payload.lng,
      lat: payload.lat,
      address: payload.address,
    },
  )
  return response.data
}

export async function fetchEmergencyIncidents(userId: number) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>(
    '/elder/emergency/incidents',
    { params: { user_id: userId } },
  )
  const rows = response.data.data
  if (!Array.isArray(rows)) return [] as EmergencyIncident[]
  return rows.map((row) => ({
    incidentId: Number(row.incident_id ?? 0),
    incidentType: String(row.incident_type ?? 'general_help'),
    description: String(row.description ?? ''),
    status: String(row.status ?? 'reported'),
    createdAt: String(row.created_at ?? ''),
    acknowledgedAt: typeof row.acknowledged_at === 'string' ? row.acknowledged_at : undefined,
    resolvedAt: typeof row.resolved_at === 'string' ? row.resolved_at : undefined,
    resolutionSummary: typeof row.resolution_summary === 'string' ? row.resolution_summary : undefined,
    elderName: String(row.elder_name ?? ''),
    address: typeof row.address === 'string' ? row.address : undefined,
    orderId: row.order_id == null ? null : Number(row.order_id),
    orderStatus: typeof row.order_status === 'string' ? row.order_status : null,
    conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
  }))
}

export async function cancelEmergencyIncident(incidentId: number, userId: number) {
  const response = await http.post<ApiEnvelope<null>>(
    `/elder/emergency/incidents/${incidentId}/cancel`,
    { user_id: userId },
  )
  return response.data
}

export async function submitServiceReview(payload: {
  orderId: number
  rating: number
  comment: string
}) {
  const response = await http.post<ApiEnvelope<null>>('/elder/orders/review', {
    order_id: payload.orderId,
    rating: payload.rating,
    comment: payload.comment,
  })
  return response.data
}

export type WeeklyReportEligibility = {
  eligible: boolean
  daysWithData: number
  weekStart: string
  weekEnd: string
}

export async function fetchWeeklyReportEligibility(userId: number) {
  const response = await http.get<ApiEnvelope<WeeklyReportEligibility>>(
    '/elder/weekly-report/eligibility',
    { params: { user_id: userId } },
  )
  return response.data
}

export type WeeklyReport = {
  reportId: number
  content: string
  weekStart: string
  weekEnd: string
  templateName: string
  generatedAt: string
}

export async function generateWeeklyReport(userId: number) {
  const response = await http.post<ApiEnvelope<WeeklyReport>>(
    '/elder/weekly-report',
    { user_id: userId },
  )
  return response.data
}

export async function fetchWeeklyReportHistory(userId: number) {
  const response = await http.get<ApiEnvelope<{ items: WeeklyReport[]; total: number }>>(
    '/elder/weekly-report/history',
    { params: { user_id: userId } },
  )
  return response.data
}

export async function deleteWeeklyReport(reportId: number, userId: number) {
  const response = await http.delete<ApiEnvelope<null>>(
    `/elder/weekly-report/${reportId}`,
    { params: { user_id: userId } },
  )
  return response.data
}
