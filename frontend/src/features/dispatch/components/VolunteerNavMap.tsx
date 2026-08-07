import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Segmented, Switch } from 'antd'

import type { DispatchMapData, DispatchRoute, NavigationMode } from '../dispatch-types'
import { formatNavDistance, trafficStyle, type AmapNavStep } from './DispatchMap'

type Point = [number, number]
type RouteMotionState = {
  key: string
  geometryKey: string
  path: Point[]
  displayedProgress: number
  anchorProgress: number
  anchorAt: number
  targetProgress: number
  motionRate: number
  totalDistanceMeters: number
  rawPosition: Point
}

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode?: string }
  }
}

let amapLoader: Promise<any> | null = null

function loadAmap() {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (amapLoader) return amapLoader
  const key = import.meta.env.VITE_AMAP_KEY
  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE
  amapLoader = new Promise((resolve, reject) => {
    if (!key || !securityJsCode) {
      reject(new Error('未配置高德地图 Key 或安全密钥'))
      return
    }
    window._AMapSecurityConfig = { securityJsCode }
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&plugin=AMap.Driving,AMap.Walking,AMap.Riding,AMap.ControlBar,AMap.ToolBar,AMap.Scale,AMap.MoveAnimation`
    script.async = true
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('高德地图加载失败')))
    script.onerror = () => reject(new Error('无法连接高德地图服务'))
    document.head.appendChild(script)
  })
  return amapLoader
}

function amapHostHint(reason: string) {
  const host = typeof window !== 'undefined' ? window.location.hostname : ''
  if (!host) return reason
  return `${reason}。当前主机「${host}」。本地演示请清空白名单/不校验；只加 127.0.0.1 却用 localhost 打开会导致地图空白`
}

function bearingDegrees(from: Point, to: Point) {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const lat1 = toRad(from[1])
  const lat2 = toRad(to[1])
  const dLng = toRad(to[0] - from[0])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function pointDistanceMeters(from: Point, to: Point) {
  const metresPerDegree = 111_320
  const lngScale = Math.cos(((from[1] + to[1]) / 2) * Math.PI / 180) * metresPerDegree
  return Math.hypot((to[0] - from[0]) * lngScale, (to[1] - from[1]) * metresPerDegree)
}

function pathDistanceMeters(path: Point[]) {
  return path.slice(1).reduce((sum, point, index) => sum + pointDistanceMeters(path[index], point), 0)
}

function projectPointToPathProgress(path: Point[], point: Point) {
  if (path.length < 2) return 0
  const totalMeters = pathDistanceMeters(path)
  if (totalMeters <= 0) return 0
  const metresPerDegree = 111_320
  const lngScale = Math.cos(point[1] * Math.PI / 180) * metresPerDegree
  let coveredMeters = 0
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  let bestAlongMeters = 0

  for (let index = 0; index < path.length - 1; index++) {
    const start = path[index]
    const end = path[index + 1]
    const startX = (start[0] - point[0]) * lngScale
    const startY = (start[1] - point[1]) * metresPerDegree
    const endX = (end[0] - point[0]) * lngScale
    const endY = (end[1] - point[1]) * metresPerDegree
    const dx = endX - startX
    const dy = endY - startY
    const segmentSquared = dx * dx + dy * dy
    const ratio = segmentSquared > 0
      ? Math.max(0, Math.min(1, -(startX * dx + startY * dy) / segmentSquared))
      : 0
    const projectedX = startX + dx * ratio
    const projectedY = startY + dy * ratio
    const distanceSquared = projectedX * projectedX + projectedY * projectedY
    const segmentMeters = pointDistanceMeters(start, end)
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestAlongMeters = coveredMeters + segmentMeters * ratio
    }
    coveredMeters += segmentMeters
  }

  return Math.max(0, Math.min(100, bestAlongMeters / totalMeters * 100))
}

function shortestAngleDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180
}

function createRoutePositionMarker(color = '#1677ff') {
  const root = document.createElement('div')
  root.style.cssText = 'position:relative;width:52px;height:66px;transform:translate(-50%,-50%);filter:drop-shadow(0 4px 10px rgba(15,23,42,.42));pointer-events:none'
  root.innerHTML = `
    <div style="position:absolute;left:4px;top:3px;width:44px;height:44px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 5px rgba(22,119,255,.16)">
      <div data-nav-arrow style="position:absolute;inset:0;transform:rotate(0deg);transform-origin:50% 50%">
        <svg viewBox="0 0 64 64" width="38" height="38" style="margin:0" xmlns="http://www.w3.org/2000/svg">
          <path d="M32 5 L50 51 L32 41 L14 51 Z" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
          <path d="M32 15 L41 40 L32 36 L23 40 Z" fill="#dbeafe"/>
        </svg>
      </div>
    </div>
    <div style="position:absolute;left:50%;bottom:0;transform:translateX(-50%);white-space:nowrap;border-radius:8px;background:rgba(15,23,42,.9);padding:2px 6px;color:#fff;font-size:10px;font-weight:700;line-height:15px">当前位置</div>`
  return { root, arrow: root.querySelector<HTMLDivElement>('[data-nav-arrow]') }
}

function pointAlongPath(path: Point[], progress: number): Point {
  if (path.length < 2) return path[0]
  // Use the same metre-weighted geometry as the backend. Degree-space length
  // makes east/west and north/south road segments advance at different visual
  // speeds, which is especially noticeable on a slow return journey.
  const lengths = path.slice(1).map((point, index) => pointDistanceMeters(path[index], point))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  const target = (total * Math.max(0, Math.min(100, progress))) / 100
  let passed = 0
  for (let index = 0; index < lengths.length; index++) {
    if (passed + lengths[index] >= target) {
      const ratio = lengths[index] ? (target - passed) / lengths[index] : 0
      return [
        path[index][0] + (path[index + 1][0] - path[index][0]) * ratio,
        path[index][1] + (path[index + 1][1] - path[index][1]) * ratio,
      ]
    }
    passed += lengths[index]
  }
  return path[path.length - 1]
}

function lookAheadPoint(path: Point[], progress: number, metersHint = 40): Point {
  if (path.length < 2) return path[0]
  const here = pointAlongPath(path, progress)
  const totalMeters = pathDistanceMeters(path)
  const lookAheadPercent = totalMeters > 0
    ? Math.max(0.08, Math.min(2.5, metersHint / totalMeters * 100))
    : 0.2
  const ahead = pointAlongPath(path, Math.min(100, progress + lookAheadPercent))
  if (pointDistanceMeters(here, ahead) < 0.5) {
    // Degenerate near end: keep last segment direction.
    return path[path.length - 1]
  }
  return ahead
}

const ROUTE_LINE_STYLE = {
  strokeWeight: 5,
  strokeOpacity: 1,
  lineJoin: 'round' as const,
  lineCap: 'round' as const,
  isOutline: false,
  borderWeight: 0,
  showDir: false,
}

function pickSelfRoute(overview: (DispatchMapData & { return_route?: DispatchRoute }) | null, routeOverride?: DispatchRoute | null): { volunteerId: number; route: DispatchRoute; position: Point } | null {
  if (!overview?.volunteers?.length) return null
  const me = overview.volunteers[0]
  const route =
    routeOverride
    || overview.routes.find((item) => item.volunteer_id === me.volunteer_id && item.journey_type !== 'returning')
    || overview.return_route
    || overview.routes.find((item) => item.volunteer_id === me.volunteer_id)
  if (!route?.path?.length) {
    return { volunteerId: me.volunteer_id, route: { order_id: 0, volunteer_id: me.volunteer_id, eta_minutes: 0, traffic_version: 0, path: [[me.lng, me.lat]] }, position: [me.lng, me.lat] }
  }
  return {
    volunteerId: me.volunteer_id,
    route,
    position: [me.lng, me.lat],
  }
}

function directionGlyph(instruction?: string) {
  if (!instruction) return '↑'
  if (instruction.includes('左转') || instruction.includes('向左')) return '↰'
  if (instruction.includes('右转') || instruction.includes('向右')) return '↱'
  if (instruction.includes('掉头')) return '↶'
  if (instruction.includes('到达')) return '●'
  return '↑'
}

export function VolunteerNavMap({
  overview,
  height = 560,
  steps = [],
  routeOverride,
  navigationMode = 'driving',
  navigationModeLocked = false,
  navigationModeLockLabel = '返程固定驾车',
  distanceKm,
  etaMinutes,
  onNavigationModeChange,
}: {
  overview: (DispatchMapData & { return_route?: DispatchRoute }) | null
  height?: number
  steps?: AmapNavStep[]
  routeOverride?: DispatchRoute | null
  navigationMode?: NavigationMode
  navigationModeLocked?: boolean
  navigationModeLockLabel?: string
  distanceKm?: number
  etaMinutes?: number
  onNavigationModeChange?: (mode: NavigationMode) => void
}) {
  const simulationEnabled = import.meta.env.VITE_ENABLE_SIMULATION === 'true'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<any[]>([])
  const selfMarkerRef = useRef<any>(null)
  const markerRenderedPositionRef = useRef<Point | null>(null)
  const markerAnimationRef = useRef<number | null>(null)
  const routeMotionRef = useRef<RouteMotionState | null>(null)
  const lastMotionFrameAtRef = useRef(0)
  const lastCameraCenterAtRef = useRef(0)
  const lastCameraUpdateAtRef = useRef(0)
  const markerArrowRef = useRef<HTMLDivElement | null>(null)
  const markerArrowAngleRef = useRef(0)
  const cameraTargetRef = useRef<Point | null>(null)
  const cameraHeadingRef = useRef<number | null>(null)
  const cameraRotationRef = useRef(0)
  const cameraInitializedRef = useRef(false)
  const displayedDistanceRef = useRef<number | undefined>(distanceKm)
  const lastDistanceCommitAtRef = useRef(0)
  const distanceJourneyKeyRef = useRef('')
  const userUnlockedRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [viewMode, setViewMode] = useState<'3D' | '2D'>('3D')
  const [follow, setFollow] = useState(true)
  const [displayedDistanceKm, setDisplayedDistanceKm] = useState<number | undefined>(distanceKm)

  const ego = useMemo(() => pickSelfRoute(overview, routeOverride), [overview, routeOverride])
  const hasRoadGeometry = (ego?.route.path?.length ?? 0) > 2
  const isReturningJourney = ego?.route.journey_type === 'returning' || Number(ego?.route.order_id || 0) < 0
  const upcoming = steps[0]
  const routeGeometryKey = useMemo(() => {
    const route = ego?.route
    const path = route?.path || []
    if (!route) return 'none'
    const sampleIndexes = Array.from(new Set([0, .2, .4, .6, .8, 1].map((ratio) => Math.round((path.length - 1) * ratio))))
    const pathFingerprint = sampleIndexes.map((index) => path[index]?.join(',')).join(':')
    // Traffic-version changes repaint the coloured overlays but must not reset
    // or re-project vehicle motion when the actual road geometry is unchanged.
    return `${route.order_id}:${route.navigation_mode || navigationMode}:${path.length}:${pathFingerprint}`
  }, [ego?.route.order_id, ego?.route.navigation_mode, ego?.route.path, navigationMode])
  const routeTrafficKey = useMemo(() => (ego?.route.traffic_segments || []).map((segment) => {
    const first = segment.path?.[0]
    const last = segment.path?.[segment.path.length - 1]
    return `${segment.status}:${segment.path?.length || 0}:${first?.join(',')}:${last?.join(',')}`
  }).join('|'), [ego?.route.traffic_segments])
  // Traffic colour changes repaint only the polylines. Vehicle motion is held
  // separately in routeMotionRef, so return journeys can update TMC overlays
  // without resetting or shaking the marker.
  const routePaintKey = `${routeGeometryKey}:${routeTrafficKey}`
  const routeJourneyKey = ego
    ? `${ego.route.order_id}:${ego.route.journey_type || (ego.route.order_id < 0 ? 'returning' : 'service')}`
    : 'none'
  const elderGeometryKey = useMemo(() => (overview?.elders || []).map((elder) => `${elder.elder_id}:${elder.lng}:${elder.lat}`).join('|'), [overview?.elders])

  useEffect(() => {
    if (distanceKm == null) {
      displayedDistanceRef.current = undefined
      lastDistanceCommitAtRef.current = 0
      setDisplayedDistanceKm(undefined)
      return
    }
    if (distanceJourneyKeyRef.current !== routeJourneyKey) {
      distanceJourneyKeyRef.current = routeJourneyKey
      lastDistanceCommitAtRef.current = performance.now()
      displayedDistanceRef.current = Math.max(0, distanceKm)
      setDisplayedDistanceKm(Math.max(0, distanceKm))
      return
    }
    let timer = 0
    let frame = 0
    const commitDistance = () => {
      const from = displayedDistanceRef.current ?? distanceKm
      const incoming = Math.max(0, distanceKm)
      // A return journey has a fixed home destination. Ignore stale responses
      // that would make the remaining distance increase and visibly flash.
      const to = isReturningJourney ? Math.min(from, incoming) : incoming
      lastDistanceCommitAtRef.current = performance.now()
      if (Math.abs(from - to) < 0.00001) {
        displayedDistanceRef.current = to
        setDisplayedDistanceKm(to)
        return
      }
      const startedAt = performance.now()
      const duration = isReturningJourney ? 720 : 950
      const animate = (now: number) => {
        const ratio = Math.min(1, (now - startedAt) / duration)
        const eased = 1 - Math.pow(1 - ratio, 3)
        const value = from + (to - from) * eased
        displayedDistanceRef.current = value
        setDisplayedDistanceKm(value)
        if (ratio < 1) frame = window.requestAnimationFrame(animate)
      }
      frame = window.requestAnimationFrame(animate)
    }

    const now = performance.now()
    const elapsed = now - lastDistanceCommitAtRef.current
    const delay = isReturningJourney && displayedDistanceRef.current != null
      ? Math.max(0, 3000 - elapsed)
      : 0
    if (delay > 0) timer = window.setTimeout(commitDistance, delay)
    else commitDistance()
    return () => {
      window.clearTimeout(timer)
      window.cancelAnimationFrame(frame)
    }
  }, [distanceKm, isReturningJourney, routeJourneyKey])

  useEffect(() => {
    let alive = true
    loadAmap().then((AMap) => {
      if (!alive || !containerRef.current) return
      const map = new AMap.Map(containerRef.current, {
        viewMode: '3D',
        pitch: 48,
        rotation: 0,
        zoom: 17.5,
        zooms: [3, 20],
        resizeEnable: true,
        rotateEnable: true,
        pitchEnable: true,
        buildingAnimation: true,
        mapStyle: 'amap://styles/normal',
        // Keep the surrounding road network, road names and POI labels visible
        // under the navigation polyline.
        features: ['bg', 'road', 'building', 'point'],
        showLabel: true,
        labelzIndex: 130,
      })
      map.setFeatures?.(['bg', 'road', 'building', 'point'])
      map.setStatus?.({ showLabel: true })
      map.addControl(new AMap.Scale())
      try {
          map.addControl(new AMap.ControlBar({ position: { right: '12px', bottom: '78px' } }))
      } catch {
        try {
          map.addControl(new AMap.ToolBar({ position: 'RT' }))
        } catch {
          // controls are optional
        }
      }
      map.on('dragstart', () => {
        userUnlockedRef.current = true
        setFollow(false)
      })
      mapRef.current = map
      const resize = () => map.resize?.()
      requestAnimationFrame(resize)
      window.setTimeout(resize, 120)
      setStatus('ready')
    }).catch((reason: Error) => {
      if (alive) {
        setError(amapHostHint(reason.message))
        setStatus('error')
      }
    })
    return () => {
      alive = false
      overlaysRef.current.forEach((overlay) => overlay.setMap?.(null))
      overlaysRef.current = []
      if (markerAnimationRef.current != null) window.cancelAnimationFrame(markerAnimationRef.current)
      markerAnimationRef.current = null
      routeMotionRef.current = null
      lastMotionFrameAtRef.current = 0
      lastCameraCenterAtRef.current = 0
      lastCameraUpdateAtRef.current = 0
      selfMarkerRef.current?.setMap?.(null)
      selfMarkerRef.current = null
      markerRenderedPositionRef.current = null
      markerArrowRef.current = null
      cameraTargetRef.current = null
      cameraHeadingRef.current = null
      cameraInitializedRef.current = false
      mapRef.current?.destroy?.()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    const timer = window.setTimeout(() => {
      try {
        map.resize?.()
      } catch {
        // ignore
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [status, height, follow, viewMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    try {
      if (viewMode === '3D') {
        map.setPitch?.(48, false)
        map.setStatus?.({ pitchEnable: true, rotateEnable: true })
      } else {
        map.setPitch?.(0, false)
      }
    } catch {
      // ignore older runtime quirks
    }
  }, [viewMode, status])

  useEffect(() => {
    const map = mapRef.current
    const AMap = window.AMap
    if (!map || !AMap || status !== 'ready' || !overview) return

    overlaysRef.current.forEach((overlay) => overlay.setMap?.(null))
    overlaysRef.current = []
    const add = (overlay: any) => {
      overlay.setMap(map)
      overlaysRef.current.push(overlay)
    }

    overview.elders.forEach((elder) => {
      add(new AMap.Marker({
        position: [elder.lng, elder.lat],
        offset: new AMap.Pixel(-12, -12),
        content: `<div style="width:24px;height:24px;border-radius:50%;background:#e11d48;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">老</div>`,
        zIndex: 20,
      }))
    })

    const self = ego
    if (self?.route?.path?.length && self.route.path.length > 2) {
      const path = self.route.path as Point[]
      const baseColor = navigationMode === 'walking' ? '#2563eb' : navigationMode === 'riding' ? '#7c3aed' : '#16a34a'
      // Same stroke for green / yellow / red — congestion is only a color change.
      add(new AMap.Polyline({
        path,
        strokeColor: baseColor,
        zIndex: 20,
        ...ROUTE_LINE_STYLE,
        showDir: navigationMode !== 'driving',
      }))
      ;(self.route.traffic_segments || []).forEach((segment) => {
        if (!segment.path || segment.path.length < 2) return
        const style = trafficStyle(segment.status)
        if (!style) return
        add(new AMap.Polyline({
          path: segment.path,
          strokeColor: style.color,
          zIndex: 24 + style.severity,
          ...ROUTE_LINE_STYLE,
        }))
      })
    }

    const position = simulationEnabled && self?.route?.path?.length && self.route.path.length > 2
      ? pointAlongPath(self.route.path as Point[], self.route.progress ?? 0)
      : self?.position
    if (position && !selfMarkerRef.current) {
      const markerContent = createRoutePositionMarker('#1677ff')
      markerArrowRef.current = markerContent.arrow
      selfMarkerRef.current = new AMap.Marker({
        position,
        content: markerContent.root,
        offset: new AMap.Pixel(0, 0),
        zIndex: 130,
      })
      selfMarkerRef.current.setMap(map)
      markerRenderedPositionRef.current = position
    }

  }, [routePaintKey, elderGeometryKey, navigationMode, status])

  useEffect(() => {
    if (status !== 'ready' || !ego) return
    const path = (ego.route.path || []) as Point[]
    const incomingProgress = Math.max(0, Math.min(100, Number(ego.route.progress || 0)))
    const now = performance.now()
    const motionRate = simulationEnabled ? Math.max(0.05, Number(ego.route.motion_rate || 0.65)) : 0
    const current = routeMotionRef.current

    if (!current || current.key !== routeJourneyKey) {
      routeMotionRef.current = {
        key: routeJourneyKey,
        geometryKey: routeGeometryKey,
        path,
        displayedProgress: incomingProgress,
        anchorProgress: incomingProgress,
        anchorAt: now,
        targetProgress: incomingProgress,
        motionRate,
        totalDistanceMeters: Math.max(1, pathDistanceMeters(path)),
        rawPosition: ego.position,
      }
      const initialPosition = simulationEnabled && path.length > 2 ? pointAlongPath(path, incomingProgress) : ego.position
      selfMarkerRef.current?.setPosition?.(initialPosition)
      markerRenderedPositionRef.current = initialPosition
      cameraInitializedRef.current = false
      cameraTargetRef.current = null
      cameraHeadingRef.current = null
      lastCameraCenterAtRef.current = 0
      lastCameraUpdateAtRef.current = 0
      return
    }

    if (current.geometryKey !== routeGeometryKey) {
      const renderedPosition = markerRenderedPositionRef.current
        ?? (current.path.length > 2 ? pointAlongPath(current.path, current.displayedProgress) : current.rawPosition)
      const projectedProgress = path.length > 2
        ? projectPointToPathProgress(path, renderedPosition)
        : incomingProgress
      const continuityProgress = Math.max(current.displayedProgress, incomingProgress)
      // Projection onto a newly resolved road can choose the wrong parallel
      // segment at an overpass. Preserve monotonic journey progress and cap a
      // one-frame projection correction so geometry swaps cannot jump either
      // backwards or far ahead.
      const correctedProgress = Math.max(continuityProgress, Math.min(projectedProgress, continuityProgress + 2))
      current.geometryKey = routeGeometryKey
      current.path = path
      current.displayedProgress = correctedProgress
      current.anchorProgress = correctedProgress
      current.targetProgress = correctedProgress
      current.anchorAt = now
      current.totalDistanceMeters = Math.max(1, pathDistanceMeters(path))
      current.rawPosition = ego.position
      return
    }

    current.path = path
    current.rawPosition = ego.position
    current.motionRate = motionRate
    current.totalDistanceMeters = Math.max(1, pathDistanceMeters(path))
    // Poll responses can arrive out of order. Never let an older sample pull
    // the vehicle backwards; a newer routeGeometryKey is the only valid reset.
    if (incomingProgress > current.anchorProgress + 0.001) {
      current.anchorProgress = incomingProgress
      current.anchorAt = now
    }
    current.targetProgress = Math.max(current.targetProgress, incomingProgress, current.displayedProgress)
  }, [
    status,
    routeJourneyKey,
    routeGeometryKey,
    ego?.route.progress,
    ego?.route.motion_rate,
    ego?.route.path,
    ego?.position[0],
    ego?.position[1],
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    let alive = true
    lastMotionFrameAtRef.current = performance.now()

    const renderMotion = (now: number) => {
      if (!alive) return
      const motion = routeMotionRef.current
      const marker = selfMarkerRef.current
      const dt = Math.max(0, Math.min(64, now - lastMotionFrameAtRef.current))
      lastMotionFrameAtRef.current = now

      if (motion && marker) {
        const followsRoadGeometry = simulationEnabled && motion.path.length > 2
        if (followsRoadGeometry) {
          // Predict only slightly beyond the last server anchor. If polling is
          // interrupted the vehicle pauses instead of drifting away from truth.
          const predictionSeconds = Math.max(0, Math.min(3.5, (now - motion.anchorAt) / 1000))
          const predictedProgress = Math.min(100, motion.anchorProgress + predictionSeconds * motion.motionRate)
          const desiredProgress = Math.max(motion.targetProgress, predictedProgress, motion.displayedProgress)
            const gap = desiredProgress - motion.displayedProgress
            if (gap > 0.0001) {
              const naturalStep = motion.motionRate * dt / 1000
              const catchUpStep = gap * (1 - Math.exp(-dt / 420))
              motion.displayedProgress = Math.min(desiredProgress, motion.displayedProgress + Math.max(naturalStep, catchUpStep))
            }
        }

        const position = followsRoadGeometry
          ? pointAlongPath(motion.path, motion.displayedProgress)
          : motion.rawPosition
        const ahead = followsRoadGeometry
          ? lookAheadPoint(motion.path, motion.displayedProgress, navigationMode === 'walking' ? 12 : 32)
          : position
        const heading = followsRoadGeometry && pointDistanceMeters(position, ahead) > 0.5
          ? bearingDegrees(position, ahead)
          : cameraHeadingRef.current ?? 0
        marker.setPosition?.(position)
        markerRenderedPositionRef.current = position

        const leadMeters = navigationMode === 'walking' ? 35 : navigationMode === 'riding' ? 70 : 115
        const cameraLeadPercent = Math.max(0.15, Math.min(4, leadMeters / motion.totalDistanceMeters * 100))
        const cameraCenter = followsRoadGeometry
          ? pointAlongPath(motion.path, Math.min(100, motion.displayedProgress + cameraLeadPercent))
          : position

        if (!follow) {
          cameraInitializedRef.current = false
          cameraRotationRef.current = Number(map.getRotation?.() || 0)
        } else {
          try {
            if (!cameraInitializedRef.current) {
              cameraRotationRef.current = -heading
              map.setZoomAndCenter?.(navigationMode === 'walking' ? 18 : 17.3, cameraCenter, false, 600)
              map.setRotation?.(cameraRotationRef.current, false, 600)
              cameraTargetRef.current = cameraCenter
              cameraHeadingRef.current = heading
              cameraInitializedRef.current = true
              lastCameraCenterAtRef.current = now
              lastCameraUpdateAtRef.current = now
            } else {
              // Restore the earlier short, low-amplitude camera transitions.
              // They were visibly steadier than either forced frame updates or
              // long 720 ms pans on AMap's 3D renderer.
              if (now - lastCameraCenterAtRef.current >= 120) {
                map.setCenter?.(cameraCenter, false, 180)
                cameraTargetRef.current = cameraCenter
                lastCameraCenterAtRef.current = now
              }
              if (now - lastCameraUpdateAtRef.current >= 520) {
                const previousHeading = cameraHeadingRef.current ?? heading
                const headingDelta = shortestAngleDelta(previousHeading, heading)
                if (Math.abs(headingDelta) >= 11) {
                  const softenedHeading = previousHeading + Math.max(-18, Math.min(18, headingDelta))
                  cameraRotationRef.current = -softenedHeading
                  cameraHeadingRef.current = (softenedHeading + 360) % 360
                  map.setRotation?.(cameraRotationRef.current, false, 520)
                }
                lastCameraUpdateAtRef.current = now
              }
            }
          } catch {
            map.setCenter?.(position)
          }
        }

        if (markerArrowRef.current) {
          const targetAngle = heading + cameraRotationRef.current
          const angleEase = 1 - Math.exp(-dt / 150)
          markerArrowAngleRef.current += shortestAngleDelta(markerArrowAngleRef.current, targetAngle) * angleEase
          markerArrowRef.current.style.transform = `rotate(${markerArrowAngleRef.current}deg)`
        }
      }

      markerAnimationRef.current = window.requestAnimationFrame(renderMotion)
    }

    markerAnimationRef.current = window.requestAnimationFrame(renderMotion)
    return () => {
      alive = false
      if (markerAnimationRef.current != null) window.cancelAnimationFrame(markerAnimationRef.current)
      markerAnimationRef.current = null
    }
  }, [status, follow, navigationMode, viewMode, routeJourneyKey])

  return (
    <div className="volunteer-nav-map relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'ready' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 text-sm text-white">
          {status === 'loading' ? '正在进入车载导航视角…' : `地图不可用：${error}`}
        </div>
      ) : null}

      {/* 顶部精简转向提示，不挡地图中部 */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex max-w-[calc(100%-16px)] items-center gap-2 rounded-xl bg-slate-950/90 px-3 py-2 text-white shadow-lg backdrop-blur">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-xl font-black">
          {directionGlyph(upcoming?.instruction)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-emerald-300">
            {upcoming ? `${formatNavDistance(upcoming.distanceMeters)}后` : '正在跟随实时位置'}
          </div>
          <div className="truncate text-sm font-bold">
            {upcoming?.instruction || (ego ? '沿当前路线继续行驶' : '接单后自动开始导航')}
          </div>
        </div>
      </div>

      {ego && ego.route.order_id !== 0 && !hasRoadGeometry ? (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-full bg-amber-500/95 px-3 py-1 text-[11px] font-semibold text-white shadow-lg">
          正在获取高德道路路线…
        </div>
      ) : null}

      {/* 底部控制条：模式/视角；距离已挪到侧栏「剩余距离」板块，地图上不再重复显示 */}
      <div className="volunteer-nav-controls pointer-events-auto absolute inset-x-2 bottom-2 rounded-2xl bg-white/95 p-2.5 text-slate-900 shadow-2xl backdrop-blur">
        <div className="volunteer-nav-distance-row mb-2 hidden items-center justify-between gap-3 px-1 md:flex">
          <div className="min-w-0">
            <div className="text-[10px] font-medium text-slate-500">剩余距离</div>
            <div className="text-base font-bold tabular-nums leading-tight">{displayedDistanceKm != null ? formatNavDistance(displayedDistanceKm * 1000) : '--'}</div>
          </div>
          <div className="min-w-0 border-l border-slate-200 pl-3">
            <div className="text-[10px] font-medium text-slate-500">预计时间</div>
            <div className="text-base font-bold leading-tight text-emerald-600">{etaMinutes != null ? `${Math.max(1, Math.ceil(etaMinutes))} 分钟` : '--'}</div>
          </div>
          {!follow ? (
            <Button
              size="small"
              type="primary"
              className="shrink-0"
              onClick={() => {
                setFollow(true)
                userUnlockedRef.current = false
              }}
            >
              回到车位
            </Button>
          ) : (
            <div className="shrink-0 text-right text-[10px] leading-tight text-slate-500">实时跟随<br />方向朝上</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 md:border-t md:border-slate-100 md:pt-2">
          <Segmented
            size="small"
            className="volunteer-nav-mode"
            value={navigationMode}
            disabled={navigationModeLocked}
            options={[
              { label: '驾车', value: 'driving' },
              { label: '骑行', value: 'riding' },
              { label: '步行', value: 'walking' },
            ]}
            onChange={(value) => onNavigationModeChange?.(value as NavigationMode)}
          />
          <Segmented
            size="small"
            value={viewMode}
            options={[{ label: '3D', value: '3D' }, { label: '2D', value: '2D' }]}
            onChange={(value) => setViewMode(value as '3D' | '2D')}
          />
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-600">
            {!follow ? (
              <Button
                size="small"
                type="primary"
                className="md:hidden"
                onClick={() => {
                  setFollow(true)
                  userUnlockedRef.current = false
                }}
              >
                回到车位
              </Button>
            ) : null}
            <span>跟随</span>
            <Switch
              size="small"
              checked={follow}
              onChange={(checked) => {
                setFollow(checked)
                if (checked) userUnlockedRef.current = false
              }}
            />
          </div>
        </div>
        {navigationModeLocked ? <div className="pt-1 text-[10px] text-slate-500">{navigationModeLockLabel}</div> : null}
      </div>
    </div>
  )
}
