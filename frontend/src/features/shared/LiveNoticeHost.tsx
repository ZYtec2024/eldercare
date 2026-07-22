import { useEffect, useRef } from 'react'
import { App, Button } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { dismissLiveNotice, fetchLiveNotices, type LiveNotice } from '@/services/adapters/live-notice-adapter'

const DISMISS_KEY = 'eldercare.liveNotice.dismissed'

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(keys: Set<string>) {
  sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...keys].slice(-80)))
}

/**
 * WeChat-like sticky toasts for SOS / capacity events across roles.
 * Mount once inside AppShell; dismissible via the close icon.
 * Re-fetches when the route changes so opening a page can surface unread tips.
 */
export function LiveNoticeHost() {
  const { session } = useSession()
  const { notification } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const shownRef = useRef<Set<string>>(new Set())
  const dismissedRef = useRef<Set<string>>(loadDismissed())

  useEffect(() => {
    if (!session?.userId) return
    let cancelled = false

    const showNotice = (item: LiveNotice) => {
      if (cancelled) return
      if (dismissedRef.current.has(item.notice_key)) return
      if (shownRef.current.has(item.notice_key)) return
      shownRef.current.add(item.notice_key)

      const type = item.level === 'error' ? 'error' : item.level === 'success' ? 'success' : 'warning'
      notification[type]({
        key: item.notice_key,
        message: item.title,
        description: (
          <div className="space-y-2">
            <div>{item.body}</div>
            {item.action_path ? (
              <Button
                type="link"
                className="!px-0"
                onClick={() => {
                  navigate(item.action_path!)
                  notification.destroy(item.notice_key)
                }}
              >
                去查看
              </Button>
            ) : null}
          </div>
        ),
        placement: 'topRight',
        duration: 0,
        onClose: () => {
          dismissedRef.current.add(item.notice_key)
          saveDismissed(dismissedRef.current)
          shownRef.current.delete(item.notice_key)
          if (item.notification_id && session?.userId) {
            void dismissLiveNotice(session.userId, item.notification_id).catch(() => {})
          }
        },
      })
    }

    const poll = async () => {
      try {
        const notices = await fetchLiveNotices(session.userId)
        if (cancelled) return
        const activeKeys = new Set(notices.map((item) => item.notice_key))
        for (const key of [...shownRef.current]) {
          if (!activeKeys.has(key) && !dismissedRef.current.has(key)) {
            notification.destroy(key)
            shownRef.current.delete(key)
          }
        }
        notices.forEach(showNotice)
      } catch {
        // Silent: toast host should not interrupt the page.
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session?.userId, notification, navigate, location.pathname])

  return null
}
