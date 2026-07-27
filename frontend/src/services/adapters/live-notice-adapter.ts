import { http, type ApiEnvelope } from '@/services/http'

export type LiveNotice = {
  notice_key: string
  title: string
  body: string
  level: 'error' | 'warning' | 'success' | 'info' | string
  action_path?: string | null
  notification_id?: number | null
  alert_id?: number | null
  is_read?: boolean
  created_at?: string | null
}

export async function fetchLiveNotices(userId: number, includeReadHealth = false) {
  const response = await http.get<ApiEnvelope<{ notices: LiveNotice[] }>>('/dispatch/live-notices', {
    params: {
      user_id: userId,
      include_read_health: includeReadHealth ? 1 : undefined,
    },
  })
  return response.data.data?.notices || []
}

export async function dismissLiveNotice(
  userId: number,
  notificationId?: number | null,
  alertId?: number | null,
  deleteHealthNotice = false,
) {
  const response = await http.post<ApiEnvelope<null>>('/dispatch/live-notices/dismiss', {
    user_id: userId,
    notification_id: notificationId,
    alert_id: alertId,
    delete_health_notice: deleteHealthNotice,
  })
  return response.data
}
