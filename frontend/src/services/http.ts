import axios from 'axios'

import { getStoredSession } from '@/features/auth/session-store'

export const SESSION_EXPIRED_EVENT = 'eldercare:session-expired'

export interface ApiEnvelope<T> {
  code: number
  message: string
  data: T
}

export class HttpRequestError extends Error {
  status?: number
  payload?: unknown

  constructor(message: string, status?: number, payload?: unknown) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = status
    this.payload = payload
  }
}

export const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
  withCredentials: true,
})

http.interceptors.request.use((config) => {
  const portalToken = getStoredSession()?.portalToken
  if (portalToken) {
    config.headers.set('X-Portal-Session', portalToken)
  }
  return config
})

http.interceptors.response.use(
  (response) => {
    const payload = response.data as ApiEnvelope<unknown> | undefined
    // Backend sometimes returns HTTP 200 with business code != 200.
    if (
      payload
      && typeof payload === 'object'
      && 'code' in payload
      && payload.code != null
      && Number(payload.code) !== 200
    ) {
      return Promise.reject(
        new HttpRequestError(
          String(payload.message || '请求失败，请稍后重试'),
          Number(payload.code),
          payload,
        ),
      )
    }
    return response
  },
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    }
    const message =
      error.response?.data?.message ?? error.message ?? '请求失败，请稍后重试'
    return Promise.reject(
      new HttpRequestError(message, error.response?.status, error.response?.data),
    )
  },
)
