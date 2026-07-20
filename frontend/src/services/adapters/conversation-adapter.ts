import { http, type ApiEnvelope } from '@/services/http'

export interface ConversationSummary {
  conversation_id: number
  conversation_type: 'service' | 'sos' | string
  status: 'active' | 'closed' | string
  order_id?: number | null
  incident_id?: number | null
  elder_name?: string | null
  service_type?: string | null
  last_message?: string | null
  last_message_at?: string | null
  unread_count?: number
}

export interface ConversationMessage {
  message_id: number
  sender_user_id: number
  sender_name?: string | null
  message_type: 'text' | 'quick_status' | 'system' | string
  content: string
  created_at?: string | null
}

export async function fetchConversations(userId: number) {
  const response = await http.get<ApiEnvelope<ConversationSummary[]>>('/conversations', { params: { user_id: userId } })
  return response.data.data
}

export async function fetchConversationMessages(conversationId: number, userId: number) {
  const response = await http.get<ApiEnvelope<ConversationMessage[]>>(`/conversations/${conversationId}/messages`, { params: { user_id: userId } })
  return response.data.data
}

export async function sendConversationMessage(conversationId: number, payload: { userId: number; content: string; type?: 'text' | 'quick_status' }) {
  const response = await http.post<ApiEnvelope<unknown>>(`/conversations/${conversationId}/messages`, {
    user_id: payload.userId,
    content: payload.content,
    message_type: payload.type ?? 'text',
  })
  return response.data
}
