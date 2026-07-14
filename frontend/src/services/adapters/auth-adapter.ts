import { getDefaultRoute } from '@/routes/role-defaults'
import { http, type ApiEnvelope } from '@/services/http'
import type {
  LoginPayload,
  PasswordResetPayload,
  RegisterPayload,
  ReviewState,
  Role,
  SessionUser,
} from '@/types/domain'

interface LoginResponseData {
  user_id: number
  username: string
  role: Role
  real_name: string
  email?: string
  review_status?: ReviewState
}

function buildSessionUser(data: LoginResponseData): SessionUser {
  return {
    userId: data.user_id,
    username: data.username,
    role: data.role,
    displayName: data.real_name,
    email: data.email,
    tokenState: 'active',
    reviewState: data.review_status ?? 'none',
    lastVisitedRoute: getDefaultRoute(data.role),
  }
}

export async function registerAccount(payload: RegisterPayload) {
  const response = await http.post<ApiEnvelope<{ user_id: number }>>(
    '/auth/register',
    {
      username: payload.username,
      password: payload.password,
      role: payload.role,
      real_name: payload.realName,
      phone: payload.phone,
      email: payload.email,
      age: payload.age,
      gender: payload.gender,
      address: payload.address,
      id_card: payload.idCard,
      skills: payload.skills,
      invite_code: payload.inviteCode,
    },
  )

  return response.data
}

export async function loginWithCredentials(payload: LoginPayload) {
  const response = await http.post<ApiEnvelope<LoginResponseData>>('/auth/login', {
    username: payload.username,
    password: payload.password,
  })

  return buildSessionUser(response.data.data)
}

export async function resetPassword(payload: PasswordResetPayload) {
  const response = await http.post<ApiEnvelope<null>>('/auth/forgot-password', {
    username: payload.username,
    phone: payload.phone,
    new_password: payload.newPassword,
  })

  return response.data
}

export async function restoreSession(session: SessionUser) {
  return Promise.resolve(session)
}

export async function changePassword(payload: {
  userId: number
  oldPassword: string
  newPassword: string
}) {
  const response = await http.post<ApiEnvelope<null>>('/auth/change-password', {
    user_id: payload.userId,
    old_password: payload.oldPassword,
    new_password: payload.newPassword,
  })

  return response.data
}
