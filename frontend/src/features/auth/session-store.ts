import type { SessionUser } from '@/types/domain'

export const SESSION_STORAGE_KEY = 'eldercare.portal.session'
export const REDIRECT_STORAGE_KEY = 'eldercare.portal.redirect'

function canUseSessionStorage() {
  return typeof window !== 'undefined'
}

export function getStoredSession(): SessionUser | null {
  if (!canUseSessionStorage()) {
    return null
  }

  const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as SessionUser
  } catch {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
    return null
  }
}

export function setStoredSession(session: SessionUser) {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredSession() {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
}

export function getStoredRedirectPath() {
  if (!canUseSessionStorage()) {
    return null
  }

  return window.sessionStorage.getItem(REDIRECT_STORAGE_KEY)
}

export function setStoredRedirectPath(path: string) {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.setItem(REDIRECT_STORAGE_KEY, path)
}

export function clearStoredRedirectPath() {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.removeItem(REDIRECT_STORAGE_KEY)
}

export function consumeStoredRedirectPath() {
  const path = getStoredRedirectPath()
  clearStoredRedirectPath()
  return path
}
