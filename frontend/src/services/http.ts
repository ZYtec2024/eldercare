import axios from 'axios'

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
    const message =
      error.response?.data?.message ?? error.message ?? '请求失败，请稍后重试'
    return Promise.reject(
      new HttpRequestError(message, error.response?.status, error.response?.data),
    )
  },
)
