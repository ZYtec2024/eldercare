import { useEffect, useRef, useState } from 'react'

import type { DispatchMapData, DispatchRoute, NavigationMode } from '../dispatch-types'
import { http } from '@/services/http'

type Point = [number, number]
type AnimatedTrip = { marker: any; volunteerId: number; journeyKey: string; path: Point[]; displayed: number; target: number; trafficVersion: number; rate: number; motionRate: number }
export type AmapNavStep = {
  instruction: string
  distanceMeters: number
  road?: string
}

export type AmapDrivingRoute = {
  path: Point[]
  geometryResolved: boolean
  distanceKm: number
  etaMinutes: number
  trafficSegments: Array<{ path: Point[]; status: string }>
  steps: AmapNavStep[]
}

export function formatNavDistance(meters: number) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} 公里`
  return `${Math.max(1, Math.round(meters))} 米`
}

export function pickUpcomingNavSteps(steps: AmapNavStep[], progressPercent = 0, limit = 4): AmapNavStep[] {
  if (!steps.length) return []
  const total = steps.reduce((sum, step) => sum + Math.max(0, step.distanceMeters), 0)
  if (total <= 0) return steps.slice(0, limit)
  const progress = Math.max(0, Math.min(100, progressPercent))
  if (progress >= 99.8) return []
  const traveled = total * progress / 100
  let passed = 0
  for (let index = 0; index < steps.length; index++) {
    const next = passed + Math.max(0, steps[index].distanceMeters)
    if (traveled < next) {
      const upcoming = steps.slice(index, index + limit)
      if (!upcoming.length) return []
      return [
        { ...upcoming[0], distanceMeters: Math.max(1, next - traveled) },
        ...upcoming.slice(1),
      ]
    }
    passed = next
  }
  return []
}

function routeNavSteps(result: any): AmapNavStep[] {
  const steps = result?.routes?.[0]?.steps
  if (!Array.isArray(steps)) return []
  return steps
    .map((step: any) => {
      const instruction = String(step.instruction || step.action || '').trim()
      const explicitRoad = String(step.road || step.roadName || step.name || '').trim()
      const inferredRoad = instruction.match(
        /(?:沿|进入|驶入|转入|到达)([^，。；]{1,30}?(?:路|街|大道|公路|高架|隧道|大桥|桥))/,
      )?.[1]
      return {
        instruction,
        distanceMeters: Number(step.distance ?? 0),
        road: explicitRoad || inferredRoad || undefined,
      }
    })
    .filter((step: AmapNavStep) => step.instruction || step.distanceMeters > 0)
}

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode?: string }
  }
}

let amapLoader: Promise<any> | null = null
const routePlanCache = new Map<string, Promise<AmapDrivingRoute>>()

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
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&plugin=AMap.Driving,AMap.Walking,AMap.Riding,AMap.Traffic,AMap.ToolBar,AMap.Scale,AMap.MoveAnimation`
    script.async = true
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error('高德地图加载失败'))
    script.onerror = () => reject(new Error('无法连接高德地图服务'))
    document.head.appendChild(script)
  })
  return amapLoader
}

function amapLoadHint(reason: string) {
  const host = typeof window !== 'undefined' ? window.location.hostname : ''
  if (!host) return reason
  // Local demo: empty whitelist / “不校验” is safest. Adding only 127.0.0.1 while
  // opening http://localhost blanks the map (INVALID_USER_DOMAIN).
  return `${reason}。当前主机「${host}」。本地演示请把 JS Key 白名单清空或选不校验 Referer；不要只加 127.0.0.1（用 localhost 打开会整图空白）。若必须加白名单，请同时加 localhost 与 127.0.0.1`
}

function markerHtml(color: string, icon: string, text: string, kind: 'person' | 'order' = 'person') {
  const radius = kind === 'order' ? '7px 7px 7px 2px' : '50%'
  const transform = kind === 'order' ? 'rotate(-45deg)' : 'none'
  const iconTransform = kind === 'order' ? 'rotate(45deg)' : 'none'
  return `<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:${radius};transform:${transform};background:${color};border:2px solid #fff;box-shadow:0 2px 8px rgba(15,23,42,.35);color:#fff;font-size:11px;font-weight:700" title="${text}"><span style="transform:${iconTransform}">${icon}</span></div>`
}

function routePoints(result: any): Point[] {
  const points: Point[] = []
  result?.routes?.[0]?.steps?.forEach((step: any) => step.path?.forEach((point: any) => points.push([point.lng, point.lat])))
  return points
}

function parseAmapPath(raw: unknown): Point[] {
  if (!raw) return []
  if (typeof raw === 'string') {
    return raw
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [lngText, latText] = pair.split(',')
        const lng = Number(lngText)
        const lat = Number(latText)
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as Point : null
      })
      .filter((point): point is Point => Boolean(point))
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((point: any) => {
      if (Array.isArray(point) && point.length >= 2) {
        const lng = Number(point[0])
        const lat = Number(point[1])
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as Point : null
      }
      const lng = Number(point?.lng ?? point?.getLng?.())
      const lat = Number(point?.lat ?? point?.getLat?.())
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as Point : null
    })
    .filter((point): point is Point => Boolean(point))
}

function routeTrafficSegments(result: any): AmapDrivingRoute['trafficSegments'] {
  const segments: AmapDrivingRoute['trafficSegments'] = []
  result?.routes?.[0]?.steps?.forEach((step: any) => {
    const tmcs = step.tmcs ?? step.tmcsPaths ?? []
    tmcs.forEach((tmc: any) => {
      const path = parseAmapPath(tmc.path ?? tmc.polyline)
      if (path.length > 1) segments.push({ path, status: String(tmc.status ?? '未知') })
    })
  })
  return segments
}

function pointAlongPath(path: Point[], progress: number): Point {
  if (path.length < 2) return path[0]
  const lengths = path.slice(1).map((point, index) => Math.hypot(point[0] - path[index][0], point[1] - path[index][1]))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  const target = total * Math.max(0, Math.min(100, progress)) / 100
  let passed = 0
  for (let index = 0; index < lengths.length; index++) {
    if (passed + lengths[index] >= target) {
      const ratio = lengths[index] ? (target - passed) / lengths[index] : 0
      return [path[index][0] + (path[index + 1][0] - path[index][0]) * ratio, path[index][1] + (path[index + 1][1] - path[index][1]) * ratio]
    }
    passed += lengths[index]
  }
  return path[path.length - 1]
}

/** Only overlay slow/jammed TMC; keep base green for unknown/smooth. */
export function trafficStyle(status?: string | number): { color: string; severity: number } | null {
  const raw = String(status ?? '').trim()
  const lowered = raw.toLowerCase()
  if (!raw || raw === '未知' || raw === '0' || raw.includes('畅通') || lowered.includes('smooth') || raw === '1') {
    return null
  }
  if (raw.includes('严重') || lowered.includes('serious') || raw === '4') return { color: '#7f1d1d', severity: 4 }
  if (raw.includes('拥堵') || lowered.includes('jam') || lowered.includes('congest') || raw === '3') {
    return { color: '#dc2626', severity: 3 }
  }
  if (raw.includes('缓行') || lowered.includes('slow') || raw === '2') return { color: '#eab308', severity: 2 }
  return null
}

const ROUTE_LINE_STYLE = {
  strokeWeight: 5,
  strokeOpacity: 1,
  lineJoin: 'round' as const,
  lineCap: 'round' as const,
  isOutline: false,
  borderWeight: 0,
}

function trafficSegments(path: Point[], route: DispatchRoute): Point[][] {
  const count = Math.min(5, Math.max(3, Math.floor(path.length / 18)))
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * (path.length - 1) / count)
    const end = Math.min(path.length - 1, Math.floor((index + 1) * (path.length - 1) / count) + 1)
    return path.slice(start, end + 1)
  }).filter((segment) => segment.length > 1)
}

function compactPath(path: Point[], maxPoints: number) {
  if (path.length <= maxPoints) return path
  const step = (path.length - 1) / (maxPoints - 1)
  return Array.from({ length: maxPoints }, (_, index) => path[Math.round(index * step)])
}

export async function getAmapDrivingRoute(start: Point, end: Point, policyName = 'LEAST_TIME', refreshSlot = ''): Promise<AmapDrivingRoute> {
  return getAmapRoute(start, end, 'driving', policyName, refreshSlot)
}

export async function getAmapRoute(start: Point, end: Point, mode: NavigationMode = 'driving', policyName = 'LEAST_TIME', refreshSlot = ''): Promise<AmapDrivingRoute> {
  const key = `${refreshSlot}:${mode}:${policyName}:${start[0].toFixed(5)},${start[1].toFixed(5)}:${end[0].toFixed(5)},${end[1].toFixed(5)}`
  if (!routePlanCache.has(key)) {
    const routePromise = loadAmap().then((AMap) => new Promise<AmapDrivingRoute>((resolve) => {
      const planner = mode === 'walking'
        ? new AMap.Walking({ map: null, hideMarkers: true })
        : mode === 'riding'
          ? new AMap.Riding({ map: null, hideMarkers: true })
          : new AMap.Driving({
              policy: AMap.DrivingPolicy[policyName] ?? AMap.DrivingPolicy.REAL_TRAFFIC ?? AMap.DrivingPolicy.LEAST_TIME,
              extensions: 'all',
              showTraffic: true,
              map: null,
              hideMarkers: true,
            })
      planner.search(new AMap.LngLat(start[0], start[1]), new AMap.LngLat(end[0], end[1]), (status: string, result: any) => {
        const points = status === 'complete' ? routePoints(result) : []
        const route = result?.routes?.[0]
        const geometryResolved = status === 'complete' && points.length > 2
        resolve({
          path: geometryResolved ? points : [start, end],
          geometryResolved,
          distanceKm: Number(route?.distance ?? 0) / 1000,
          etaMinutes: Math.max(1, Math.round(Number(route?.time ?? 0) / 60)),
          trafficSegments: geometryResolved && mode === 'driving' ? routeTrafficSegments(result) : [],
          steps: geometryResolved ? routeNavSteps(result) : [],
        })
      })
    }))
    routePlanCache.set(key, routePromise)
    void routePromise.then((route) => {
      if (!route.geometryResolved && routePlanCache.get(key) === routePromise) routePlanCache.delete(key)
    }, () => {
      if (routePlanCache.get(key) === routePromise) routePlanCache.delete(key)
    })
  }
  return routePlanCache.get(key)!
}

export async function getAmapDrivingPath(start: Point, end: Point, policyName = 'LEAST_TIME'): Promise<Point[]> {
  return (await getAmapDrivingRoute(start, end, policyName)).path
}

export async function getAmapPointAtProgress(start: Point, end: Point, progress: number): Promise<Point> {
  return pointAlongPath(await getAmapDrivingPath(start, end), progress)
}

export function DispatchMap({
  overview,
  height = 420,
  expandable = false,
  onExpand,
}: {
  overview: DispatchMapData | null
  height?: number
  expandable?: boolean
  onExpand?: () => void
}) {
  const simulationEnabled = import.meta.env.VITE_ENABLE_SIMULATION === 'true'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<any[]>([])
  const routeCache = useRef(new Map<string, {
    path: Point[]
    trafficSegments: AmapDrivingRoute['trafficSegments']
  }>())
  const routeProgressRef = useRef(new Map<number, number>())
  const sosRouteHistoryRef = useRef(new Map<number, { version: number; path: Point[]; oldPath?: Point[]; expiresAt?: number }>())
  const animatedTripsRef = useRef(new Map<number, AnimatedTrip>())
  const publishedGeometryRef = useRef(new Set<string>())
  const animationFrameRef = useRef<number | null>(null)
  const focusedRegionRef = useRef<string | null>(null)
  const userAdjustedViewRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    loadAmap().then((AMap) => {
      if (!alive || !containerRef.current) return
      // Do not invent a Baoshan center before role-scoped tracking arrives.
      // First paint + setFitView below will lock onto visible markers only.
      const map = new AMap.Map(containerRef.current, {
        zoom: 12, resizeEnable: true, viewMode: '2D',
      })
      map.addControl(new AMap.Scale())
      map.addControl(new AMap.ToolBar({ position: 'RT' }))
      // Remember manual zoom/pan so polling never snaps the viewport back.
      const markUserView = () => { userAdjustedViewRef.current = true }
      map.on?.('zoomstart', markUserView)
      map.on?.('dragstart', markUserView)
      mapRef.current = map
      // Desktop/mobile layouts often finish sizing after Map() constructs; force a
      // resize so canvas is not stuck at 0×0 (blank gray box with no tiles).
      const resize = () => map.resize?.()
      requestAnimationFrame(resize)
      window.setTimeout(resize, 120)
      window.setTimeout(resize, 480)
      const ro = typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(() => resize())
        : null
      ro?.observe(containerRef.current!)
      map.on?.('error', (event: { message?: string; type?: string }) => {
        if (!alive) return
        const detail = String(event?.message || event?.type || '地图鉴权或瓦片加载失败')
        setError(amapLoadHint(detail))
        setStatus('error')
      })
      let previousFrame = performance.now()
      const animateTrips = (now: number) => {
        const elapsed = Math.min(80, now - previousFrame)
        previousFrame = now
        animatedTripsRef.current.forEach((trip) => {
          // Let the marker finish the final few metres on the road geometry.
          // Capping at 99 made the next poll remove it and visually jump it
          // into the elder's home / volunteer's home marker.
          if (trip.motionRate > 0) trip.target = Math.min(100, trip.target + elapsed / 1000 * trip.motionRate)
          const gap = trip.target - trip.displayed
          if (Math.abs(gap) < 0.02) return
          const step = Math.sign(gap) * Math.min(Math.abs(gap), elapsed * trip.rate)
          trip.displayed = Math.max(0, Math.min(100, trip.displayed + step))
          trip.marker.setPosition(pointAlongPath(trip.path, trip.displayed))
        })
        animationFrameRef.current = requestAnimationFrame(animateTrips)
      }
      animationFrameRef.current = requestAnimationFrame(animateTrips)
      setStatus('ready')
      ;(map as { __resizeObserver?: ResizeObserver | null }).__resizeObserver = ro
    }).catch((reason: Error) => { if (alive) { setError(amapLoadHint(reason.message)); setStatus('error') } })
    return () => {
      alive = false
      overlaysRef.current.forEach((overlay) => overlay.setMap?.(null))
      overlaysRef.current = []
      if (animationFrameRef.current != null) cancelAnimationFrame(animationFrameRef.current)
      animatedTripsRef.current.forEach((trip) => trip.marker.setMap?.(null))
      animatedTripsRef.current.clear()
      const map = mapRef.current as { __resizeObserver?: ResizeObserver | null } | null
      map?.__resizeObserver?.disconnect?.()
      mapRef.current?.destroy?.()
      mapRef.current = null
    }
  // The map is intentionally created once.  Data is painted by the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const AMap = window.AMap
    if (!map || !AMap || !overview) return
    overlaysRef.current.forEach((overlay) => overlay.setMap?.(null))
    overlaysRef.current = []
    const add = (overlay: any) => { overlay.setMap(map); overlaysRef.current.push(overlay) }
    const availabilityColor = (availability: string) => availability === 'idle' ? '#16a34a' : availability === 'serving' ? '#2563eb' : availability === 'returning' ? '#7c3aed' : '#f59e0b'
    if (!simulationEnabled) {
      animatedTripsRef.current.forEach((trip) => trip.marker.setMap?.(null))
      animatedTripsRef.current.clear()
    }
    // Keep a route at 100% for one render so the road marker reaches the
    // endpoint before the service/home marker takes over.
    const activeRouteIds = new Set(overview.routes.filter((route) => route.progress != null && route.progress <= 100).map((route) => route.order_id))
    const activeOutboundVolunteerIds = new Set(overview.routes
      .filter((route) => route.order_id > 0 && route.progress != null && route.progress <= 100)
      .map((route) => route.volunteer_id))
    const servingRouteIds = new Set(overview.routes.filter((route) => route.journey_type === 'serving').map((route) => route.order_id))
    const visibleOrderIds = new Set(overview.orders.map((order) => order.order_id))
    const finishingVolunteerIds = new Set<number>()
    animatedTripsRef.current.forEach((trip, orderId) => {
      // A new assignment cancels the negative-id return route.  It must not
      // finish the old purple animation to the home point, otherwise it looks
      // as though the new outbound journey restarted from the volunteer home.
      if (orderId < 0 && activeOutboundVolunteerIds.has(trip.volunteerId)) {
        trip.marker.setMap?.(null)
        animatedTripsRef.current.delete(orderId)
        return
      }
      if (servingRouteIds.has(orderId)) {
        // Another portal can poll first and move the shared order into
        // ``serving`` while this portal is still rendering the last few road
        // metres.  Never delete that marker immediately: let it finish along
        // the exact same polyline, then show the service marker.
        if (trip.displayed < 99.8) {
          trip.target = 100
          trip.motionRate = 0
          // The persisted one-second arrival hand-off normally means only a
          // few metres remain.  Finish those metres at the standard smooth
          // frame rate so the service status and marker change together.
          trip.rate = .006
          finishingVolunteerIds.add(trip.volunteerId)
        } else {
          trip.marker.setMap?.(null)
          animatedTripsRef.current.delete(orderId)
        }
        return
      }
      if (!activeRouteIds.has(orderId)) {
        // Cancellation removes the order and its dispatch route in the same
        // shared response.  It is not an arrival: stop the old vehicle at
        // once, otherwise a stale client marker keeps driving to the elder
        // after the order has been cancelled.
        if (orderId > 0 && !visibleOrderIds.has(orderId)) {
          trip.marker.setMap?.(null)
          animatedTripsRef.current.delete(orderId)
          return
        }
        // The server removes a completed route before the next five-second
        // polling response.  Let the already-rendered road marker cover the
        // final few percent instead of replacing it with a home marker.
        if (trip.displayed < 99.8) {
          trip.target = 100
          trip.motionRate = Math.max(trip.motionRate, 4)
          finishingVolunteerIds.add(trip.volunteerId)
        } else {
          trip.marker.setMap?.(null)
          animatedTripsRef.current.delete(orderId)
        }
      }
    })

    const focusPoints: Point[] = []
    overview.elders.forEach((elder) => {
      focusPoints.push([elder.lng, elder.lat])
      add(new AMap.Marker({
        position: [elder.lng, elder.lat], offset: new AMap.Pixel(-13, -13),
        content: markerHtml('#e11d48', '人', elder.name), label: { content: `${elder.name} · 实时位置`, direction: 'bottom', offset: new AMap.Pixel(0, 4), style: { fontSize: '11px', color: '#334155', border: '0', background: '#fff' } }, zIndex: 30,
      }))
    })
    const routedVolunteerIds = simulationEnabled
      ? new Set([...overview.routes.filter((route) => route.progress != null && route.progress <= 100).map((route) => route.volunteer_id), ...finishingVolunteerIds])
      : new Set<number>()
    overview.volunteers.filter((volunteer) => !routedVolunteerIds.has(volunteer.volunteer_id)).forEach((volunteer) => {
      focusPoints.push([volunteer.lng, volunteer.lat])
      add(new AMap.Marker({
        position: [volunteer.lng, volunteer.lat], offset: new AMap.Pixel(-13, -13),
        content: markerHtml('#2563eb', '志', volunteer.name), label: { content: `${volunteer.name} · 志愿者实时位置`, direction: 'bottom', offset: new AMap.Pixel(0, 4), style: { fontSize: '11px', color: '#1e3a8a', border: '0', background: '#eff6ff' } }, zIndex: 40,
      }))
    })
    overview.orders.filter((order) => order.lng != null && order.lat != null).forEach((order) => {
      focusPoints.push([order.lng!, order.lat!])
      add(new AMap.Marker({
        position: [order.lng!, order.lat!], offset: new AMap.Pixel(-11, -11),
        content: markerHtml(order.urgency === 'sos' ? '#dc2626' : '#ea580c', order.urgency === 'sos' ? 'SOS' : '单', order.service_type, 'order'),
        label: { content: `${order.elder_name} · 订单服务点`, direction: 'bottom', offset: new AMap.Pixel(0, 4), style: { fontSize: '11px', color: '#7c2d12', border: '0', background: '#fff7ed' } },
        zIndex: 50,
      }))
    })
    // Include the persisted road endpoints when fitting the command map.
    // Returning volunteers do not have an active order marker, so without
    // these points the map could frame only the district markers and make the
    // actual return road appear clipped or visually like a straight shortcut.
    overview.routes.forEach((route) => {
      if (route.path.length < 2) return
      focusPoints.push(route.path[0], route.path[route.path.length - 1])
    })

    // Fit once when the visible cast changes. Do NOT include live GPS coords,
    // otherwise every poll snaps zoom back after the volunteer zooms/pans.
    map.resize?.()
    const focusKey = [
      overview.region_adcode ?? '',
      // Elder positions change only through an explicit location/address
      // update. Include their coordinates so every authorised map reframes
      // once after that change, while frequent volunteer movement still does
      // not snap the user's zoom on every poll.
      ...overview.elders.map((item) => `e${item.elder_id}:${item.lng.toFixed(5)},${item.lat.toFixed(5)}`),
      ...overview.volunteers.map((item) => `v${item.volunteer_id}`),
      ...overview.orders.map((item) => `o${item.order_id}`),
      ...overview.routes.map((item) => `r${item.order_id}`),
    ].join('|')
    if (focusedRegionRef.current !== focusKey) {
      focusedRegionRef.current = focusKey
      userAdjustedViewRef.current = false
      if (focusPoints.length === 1) {
        map.setZoomAndCenter?.(14, focusPoints[0])
      } else if (focusPoints.length > 1) {
        const lngs = focusPoints.map((point) => point[0])
        const lats = focusPoints.map((point) => point[1])
        const pad = 0.008
        map.setBounds?.(new AMap.Bounds(
          [Math.min(...lngs) - pad, Math.min(...lats) - pad],
          [Math.max(...lngs) + pad, Math.max(...lats) + pad],
        ))
      } else if (overview.bounds) {
        const bounds = overview.bounds
        map.setBounds?.(new AMap.Bounds([bounds.west, bounds.south], [bounds.east, bounds.north]))
      }
    }
    const drawActualRoute = (route: DispatchRoute) => {
      const fallback = route.path
      if (fallback.length < 2) return
      const start = fallback[0]
      const end = fallback[fallback.length - 1]
      const journeyKey = route.journey_id
        || `${route.order_id}:${start[0].toFixed(5)},${start[1].toFixed(5)}:${end[0].toFixed(5)},${end[1].toFixed(5)}`
      const navigationMode = route.navigation_mode || 'driving'
      const key = `${route.order_id}:${route.traffic_version}:${navigationMode}:${start[0].toFixed(5)},${start[1].toFixed(5)}:${end[0].toFixed(5)},${end[1].toFixed(5)}`
      const isSos = overview.orders.some((order) => order.order_id === route.order_id && order.urgency === 'sos')
      const publishGeometry = (points: Point[], segments: AmapDrivingRoute['trafficSegments']) => {
        // The first portal that resolves the AMap driving route publishes a
        // compact road polyline.  Thereafter every portal and the backend
        // movement clock use the identical geometry, just like the sandbox.
        const signature = `${journeyKey}:${route.traffic_version}:${navigationMode}`
        if (publishedGeometryRef.current.has(signature) || points.length < 3) return
        publishedGeometryRef.current.add(signature)
        void http.post(`/dispatch/routes/${route.order_id}/geometry`, {
          volunteer_id: route.volunteer_id,
          path: compactPath(points, 320),
          traffic_segments: segments.map((segment) => ({ ...segment, path: compactPath(segment.path, 90) })),
          navigation_mode: navigationMode,
        }).catch(() => publishedGeometryRef.current.delete(signature))
      }
      const paint = (points: Point[], isFallback = false, routeWithTraffic: DispatchRoute = route) => {
        if (!mapRef.current || points.length < 2) return
        const history = sosRouteHistoryRef.current.get(route.order_id)
        const oldPath = isSos && history?.version !== route.traffic_version ? history?.path : history?.expiresAt && history.expiresAt > Date.now() ? history.oldPath : undefined
        if (isSos && oldPath?.length && oldPath.length > 1) add(new AMap.Polyline({ path: oldPath, strokeColor: '#94a3b8', strokeWeight: 4, strokeOpacity: .8, strokeStyle: 'dashed', zIndex: 21 }))
        if (isSos) sosRouteHistoryRef.current.set(route.order_id, { version: route.traffic_version, path: points, oldPath: history?.version !== route.traffic_version ? history?.path : history?.oldPath, expiresAt: history?.version !== route.traffic_version ? Date.now() + 6000 : history?.expiresAt })
        const segments = routeWithTraffic.traffic_segments?.length ? routeWithTraffic.traffic_segments : []
        // Green / yellow / red share one stroke style; only color differs.
        add(new AMap.Polyline({
          path: points,
          strokeColor: route.geometry_source === 'actual_gps' ? '#2563eb' : '#16a34a',
          strokeStyle: isFallback ? 'dashed' : 'solid',
          zIndex: 19,
          ...ROUTE_LINE_STYLE,
        }))
        segments.forEach((segment) => {
          const style = trafficStyle(segment.status)
          if (!style || segment.path.length < 2) return
          add(new AMap.Polyline({
            path: segment.path,
            strokeColor: style.color,
            strokeStyle: isFallback ? 'dashed' : 'solid',
            zIndex: 20 + style.severity,
            ...ROUTE_LINE_STYLE,
          }))
        })
        if (simulationEnabled && route.progress != null && route.progress <= 100) {
          const previous = routeProgressRef.current.get(route.order_id)
          const history = sosRouteHistoryRef.current.get(route.order_id)
          // A new traffic version starts at the responder's *current* point.
          // Never carry a percentage from the old route into the re-planned one.
          const isReplanned = isSos && history?.version === route.traffic_version && previous != null && route.progress < previous
          const fromProgress = isReplanned || previous == null ? route.progress : Math.min(previous, route.progress)
          const position = pointAlongPath(points, fromProgress)
          routeProgressRef.current.set(route.order_id, route.progress)
          const volunteer = overview.volunteers.find((item) => item.volunteer_id === route.volunteer_id)
          if (volunteer) {
            let trip = animatedTripsRef.current.get(route.order_id)
            if (!trip) {
              const marker = new AMap.Marker({ position, offset: new AMap.Pixel(-14, -14), content: markerHtml(availabilityColor(volunteer.availability), '车', `${volunteer.name} 行驶中`), zIndex: 60 })
              marker.setMap(map)
              trip = { marker, volunteerId: route.volunteer_id, journeyKey, path: points, displayed: fromProgress, target: route.progress, trafficVersion: route.traffic_version, rate: route.journey_type === 'returning' ? .003 : .006, motionRate: route.motion_rate ?? 0 }
              animatedTripsRef.current.set(route.order_id, trip)
            } else if (trip.trafficVersion !== route.traffic_version || trip.journeyKey !== journeyKey) {
              trip.journeyKey = journeyKey
              trip.path = points
              trip.displayed = route.progress
              trip.target = route.progress
              trip.trafficVersion = route.traffic_version
              trip.rate = route.journey_type === 'returning' ? .003 : .006
              trip.motionRate = route.motion_rate ?? 0
              trip.marker.setPosition(pointAlongPath(points, route.progress))
            } else {
              trip.path = points
              trip.target = trip.motionRate > 0 ? Math.max(trip.target, route.progress) : route.progress
              trip.rate = route.journey_type === 'returning' ? .003 : .006
              trip.motionRate = route.motion_rate ?? 0
            }
          }
          // The persistent marker above is updated on every animation frame.  Do not create a
          // second MoveAnimation marker here: two markers make the journey look like it jumps.
          if (volunteer && !animatedTripsRef.current.has(route.order_id)) {
            const marker = new AMap.Marker({
            position, offset: new AMap.Pixel(-13, -13),
            content: markerHtml(availabilityColor(volunteer.availability), route.journey_type === 'returning' ? '↩' : '🚗', `${volunteer.name} ${Math.round(route.progress)}%`),
            label: { content: `${volunteer.name} · ${Math.round(route.progress)}%`, direction: 'bottom', offset: new AMap.Pixel(0, 4), style: { fontSize: '11px', color: '#334155', border: '0', background: '#fff' } }, zIndex: 45,
            })
            add(marker)
            const target = pointAlongPath(points, route.progress)
            if (marker.moveAlong && fromProgress < route.progress) marker.moveAlong([position, target], { duration: 480, autoRotation: true })
            else if (fromProgress < route.progress) {
              const startedAt = performance.now()
              const animate = (now: number) => {
                const ratio = Math.min(1, (now - startedAt) / 480)
                marker.setPosition([position[0] + (target[0] - position[0]) * ratio, position[1] + (target[1] - position[1]) * ratio])
                if (ratio < 1) requestAnimationFrame(animate)
              }
              requestAnimationFrame(animate)
            } else marker.setPosition(target)
          }
        }
      }
      // A recorded GPS breadcrumb is evidence of the journey itself. Never
      // ask AMap to replace it with a newly planned road after completion.
      if (route.geometry_source === 'actual_gps' || fallback.length > 2) { paint(fallback); return }
      const cached = routeCache.current.get(key)
      if (cached) {
        paint(cached.path, false, { ...route, traffic_segments: cached.trafficSegments })
        return
      }
      const planner = navigationMode === 'walking'
        ? new AMap.Walking({ map: null, hideMarkers: true })
        : navigationMode === 'riding'
          ? new AMap.Riding({ map: null, hideMarkers: true })
          : new AMap.Driving({ policy: AMap.DrivingPolicy.REAL_TRAFFIC ?? AMap.DrivingPolicy.LEAST_TIME, extensions: 'all', showTraffic: true, map: null, hideMarkers: true })
      planner.search(new AMap.LngLat(...start), new AMap.LngLat(...end), (resultStatus: string, result: any) => {
        const points = resultStatus === 'complete' ? routePoints(result) : []
        if (points.length > 1) {
          const segments = navigationMode === 'driving' ? routeTrafficSegments(result) : []
          // Keep the TMC colours together with the geometry. Polling can hit
          // this cache before the shared backend write returns; caching only
          // `path` repainted the same road green one second after red/yellow
          // segments had first appeared.
          routeCache.current.set(key, { path: points, trafficSegments: segments })
          publishGeometry(points, segments)
          paint(points, false, { ...route, traffic_segments: segments })
        } else paint(fallback, true)
      })
    }
    overview.routes.forEach(drawActualRoute)
  }, [overview, status])

  const routeTrafficStatuses = (overview?.routes ?? [])
    .flatMap((route) => route.traffic_segments ?? [])
    .map((segment) => segment.status)
    .filter(Boolean)
  const hasCongestion = routeTrafficStatuses.some((status) => status.includes('拥堵'))
  const hasSlowTraffic = routeTrafficStatuses.some((status) => status.includes('缓行'))
  const hasClearTraffic = routeTrafficStatuses.some((status) => status.includes('畅通'))
  const trafficSummary = hasCongestion
    ? '高德本次规划：存在拥堵路段'
    : hasSlowTraffic
      ? '高德本次规划：存在缓行路段'
      : hasClearTraffic
        ? '高德本次规划：返回路段均为畅通'
        : '高德未返回分段路况，绿色仅为默认路线底色'

  return <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100" style={{ height }}>
    <div ref={containerRef} className="h-full w-full" />
    {status !== 'ready' ? <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm text-white">{status === 'loading' ? '正在加载高德真实地图与路况…' : `高德地图不可用：${error}`}</div> : null}
    <div className="pointer-events-none absolute left-3 top-3 rounded-xl bg-slate-950/85 px-3 py-2 text-xs text-white shadow-lg"><div className="font-semibold">{overview?.region_name || '当前服务区县'} · 人单分离地图</div><div className="mt-1 text-[11px] text-slate-200"><span className="text-rose-300">● 老人实时位置</span> · <span className="text-blue-300">● 志愿者实时位置</span> · <span className="text-orange-300">◆ 订单服务位置</span></div><div className="mt-2 flex gap-3 text-[11px]"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400" />畅通</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />缓行</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500" />拥堵</span></div></div>
    {(expandable || onExpand) ? (
      <button
        type="button"
        className="absolute right-3 top-3 z-10 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-medium text-white shadow hover:bg-emerald-500"
        onClick={(event) => {
          event.stopPropagation()
          onExpand?.()
        }}
      >
        导航大图
      </button>
    ) : null}
    <div className="pointer-events-none absolute bottom-3 right-3 rounded-lg bg-white/95 px-2 py-1 text-[11px] font-medium text-slate-700">{trafficSummary}</div>
  </div>
}
