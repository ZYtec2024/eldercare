import { http, type ApiEnvelope } from '@/services/http'
import type { ProfileSnapshot, Role } from '@/types/domain'

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
