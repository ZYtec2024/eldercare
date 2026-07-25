import { http, type ApiEnvelope } from '@/services/http'
import type { VolunteerProfile, VolunteerTaskCard } from '@/types/domain'

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseAwards(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }

  if (typeof value !== 'string') {
    return []
  }

  return value
    .split(/\n|；|;|,|，/g)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeProfile(record: Record<string, unknown>): VolunteerProfile {
  return {
    rank: toNumber(record.rank ?? record.leaderboardRank),
    leaderboardRank: toNumber(record.leaderboardRank ?? record.rank),
    userId: toNumber(record.userId ?? record.user_id),
    realName: typeof record.realName === 'string' ? record.realName : typeof record.real_name === 'string' ? record.real_name : undefined,
    completedCount: toNumber(record.completedCount ?? record.completed_count),
    totalHours: toNumber(record.totalHours ?? record.total_hours),
    weeklyHours: toNumber(record.weeklyHours ?? record.weekly_hours),
    likesCount: toNumber(record.likesCount ?? record.likes_count),
    awards: parseAwards(record.awards),
    badges: Array.isArray(record.badges)
      ? record.badges.filter((badge): badge is string => typeof badge === 'string')
      : undefined,
  }
}

function normalizeTask(item: Record<string, unknown>): VolunteerTaskCard {
  return {
    orderId: toNumber(item.orderId ?? item.order_id),
    serviceType: String(item.serviceType ?? item.service_type ?? ''),
    scheduledTime: String(item.scheduledTime ?? item.service_time ?? ''),
    addressPreview: String(item.addressPreview ?? item.address_preview ?? item.address ?? '地址待补充'),
    serviceHours: toNumber(item.serviceHours ?? item.service_hours, 1),
    rewardPoints: typeof item.rewardPoints === 'number' ? item.rewardPoints : undefined,
    urgencyLevel: String(item.urgencyLevel ?? 'medium') as VolunteerTaskCard['urgencyLevel'],
    elderName: typeof item.elderName === 'string' ? item.elderName : undefined,
    personalityBio: typeof item.personality_bio === 'string' && item.personality_bio
      ? item.personality_bio
      : (typeof item.personalityBio === 'string' ? item.personalityBio : undefined),
    status: String(item.status ?? 'pending') as VolunteerTaskCard['status'],
    availableActions: Array.isArray(item.availableActions)
      ? (item.availableActions.filter((action): action is 'accept' | 'start' | 'complete' | 'cancel' =>
          action === 'accept' || action === 'start' || action === 'complete' || action === 'cancel',
        ) as Array<'accept' | 'start' | 'complete' | 'cancel'>)
      : [],
  }
}

export async function fetchVolunteerTasks(volunteerId?: number) {
  const response = await http.get<ApiEnvelope<VolunteerTaskCard[]>>(
    '/volunteer/orders/available',
    {
      params: volunteerId ? { volunteer_id: volunteerId } : undefined,
    },
  )
  return Array.isArray(response.data.data)
    ? response.data.data.map((item) => normalizeTask(item as unknown as Record<string, unknown>))
    : []
}

export async function fetchVolunteerTaskDetail(taskId: number, volunteerId?: number) {
  const response = await http.get<ApiEnvelope<VolunteerTaskCard>>(
    `/volunteer/orders/available/${taskId}`,
    {
      params: volunteerId ? { volunteer_id: volunteerId } : undefined,
    },
  )
  return normalizeTask(response.data.data as unknown as Record<string, unknown>)
}

export async function grabVolunteerTask(taskId: number, volunteerId = 302) {
  const response = await http.post<ApiEnvelope<{ status: string }>>(
    '/volunteer/orders/grab',
    {
      order_id: taskId,
      volunteer_id: volunteerId,
    },
  )
  return response.data
}

export async function updateVolunteerTaskAction(
  taskId: number,
  action: 'accept' | 'start' | 'complete' | 'cancel',
  volunteerId?: number,
  actualHours?: number,
) {
  if (action === 'accept') {
    const result = await grabVolunteerTask(taskId, volunteerId)
    const task = await fetchVolunteerTaskDetail(taskId, volunteerId)
    return {
      message: result.message,
      task,
    }
  }

  const response = await http.post<
    ApiEnvelope<{ status: string; total_hours?: number; weekly_hours?: number }>
  >('/volunteer/orders/update-status', {
    order_id: taskId,
    action,
    volunteer_id: volunteerId,
    actual_hours: actualHours,
  })

  let task: VolunteerTaskCard
  try {
    task = await fetchVolunteerTaskDetail(taskId, volunteerId)
  } catch {
    task = {
      orderId: taskId,
      serviceType: '',
      scheduledTime: '',
      addressPreview: '地址待补充',
      serviceHours: 0,
      urgencyLevel: 'medium',
      status: action === 'cancel' ? 'pending' : action === 'start' ? 'in_progress' : 'completed',
      availableActions: [],
    }
  }

  return {
    message: response.data.message,
    task,
  }
}

export async function likeVolunteer(fromUserId: number, toVolunteerId: number) {
  const response = await http.post<ApiEnvelope<null>>('/volunteer/like', {
    from_user_id: fromUserId,
    to_volunteer_id: toVolunteerId,
  })

  return response.data
}

export async function submitVolunteerAwardRequest(payload: {
  volunteerId: number
  awardTitle: string
  reason?: string
}) {
  const response = await http.post<ApiEnvelope<null>>('/volunteer/awards/request', {
    volunteer_id: payload.volunteerId,
    award_title: payload.awardTitle,
    reason: payload.reason ?? '',
  })

  return response.data
}

export async function fetchVolunteerProfile(volunteerId = 302) {
  const response = await http.get<ApiEnvelope<VolunteerProfile>>(
    `/volunteer/profile/summary`,
    {
      params: { volunteer_id: volunteerId },
    },
  )
  return normalizeProfile(response.data.data as unknown as Record<string, unknown>)
}

export async function fetchVolunteerLeaderboard(options?: {
  adminUserId?: number
  viewerUserId?: number
  regionAdcode?: string
  provinceName?: string
  cityName?: string
}) {
  const response = await http.get<ApiEnvelope<Array<Record<string, unknown>> | VolunteerProfile[]>>(
    '/volunteer/leaderboard', {
      params: {
        admin_user_id: options?.adminUserId,
        viewer_user_id: options?.viewerUserId,
        region_adcode: options?.regionAdcode,
        province_name: options?.provinceName,
        city_name: options?.cityName,
      },
    },
  )

  const list = response.data.data
  if (!Array.isArray(list)) {
    return []
  }

  return list.map((item, index) => {
    const record = item as Record<string, unknown>
    return {
      ...normalizeProfile(record),
      rank: toNumber(record.rank ?? record.leaderboardRank, index + 1),
      leaderboardRank: toNumber(record.leaderboardRank ?? record.rank, index + 1),
    } satisfies VolunteerProfile
  })
}

export interface VolunteerReview {
  orderId: number
  serviceType: string
  elderName?: string
  serviceTime: string
  rating: number
  comment: string
}

function normalizeReview(item: Record<string, unknown>): VolunteerReview {
  return {
    orderId: toNumber(item.orderId ?? item.order_id),
    serviceType: String(item.serviceType ?? item.service_type ?? ''),
    elderName: typeof item.elderName === 'string' ? item.elderName : typeof item.elder_name === 'string' ? item.elder_name : undefined,
    serviceTime: String(item.serviceTime ?? item.service_time ?? ''),
    rating: toNumber(item.rating, 0),
    comment: String(item.comment ?? ''),
  }
}

export async function fetchMyTasks(volunteerId?: number) {
  const response = await http.get<ApiEnvelope<VolunteerTaskCard[]>>(
    '/volunteer/my-tasks',
    {
      params: volunteerId ? { volunteer_id: volunteerId } : undefined,
    },
  )
  const list = Array.isArray(response.data.data) ? response.data.data : []
  return list.map((item) => normalizeTask(item as unknown as Record<string, unknown>))
}

export async function fetchMyReviews(volunteerId?: number) {
  const response = await http.get<ApiEnvelope<VolunteerReview[]>>(
    '/volunteer/my-reviews',
    {
      params: volunteerId ? { volunteer_id: volunteerId } : undefined,
    },
  )
  const list = Array.isArray(response.data.data) ? response.data.data : []
  return list.map((item) => normalizeReview(item as unknown as Record<string, unknown>))
}
