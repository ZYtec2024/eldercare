import { http, type ApiEnvelope } from '@/services/http'
import type {
  ElderSummary,
  HealthTrendSnapshot,
  ServiceRequestCard,
  ServiceRequestDraft,
} from '@/types/domain'
import type { AddressPoiSuggestion, ElderAddress } from '@/services/adapters/profile-adapter'

type FamilyElderApiRow = {
  elder_id?: number
  elderId?: number
  name?: string
  age?: number
  gender?: string
  address?: string
  addressPreview?: string
  default_address?: string
  default_label?: string
  current_service_address?: string
  location_source?: string
  has_live_location?: boolean
  has_current_service_point?: boolean
  live_location_hint?: string
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
  const defaultAddress = String(row.default_address ?? row.addressPreview ?? row.address ?? '地址待补充')
  const currentServiceAddress = String(row.current_service_address ?? row.address ?? defaultAddress)
  return {
    elderId: Number(row.elder_id ?? row.elderId ?? 0),
    name: String(row.name ?? '未命名长辈'),
    age: Number(row.age ?? 0),
    gender: row.gender,
    addressPreview: currentServiceAddress || defaultAddress,
    defaultAddress,
    defaultLabel: String(row.default_label ?? '家'),
    currentServiceAddress,
    locationSource: String(row.location_source ?? ''),
    hasLiveLocation: Boolean(row.has_live_location),
    hasCurrentServicePoint: Boolean(row.has_current_service_point ?? row.has_live_location),
    liveLocationHint: String(row.live_location_hint ?? ''),
    relationType: String(row.relation_type ?? row.relationType ?? '亲属'),
    relationLabel: String(row.relation_type ?? row.relationType ?? '亲属'),
    riskLevel: 'normal',
    pendingServiceCount: 0,
    latestAlertSummary: '暂无提醒',
    latestSosStatus: '暂无 SOS',
  }
}

function pickHealthField(row: Record<string, unknown>, snake: string, camel: string) {
  const value = row[snake] ?? row[camel]
  return value === undefined || value === null || value === '' ? undefined : value
}

function normalizeHealthTrend(
  elderId: number,
  payload: HealthTrendSnapshot | HealthRecordApiRow[],
): HealthTrendSnapshot {
  if (!Array.isArray(payload)) {
    // Already-normalized snapshot (e.g. mock). Keep if it has dates; otherwise empty.
    if (payload?.dateRange?.length) return payload
    return {
      elderId,
      dateRange: [],
      systolicSeries: [],
      diastolicSeries: [],
      heartRateSeries: [],
      abnormalFlag: false,
      annotationText: '暂无健康记录，请先完成健康打卡。',
    }
  }

  const records = payload
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as Record<string, unknown>)

  return {
    elderId,
    dateRange: records.map((item) => String(pickHealthField(item, 'record_date', 'recordDate') ?? '')),
    systolicSeries: records.map((item) => Number(pickHealthField(item, 'blood_pressure_sys', 'bloodPressureSys') ?? 0)),
    diastolicSeries: records.map((item) => Number(pickHealthField(item, 'blood_pressure_dia', 'bloodPressureDia') ?? 0)),
    heartRateSeries: records.map((item) => Number(pickHealthField(item, 'heart_rate', 'heartRate') ?? 0)),
    bloodOxygenSeries: records.map((item) => {
      const value = pickHealthField(item, 'blood_oxygen', 'bloodOxygen')
      return value === undefined ? null : Number(value)
    }),
    bloodSugarSeries: records.map((item) => {
      const value = pickHealthField(item, 'blood_sugar', 'bloodSugar')
      return value === undefined ? null : Number(value)
    }),
    temperatureSeries: records.map((item) => {
      const value = pickHealthField(item, 'temperature', 'temperature')
      return value === undefined ? null : Number(value)
    }),
    weightSeries: records.map((item) => {
      const value = pickHealthField(item, 'weight', 'weight')
      return value === undefined ? null : Number(value)
    }),
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

function mapElderAddress(item: Record<string, unknown>): ElderAddress {
  return {
    addressId: Number(item.address_id ?? item.addressId),
    label: String(item.label ?? '家'),
    provinceName: String(item.province_name ?? item.provinceName ?? ''),
    cityName: String(item.city_name ?? item.cityName ?? ''),
    districtName: String(item.district_name ?? item.districtName ?? ''),
    regionAdcode: String(item.region_adcode ?? item.regionAdcode ?? ''),
    detailAddress: String(item.detail_address ?? item.detailAddress ?? ''),
    fullAddress: String(item.full_address ?? item.fullAddress ?? ''),
    lng: item.lng == null ? undefined : Number(item.lng),
    lat: item.lat == null ? undefined : Number(item.lat),
    isCurrent: Boolean(item.is_current ?? item.isCurrent),
  }
}

export async function fetchFamilyElderAddresses(familyUserId: number, elderId: number) {
  const response = await http.get<ApiEnvelope<{
    addresses?: Array<Record<string, unknown>>
    current_service_point?: Record<string, unknown> | null
  }>>(`/family/elders/${elderId}/addresses`, {
    params: { family_user_id: familyUserId },
  })
  const payload = response.data.data || {}
  const list = Array.isArray(payload.addresses) ? payload.addresses : []
  return {
    addresses: list.map(mapElderAddress),
    currentServicePoint: payload.current_service_point
      ? {
          lng: Number(payload.current_service_point.lng),
          lat: Number(payload.current_service_point.lat),
          address: String(payload.current_service_point.address ?? ''),
          locationSource: String(payload.current_service_point.location_source ?? ''),
          isLive: Boolean(
            payload.current_service_point.is_live
            ?? ['browser_gps', 'virtual'].includes(String(payload.current_service_point.location_source ?? '')),
          ),
          isHomeFixed: Boolean(payload.current_service_point.is_home_fixed),
          updatedAt: payload.current_service_point.updated_at
            ? String(payload.current_service_point.updated_at)
            : undefined,
        }
      : null,
  }
}

export async function addFamilyElderAddress(payload: {
  familyUserId: number
  elderId: number
  label: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  detailAddress: string
  addressSupplement?: string
  poi?: AddressPoiSuggestion
  isCurrent?: boolean
}) {
  const response = await http.post<ApiEnvelope<{ address_id: number }>>(
    `/family/elders/${payload.elderId}/addresses`,
    {
      family_user_id: payload.familyUserId,
      label: payload.label,
      province_name: payload.provinceName,
      city_name: payload.cityName,
      district_name: payload.districtName,
      region_adcode: payload.regionAdcode,
      detail_address: payload.detailAddress,
      address_supplement: payload.addressSupplement,
      poi_lng: payload.poi?.lng,
      poi_lat: payload.poi?.lat,
      poi_name: payload.poi?.name,
      poi_full_address: payload.poi?.fullAddress,
      is_current: payload.isCurrent !== false,
    },
  )
  return response.data
}

export async function updateFamilyElderAddress(payload: {
  familyUserId: number
  elderId: number
  addressId: number
  label: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  detailAddress: string
  addressSupplement?: string
  poi?: AddressPoiSuggestion
  isCurrent?: boolean
}) {
  const response = await http.put<ApiEnvelope<{ address_id: number }>>(
    `/family/elders/${payload.elderId}/addresses/${payload.addressId}`,
    {
      family_user_id: payload.familyUserId,
      label: payload.label,
      province_name: payload.provinceName,
      city_name: payload.cityName,
      district_name: payload.districtName,
      region_adcode: payload.regionAdcode,
      detail_address: payload.detailAddress,
      address_supplement: payload.addressSupplement,
      poi_lng: payload.poi?.lng,
      poi_lat: payload.poi?.lat,
      poi_name: payload.poi?.name,
      poi_full_address: payload.poi?.fullAddress,
      is_current: payload.isCurrent,
    },
  )
  return response.data
}

export async function selectFamilyElderAddress(payload: {
  familyUserId: number
  elderId: number
  addressId: number
}) {
  const response = await http.post<ApiEnvelope<null>>(
    `/family/elders/${payload.elderId}/addresses/select`,
    {
      family_user_id: payload.familyUserId,
      address_id: payload.addressId,
    },
  )
  return response.data
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
    location_mode: payload.locationMode || 'current',
    address_id: payload.addressId,
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
      requestId: Number(row.requestId ?? row.orderId ?? row.order_id ?? 0),
      familyUserId,
      elderId: Number(row.elderId ?? row.elder_id ?? 0),
      elderName: String(row.elderName ?? row.elder_name ?? ''),
      serviceType: String(row.serviceType ?? row.service_type ?? ''),
      serviceTime: String(row.serviceTime ?? row.service_time ?? ''),
      serviceHours: Number(row.serviceHours ?? row.service_hours ?? 1),
      address: String(row.address ?? ''),
      notes: String(row.notes ?? ''),
      status: String(row.status ?? 'pending') as ServiceRequestCard['status'],
      assignedVolunteerId: Number(row.assignedVolunteerId ?? row.volunteerId ?? row.volunteer_id ?? 0) || undefined,
      assignedVolunteerName:
        typeof (row.assignedVolunteerName ?? row.assigned_volunteer_name) === 'string'
          ? String(row.assignedVolunteerName ?? row.assigned_volunteer_name)
          : undefined,
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

export type FamilyAlertItem = {
  notificationId: number
  alertId?: number
  incidentId: number
  category: 'sos' | 'health_warning'
  elderName: string
  description: string
  status: string
  createdAt: string
  conversationId?: number
  unread: boolean
}

export async function fetchFamilyAlerts(familyUserId: number) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/family/alerts', {
    params: { family_user_id: familyUserId },
  })
  const rawList = Array.isArray(response.data.data) ? response.data.data : []
  return rawList.map((row) => ({
    notificationId: Number(row.notificationId ?? row.notification_id ?? 0),
    alertId: Number(row.alertId ?? row.alert_id ?? 0) || undefined,
    incidentId: Number(row.incidentId ?? row.incident_id ?? 0),
    category: String(row.category ?? 'sos') === 'sos' ? 'sos' as const : 'health_warning' as const,
    elderName: String(row.elderName ?? row.elder_name ?? '长辈'),
    description: String(row.description ?? ''),
    status: String(row.status ?? 'reported'),
    createdAt: String(row.createdAt ?? row.created_at ?? ''),
    conversationId: Number(row.conversationId ?? row.conversation_id ?? 0) || undefined,
    unread: Boolean(row.unread),
  } satisfies FamilyAlertItem))
}

export async function ackFamilyAlert(
  familyUserId: number,
  notificationId: number,
  category: FamilyAlertItem['category'] = 'sos',
) {
  const response = await http.post<ApiEnvelope<null>>('/family/alerts/ack', {
    family_user_id: familyUserId,
    notification_id: notificationId,
    category,
  })
  return response.data
}
