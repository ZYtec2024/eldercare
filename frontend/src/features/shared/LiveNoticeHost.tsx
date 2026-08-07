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

function solidTone(level: LiveNotice['level']) {
  if (level === 'error') {
    return {
      className: 'live-notice-toast live-notice-toast--error',
      dot: '#ef4444',
    }
  }
  if (level === 'success') {
    return {
      className: 'live-notice-toast live-notice-toast--success',
      dot: '#10b981',
    }
  }
  return {
    className: 'live-notice-toast live-notice-toast--warning',
    dot: '#f59e0b',
  }
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

      const tone = solidTone(item.level)
      notification.open({
        key: item.notice_key,
        // White card + left color dot; no check / cross glyph.
        icon: <span className="live-notice-dot" style={{ background: tone.dot }} />,
        className: tone.className,
        style: {
          background: '#ffffff',
          borderRadius: 12,
          padding: '14px 16px',
          boxShadow: '0 10px 28px rgba(15, 23, 42, 0.14)',
          border: '1px solid #e2e8f0',
        },
        styles: {
          root: {
            background: '#ffffff',
            borderRadius: 12,
          },
        },
        message: <span style={{ color: '#0f172a', fontWeight: 700 }}>{item.title}</span>,
        description: (
          <div className="space-y-2" style={{ color: '#334155' }}>
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
        closeIcon: <span className="live-notice-close-x" style={{ color: '#0f172a', fontSize: 18, fontWeight: 700, lineHeight: 1 }}>×</span>,
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
