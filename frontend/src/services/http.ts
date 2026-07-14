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
  timeout: 5000,
})

http.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error.response?.data?.message ?? error.message ?? '请求失败，请稍后重试'
    return Promise.reject(
      new HttpRequestError(message, error.response?.status, error.response?.data),
    )
  },
)
