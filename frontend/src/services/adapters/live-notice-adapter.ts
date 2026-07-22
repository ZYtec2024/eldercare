import { http, type ApiEnvelope } from '@/services/http'

export type LiveNotice = {
  notice_key: string
  title: string
  body: string
  level: 'error' | 'warning' | 'success' | 'info' | string
  action_path?: string | null
  notification_id?: number | null
}

export async function fetchLiveNotices(userId: number) {
  const response = await http.get<ApiEnvelope<{ notices: LiveNotice[] }>>('/dispatch/live-notices', {
    params: { user_id: userId },
  })
  return response.data.data?.notices || []
}

export async function dismissLiveNotice(userId: number, notificationId: number) {
  const response = await http.post<ApiEnvelope<null>>('/dispatch/live-notices/dismiss', {
    user_id: userId,
    notification_id: notificationId,
  })
  return response.data
}
