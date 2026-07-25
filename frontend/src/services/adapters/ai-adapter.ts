import { http, type ApiEnvelope } from '@/services/http'

export interface CompanionHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

export interface CompanionConfig {
  hasGroqApiKey: boolean
  groqChatModel: string
  groqTranscribeModel: string
  hasChatApiKey: boolean
  chatApiBaseUrl: string
  chatModelName: string
  ttsVoice: string
  ttsRate: string
  ttsVolume: string
  companionSystemPrompt: string
}

function decodeArrayBufferJson(buffer: ArrayBuffer) {
  const text = new TextDecoder('utf-8').decode(buffer)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function decodeBase64(base64: string) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function fetchCompanionConfig(adminUserId: number): Promise<CompanionConfig> {
  const response = await http.get<ApiEnvelope<CompanionConfig>>('/admin/ai-config', {
    params: { admin_user_id: adminUserId },
  })
  return response.data.data
}

export async function updateCompanionConfig(payload: {
  adminUserId: number
  groqApiKey?: string
  groqChatModel: string
  groqTranscribeModel: string
  chatApiKey?: string
  chatApiBaseUrl: string
  chatModelName: string
  ttsVoice: string
  ttsRate: string
  ttsVolume: string
  companionSystemPrompt: string
}) {
  const response = await http.put<ApiEnvelope<CompanionConfig>>('/admin/ai-config', {
    admin_user_id: payload.adminUserId,
    groq_api_key: payload.groqApiKey,
    groq_chat_model: payload.groqChatModel,
    groq_transcribe_model: payload.groqTranscribeModel,
    chat_api_key: payload.chatApiKey,
    chat_api_base_url: payload.chatApiBaseUrl,
    chat_model_name: payload.chatModelName,
    tts_voice: payload.ttsVoice,
    tts_rate: payload.ttsRate,
    tts_volume: payload.ttsVolume,
    companion_system_prompt: payload.companionSystemPrompt,
  })
  return response.data.data
}

export async function sendCompanionChat(payload: {
  userId: number
  message: string
  history?: CompanionHistoryItem[]
}) {
  const response = await http.post<ApiEnvelope<{ reply: string; model?: string }>>('/elder/companion/chat', {
    user_id: payload.userId,
    message: payload.message,
    history: payload.history ?? [],
  })
  return response.data.data
}

export async function transcribeCompanionAudio(userId: number, audio: Blob) {
  const formData = new FormData()
  formData.append('user_id', String(userId))
  formData.append('audio', audio, 'companion.webm')
  const response = await http.post<ArrayBuffer>('/elder/companion/transcribe', formData, {
    responseType: 'arraybuffer',
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })

  const contentType = String(response.headers?.['content-type'] || '')
  if (contentType.includes('application/json')) {
    const parsed = decodeArrayBufferJson(response.data)
    const data = parsed?.data && typeof parsed.data === 'object'
      ? parsed.data as Record<string, unknown>
      : parsed ?? {}
    return String(data.text ?? data.transcript ?? '')
  }

  return ''
}

export async function synthesizeCompanionSpeech(text: string, userId?: number) {
  const response = await http.post<ArrayBuffer>('/elder/companion/tts', {
    user_id: userId,
    text,
  }, {
    responseType: 'arraybuffer',
  })

  const contentType = String(response.headers?.['content-type'] || '')
  if (contentType.includes('application/json')) {
    const parsed = decodeArrayBufferJson(response.data)
    const data = parsed?.data && typeof parsed.data === 'object'
      ? parsed.data as Record<string, unknown>
      : parsed ?? {}
    const base64 = String(data.audio_base64 ?? data.audioBase64 ?? '')
    const mimeType = String(data.mime_type ?? data.mimeType ?? 'audio/mpeg')
    const bytes = decodeBase64(base64)
    return new Blob([bytes], { type: mimeType })
  }

  return new Blob([response.data], { type: contentType || 'audio/mpeg' })
}