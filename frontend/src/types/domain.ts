export type Role = 'family' | 'elder' | 'volunteer' | 'admin'

export type TokenState = 'missing' | 'active' | 'expired'
export type ReviewState = 'none' | 'pending_review' | 'rejected' | 'approved'
export type AccountStatus =
  | 'active'
  | 'pending_review'
  | 'rejected'
  | 'archived'

export type AsyncStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'status_blocked'

export type RiskLevel = 'normal' | 'attention' | 'urgent'

export type ServiceStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'unavailable'

export interface SessionUser {
  userId: number
  username: string
  role: Role
  displayName: string
  email?: string
  tokenState: TokenState
  reviewState: ReviewState
  lastVisitedRoute: string
}

export interface NavigationItem {
  key: string
  label: string
  path: string
  allowedRoles: Role[]
  description: string
}

export interface RoleWorkspace {
  role: Role
  defaultRoute: string
  navigationItems: NavigationItem[]
  homeActions: Array<{
    label: string
    path: string
    description: string
  }>
  permissionMessage: string
}

export interface ElderSummary {
  elderId: number
  name: string
  age: number
  gender?: string
  addressPreview: string
  relationType: string
  relationLabel?: string
  riskLevel: RiskLevel
  pendingServiceCount: number
  latestAlertSummary?: string
  latestSosStatus?: string
  latestCheckinAt?: string
}

export interface HealthTrendSnapshot {
  elderId: number
  dateRange: string[]
  systolicSeries: number[]
  diastolicSeries: number[]
  heartRateSeries: number[]
  bloodOxygenSeries?: Array<number | null>
  bloodSugarSeries?: Array<number | null>
  temperatureSeries?: Array<number | null>
  weightSeries?: Array<number | null>
  abnormalFlag: boolean
  annotationText: string
}

export interface ServiceRequestDraft {
  familyUserId?: number
  elderId: number
  serviceType: string
  serviceTime: string
  serviceHours: number
  address?: string
  notes: string
}

export interface ServiceRequestCard extends ServiceRequestDraft {
  requestId: number
  status: ServiceStatus
  elderName?: string
  assignedVolunteerId?: number
  assignedVolunteerName?: string
  hourReviewStatus?: 'pending_family' | 'pending_admin' | 'approved' | 'rejected'
  hourReviewApprovedHours?: number | null
}

export interface PendingService {
  orderId: number
  serviceType: string
  time: string
  volunteerId?: number
  volunteerName?: string
  status: ServiceStatus
  canReview?: boolean
  reviewSubmitted?: boolean
}

export interface CheckInPayload {
  userId?: number
  bloodPressureSys?: number
  bloodPressureDia?: number
  heartRate?: number
  bloodOxygen?: number
  bloodSugar?: number
  temperature?: number
  weight?: number
  notes?: string
}

export interface VolunteerTaskCard {
  orderId: number
  serviceType: string
  scheduledTime: string
  addressPreview: string
  serviceHours: number
  rewardPoints?: number
  urgencyLevel: 'low' | 'medium' | 'high'
  elderName?: string
  status: Extract<
    ServiceStatus,
    'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'unavailable'
  >
  availableActions: Array<'accept' | 'start' | 'complete' | 'cancel'>
}

export interface VolunteerProfile {
  rank: number
  leaderboardRank?: number
  userId?: number
  realName?: string
  completedCount: number
  totalHours: number
  weeklyHours: number
  likesCount: number
  awards: string[]
  badges?: string[]
}

export interface AlertItem {
  alertId: number
  category: 'sos' | 'health_abnormal'
  priority: 'high' | 'medium' | 'low'
  createdAt: string
  status: 'new' | 'acknowledged' | 'dispatching' | 'handled'
  sourceLabel: string
  linkedEntityId: number
  resolutionSummary?: string
  incidentId?: number | null
  incidentStatus?: 'reported' | 'acknowledged' | 'dispatching' | 'resolved' | string | null
  conversationId?: number | null
  linkedOrderId?: number | null
  linkedOrderStatus?: string | null
  linkedVolunteerName?: string | null
  acknowledgedAt?: string
  resolvedAt?: string
}

export interface DashboardMetric {
  metricId: string
  label: string
  value: number
  comparisonText: string
  visualType: 'stat' | 'bar' | 'pie'
  datasetPreview: Array<{
    label: string
    value: number
  }>
}

export interface AdminUserRow {
  userId: number
  username: string
  role: Role
  name: string
  phone: string
  email?: string
  status: AccountStatus
  regionAdcodes?: string[]
  regionNames?: string[]
  address?: string
  relatedElders?: Array<{
    elderId: number
    name: string
    regionAdcode?: string
    regionName?: string
  }>
}

export interface HourReviewItem {
  reviewId: number
  orderId: number
  volunteerId: number
  volunteerName: string
  familyUserId: number
  familyName: string
  serviceType: string
  serviceTime: string
  expectedHours: number
  declaredHours: number
  maxAutoHours: number
  reviewStatus: 'pending_admin' | 'approved' | 'rejected' | 'pending_family'
  approvedHours?: number | null
  reviewNote?: string
  createdAt?: string
  reviewedAt?: string
}

export interface AwardRequestItem {
  requestId: number
  volunteerId: number
  volunteerName: string
  awardTitle: string
  reason?: string
  status: 'pending' | 'approved' | 'rejected'
  reviewNote?: string
  createdAt?: string
  reviewedAt?: string
}

export interface UIStateEnvelope {
  status: AsyncStatus
  message?: string
  retryActionLabel?: string
  lastUpdatedAt?: string
}

export interface HealthKnowledgeEntry {
  entryId: string
  metricType:
    | 'blood_pressure'
    | 'blood_oxygen'
    | 'blood_sugar'
    | 'temperature'
    | 'weight'
    | 'heart_rate'
  title: string
  normalRangeText: string
  summary: string
  careTips: string[]
}

export interface ProfileSnapshot {
  accountId: number
  role: Role
  realName: string
  phone: string
  email: string
  medicalHistory?: string
  alertSysThreshold?: number
  skills?: string
  totalHours?: number
  weeklyHours?: number
  awards?: string[]
  likesCount?: number
}

export interface RegisterPayload {
  username: string
  password: string
  role: Exclude<Role, 'admin'> | 'admin'
  realName: string
  phone: string
  email: string
  age?: number
  gender?: string
  address?: string
  idCard?: string
  skills?: string
  inviteCode?: string
}

export interface LoginPayload {
  username: string
  password: string
}

export interface PasswordResetPayload {
  username: string
  phone: string
  newPassword: string
}

export const roleLabels: Record<Role, string> = {
  family: '家属',
  elder: '老人',
  volunteer: '志愿者',
  admin: '管理员',
}
