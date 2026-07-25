import { http, type ApiEnvelope } from '@/services/http'
import type { ProfileSnapshot, Role } from '@/types/domain'

export interface ElderAddress {
  addressId: number
  label: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  detailAddress: string
  fullAddress: string
  lng?: number
  lat?: number
  isCurrent: boolean
}

export interface AddressPoiSuggestion {
  id: string
  name: string
  displayName: string
  fullAddress: string
  address: string
  districtName: string
  regionAdcode: string
  lng: number
  lat: number
}

export interface ResolvedLiveLocation {
  formattedAddress: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  lng: number
  lat: number
}

export async function fetchAddressSuggestions(keywords: string, regionAdcode: string): Promise<AddressPoiSuggestion[]> {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/profile/address-suggestions', {
    params: { keywords, region_adcode: regionAdcode },
  })
  return (response.data.data || []).map((item) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    displayName: String(item.display_name ?? item.displayName ?? item.name ?? ''),
    fullAddress: String(item.full_address ?? item.fullAddress ?? ''),
    address: String(item.address ?? ''),
    districtName: String(item.district_name ?? item.districtName ?? ''),
    regionAdcode: String(item.adcode ?? item.region_adcode ?? ''),
    lng: Number(item.lng),
    lat: Number(item.lat),
  }))
}

export async function resolveBrowserLocation(
  userId: number,
  role: 'elder' | 'volunteer',
  lng: number,
  lat: number,
  options?: { fromGps?: boolean },
): Promise<ResolvedLiveLocation> {
  const response = await http.post<ApiEnvelope<Record<string, unknown>>>('/profile/location/resolve', {
    user_id: userId,
    role,
    lng,
    lat,
    // Match uploaded/master: omit conversion unless caller explicitly requests it.
    from_gps: options?.fromGps === true,
  })
  const item = response.data.data
  return {
    formattedAddress: String(item.formatted_address ?? item.formattedAddress ?? '实时位置'),
    provinceName: String(item.province_name ?? item.provinceName ?? ''),
    cityName: String(item.city_name ?? item.cityName ?? ''),
    districtName: String(item.district_name ?? item.districtName ?? ''),
    regionAdcode: String(item.adcode ?? item.region_adcode ?? ''),
    lng: Number(item.lng),
    lat: Number(item.lat),
  }
}

export async function updateVolunteerLiveLocation(
  userId: number,
  lng: number,
  lat: number,
  options?: { fromGps?: boolean },
) {
  const response = await http.post<ApiEnvelope<Record<string, unknown>>>('/profile/volunteer/location', {
    user_id: userId,
    lng,
    lat,
    from_gps: options?.fromGps === true,
  })
  return response.data
}

function toNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseAwards(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const result = value
    .split(/\n|；|;|,|，/g)
    .map((item) => item.trim())
    .filter(Boolean)

  return result.length > 0 ? result : undefined
}

export async function fetchProfileInfo(userId: number, role: Role) {
  const response = await http.get<ApiEnvelope<Record<string, unknown> | ProfileSnapshot>>('/profile/info', {
    params: {
      user_id: userId,
      role,
    },
  })

  const data = response.data.data as Record<string, unknown>

  return {
    accountId: Number(data.accountId ?? data.account_id ?? data.user_id ?? userId),
    role,
    realName: String(data.realName ?? data.real_name ?? ''),
    phone: String(data.phone ?? ''),
    email: String(data.email ?? ''),
    medicalHistory:
      typeof data.medicalHistory === 'string'
        ? data.medicalHistory
        : typeof data.medical_history === 'string'
          ? data.medical_history
          : undefined,
    alertSysThreshold: toNumber(data.alertSysThreshold ?? data.alert_sys_threshold),
    skills:
      typeof data.skills === 'string'
        ? data.skills
        : undefined,
    totalHours: toNumber(data.totalHours ?? data.total_hours),
    weeklyHours: toNumber(data.weeklyHours ?? data.weekly_hours),
    awards: parseAwards(data.awards),
    likesCount: toNumber(data.likesCount ?? data.likes_count),
    regionAdcode: data.region_adcode == null && data.regionAdcode == null
      ? undefined
      : String(data.regionAdcode ?? data.region_adcode),
    regionName: data.region_name == null && data.regionName == null
      ? undefined
      : String(data.regionName ?? data.region_name),
  }
}

export async function updateProfileInfo(payload: {
  userId: number
  role: Role
  phone: string
  email: string
  medicalHistory?: string
  alertSysThreshold?: number
  skills?: string
}) {
  const response = await http.post<ApiEnvelope<ProfileSnapshot>>(
    '/profile/update',
    {
      user_id: payload.userId,
      role: payload.role,
      phone: payload.phone,
      email: payload.email,
      medical_history: payload.medicalHistory,
      alert_sys_threshold: payload.alertSysThreshold,
      skills: payload.skills,
    },
  )

  return response.data.data
}

export async function fetchElderAddresses(userId: number): Promise<ElderAddress[]> {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>>>>('/profile/addresses', {
    params: { user_id: userId },
  })
  return (response.data.data || []).map((item) => ({
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
  }))
}

export async function addElderAddress(payload: {
  userId: number
  label: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  detailAddress: string
  addressSupplement?: string
  poi?: AddressPoiSuggestion
}) {
  const response = await http.post<ApiEnvelope<{ address_id: number }>>('/profile/addresses', {
    user_id: payload.userId,
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
    is_current: true,
  })
  return response.data
}

export async function updateElderAddress(payload: {
  addressId: number
  userId: number
  label: string
  provinceName: string
  cityName: string
  districtName: string
  regionAdcode: string
  detailAddress: string
  isCurrent: boolean
  addressSupplement?: string
  poi?: AddressPoiSuggestion
}) {
  const response = await http.put<ApiEnvelope<{ address_id: number }>>(`/profile/addresses/${payload.addressId}`, {
    user_id: payload.userId,
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
  })
  return response.data
}

export async function selectElderAddress(userId: number, addressId: number) {
  const response = await http.post<ApiEnvelope<null>>('/profile/addresses/select', {
    user_id: userId,
    address_id: addressId,
  })
  return response.data
}
