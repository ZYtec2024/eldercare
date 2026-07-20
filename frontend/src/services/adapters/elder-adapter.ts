import { http, type ApiEnvelope } from '@/services/http'
import type { CheckInPayload, PendingService } from '@/types/domain'

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
  const response = await http.get<ApiEnvelope<PendingService[]>>(
    '/elder/my-services',
    {
      params: { user_id: userId },
    },
  )
  return response.data.data
}

export async function submitElderCheckIn(payload: CheckInPayload) {
  const response = await http.post<
    ApiEnvelope<{ abnormal: boolean; alert_id?: number | null }>
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
}) {
  const response = await http.post<ApiEnvelope<{ incident_id: number; conversation_id: number; order_id?: number | null }>>(
    '/elder/emergency/incidents',
    {
      reporter_user_id: payload.reporterUserId,
      elder_id: payload.elderId,
      incident_type: payload.incidentType ?? 'general_help',
      description: payload.description ?? '一键紧急求助',
      dispatch_service: payload.dispatchService ?? false,
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
