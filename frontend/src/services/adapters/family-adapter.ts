import { http, type ApiEnvelope } from '@/services/http'
import type {
  ElderSummary,
  HealthTrendSnapshot,
  ServiceRequestCard,
  ServiceRequestDraft,
} from '@/types/domain'

type FamilyElderApiRow = {
  elder_id?: number
  elderId?: number
  name?: string
  age?: number
  gender?: string
  address?: string
  addressPreview?: string
  relation_type?: string
  relationType?: string
  medical_history?: string
}

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

function mapFamilyElderRow(row: FamilyElderApiRow): ElderSummary {
  return {
    elderId: Number(row.elder_id ?? row.elderId ?? 0),
    name: String(row.name ?? '未命名长辈'),
    age: Number(row.age ?? 0),
    gender: row.gender,
    addressPreview: String(row.addressPreview ?? row.address ?? '地址待补充'),
    relationType: String(row.relation_type ?? row.relationType ?? '亲属'),
    relationLabel: String(row.relation_type ?? row.relationType ?? '亲属'),
    riskLevel: 'normal',
    pendingServiceCount: 0,
    latestAlertSummary: '暂无提醒',
    latestSosStatus: '暂无 SOS',
  }
}

function normalizeHealthTrend(
  elderId: number,
  payload: HealthTrendSnapshot | HealthRecordApiRow[],
): HealthTrendSnapshot {
  if (!Array.isArray(payload)) {
    return payload
  }

  const records = payload
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as HealthRecordApiRow)

  return {
    elderId,
    dateRange: records.map((item) => String(item.record_date ?? '')),
    systolicSeries: records.map((item) => Number(item.blood_pressure_sys ?? 0)),
    diastolicSeries: records.map((item) => Number(item.blood_pressure_dia ?? 0)),
    heartRateSeries: records.map((item) => Number(item.heart_rate ?? 0)),
    bloodOxygenSeries: records.map((item) =>
      item.blood_oxygen === undefined ? null : Number(item.blood_oxygen),
    ),
    bloodSugarSeries: records.map((item) =>
      item.blood_sugar === undefined ? null : Number(item.blood_sugar),
    ),
    temperatureSeries: records.map((item) =>
      item.temperature === undefined ? null : Number(item.temperature),
    ),
    weightSeries: records.map((item) =>
      item.weight === undefined ? null : Number(item.weight),
    ),
    abnormalFlag: false,
    annotationText: records.length
      ? '近 7 天健康记录'
      : '暂无健康记录，请先完成健康打卡。',
  }
}

export async function bindFamilyElder(payload: {
  familyUserId: number
  elderPhone: string
  relationType: string
}) {
  const response = await http.post<ApiEnvelope<{ relation_id: number }>>(
    '/family/bind-elder',
    {
      family_user_id: payload.familyUserId,
      elder_phone: payload.elderPhone,
      relation_type: payload.relationType,
    },
  )

  return response.data
}

export async function updateFamilyElderRelation(payload: {
  familyUserId: number
  elderId: number
  relationType: string
}) {
  const response = await http.put<ApiEnvelope<null>>('/family/bind-elder/relation', {
    family_user_id: payload.familyUserId,
    elder_id: payload.elderId,
    relation_type: payload.relationType,
  })

  return response.data
}

export async function unbindFamilyElder(payload: {
  familyUserId: number
  elderId: number
}) {
  const response = await http.delete<ApiEnvelope<null>>('/family/bind-elder', {
    params: {
      family_user_id: payload.familyUserId,
      elder_id: payload.elderId,
    },
  })

  return response.data
}

export async function fetchFamilyElders(familyUserId = 101) {
  const response = await http.get<ApiEnvelope<FamilyElderApiRow[]>>('/family/elders', {
    params: { family_user_id: familyUserId },
  })
  const list = Array.isArray(response.data.data) ? response.data.data : []
  return list.map(mapFamilyElderRow)
}

export async function fetchFamilyElderDetail(elderId: number, familyUserId: number) {
  const elders = await fetchFamilyElders(familyUserId)
  const elder = elders.find((item) => item.elderId === elderId)
  if (!elder) {
    throw new Error('长辈不存在')
  }
  return elder
}

export async function fetchFamilyHealthTrend(elderId: number) {
  const response = await http.get<ApiEnvelope<HealthTrendSnapshot | HealthRecordApiRow[]>>(
    `/family/elder-health-chart/${elderId}`,
  )
  return normalizeHealthTrend(elderId, response.data.data)
}

export async function createFamilyServiceRequest(payload: ServiceRequestDraft) {
  const response = await http.post<
    ApiEnvelope<{ order_id: number; status: string }>
  >('/family/orders/publish', {
    family_user_id: payload.familyUserId ?? 101,
    elder_id: payload.elderId,
    service_type: payload.serviceType,
    service_time: payload.serviceTime,
    service_hours: payload.serviceHours,
    address: payload.address || '',
    notes: payload.notes,
  })

  return response.data
}

export async function fetchFamilyOrders(familyUserId = 101) {
  const response = await http.get<ApiEnvelope<ServiceRequestCard[]>>(
    '/family/orders',
    {
      params: { family_user_id: familyUserId },
    },
  )

  const rawList = Array.isArray(response.data.data) ? response.data.data : []
  return rawList.map((item) => {
    const row = item as unknown as Record<string, unknown>
    return {
      requestId: Number(row.requestId ?? row.orderId ?? 0),
      familyUserId,
      elderId: Number(row.elderId ?? 0),
      elderName: String(row.elderName ?? ''),
      serviceType: String(row.serviceType ?? ''),
      serviceTime: String(row.serviceTime ?? ''),
      serviceHours: Number(row.serviceHours ?? 1),
      address: String(row.address ?? ''),
      notes: String(row.notes ?? ''),
      status: String(row.status ?? 'pending') as ServiceRequestCard['status'],
      assignedVolunteerId: row.volunteerId ? Number(row.volunteerId) : undefined,
      assignedVolunteerName:
        typeof row.assignedVolunteerName === 'string' ? row.assignedVolunteerName : undefined,
      hourReviewStatus: typeof row.hourReviewStatus === 'string'
        ? row.hourReviewStatus as ServiceRequestCard['hourReviewStatus']
        : typeof row.hour_review_status === 'string'
          ? row.hour_review_status as ServiceRequestCard['hourReviewStatus']
          : undefined,
      hourReviewApprovedHours:
        row.hourReviewApprovedHours === null || row.hour_review_approved_hours === null
          ? null
          : row.hourReviewApprovedHours ?? row.hour_review_approved_hours
            ? Number(row.hourReviewApprovedHours ?? row.hour_review_approved_hours)
            : undefined,
    } satisfies ServiceRequestCard
  })
}

export async function cancelFamilyOrder(orderId: number, familyUserId: number) {
  const response = await http.post<ApiEnvelope<{ status: string }>>(
    '/family/orders/cancel',
    {
      order_id: orderId,
      family_user_id: familyUserId,
    },
  )

  return response.data
}

export async function confirmFamilyOrderHours(payload: {
  orderId: number
  familyUserId: number
  actualHours: number
  reviewNote?: string
}) {
  const response = await http.post<ApiEnvelope<{ status: string }>>(
    '/family/orders/confirm-hours',
    {
      order_id: payload.orderId,
      family_user_id: payload.familyUserId,
      actual_hours: payload.actualHours,
      review_note: payload.reviewNote ?? '',
    },
  )

  return response.data
}

export async function reviewFamilyOrder(payload: { orderId: number; familyUserId: number; rating: number; comment?: string }) {
  const response = await http.post<ApiEnvelope<unknown>>('/family/orders/review', {
    order_id: payload.orderId, family_user_id: payload.familyUserId, rating: payload.rating, comment: payload.comment ?? '',
  })
  return response.data
}
