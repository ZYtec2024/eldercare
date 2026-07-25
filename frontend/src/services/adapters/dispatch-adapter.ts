import { http, type ApiEnvelope } from '@/services/http'
import type { DispatchOrder, DispatchOverview, DispatchTracking, NavigationMode, VolunteerDispatchTask } from '@/features/dispatch/dispatch-types'

export async function fetchDispatchOverview(userId?: number, regionAdcode?: string) {
  const response = await http.get<ApiEnvelope<DispatchOverview>>('/dispatch/overview', { params: { user_id: userId, region_adcode: regionAdcode } })
  return response.data.data
}

export async function fetchAdminDispatchRegions(adminUserId: number) {
  const response = await http.get<ApiEnvelope<Array<{ adcode: string; name: string }>>>('/dispatch/admin/regions', { params: { admin_user_id: adminUserId } })
  return response.data.data
}

export type RegionCatalogNode = {
  adcode: string
  name: string
  level: string
  center?: string
}

export type ManagedDispatchRegionManager = {
  user_id: number
  username: string
  real_name: string
}

export type ManagedDispatchRegion = {
  adcode: string
  name: string
  city_name?: string
  province_name?: string
  region_level?: string
  active: boolean
  has_polygon: boolean
  center_lng?: number | null
  center_lat?: number | null
  managers?: ManagedDispatchRegionManager[]
}

export type CandidateDistrictManager = {
  user_id: number
  username: string
  real_name: string
  region_adcodes: string[]
}

function mapManagedRegionManager(row: Record<string, unknown>): ManagedDispatchRegionManager {
  return {
    user_id: Number(row.user_id ?? row.userId ?? 0),
    username: String(row.username ?? ''),
    real_name: String(row.real_name ?? row.realName ?? ''),
  }
}

function mapManagedRegion(row: Record<string, unknown>): ManagedDispatchRegion {
  const managersRaw = Array.isArray(row.managers) ? row.managers : []
  return {
    adcode: String(row.adcode ?? ''),
    name: String(row.name ?? ''),
    city_name: row.city_name == null && row.cityName == null ? undefined : String(row.city_name ?? row.cityName ?? ''),
    province_name: row.province_name == null && row.provinceName == null ? undefined : String(row.province_name ?? row.provinceName ?? ''),
    region_level: row.region_level == null && row.regionLevel == null ? undefined : String(row.region_level ?? row.regionLevel ?? ''),
    active: Boolean(row.active),
    has_polygon: Boolean(row.has_polygon ?? row.hasPolygon),
    center_lng: row.center_lng == null && row.centerLng == null ? null : Number(row.center_lng ?? row.centerLng),
    center_lat: row.center_lat == null && row.centerLat == null ? null : Number(row.center_lat ?? row.centerLat),
    managers: managersRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map(mapManagedRegionManager)
      .filter((item) => item.user_id > 0),
  }
}

export async function fetchDispatchRegionChildren(adminUserId: number, keywords: string) {
  const response = await http.get<ApiEnvelope<RegionCatalogNode[]>>('/dispatch/admin/region-catalog/children', {
    params: { admin_user_id: adminUserId, keywords },
  })
  return response.data.data
}

export async function fetchManagedDispatchRegions(adminUserId: number) {
  const response = await http.get<ApiEnvelope<Record<string, unknown>[]>>('/dispatch/admin/regions/managed', {
    params: { admin_user_id: adminUserId },
  })
  const payload = response.data.data
  return Array.isArray(payload) ? payload.map(mapManagedRegion) : []
}

export async function fetchCandidateDistrictManagers(adminUserId: number) {
  const response = await http.get<ApiEnvelope<Record<string, unknown>[]>>('/dispatch/admin/candidate-managers', {
    params: { admin_user_id: adminUserId },
  })
  const payload = response.data.data
  if (!Array.isArray(payload)) return []
  return payload.map((row) => ({
    user_id: Number(row.user_id ?? row.userId ?? 0),
    username: String(row.username ?? ''),
    real_name: String(row.real_name ?? row.realName ?? ''),
    region_adcodes: Array.isArray(row.region_adcodes)
      ? row.region_adcodes.map(String)
      : Array.isArray(row.regionAdcodes)
        ? row.regionAdcodes.map(String)
        : [],
  }))
}

export async function createManagedDispatchRegion(payload: {
  adminUserId: number
  adcode: string
  provinceName?: string
  cityName?: string
  managerUserId?: number
  districtAdmin?: {
    username: string
    password: string
    real_name: string
    phone: string
    email: string
  }
}) {
  const response = await http.post<ApiEnvelope<{
    adcode: string
    name: string
    polygon_rings: number
    manager?: ManagedDispatchRegionManager & { created?: boolean }
  }>>('/dispatch/admin/regions', {
    admin_user_id: payload.adminUserId,
    adcode: payload.adcode,
    province_name: payload.provinceName,
    city_name: payload.cityName,
    manager_user_id: payload.managerUserId,
    district_admin: payload.districtAdmin,
  })
  return response.data
}

export async function bindManagedDispatchRegionManager(
  adcode: string,
  payload: {
    adminUserId: number
    managerUserId?: number
    districtAdmin?: {
      username: string
      password: string
      real_name: string
      phone: string
      email: string
    }
  },
) {
  const response = await http.post<ApiEnvelope<{ adcode: string; manager: ManagedDispatchRegionManager }>>(
    `/dispatch/admin/regions/${adcode}/managers`,
    {
      admin_user_id: payload.adminUserId,
      manager_user_id: payload.managerUserId,
      district_admin: payload.districtAdmin,
    },
  )
  return response.data
}

export async function unbindManagedDispatchRegionManager(
  adcode: string,
  managerUserId: number,
  adminUserId: number,
) {
  const response = await http.delete<ApiEnvelope<{ adcode: string; manager: ManagedDispatchRegionManager }>>(
    `/dispatch/admin/regions/${adcode}/managers/${managerUserId}`,
    { params: { admin_user_id: adminUserId } },
  )
  return response.data
}

export async function patchManagedDispatchRegion(
  adcode: string,
  payload: { adminUserId: number; active?: boolean; refreshPolygon?: boolean },
) {
  const response = await http.patch<ApiEnvelope<unknown>>(`/dispatch/admin/regions/${adcode}`, {
    admin_user_id: payload.adminUserId,
    active: payload.active,
    refresh_polygon: payload.refreshPolygon,
  })
  return response.data
}

export async function manuallyAssignDispatchOrder(orderId: number, payload: { adminUserId: number; volunteerId: number; reason: string }) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/admin/orders/${orderId}/manual-assign`, {
    admin_user_id: payload.adminUserId,
    volunteer_id: payload.volunteerId,
    reason: payload.reason,
  })
  return response.data
}

export type DispatchTrailVolunteer = { volunteer_id: number; volunteer_name: string; candidate_rank?: number | null; response_status?: string; auto_accept_enabled?: boolean }
export type DispatchTrailPhase = {
  label: string
  invited: DispatchTrailVolunteer[]
  newly_invited: DispatchTrailVolunteer[]
  kept: DispatchTrailVolunteer[]
  at?: string | null
  reason?: string
}
export type DispatchTrail = {
  order_id: number
  elder_name?: string
  service_type?: string
  urgency?: string
  dispatch_phase?: string
  dispatch_state?: string
  status?: string
  phases: Record<string, DispatchTrailPhase>
  assignee?: (DispatchTrailVolunteer & { mode?: string; automatic?: boolean; at?: string | null; message?: string }) | null
  current_invited: DispatchTrailVolunteer[]
  events: Array<{ event_id: number; event_type: string; message: string; created_at?: string }>
}

export async function fetchOrderDispatchTrail(orderId: number, adminUserId: number) {
  const response = await http.get<ApiEnvelope<DispatchTrail>>(`/dispatch/admin/orders/${orderId}/dispatch-trail`, {
    params: { admin_user_id: adminUserId },
  })
  return response.data.data
}

export type ManualSosCandidate = {
  volunteer_id: number
  volunteer_name: string
  distance_km: number
  eta_minutes: number
  total_score: number
  skill_match: string
  candidate_rank?: number
  availability?: string
  auto_accept_enabled?: boolean
  service_rating?: number
}

/** Start / re-trigger SOS auto-assign for an incident (no admin volunteer pick). */
export async function startAutoSosService(
  incidentId: number,
  adminUserId: number,
  requiredSkills?: string[],
) {
  const response = await http.post<ApiEnvelope<{
    order_id: number
    assigned?: boolean
    created?: boolean
    required_skills?: string[]
  }>>(
    `/dispatch/admin/incidents/${incidentId}/start-auto-sos-service`,
    {
      admin_user_id: adminUserId,
      required_skills: requiredSkills ?? ['emergency_response', 'medical_support'],
    },
  )
  return response.data
}

/** @deprecated Use startAutoSosService — SOS is auto-assign only. */
export const startManualSosService = startAutoSosService

export const SOS_SKILL_OPTIONS = [
  { code: 'emergency_response', label: '急救响应' },
  { code: 'medical_support', label: '医疗陪护' },
  { code: 'mobility_assist', label: '行动辅助' },
  { code: 'errand', label: '代办采购' },
  { code: 'companion', label: '陪伴沟通' },
  { code: 'rehab', label: '康复训练' },
  { code: 'digital_assist', label: '智能设备协助' },
  { code: 'grooming', label: '生活照护' },
] as const

export async function fetchElderDispatchOrders(userId: number) {
  const response = await http.get<ApiEnvelope<DispatchOrder[]>>('/dispatch/elder/orders', { params: { user_id: userId } })
  return response.data.data
}

export async function fetchDispatchTracking(role: 'elder' | 'volunteer' | 'family' | 'admin', userId: number) {
  const response = await http.get<ApiEnvelope<DispatchTracking>>('/dispatch/tracking', { params: { role, user_id: userId } })
  return response.data.data
}

export async function updateElderDispatchLocation(payload: {
  userId: number
  lng: number
  lat: number
  address?: string
  source?: 'fixed_home' | 'browser_gps' | 'virtual' | 'address_book'
  syncDisplay?: boolean
}) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/locations/elder', {
    user_id: payload.userId,
    lng: payload.lng,
    lat: payload.lat,
    address: payload.address,
    source: payload.source ?? 'fixed_home',
    sync_display: payload.syncDisplay === true,
  })
  return response.data
}

export async function updateVolunteerDispatchLocation(payload: {
  volunteerId: number
  lng?: number
  lat?: number
  source?: 'browser_gps' | 'virtual' | 'home_default'
  useHome?: boolean
}) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/locations/volunteer', {
    volunteer_id: payload.volunteerId,
    lng: payload.lng,
    lat: payload.lat,
    source: payload.useHome ? 'home_default' : (payload.source ?? 'virtual'),
    use_home: payload.useHome === true,
  })
  return response.data
}

export async function updateVolunteerDispatchPreferences(payload: { volunteerId: number; autoAcceptEnabled: boolean; homeLng?: number; homeLat?: number }) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/volunteer/preferences', {
    volunteer_id: payload.volunteerId, auto_accept_enabled: payload.autoAcceptEnabled, home_lng: payload.homeLng, home_lat: payload.homeLat,
  })
  return response.data
}

export async function updateVolunteerNavigationRoute(payload: {
  orderId: number
  volunteerId: number
  path: Array<[number, number]>
  trafficSegments: Array<{ path: Array<[number, number]>; status: string }>
  distanceKm: number
  etaMinutes: number
  navigationMode: NavigationMode
}) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/routes/${payload.orderId}/geometry`, {
    volunteer_id: payload.volunteerId,
    path: payload.path,
    traffic_segments: payload.trafficSegments,
    distance_km: payload.distanceKm,
    eta_minutes: payload.etaMinutes,
    navigation_mode: payload.navigationMode,
    restart_from_current: true,
  })
  return response.data
}

export async function createDispatchOrder(payload: {
  userId: number
  serviceType: string
  serviceHours?: number
  serviceTime?: string
  notes?: string
  urgent?: boolean
  requiredSkills?: string[]
  locationMode?: 'address' | 'live'
  lng?: number
  lat?: number
}) {
  const response = await http.post<ApiEnvelope<{ order_id: number; scheduled?: boolean }>>('/dispatch/orders', {
    user_id: payload.userId,
    service_type: payload.serviceType,
    service_hours: payload.serviceHours,
    service_time: payload.serviceTime,
    notes: payload.notes,
    urgent: payload.urgent,
    required_skills: payload.requiredSkills,
    location_mode: payload.locationMode,
    lng: payload.lng,
    lat: payload.lat,
  })
  return response.data
}

export async function cancelElderDispatchOrder(orderId: number, userId: number) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/orders/${orderId}/cancel`, { user_id: userId })
  return response.data
}

export async function completeElderDispatchOrder(orderId: number, userId: number) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/orders/${orderId}/elder-complete`, { user_id: userId })
  return response.data
}

export async function completeFamilyDispatchOrder(orderId: number, userId: number) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/orders/${orderId}/family-complete`, { user_id: userId })
  return response.data
}

export async function redispatchDispatchOrder(orderId: number, userId: number, reason?: string) {
  const response = await http.post<ApiEnvelope<{
    order_id: number
    mode: string
    urgency?: string
    dispatch_state?: string
    message: string
  }>>(`/dispatch/orders/${orderId}/redispatch`, {
    user_id: userId,
    reason: reason || '服务中出现问题，需要更换志愿者',
  })
  return response.data
}

export async function requestAdminForDispatchOrder(
  orderId: number,
  userId: number,
  options?: { reason?: string; alsoRedispatch?: boolean },
) {
  const response = await http.post<ApiEnvelope<{
    incident_id: number
    conversation_id?: number | null
    upgraded?: boolean
    created?: boolean
    redispatch?: unknown
  }>>(`/dispatch/orders/${orderId}/request-admin`, {
    user_id: userId,
    reason: options?.reason || '服务中需要管理员协助',
    also_redispatch: Boolean(options?.alsoRedispatch),
  })
  return response.data
}

export async function fetchVolunteerDispatchFeed(volunteerId: number) {
  const response = await http.get<ApiEnvelope<{ tasks: VolunteerDispatchTask[]; completed_tasks: Array<{ order_id: number; service_type: string; elder_name: string; address?: string; completed_at?: string | null; close_status?: string }>; state: { availability: string; fatigue_score: number; service_rating: number; assigned_today: number } }>>(
    '/dispatch/volunteer/feed', { params: { volunteer_id: volunteerId } },
  )
  return response.data.data
}

export async function respondDispatchOrder(orderId: number, volunteerId: number, action: 'accept' | 'decline' | 'start' | 'simulate_move' | 'complete' | 'cancel', position?: { lng: number; lat: number }, step?: number) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/orders/${orderId}/respond`, {
    volunteer_id: volunteerId,
    action,
    lng: position?.lng,
    lat: position?.lat,
    step,
  })
  return response.data
}

export async function advanceVolunteerReturnRoute(volunteerId: number, step = 7, position?: { lng: number; lat: number }) {
  const response = await http.post<ApiEnvelope<{ progress: number }>>('/dispatch/volunteer/return/move', { volunteer_id: volunteerId, step, lng: position?.lng, lat: position?.lat })
  return response.data
}

export async function simulateDispatchBurst(count = 10) {
  const response = await http.post<ApiEnvelope<{ order_ids: number[] }>>('/dispatch/simulation/burst', { count })
  return response.data
}

export async function advanceDispatchSimulation(step = 24) {
  const response = await http.post<ApiEnvelope<{ moved: number; started: number; completed: number }>>('/dispatch/simulation/tick', { step })
  return response.data
}

export async function perturbDispatchTraffic() {
  const response = await http.post<ApiEnvelope<{ traffic_version: number; rerouted: number }>>('/dispatch/traffic/perturb')
  return response.data
}

export async function resetDispatchSimulation() {
  const response = await http.post<ApiEnvelope<{ removed: number }>>('/dispatch/simulation/reset')
  return response.data
}
