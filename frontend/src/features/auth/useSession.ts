import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'

import {
  loginWithCredentials,
  logoutSession,
  restoreSession,
} from '@/services/adapters/auth-adapter'
import type { LoginPayload, SessionUser } from '@/types/domain'
import { SESSION_EXPIRED_EVENT } from '@/services/http'
import {
  clearStoredSession,
  consumeStoredRedirectPath,
  getStoredRedirectPath,
  getStoredSession,
  setStoredRedirectPath,
  setStoredSession,
} from './session-store'

interface SessionContextValue {
  session: SessionUser | null
  isHydrated: boolean
  login: (input: LoginPayload) => Promise<SessionUser>
  logout: () => void
  patchSession: (patch: Partial<SessionUser>) => void
  updateLastVisitedRoute: (path: string) => void
  rememberRedirectPath: (path: string) => void
  getRedirectPath: () => string | null
  consumeRedirectPath: () => string | null
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: React.PropsWithChildren) {
  const [session, setSession] = useState<SessionUser | null>(null)
  const [isHydrated, setIsHydrated] = useState(() => {
    if (typeof window === 'undefined') {
      return true
    }

    return getStoredSession() === null
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const stored = getStoredSession()
    if (!stored) {
      return
    }

    let active = true

    restoreSession(stored)
      .then((restoredSession) => {
        if (!active) {
          return
        }

        setStoredSession(restoredSession)
        setSession(restoredSession)
      })
      .catch(() => {
        if (!active) {
          return
        }

        clearStoredSession()
        setSession(null)
      })
      .finally(() => {
        if (active) {
          setIsHydrated(true)
        }
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const handleExpiredSession = () => {
      clearStoredSession()
      setSession(null)
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpiredSession)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpiredSession)
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      isHydrated,
      async login(input) {
        const nextSession = await loginWithCredentials(input)
        setStoredSession(nextSession)
        setSession(nextSession)
        return nextSession
      },
      logout() {
        void logoutSession().catch(() => undefined)
        clearStoredSession()
        setSession(null)
      },
      patchSession(patch) {
        if (!session) {
          return
        }

        const nextSession = { ...session, ...patch }
        setStoredSession(nextSession)
        setSession(nextSession)
      },
      updateLastVisitedRoute(path) {
        if (!session || session.lastVisitedRoute === path) {
          return
        }

        const nextSession = { ...session, lastVisitedRoute: path }
        setStoredSession(nextSession)
        setSession(nextSession)
      },
      rememberRedirectPath(path) {
        if (!path || !path.startsWith('/')) {
          return
        }

        setStoredRedirectPath(path)
      },
      getRedirectPath() {
        return getStoredRedirectPath()
      },
      consumeRedirectPath() {
        return consumeStoredRedirectPath()
      },
    }),
    [isHydrated, session],
  )

  return React.createElement(SessionContext.Provider, { value }, children)
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession must be used within SessionProvider')
  }

  return context
}
