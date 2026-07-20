import { http, type ApiEnvelope } from '@/services/http'
import type { DispatchOrder, DispatchOverview, DispatchTracking, VolunteerDispatchTask } from '@/features/dispatch/dispatch-types'

export async function fetchDispatchOverview(userId?: number, regionAdcode?: string) {
  const response = await http.get<ApiEnvelope<DispatchOverview>>('/dispatch/overview', { params: { user_id: userId, region_adcode: regionAdcode } })
  return response.data.data
}

export async function fetchAdminDispatchRegions(adminUserId: number) {
  const response = await http.get<ApiEnvelope<Array<{ adcode: string; name: string }>>>('/dispatch/admin/regions', { params: { admin_user_id: adminUserId } })
  return response.data.data
}

export async function manuallyAssignDispatchOrder(orderId: number, payload: { adminUserId: number; volunteerId: number; reason: string }) {
  const response = await http.post<ApiEnvelope<unknown>>(`/dispatch/admin/orders/${orderId}/manual-assign`, {
    admin_user_id: payload.adminUserId,
    volunteer_id: payload.volunteerId,
    reason: payload.reason,
  })
  return response.data
}

export type ManualSosCandidate = {
  volunteer_id: number
  volunteer_name: string
  distance_km: number
  eta_minutes: number
  total_score: number
  skill_match: string
}

export async function startManualSosService(incidentId: number, adminUserId: number) {
  const response = await http.post<ApiEnvelope<{ order_id: number; candidates: ManualSosCandidate[] }>>(
    `/dispatch/admin/incidents/${incidentId}/start-manual-sos-service`,
    { admin_user_id: adminUserId },
  )
  return response.data
}

export async function fetchElderDispatchOrders(userId: number) {
  const response = await http.get<ApiEnvelope<DispatchOrder[]>>('/dispatch/elder/orders', { params: { user_id: userId } })
  return response.data.data
}

export async function fetchDispatchTracking(role: 'elder' | 'volunteer' | 'family' | 'admin', userId: number) {
  const response = await http.get<ApiEnvelope<DispatchTracking>>('/dispatch/tracking', { params: { role, user_id: userId } })
  return response.data.data
}

export async function updateElderDispatchLocation(payload: { userId: number; lng: number; lat: number; address?: string; source?: 'fixed_home' | 'browser_gps' | 'virtual' }) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/locations/elder', {
    user_id: payload.userId, lng: payload.lng, lat: payload.lat, address: payload.address, source: payload.source ?? 'fixed_home',
  })
  return response.data
}

export async function updateVolunteerDispatchLocation(payload: { volunteerId: number; lng: number; lat: number; source?: 'browser_gps' | 'virtual' }) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/locations/volunteer', {
    volunteer_id: payload.volunteerId, lng: payload.lng, lat: payload.lat, source: payload.source ?? 'virtual',
  })
  return response.data
}

export async function updateVolunteerDispatchPreferences(payload: { volunteerId: number; autoAcceptEnabled: boolean; homeLng?: number; homeLat?: number }) {
  const response = await http.post<ApiEnvelope<unknown>>('/dispatch/volunteer/preferences', {
    volunteer_id: payload.volunteerId, auto_accept_enabled: payload.autoAcceptEnabled, home_lng: payload.homeLng, home_lat: payload.homeLat,
  })
  return response.data
}

export async function createDispatchOrder(payload: {
  userId: number
  serviceType: string
  serviceHours?: number
  notes?: string
  urgent?: boolean
}) {
  const response = await http.post<ApiEnvelope<{ order_id: number }>>('/dispatch/orders', {
    user_id: payload.userId,
    service_type: payload.serviceType,
    service_hours: payload.serviceHours,
    notes: payload.notes,
    urgent: payload.urgent,
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

export async function fetchVolunteerDispatchFeed(volunteerId: number) {
  const response = await http.get<ApiEnvelope<{ tasks: VolunteerDispatchTask[]; completed_tasks: Array<{ order_id: number; service_type: string; elder_name: string; address?: string; completed_at?: string | null }>; state: { availability: string; fatigue_score: number; service_rating: number; assigned_today: number } }>>(
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
