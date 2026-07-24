import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Progress, Select, Slider, Tag } from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'

import { DispatchMap, getAmapDrivingRoute } from '@/features/dispatch/components/DispatchMap'
import type { DispatchMapData, DispatchOverview, DispatchOrder, DispatchRoute } from '@/features/dispatch/dispatch-types'

type Point = [number, number]
type VolunteerMode = 'idle' | 'routing' | 'en_route' | 'serving' | 'returning'
type OrderState = 'waiting' | 'routing' | 'en_route' | 'serving' | 'completed'

type SimVolunteer = DispatchMapData['volunteers'][number] & {
  home: Point
  point: Point
  mode: VolunteerMode
  currentOrderId?: number
}
type SimOrder = {
  id: number
  elderId: number
  serviceType: string
  requiredSkills: string[]
  urgency: 'normal' | 'sos'
  createdAt: number
  state: OrderState
  volunteerId?: number
  stage: number
  /** 0=SOS P0, 1=escalated P1, 2=normal P2 */
  priorityTier: number
  dispatchAt: number
  phase?: 'top1' | 'top3' | 'top10' | 'fallback'
  manualConfirmAt?: number
}
type SimTrip = {
  id: string
  volunteerId: number
  orderId?: number
  kind: 'service' | 'return'
  path: Point[]
  progress: number
  distanceKm: number
  etaMinutes: number
  trafficVersion: number
  startedAt: number
  serviceLeft?: number
  congested?: boolean
  trafficSegments: Array<{ path: Point[]; status: string }>
}
type Runtime = {
  now: number
  nextOrderId: number
  trafficVersion: number
  volunteers: SimVolunteer[]
  orders: SimOrder[]
  trips: SimTrip[]
  events: string[]
  scheduled: Array<{ at: number; elderId: number; serviceType: string; urgency: 'normal' | 'sos' }>
}

const TICK_MS = 250
const NEAR_SECONDS = 10
const FAR_SECONDS = 20
const SERVICE_SECONDS = 4
const DISPATCH_DELAY_SECONDS = 1.5

function distanceKm(from: Point, to: Point) {
  const rad = Math.PI / 180
  const lat = (to[1] - from[1]) * rad
  const lng = (to[0] - from[0]) * rad
  const a = Math.sin(lat / 2) ** 2 + Math.cos(from[1] * rad) * Math.cos(to[1] * rad) * Math.sin(lng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function pathDistance(path: Point[]) {
  return path.slice(1).reduce((sum, point, index) => sum + distanceKm(path[index], point), 0)
}

function pointAt(path: Point[], progress: number): Point {
  if (path.length < 2) return path[0] || [121.45, 31.4]
  const lengths = path.slice(1).map((point, index) => distanceKm(path[index], point))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  const target = total * Math.min(1, Math.max(0, progress))
  let walked = 0
  for (let index = 0; index < lengths.length; index += 1) {
    if (walked + lengths[index] >= target) {
      const ratio = lengths[index] ? (target - walked) / lengths[index] : 0
      return [path[index][0] + (path[index + 1][0] - path[index][0]) * ratio, path[index][1] + (path[index + 1][1] - path[index][1]) * ratio]
    }
    walked += lengths[index]
  }
  return path[path.length - 1]
}

function routeMateriallyChanged(oldPath: Point[], oldProgress: number, newPath: Point[]) {
  if (oldPath.length < 2 || newPath.length < 2) return true
  // Compare the remaining route at several equal-distance points.  A new start
  // position alone must not count as a reroute; at least one point must differ
  // by roughly one city block (80m).
  return [.25, .5, .75].some((ratio) => {
    const previous = pointAt(oldPath, oldProgress + (1 - oldProgress) * ratio)
    const next = pointAt(newPath, ratio)
    return distanceKm(previous, next) >= .08
  })
}

function hash(value: string) {
  return [...value].reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) % 997, 7)
}

function roadSpeed(trip: SimTrip, now: number) {
  if (trip.congested) return 8
  const phase = (hash(`${trip.id}:${trip.trafficVersion}`) + Math.floor(now / 4)) % 7
  return phase === 0 ? 15 : phase <= 2 ? 27 : 44
}

function label(mode: VolunteerMode) {
  return ({ idle: '空闲待命', routing: '规划路线', en_route: '前往老人家', serving: '正在服务', returning: '返程中' } as Record<VolunteerMode, string>)[mode]
}

export function DispatchSimulationPanel({ overview }: { overview: DispatchOverview | null }) {
  const runtimeRef = useRef<Runtime | null>(null)
  const runningRef = useRef(false)
  const routeSerialRef = useRef(0)
  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [revision, setRevision] = useState(0)
  const [rerouteNotice, setRerouteNotice] = useState('')
  const [selectedElder, setSelectedElder] = useState<number>()
  const [selectedService, setSelectedService] = useState<string>()

  const catalog = overview?.service_catalog ?? []
  const elders = overview?.elders ?? []

  const initialise = () => {
    if (!overview) return
    const simulationSkills = [
      ['medical_support', 'emergency_response', 'errand'],
      ['companion', 'rehab', 'mobility_assist'],
      ['grooming', 'digital_assist', 'errand'],
      ['medical_support', 'emergency_response'],
      ['companion', 'rehab', 'digital_assist'],
    ]
    const volunteers = overview.volunteers.slice(0, 5).map((volunteer, index) => {
      const point: Point = [volunteer.lng, volunteer.lat]
      return {
        ...volunteer,
        point,
        home: [volunteer.home_lng ?? point[0], volunteer.home_lat ?? point[1]] as Point,
        mode: 'idle' as VolunteerMode,
        // 3 nearby first responders plus 2 remote backups. These are fixed
        // demo certifications, so the hard skill gate is reproducible.
        skills: simulationSkills[index],
        assigned_today: volunteer.assigned_today + (index >= 3 ? 1 : 0),
        // Mirror live SOS gates: auto-accept + rating ≥ 4.
        auto_accept_enabled: true,
        rating: Math.max(Number(volunteer.rating) || 0, 4.2),
      }
    })
    const usefulElders = overview.elders.slice(0, 15)
    const normalServices = catalog.filter((item) => !item.urgent).map((item) => item.code)
    // 15 different elders: the first burst produces a queue, the SOS at 3.2s
    // takes the head, mid-script requests show direct chaining, and the final
    // requests arrive after an idle worker has started the return journey.
    const scriptTimes = [0, .6, 1.2, 1.8, 2.4, 3.2, 4, 4.8, 12, 14, 16, 18, 27, 29, 31]
    const defaults = scriptTimes.map((at, index) => ({
      at,
      elderId: usefulElders[index]?.elder_id,
      serviceType: normalServices[index % Math.max(1, normalServices.length)] ?? catalog[0]?.code,
      urgency: index === 5 ? 'sos' as const : 'normal' as const,
    })).filter((item) => item.elderId && item.serviceType) as Runtime['scheduled']
    runtimeRef.current = { now: 0, nextOrderId: 9001, trafficVersion: 1, volunteers, orders: [], trips: [], events: ['演示已重置：请求将分批进入，全部由智能引擎自动派单。'], scheduled: defaults }
    setRerouteNotice('')
    setSelectedElder(usefulElders[0]?.elder_id)
    setSelectedService(catalog[0]?.code)
    setRevision((value) => value + 1)
  }

  useEffect(() => { initialise() }, [overview?.traffic_version])

  const addOrder = (elderId?: number, serviceType?: string, urgency: 'normal' | 'sos' = 'normal') => {
    const runtime = runtimeRef.current
    if (!runtime || !elderId || !serviceType) return
    const service = urgency === 'sos' ? catalog.find((item) => item.urgent) : catalog.find((item) => item.code === serviceType)
    if (!service) return
    const displayService = urgency === 'sos' ? `${service.label} · 突发身体不适` : service.label
    const id = runtime.nextOrderId++
    // Most requests demonstrate a Top1 confirmation; every third request is
    // deliberately left unanswered so Top3, Top10 and fallback are visible.
    const manualConfirmAt = urgency === 'normal' && id % 3 !== 0 ? runtime.now + 3.5 + (id % 2) : undefined
    runtime.orders.push({
      id,
      elderId,
      serviceType: displayService,
      requiredSkills: service.skills,
      urgency,
      createdAt: runtime.now,
      dispatchAt: runtime.now + DISPATCH_DELAY_SECONDS,
      state: 'waiting',
      stage: 0,
      priorityTier: urgency === 'sos' ? 0 : 2,
      manualConfirmAt,
    })
    const elder = elders.find((item) => item.elder_id === elderId)
    runtime.events.unshift(`${urgency === 'sos' ? 'SOS' : '普通'}请求 #${runtime.nextOrderId - 1}：${elder?.name ?? '老人'} / ${service.label} 已进入队列`)
    setRevision((value) => value + 1)
  }

  const startTrip = async (runtime: Runtime, volunteer: SimVolunteer, order: SimOrder | undefined, kind: 'service' | 'return', rerouted = false, previous?: SimTrip) => {
    const serial = ++routeSerialRef.current
    const end: Point = kind === 'return' ? volunteer.home : (() => {
      const elder = elders.find((item) => item.elder_id === order?.elderId)
      return [elder?.lng ?? volunteer.point[0], elder?.lat ?? volunteer.point[1]] as Point
    })()
    volunteer.mode = 'routing'
    volunteer.currentOrderId = order?.id
    if (order) { order.state = 'routing'; order.volunteerId = volunteer.volunteer_id }
    const start = volunteer.point
    try {
      const refreshSlot = String(Math.floor(Date.now() / 60_000))
      let drivingRoute = await getAmapDrivingRoute(start, end, 'REAL_TRAFFIC', refreshSlot)
      if (!drivingRoute.geometryResolved) throw new Error('AMap road geometry is not ready')
      let path = drivingRoute.path
      if (runtimeRef.current !== runtime || serial > routeSerialRef.current) return
      let changed = !rerouted || !previous || routeMateriallyChanged(previous.path, previous.progress, path)
      // In a classroom simulation the AMap live-traffic policy can occasionally
      // select the same road. Ask AMap for a second real-road alternative before
      // concluding that there is no usable detour.
      if (rerouted && previous && !changed) {
        const alternative = await getAmapDrivingRoute(start, end, 'LEAST_DISTANCE', refreshSlot)
        if (alternative.geometryResolved && routeMateriallyChanged(previous.path, previous.progress, alternative.path)) {
          drivingRoute = alternative
          path = alternative.path
          changed = true
        }
      }
      const remainingKm = Math.max(.1, previous ? previous.distanceKm * (1 - previous.progress) : pathDistance(path))
      const oldCongestedEta = Math.ceil(remainingKm / 8 * 60)
      const distanceKm = Math.max(.1, drivingRoute.distanceKm || pathDistance(path))
      const newEta = rerouted && !changed ? Math.ceil(distanceKm / 8 * 60) : Math.max(1, drivingRoute.etaMinutes)
      const trip: SimTrip = { id: `${kind}-${order?.id ?? volunteer.volunteer_id}-${runtime.now}`, volunteerId: volunteer.volunteer_id, orderId: order?.id, kind, path, progress: 0, distanceKm, etaMinutes: newEta, trafficVersion: changed ? runtime.trafficVersion : previous?.trafficVersion ?? runtime.trafficVersion, startedAt: runtime.now, congested: rerouted && !changed, trafficSegments: drivingRoute.trafficSegments }
      runtime.trips = runtime.trips.filter((item) => item.volunteerId !== volunteer.volunteer_id)
      runtime.trips.push(trip)
      volunteer.mode = kind === 'return' ? 'returning' : 'en_route'
      if (order) order.state = 'en_route'
      if (rerouted && order && changed) {
        const notice = `SOS #${order.id} 重规划成功：原路线拥堵后预计 ${oldCongestedEta} 分钟，新路线预计 ${newEta} 分钟；${volunteer.name} 已切换新路线。`
        setRerouteNotice(notice)
        runtime.events.unshift(notice)
      } else if (rerouted && order) {
        runtime.events.unshift(`SOS #${order.id} 未找到更优绕行路线：当前道路拥堵，车辆已降速至 8 km/h，预计 ${newEta} 分钟到达。`)
      } else {
        runtime.events.unshift(`${volunteer.name} ${kind === 'return' ? '开始返程' : `已接 #${order?.id}，沿高德最优路线出发`}`)
      }
    } catch {
      volunteer.mode = 'idle'
      volunteer.currentOrderId = undefined
      if (order) { order.state = 'waiting'; order.volunteerId = undefined }
      runtime.events.unshift(`${volunteer.name} 路线获取失败，订单重新排队。`)
    }
  }

  const dispatch = (runtime: Runtime) => {
    // P0 SOS → P1 escalated (after 35s fallback) → P2 normal Top windows.
    const queue = runtime.orders
      .filter((order) => order.state === 'waiting' && runtime.now >= order.dispatchAt)
      .sort((a, b) => {
        if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier
        return a.createdAt - b.createdAt
      })

    const sosWaiting = queue.filter((order) => order.urgency === 'sos')
    const reservedForSos = new Set<number>()
    sosWaiting.forEach((sos) => {
      runtime.volunteers.forEach((volunteer) => {
        const skillOK = sos.requiredSkills.every((skill) => volunteer.skills.includes(skill))
        const available = volunteer.mode === 'idle' || volunteer.mode === 'returning'
        if (
          skillOK
          && available
          && volunteer.auto_accept_enabled
          && Number(volunteer.rating) >= 4
          && !reservedForSos.has(volunteer.volunteer_id)
        ) {
          reservedForSos.add(volunteer.volunteer_id)
        }
      })
    })

    queue.forEach((order) => {
      const elder = elders.find((item) => item.elder_id === order.elderId)
      if (!elder) return
      const waited = runtime.now - order.createdAt
      const phase: SimOrder['phase'] = order.urgency === 'sos'
        ? 'fallback'
        : waited >= 35
          ? 'fallback'
          : waited >= 20
            ? 'top10'
            : waited >= 8
              ? 'top3'
              : 'top1'
      const stage = phase === 'top1' ? 1 : phase === 'top3' ? 2 : phase === 'top10' ? 3 : 4
      const priorityTier = order.urgency === 'sos' ? 0 : phase === 'fallback' ? 1 : 2
      if (order.phase !== phase || order.priorityTier !== priorityTier) {
        order.phase = phase
        order.stage = stage
        order.priorityTier = priorityTier
        runtime.events.unshift(
          order.urgency === 'sos'
            ? `SOS #${order.id} 进入 P0 最高优先队列，立即强制调度。`
            : phase === 'fallback'
              ? `请求 #${order.id} 升入 P1 升级队列（Top10 + 自动接单兜底）。`
              : `请求 #${order.id} 处于 P2：${phase === 'top1' ? 'Top1 专属确认' : phase === 'top3' ? 'Top3 抢单' : 'Top10 扩散抢单'}。`,
        )
      }
      const choices = runtime.volunteers.filter((volunteer) => {
        const skillOK = order.requiredSkills.every((skill) => volunteer.skills.includes(skill))
        const available = volunteer.mode === 'idle' || volunteer.mode === 'returning'
        if (!skillOK || !available) return false
        // P0 SOS capacity hold: do not let P1/P2 drain excellent auto-accept people.
        if (order.urgency !== 'sos' && reservedForSos.has(volunteer.volunteer_id)) return false
        return true
      }).map((volunteer) => {
        const km = distanceKm(volunteer.point, [elder.lng, elder.lat])
        const traffic = 58 + (hash(`${order.id}-${volunteer.volunteer_id}-${runtime.trafficVersion}`) % 39)
        const fatigue = Math.max(0, 100 - volunteer.fatigue * 10 - volunteer.assigned_today * 5)
        const rating = volunteer.rating * 20
        const total = Math.max(0, 100 - km * 12) * .4 + traffic * .25 + fatigue * .1 + rating * .25
        return { volunteer, km, total }
      }).sort((a, b) => b.total - a.total)

      const visibleCap = phase === 'top1' ? 1 : phase === 'top3' ? 3 : phase === 'top10' ? 10 : choices.length
      const visible = choices.slice(0, visibleCap)
      const picked = order.urgency === 'sos'
        ? choices
          .filter((item) => item.volunteer.auto_accept_enabled && Number(item.volunteer.rating) >= 4)
          .sort((a, b) => a.km - b.km || b.total - a.total)[0]
        : phase === 'fallback'
          ? choices.find((item) => item.volunteer.auto_accept_enabled)
          : order.manualConfirmAt != null && runtime.now >= order.manualConfirmAt
            ? visible[0]
            : undefined
      if (!picked) return
      if (picked.volunteer.mode === 'returning') runtime.trips = runtime.trips.filter((trip) => trip.volunteerId !== picked.volunteer.volunteer_id)
      reservedForSos.delete(picked.volunteer.volunteer_id)
      runtime.events.unshift(
        `${order.urgency === 'sos' ? 'P0 SOS强制派单' : phase === 'fallback' ? 'P1 自动兜底' : 'P2 手动确认接单'} #${order.id} → ${picked.volunteer.name}（${picked.km.toFixed(2)}km，综合 ${picked.total.toFixed(1)}）`,
      )
      void startTrip(runtime, picked.volunteer, order, 'service')
    })
  }

  const trafficShock = () => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.trafficVersion += 1
    setRerouteNotice('')
    const sosTrips = runtime.trips.filter((trip) => runtime.orders.find((order) => order.id === trip.orderId)?.urgency === 'sos' && trip.kind === 'service')
    sosTrips.forEach((trip) => {
      const volunteer = runtime.volunteers.find((item) => item.volunteer_id === trip.volunteerId)
      const order = runtime.orders.find((item) => item.id === trip.orderId)
      const elder = elders.find((item) => item.elder_id === order?.elderId)
      if (!volunteer || !elder) return
      volunteer.point = pointAt(trip.path, trip.progress)
      runtime.trips = runtime.trips.filter((item) => item !== trip)
      runtime.events.unshift(`SOS #${order?.id} 检测到路况突变：从当前位置重新规划最优路线。`)
      void startTrip(runtime, volunteer, order, 'service', true, trip)
    })
    if (!sosTrips.length) runtime.events.unshift('路况已变化；下一笔 SOS 会以最新路况规划。')
    setRevision((value) => value + 1)
  }

  const tick = () => {
    const runtime = runtimeRef.current
    if (!runtime || !runningRef.current) return
    runtime.now += TICK_MS / 1000
    runtime.scheduled.filter((item) => item.at <= runtime.now).forEach((item) => {
      addOrder(item.elderId, item.serviceType, item.urgency)
    })
    runtime.scheduled = runtime.scheduled.filter((item) => item.at > runtime.now)
    runtime.trips.slice().forEach((trip) => {
      const volunteer = runtime.volunteers.find((item) => item.volunteer_id === trip.volunteerId)
      const order = runtime.orders.find((item) => item.id === trip.orderId)
      if (!volunteer) return
      if (trip.serviceLeft != null) {
        trip.serviceLeft -= TICK_MS / 1000
        if (trip.serviceLeft > 0) return
        runtime.trips = runtime.trips.filter((item) => item !== trip)
        if (order) { order.state = 'completed'; volunteer.fatigue += 1; volunteer.assigned_today += 1; runtime.events.unshift(`${volunteer.name} 完成 #${order.id}；立即扫描下一笔最优请求。`) }
        volunteer.mode = 'idle'; volunteer.currentOrderId = undefined
        return
      }
      // Simulation time is accelerated, but the marker itself moves continuously between these 250ms samples.
      trip.progress = Math.min(1, trip.progress + (roadSpeed(trip, runtime.now) / 3600 * (TICK_MS / 1000) * speed * 13) / trip.distanceKm)
      volunteer.point = pointAt(trip.path, trip.progress)
      if (trip.progress < 1) return
      if (trip.kind === 'return') {
        runtime.trips = runtime.trips.filter((item) => item !== trip)
        volunteer.mode = 'idle'; volunteer.point = volunteer.home; volunteer.currentOrderId = undefined
        runtime.events.unshift(`${volunteer.name} 已回到起始地址待命。`)
      } else if (order) {
        volunteer.mode = 'serving'; order.state = 'serving'; trip.serviceLeft = SERVICE_SECONDS / Math.max(1, speed / 2)
        runtime.events.unshift(`${volunteer.name} 已到达 ${elders.find((item) => item.elder_id === order.elderId)?.name ?? '老人'} 家，开始服务。`)
      }
    })
    dispatch(runtime)
    runtime.volunteers.filter((volunteer) => volunteer.mode === 'idle').forEach((volunteer) => {
      if (!runtime.orders.some((order) => order.state === 'waiting' || order.state === 'routing') && distanceKm(volunteer.point, volunteer.home) > .04) void startTrip(runtime, volunteer, undefined, 'return')
    })
    setRevision((value) => value + 1)
  }

  useEffect(() => {
    const timer = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(timer)
  })

  const view = useMemo(() => {
    const runtime = runtimeRef.current
    if (!overview || !runtime) return null
    const orderRows: DispatchOrder[] = runtime.orders.filter((order) => order.state !== 'completed').map((order) => {
      const elder = elders.find((item) => item.elder_id === order.elderId)
      const volunteer = runtime.volunteers.find((item) => item.volunteer_id === order.volunteerId)
      const route = runtime.trips.find((trip) => trip.orderId === order.id)
      return { order_id: order.id, service_type: order.serviceType, status: order.state === 'serving' ? 'in_progress' : order.state === 'waiting' ? 'pending' : 'accepted', volunteer_id: volunteer?.volunteer_id, volunteer_name: volunteer?.name, elder_name: elder?.name ?? '未知老人', urgency: order.urgency, dispatch_state: order.state, search_stage: order.stage, forced_assignment: order.urgency === 'sos', lng: elder?.lng, lat: elder?.lat, route: route ? { order_id: order.id, volunteer_id: route.volunteerId, eta_minutes: Math.max(1, Math.ceil((route.distanceKm * (1 - route.progress)) / 0.5)), traffic_version: route.trafficVersion, path: route.path, distance_km: route.distanceKm, progress: route.progress * 100 } : null }
    })
    const routes: DispatchRoute[] = runtime.trips.map((trip) => ({ order_id: trip.orderId ?? -trip.volunteerId, volunteer_id: trip.volunteerId, eta_minutes: Math.max(1, Math.ceil(trip.etaMinutes * (1 - trip.progress))), traffic_version: trip.trafficVersion, path: trip.path, distance_km: trip.distanceKm, progress: trip.progress * 100, journey_type: trip.kind === 'return' ? 'returning' : 'service', congested: trip.congested, traffic_segments: trip.trafficSegments }))
    return { ...overview, volunteers: runtime.volunteers.map(({ point, mode, home, ...volunteer }) => ({ ...volunteer, lng: point[0], lat: point[1], availability: mode, home_lng: home[0], home_lat: home[1] })), orders: orderRows, routes, traffic_version: runtime.trafficVersion } as DispatchOverview
  }, [overview, revision])

  const runtime = runtimeRef.current
  const queue = runtime?.orders.filter((order) => order.state === 'waiting' || order.state === 'routing').sort((a, b) => (a.priorityTier !== b.priorityTier ? a.priorityTier - b.priorityTier : a.createdAt - b.createdAt)) ?? []
  const active = runtime?.orders.filter((order) => ['en_route', 'serving', 'routing'].includes(order.state)) ?? []

  if (!overview || !runtime) return <Card className="!rounded-2xl">正在准备智能调度沙盘…</Card>
  return <Card className="!rounded-2xl" title="连续智能派单沙盘（全部自动接单）" extra={<Tag color={running ? 'green' : 'default'}>{running ? '演示运行中' : '已暂停'}</Tag>}>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button type="primary" icon={running ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={() => { runningRef.current = !running; setRunning(runningRef.current) }}>{running ? '暂停演示' : '开始连续演示'}</Button>
      <Button onClick={initialise}>重置场景</Button>
      <span className="ml-2 text-sm text-slate-500">速度</span><Slider className="w-28" min={1} max={8} value={speed} onChange={setSpeed} />
      <Select className="min-w-36" value={selectedElder} options={elders.slice(0, 25).map((elder) => ({ value: elder.elder_id, label: elder.name }))} onChange={setSelectedElder} />
      <Select className="min-w-36" value={selectedService} options={catalog.map((service) => ({ value: service.code, label: service.label }))} onChange={setSelectedService} />
      <Button icon={<PlusOutlined />} onClick={() => addOrder(selectedElder, selectedService)}>手动加普通请求</Button>
      <Button danger icon={<PlusOutlined />} onClick={() => addOrder(selectedElder, selectedService, 'sos')}>手动加 SOS</Button>
      <Button icon={<ThunderboltOutlined />} onClick={trafficShock}>SOS 路况突变并重规划</Button>
    </div>
    {rerouteNotice ? <div className="mb-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">✓ {rerouteNotice}</div> : null}
    <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">规则：三级优先队列 <b>P0 SOS</b> → <b>P1 升级</b>（35秒后兜底）→ <b>P2 普通</b>（Top1→Top3→Top10）。SOS 只派给「自动接单 + 技能匹配 + 评分≥4 + 空闲/返程」，并优先占用这些人的运力；普通单不能抢走。评分 = 距离 40% + 路况 25% + 疲劳 10% + 服务评分 25%；前往/服务中不派新单，服务结束后返程即可再接。</div>
    <div className="grid gap-3 lg:grid-cols-3">
      <Card size="small" title={`当前服务 / 出发 (${active.length})`}><div className="space-y-2 text-sm">{active.slice(0, 5).map((order) => { const volunteer = runtime.volunteers.find((item) => item.volunteer_id === order.volunteerId); const elder = elders.find((item) => item.elder_id === order.elderId); const trip = runtime.trips.find((item) => item.orderId === order.id); return <div key={order.id} className="rounded-lg bg-blue-50 p-2"><b>{volunteer?.name}</b> → <b>{elder?.name}</b><div className="text-xs text-blue-700">#{order.id} {order.state === 'serving' ? '服务中' : '沿真实路线前往'} {trip ? `${Math.round(trip.progress * 100)}%` : '规划中'}</div>{trip ? <Progress size="small" percent={Math.round(trip.progress * 100)} showInfo={false} /> : null}</div> }) || <span className="text-slate-400">尚无进行中的请求</span>}</div></Card>
      <Card size="small" title={`优先队列 (${queue.length})`}><div className="space-y-2 text-sm">{queue.slice(0, 5).map((order, index) => <div key={order.id} className={`rounded-lg p-2 ${order.urgency === 'sos' ? 'bg-red-50 text-red-800' : order.priorityTier === 1 ? 'bg-violet-50 text-violet-800' : 'bg-amber-50 text-amber-800'}`}><b>#{index + 1} #{order.id}</b> {order.serviceType} <Tag color={order.urgency === 'sos' ? 'red' : order.priorityTier === 1 ? 'purple' : 'orange'}>{order.urgency === 'sos' ? 'P0 SOS' : order.priorityTier === 1 ? 'P1 升级' : `P2 · 第 ${order.stage || 1} 圈`}</Tag><div className="text-xs">{order.state === 'routing' ? '正在锁定最优志愿者和路线' : `等待 ${Math.floor(runtime.now - order.createdAt)} 秒`}</div></div>) || <span className="text-slate-400">队列为空</span>}</div></Card>
      <Card size="small" title="全员自动调度方案"><div className="max-h-40 space-y-1 overflow-auto text-sm">{runtime.volunteers.map((volunteer) => <div key={volunteer.volunteer_id} className="flex justify-between rounded bg-slate-50 px-2 py-1"><span><b>{volunteer.name}</b> · {label(volunteer.mode)}</span><span className="text-xs text-slate-500">疲劳 {volunteer.fatigue} / 评分 {volunteer.rating}</span></div>)}</div></Card>
    </div>
    <div className="mt-3"><DispatchMap overview={view} height={500} /></div>
    <div className="mt-3 max-h-32 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">{runtime.events.slice(0, 10).map((event, index) => <div key={`${event}-${index}`} className="py-0.5"><span className="text-sky-300">[{runtime.now.toFixed(1)}s]</span> {event}</div>)}</div>
  </Card>
}
