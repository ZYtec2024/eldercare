export type NavigationMode = 'driving' | 'riding' | 'walking'

export interface DispatchRoute {
  order_id: number
  volunteer_id: number
  eta_minutes: number
  traffic_version: number
  replanned_at?: string
  path: Array<[number, number]>
  distance_km?: number
  remaining_distance_km?: number
  remaining_eta_minutes?: number
  progress?: number
  journey_type?: 'returning' | string
  journey_id?: string
  congested?: boolean
  traffic_segments?: Array<{ path: Array<[number, number]>; status: string }>
  motion_rate?: number
  navigation_mode?: NavigationMode
  geometry_source?: 'amap' | string
}

export interface DispatchOrder {
  order_id: number
  service_type: string
  status: string
  volunteer_id?: number | null
  volunteer_name?: string | null
  volunteer_availability?: string | null
  volunteer_rating?: number | null
  volunteer_skills?: string[]
  elder_name: string
  personality_bio?: string | null
  urgency: 'normal' | 'sos'
  dispatch_state: string
  search_stage: number
  dispatch_phase?: 'top1' | 'top3' | 'top10' | 'fallback' | string
  phase_expires_at?: string | null
  dispatch_version?: number
  forced_assignment: boolean
  created_at?: string
  service_time?: string | null
  lng?: number
  lat?: number
  eta_minutes?: number | null
  route?: DispatchRoute | null
  address?: string | null
  is_simulated?: boolean
  location_sharing_active?: boolean
  amap_marker_url?: string
  amap_navigation_url?: string
  proxy_created_by?: number | null
  proxy_creator_name?: string | null
  proxy_creator_role?: string | null
  proxy_family_name?: string | null
  proxy_reason?: string | null
}

export interface DispatchCandidate {
  order_id: number
  volunteer_id: number
  volunteer_name: string
  eligible: boolean
  skill_match: string
  distance_km?: number | null
  eta_minutes?: number | null
  distance_score?: number | null
  traffic_score?: number | null
  fatigue_score?: number | null
  rating_score?: number | null
  total_score?: number | null
  candidate_rank?: number | null
  response_status: string
  service_type: string
  search_stage: number
  dispatch_phase?: 'top1' | 'top3' | 'top10' | 'fallback' | string
  auto_accept_enabled?: boolean
}

export interface DispatchMapData {
  bounds: { west: number; east: number; south: number; north: number }
  region_adcode?: string
  region_name?: string
  grid_size: number
  traffic_version: number
  traffic_cells: Array<{ x: number; y: number; level: 'green' | 'yellow' | 'red'; weight: number }>
  volunteers: Array<{ volunteer_id: number; name: string; lng: number; lat: number; availability: string; fatigue: number; rating: number; assigned_today: number; skills: string[]; location_source?: string; home_lng?: number | null; home_lat?: number | null; auto_accept_enabled?: boolean }>
  elders: Array<{
    elder_id: number
    name: string
    lng: number
    lat: number
    address?: string
    default_address?: string
    default_label?: string
    default_lng?: number | null
    default_lat?: number | null
    location_source?: string
    is_home_fixed?: boolean
  }>
  orders: DispatchOrder[]
  routes: DispatchRoute[]
}

export interface DispatchOverview extends DispatchMapData {
  candidates: DispatchCandidate[]
  events: Array<{ event_id: number; order_id?: number | null; event_type: string; message: string; created_at?: string }>
  summary: { pending: number; assigned: number; sos: number; admin_watch: number; idle_volunteers: number }
  service_catalog: Array<{ code: string; label: string; skills: string[]; skill_labels: string[]; hours: number; urgent: boolean }>
  skill_options?: Array<{ code: string; label: string }>
}

export interface DispatchTracking extends DispatchMapData {
  service_catalog: DispatchOverview['service_catalog']
  skill_options?: Array<{ code: string; label: string }>
  privacy_message?: string
  return_route?: DispatchRoute
  next_assignment_preview?: {
    order_id: number
    elder_name: string
    service_type: string
    urgency: 'normal' | 'sos'
    address?: string
    distance_km: number
    eta_minutes: number
    total_score: number
    required_skill_labels: string[]
  }
  auto_assignment?: {
    order_id: number
    elder_name: string
    service_type: string
    address?: string
    urgency: 'normal' | 'sos'
    lng: number
    lat: number
  }
}

export interface VolunteerDispatchTask extends DispatchCandidate {
  status: string
  urgency: 'normal' | 'sos'
  forced_assignment: boolean
  elder_name: string
  personality_bio?: string | null
  /** Elder-written situation note, e.g. 腿脚不适. */
  notes?: string
  required_skills: string[]
  required_skill_labels: string[]
  route?: DispatchRoute | null
  lng?: number
  lat?: number
  address?: string
  amap_marker_url?: string
  amap_navigation_url?: string
  /** Exact elder pin is only present after accept. */
  location_unlocked?: boolean
}
