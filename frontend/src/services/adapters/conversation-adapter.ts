import { http, type ApiEnvelope } from '@/services/http'

export interface ConversationParticipant {
  user_id: number
  name: string
  role: string
  role_label: string
  display_label: string
  can_speak: boolean
  is_root_admin?: boolean
}

export interface ConversationSummary {
  conversation_id: number
  conversation_type: 'service' | 'sos' | string
  status: 'active' | 'archived' | 'closed' | string
  order_id?: number | null
  incident_id?: number | null
  elder_name?: string | null
  service_type?: string | null
  order_status?: string | null
  order_address?: string | null
  volunteer_id?: number | null
  volunteer_name?: string | null
  title?: string | null
  thread_code?: string | null
  participant_subtitle?: string | null
  member_guide?: string | null
  upgraded_to_sos?: boolean
  participants?: ConversationParticipant[]
  last_message?: string | null
  last_message_at?: string | null
  unread_count?: number
  my_can_speak?: boolean
  can_hide?: boolean
}

export interface ConversationMessage {
  message_id: number
  sender_user_id: number
  sender_name?: string | null
  message_type: 'text' | 'quick_status' | 'system' | string
  content: string
  created_at?: string | null
}

export interface ConversationThread {
  messages: ConversationMessage[]
  participants: ConversationParticipant[]
  participant_subtitle?: string
  member_guide?: string
  thread_code?: string
  title?: string
  upgraded_to_sos?: boolean
  conversation_type?: string
  status?: string
  order_id?: number | null
  elder_name?: string | null
  service_type?: string | null
  order_status?: string | null
  my_can_speak?: boolean
  can_hide?: boolean
}

export async function fetchConversations(userId: number) {
  const response = await http.get<ApiEnvelope<ConversationSummary[]>>('/conversations', { params: { user_id: userId } })
  const rows = response.data.data
  return Array.isArray(rows) ? rows : []
}

export async function fetchConversationMessages(conversationId: number, userId: number) {
  const response = await http.get<ApiEnvelope<ConversationMessage[] | ConversationThread>>(
    `/conversations/${conversationId}/messages`,
    { params: { user_id: userId } },
  )
  const payload = response.data.data as any
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.messages)) return payload.messages
  return []
}

export async function fetchConversationThread(conversationId: number, userId: number): Promise<ConversationThread> {
  const response = await http.get<ApiEnvelope<ConversationMessage[] | ConversationThread>>(
    `/conversations/${conversationId}/messages`,
    { params: { user_id: userId } },
  )
  const payload = response.data.data as any
  if (Array.isArray(payload)) {
    return { messages: payload, participants: [], my_can_speak: true, can_hide: false }
  }
  return {
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    participants: Array.isArray(payload?.participants) ? payload.participants : [],
    participant_subtitle: payload?.participant_subtitle ?? payload?.participantSubtitle,
    member_guide: payload?.member_guide ?? payload?.memberGuide,
    thread_code: payload?.thread_code ?? payload?.threadCode,
    title: payload?.title,
    upgraded_to_sos: Boolean(payload?.upgraded_to_sos ?? payload?.upgradedToSos),
    conversation_type: payload?.conversation_type ?? payload?.conversationType,
    status: payload?.status,
    order_id: payload?.order_id ?? payload?.orderId,
    elder_name: payload?.elder_name ?? payload?.elderName,
    service_type: payload?.service_type ?? payload?.serviceType,
    order_status: payload?.order_status ?? payload?.orderStatus,
    my_can_speak: (payload?.my_can_speak ?? payload?.myCanSpeak) !== false,
    can_hide: Boolean(payload?.can_hide ?? payload?.canHide),
  }
}

export async function sendConversationMessage(conversationId: number, payload: { userId: number; content: string; type?: 'text' | 'quick_status' }) {
  const response = await http.post<ApiEnvelope<unknown>>(`/conversations/${conversationId}/messages`, {
    user_id: payload.userId,
    content: payload.content,
    message_type: payload.type ?? 'text',
  })
  return response.data
}

export async function hideConversation(conversationId: number, userId: number) {
  const response = await http.post<ApiEnvelope<unknown>>(`/conversations/${conversationId}/hide`, {
    user_id: userId,
  })
  return response.data
}
