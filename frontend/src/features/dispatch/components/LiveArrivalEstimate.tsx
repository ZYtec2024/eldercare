import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ClockCircleOutlined, EnvironmentOutlined } from '@ant-design/icons'

import type { DispatchRoute } from '../dispatch-types'
import { formatNavDistance } from './DispatchMap'

function routeRemainingDistance(route: DispatchRoute) {
  if (route.remaining_distance_km != null) return Math.max(0, route.remaining_distance_km)
  const progress = Math.max(0, Math.min(100, Number(route.progress || 0)))
  return Math.max(0, Number(route.distance_km || 0) * (100 - progress) / 100)
}

export function LiveArrivalEstimate({
  route,
  compact = false,
  action,
}: {
  route?: DispatchRoute | null
  compact?: boolean
  action?: ReactNode
}) {
  const targetDistanceKm = route ? routeRemainingDistance(route) : undefined
  const displayedRef = useRef<number | undefined>(targetDistanceKm)
  const [displayedDistanceKm, setDisplayedDistanceKm] = useState<number | undefined>(targetDistanceKm)

  useEffect(() => {
    if (targetDistanceKm == null) {
      displayedRef.current = undefined
      setDisplayedDistanceKm(undefined)
      return
    }
    const from = displayedRef.current ?? targetDistanceKm
    const to = targetDistanceKm
    if (Math.abs(from - to) < 0.00001) {
      displayedRef.current = to
      setDisplayedDistanceKm(to)
      return
    }
    let frame = 0
    const startedAt = performance.now()
    const animate = (now: number) => {
      const ratio = Math.min(1, (now - startedAt) / 950)
      const eased = 1 - Math.pow(1 - ratio, 3)
      const value = from + (to - from) * eased
      displayedRef.current = value
      setDisplayedDistanceKm(value)
      if (ratio < 1) frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frame)
  }, [targetDistanceKm])

  if (!route || displayedDistanceKm == null) {
    if (!action) return null
    return <div className="live-arrival-estimate live-arrival-estimate--action-only">{action}</div>
  }

  const progress = Math.max(0, Number(route.progress || 0))
  const etaMinutes = Math.max(0, Number(route.remaining_eta_minutes ?? route.eta_minutes ?? 0))
  const arrived = progress >= 100 || (etaMinutes === 0 && displayedDistanceKm <= 0.02)

  return (
    <div className={`live-arrival-estimate ${compact ? 'live-arrival-estimate--compact' : ''} ${action ? 'live-arrival-estimate--triple' : ''}`}>
      <div className="live-arrival-cell">
        <div className="live-arrival-label"><ClockCircleOutlined className="mr-1" />预计到达</div>
        <div className="live-arrival-value">{arrived ? '已到达' : `约 ${Math.max(1, Math.ceil(etaMinutes))} 分钟`}</div>
      </div>
      <div className="live-arrival-cell">
        <div className="live-arrival-label"><EnvironmentOutlined className="mr-1" />剩余距离</div>
        <div className="live-arrival-value">{arrived ? '0 米' : formatNavDistance(displayedDistanceKm * 1000)}</div>
      </div>
      {action ? <div className="live-arrival-cell live-arrival-action-cell">{action}</div> : null}
    </div>
  )
}
