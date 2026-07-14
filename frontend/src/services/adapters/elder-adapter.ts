import { http, type ApiEnvelope } from '@/services/http'
import type { CheckInPayload, PendingService } from '@/types/domain'

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
