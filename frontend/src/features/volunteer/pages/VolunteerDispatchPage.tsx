import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Card, Modal, Progress, Space, Switch, Tag, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, EnvironmentOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import {
  DispatchMap,
  formatNavDistance,
  getAmapRoute,
  getAmapPointAtProgress,
  pickUpcomingNavSteps,
  type AmapNavStep,
} from '@/features/dispatch/components/DispatchMap'
import { VolunteerNavMap } from '@/features/dispatch/components/VolunteerNavMap'
import type { DispatchRoute, DispatchTracking, NavigationMode, VolunteerDispatchTask } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { fetchDispatchTracking, fetchVolunteerDispatchFeed, redispatchDispatchOrder, requestAdminForDispatchOrder, respondDispatchOrder, updateVolunteerDispatchPreferences, updateVolunteerNavigationRoute } from '@/services/adapters/dispatch-adapter'
import { updateVolunteerLiveLocation } from '@/services/adapters/profile-adapter'
import { captureBrowserLocation } from '@/utils/browser-geolocation'

function NavStepsList({ steps, title }: { steps: AmapNavStep[]; title?: string }) {
  if (!steps.length) {
    return <div className="text-sm text-slate-500">暂无转弯提示，接单出发后会根据高德路线生成。</div>
  }
  return (
    <div className="space-y-2">
      {title ? <div className="text-sm font-medium text-slate-700">{title}</div> : null}
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={`${step.instruction}-${index}`}
            className={`rounded-xl border px-3 py-2 text-sm ${index === 0 ? 'border-blue-300 bg-blue-50 text-blue-950' : 'border-slate-200 bg-white text-slate-700'}`}
          >
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${index === 0 ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {step.distanceMeters > 0 ? `约 ${formatNavDistance(step.distanceMeters)}后` : '接着'}
                  {' '}
                  {step.instruction || '沿道路继续前行'}
                </div>
                {step.road ? <div className="mt-0.5 text-xs text-slate-500">道路：{step.road}</div> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function compactNavigationPath(path: Array<[number, number]>, maxPoints = 320) {
  if (path.length <= maxPoints) return path
  const step = (path.length - 1) / (maxPoints - 1)
  return Array.from({ length: maxPoints }, (_, index) => path[Math.round(index * step)])
}

export default function VolunteerDispatchPage() {
  const { session } = useSession()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const simulationEnabled = import.meta.env.VITE_ENABLE_SIMULATION === 'true'
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [tasks, setTasks] = useState<VolunteerDispatchTask[]>([])
  const [state, setState] = useState({ availability: 'idle', fatigue_score: 0, service_rating: 0, assigned_today: 0, auto_accept_enabled: false, home_lng: null as number | null, home_lat: null as number | null })
  const [working, setWorking] = useState<number | 'return' | null>(null)
  const [issueWorking, setIssueWorking] = useState<number | null>(null)
  const [mapExpanded, setMapExpanded] = useState(false)
  const [navSteps, setNavSteps] = useState<AmapNavStep[]>([])
  const [plannedNavSteps, setPlannedNavSteps] = useState<AmapNavStep[]>([])
  const [navMeta, setNavMeta] = useState<{ distanceKm?: number; etaMinutes?: number; progress?: number }>({})
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('driving')
  const [plannedRoute, setPlannedRoute] = useState<DispatchRoute | null>(null)
  const [switchingNavigationMode, setSwitchingNavigationMode] = useState(false)
  const announcedAutoOrder = useRef<number | null>(null)
  const initializedNavigationRoutes = useRef(new Set<string>())
  const returnGuidanceLastCommitAt = useRef(0)
  const returnGuidanceJourneyKey = useRef('')

  const load = async () => {
    if (!session) return
    const [map, feed] = await Promise.all([fetchDispatchTracking('volunteer', session.userId), fetchVolunteerDispatchFeed(session.userId)])
    setTracking(map); setTasks(feed.tasks); setState(feed.state as typeof state)
    const autoOrder = map.auto_assignment
    if (autoOrder && announcedAutoOrder.current !== autoOrder.order_id) {
      announcedAutoOrder.current = autoOrder.order_id
      message.success(`系统已自动接单：${autoOrder.elder_name}的${autoOrder.service_type}，已从当前位置规划路线。`, 6)
    }
    if (!autoOrder) announcedAutoOrder.current = null
  }
  useEffect(() => {
    let stopped = false
    let timer = 0
    const refresh = async () => {
      await load().catch(() => {})
      if (!stopped) timer = window.setTimeout(refresh, 1000)
    }
    void refresh()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [session?.userId])

  const activeNavTask = useMemo(() => {
    const active = tasks.find((task) => ['accepted', 'in_progress'].includes(task.status) && task.route?.path?.length)
    if (active) return active
    return tasks.find((task) => task.route?.path?.length && task.lng != null && task.lat != null)
  }, [tasks])

  useEffect(() => {
    if (!session || !activeNavTask || !navigator.geolocation) return
    let lastUploadAt = 0
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now()
        if (now - lastUploadAt < 8_000) return
        lastUploadAt = now
        void updateVolunteerLiveLocation(
          session.userId,
          position.coords.longitude,
          position.coords.latitude,
          { fromGps: true, accuracyMeters: position.coords.accuracy },
        ).catch(() => undefined)
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [activeNavTask?.order_id, session?.userId])

  const returningHome = state.availability === 'returning'
  const activeRoute = useMemo(() => {
    // Once return mode starts, never let a recently completed outbound task
    // override the dedicated home route while the task feed catches up.
    if (returningHome) return tracking?.return_route
    if (activeNavTask?.route) return activeNavTask.route
    if (state.availability === 'serving') return undefined
    return tracking?.routes?.[0]
  }, [activeNavTask, returningHome, state.availability, tracking])

  const currentVolunteer = tracking?.volunteers[0]
  const routePlanStart = !returningHome && currentVolunteer
    ? [currentVolunteer.lng, currentVolunteer.lat] as [number, number]
    : activeRoute?.path?.[0]
  const routePlanEnd = !returningHome && activeNavTask?.lng != null && activeNavTask?.lat != null
    ? [activeNavTask.lng, activeNavTask.lat] as [number, number]
    : activeRoute?.path?.[activeRoute.path.length - 1]
  const routePlanStartKey = routePlanStart ? `${routePlanStart[0].toFixed(6)},${routePlanStart[1].toFixed(6)}` : ''
  const routePlanEndKey = routePlanEnd ? `${routePlanEnd[0].toFixed(6)},${routePlanEnd[1].toFixed(6)}` : ''
  const canOpenNavigation = Boolean(activeNavTask && activeRoute && !returningHome && state.availability !== 'serving')

  useEffect(() => {
    if (returningHome) setNavigationMode('driving')
    else if (activeRoute?.navigation_mode) setNavigationMode(activeRoute.navigation_mode)
  }, [activeRoute?.order_id, returningHome])

  useEffect(() => {
    let cancelled = false
    const refreshNav = async () => {
      const end = !returningHome && activeNavTask?.lng != null && activeNavTask?.lat != null
        ? [activeNavTask.lng, activeNavTask.lat] as [number, number]
        : activeRoute?.path?.[activeRoute.path.length - 1]
      const me = tracking?.volunteers[0]
      const start = !returningHome && me
        ? [me.lng, me.lat] as [number, number]
        : activeRoute?.path?.[0]
      if (!start || !end || start[0] == null || end[0] == null) {
        if (!cancelled) {
          setNavSteps([])
          setPlannedNavSteps([])
          setNavMeta({})
          setPlannedRoute(null)
        }
        return
      }
      try {
        const mode: NavigationMode = returningHome ? 'driving' : navigationMode
        const routeKey = returningHome ? 'return' : activeNavTask?.order_id || 'route'
        let route = await getAmapRoute(
          start,
          end,
          mode,
          mode === 'driving' ? 'REAL_TRAFFIC' : 'LEAST_TIME',
          `${routeKey}-${activeRoute?.traffic_version || 0}-steps-0`,
        )
        // AMap can return geometry before its detailed manoeuvre list is
        // populated. Retry with a fresh planner/cache key instead of leaving
        // the navigation panel permanently empty after the first response.
        for (let attempt = 1; attempt <= 2 && (!route.geometryResolved || !route.steps.length); attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, attempt * 350))
          if (cancelled) return
          route = await getAmapRoute(
            start,
            end,
            mode,
            mode === 'driving' ? 'REAL_TRAFFIC' : 'LEAST_TIME',
            `${routeKey}-${activeRoute?.traffic_version || 0}-steps-${attempt}`,
          )
        }
        if (cancelled) return
        const progress = Math.max(0, Math.min(100, activeRoute?.progress ?? 0))
        const hasPersistedRoadGeometry = simulationEnabled && (activeRoute?.path?.length ?? 0) > 2
        const fallbackDistanceMeters = Math.max(
          1,
          Math.round(Number(route.distanceKm || activeRoute?.distance_km || 0.1) * 1000),
        )
        const steps = route.steps.length
          ? route.steps
          : [{
              instruction: mode === 'driving'
                ? '沿地图绿色路线继续行驶，注意道路名称和转向'
                : mode === 'riding'
                  ? '沿地图紫色路线继续骑行，注意道路名称和转向'
                  : '沿地图蓝色路线继续步行，注意道路名称和转向',
              distanceMeters: fallbackDistanceMeters,
            }]
        setPlannedNavSteps(steps)
        setPlannedRoute({
          ...(activeRoute as DispatchRoute),
          // The persisted road is the canonical journey geometry used by the
          // backend location clock. A second AMap search may choose a slightly
          // different road even with identical endpoints, so use it only for
          // turn instructions and never replace an active journey's path.
          path: hasPersistedRoadGeometry ? activeRoute!.path : route.path,
          // Prefer freshly resolved TMC even when the road path is persisted —
          // empty stored traffic_segments would otherwise hide red/yellow.
          traffic_segments: mode === 'driving' && route.trafficSegments.length
            ? route.trafficSegments
            : (activeRoute?.traffic_segments ?? []),
          distance_km: route.geometryResolved && route.distanceKm > 0 ? route.distanceKm : activeRoute?.distance_km,
          eta_minutes: route.geometryResolved && route.etaMinutes > 0 ? route.etaMinutes : (activeRoute?.eta_minutes ?? 1),
          progress,
          navigation_mode: mode,
        })
        if (!simulationEnabled && activeNavTask && route.geometryResolved) {
          await updateVolunteerNavigationRoute({
            orderId: activeNavTask.order_id,
            volunteerId: session!.userId,
            path: compactNavigationPath(route.path),
            trafficSegments: route.trafficSegments.map((segment) => ({
              ...segment,
              path: compactNavigationPath(segment.path, 90),
            })),
            distanceKm: route.distanceKm,
            etaMinutes: route.etaMinutes,
            navigationMode: mode,
          })
        }
      } catch {
        if (!cancelled) {
          const fallbackDistanceMeters = Math.max(
            1,
            Math.round(Number(activeRoute?.distance_km || 0.1) * 1000),
          )
          setPlannedNavSteps([{
            instruction: '沿地图路线继续前行，注意周边道路名称',
            distanceMeters: fallbackDistanceMeters,
          }])
          setPlannedRoute(activeRoute ?? null)
        }
      }
    }
    void refreshNav()
    return () => { cancelled = true }
  }, [activeNavTask?.order_id, activeRoute?.order_id, activeRoute?.traffic_version, routePlanStartKey, routePlanEndKey, navigationMode, returningHome, simulationEnabled])

  useEffect(() => {
    if (!activeRoute) {
      returnGuidanceLastCommitAt.current = 0
      returnGuidanceJourneyKey.current = ''
      return
    }
    const progress = Math.max(0, Math.min(100, activeRoute.progress ?? 0))
    const remainingRatio = Math.max(0, 1 - progress / 100)
    const hasMatchingPlan = Boolean(plannedRoute && plannedRoute.order_id === activeRoute.order_id)
    const baseDistance = hasMatchingPlan ? plannedRoute?.distance_km : activeRoute.distance_km
    const baseEta = hasMatchingPlan ? plannedRoute?.eta_minutes : activeRoute.eta_minutes

    // Keep the route/vehicle motion current on every tracking poll. Return-trip
    // guidance is committed separately as one snapshot so distance, ETA and the
    // next instruction never render from different progress samples.
    setPlannedRoute((current) => {
      if (!current || current.order_id !== activeRoute.order_id) return activeRoute
      if (current.progress === progress && current.traffic_version === activeRoute.traffic_version) return current
      return { ...current, progress, traffic_version: activeRoute.traffic_version }
    })

    let timer = 0
    const journeyKey = `${activeRoute.order_id}:${returningHome ? 'return' : 'outbound'}`
    const commitGuidance = () => {
      returnGuidanceLastCommitAt.current = performance.now()
      setNavSteps(pickUpcomingNavSteps(plannedNavSteps, progress, 5))
      setNavMeta({
        distanceKm: baseDistance == null ? undefined : baseDistance * remainingRatio,
        etaMinutes: baseEta == null ? undefined : Math.max(1, Math.ceil(baseEta * remainingRatio)),
        progress,
      })
    }

    if (!returningHome || returnGuidanceJourneyKey.current !== journeyKey) {
      returnGuidanceJourneyKey.current = journeyKey
      commitGuidance()
    } else {
      const elapsed = performance.now() - returnGuidanceLastCommitAt.current
      const delay = Math.max(0, 3000 - elapsed)
      if (delay > 0) timer = window.setTimeout(commitGuidance, delay)
      else commitGuidance()
    }

    return () => window.clearTimeout(timer)
  }, [activeRoute?.order_id, activeRoute?.progress, activeRoute?.traffic_version, plannedRoute?.order_id, plannedRoute?.distance_km, plannedRoute?.eta_minutes, plannedNavSteps, returningHome])

  const changeNavigationMode = async (mode: NavigationMode, silent = false) => {
    if (returningHome) {
      message.info('返家路线固定使用驾车模拟')
      return
    }
    if (state.availability === 'serving') {
      message.info('已到达服务点，服务中无需切换导航方式')
      return
    }
    const me = tracking?.volunteers[0]
    const end = activeNavTask?.lng != null && activeNavTask?.lat != null
      ? [activeNavTask.lng, activeNavTask.lat] as [number, number]
      : activeRoute?.path?.[activeRoute.path.length - 1]
    if (!me || !activeRoute || !activeNavTask || !end) {
      setNavigationMode(mode)
      return
    }
    setSwitchingNavigationMode(true)
    try {
      const start: [number, number] = [me.lng, me.lat]
      const route = await getAmapRoute(start, end, mode, mode === 'driving' ? 'REAL_TRAFFIC' : 'LEAST_TIME', `mode-${activeNavTask.order_id}-${Date.now()}`)
      if (!route.geometryResolved) throw new Error('高德道路路线暂未返回，正在自动重试')
      const nextRoute: DispatchRoute = {
        ...activeRoute,
        path: route.path,
        traffic_segments: mode === 'driving' ? route.trafficSegments : [],
        distance_km: route.distanceKm,
        eta_minutes: route.etaMinutes,
        progress: 0,
        navigation_mode: mode,
      }
      setNavigationMode(mode)
      setPlannedRoute(nextRoute)
      setPlannedNavSteps(route.steps)
      setNavSteps(route.steps.slice(0, 5))
      setNavMeta({ distanceKm: route.distanceKm, etaMinutes: route.etaMinutes, progress: 0 })
      await updateVolunteerNavigationRoute({
        orderId: activeNavTask.order_id,
        volunteerId: me.volunteer_id,
        path: compactNavigationPath(route.path),
        trafficSegments: route.trafficSegments.map((segment) => ({ ...segment, path: compactNavigationPath(segment.path, 90) })),
        distanceKm: route.distanceKm,
        etaMinutes: route.etaMinutes,
        navigationMode: mode,
      })
      if (!silent) message.success(`已切换为${mode === 'driving' ? '驾车' : mode === 'riding' ? '骑行' : '步行'}，已从当前位置重新规划路线`)
      await load()
    } catch (err: any) {
      if (!silent) message.error(err?.message || '切换导航方式失败')
      if (silent && activeNavTask) initializedNavigationRoutes.current.delete(`order-${activeNavTask.order_id}`)
    } finally {
      setSwitchingNavigationMode(false)
    }
  }

  useEffect(() => {
    const me = tracking?.volunteers[0]
    if (!me || !activeRoute || activeRoute.path.length > 2) return
    const routeKey = returningHome ? `return-${me.volunteer_id}` : `order-${activeNavTask?.order_id || 0}`
    if (initializedNavigationRoutes.current.has(routeKey)) return
    initializedNavigationRoutes.current.add(routeKey)
    if (!returningHome && activeNavTask) {
      void changeNavigationMode(activeRoute.navigation_mode || 'driving', true)
      return
    }
    const end = activeRoute.path[activeRoute.path.length - 1]
    const start: [number, number] = [me.lng, me.lat]
    void getAmapRoute(start, end, 'driving', 'REAL_TRAFFIC', `auto-return-${me.volunteer_id}-${activeRoute.traffic_version}`)
      .then(async (route) => {
        if (!route.geometryResolved) throw new Error('AMap road geometry is not ready')
        setNavigationMode('driving')
        setPlannedRoute({
          ...activeRoute,
          path: route.path,
          traffic_segments: route.trafficSegments,
          distance_km: route.distanceKm,
          eta_minutes: route.etaMinutes,
          progress: 0,
          navigation_mode: 'driving',
        })
        setPlannedNavSteps(route.steps)
        setNavSteps(route.steps.slice(0, 5))
        setNavMeta({ distanceKm: route.distanceKm, etaMinutes: route.etaMinutes, progress: 0 })
        await updateVolunteerNavigationRoute({
          orderId: -me.volunteer_id,
          volunteerId: me.volunteer_id,
          path: compactNavigationPath(route.path),
          trafficSegments: route.trafficSegments.map((segment) => ({ ...segment, path: compactNavigationPath(segment.path, 90) })),
          distanceKm: route.distanceKm,
          etaMinutes: route.etaMinutes,
          navigationMode: 'driving',
        })
        await load()
      })
      .catch(() => initializedNavigationRoutes.current.delete(routeKey))
  }, [activeNavTask?.order_id, activeRoute?.order_id, activeRoute?.path.length, activeRoute?.traffic_version, returningHome, tracking?.volunteers])

  const upcomingHint = navSteps[0]
  const reportIssueRedispatch = async (task: VolunteerDispatchTask) => {
    if (!session) return
    setIssueWorking(task.order_id)
    try {
      const result = await redispatchDispatchOrder(task.order_id, session.userId, '服务中无法继续，申请换人重派')
      message.success(result.message)
      await load()
    } catch (err: any) {
      message.error(err?.message || '换人重派失败')
    } finally {
      setIssueWorking(null)
    }
  }
  const reportIssueAdmin = async (task: VolunteerDispatchTask) => {
    if (!session) return
    setIssueWorking(task.order_id)
    try {
      const result = await requestAdminForDispatchOrder(task.order_id, session.userId, {
        reason: '服务中需要管理员协助',
      })
      message.success(result.message || '已在本群联系管理员')
      if (result.data?.conversation_id) navigate(`/conversations?id=${result.data.conversation_id}`)
      else await load()
    } catch (err: any) {
      message.error(err?.message || '联系管理员失败')
    } finally {
      setIssueWorking(null)
    }
  }
  const respond = async (task: VolunteerDispatchTask, action: 'accept' | 'decline' | 'start' | 'simulate_move' | 'complete' | 'cancel') => {
    if (!session) return
    setWorking(task.order_id)
    try {
      let position: { lng: number; lat: number; accuracyMeters?: number; fromGps?: boolean } | undefined
      if (action === 'start') {
        const fix = await captureBrowserLocation({ timeoutMs: 15_000 })
        position = {
          lng: fix.lng,
          lat: fix.lat,
          accuracyMeters: fix.accuracyMeters,
          fromGps: fix.fromGps,
        }
      }
      const taskRoute = task.route
      if (action === 'simulate_move' && taskRoute && Array.isArray(taskRoute.path) && taskRoute.path.length >= 2) {
        const progress = Math.min(95, (taskRoute.progress ?? 0) + 15)
        const point = await getAmapPointAtProgress(taskRoute.path[0], taskRoute.path[taskRoute.path.length - 1], progress)
        position = { lng: point[0], lat: point[1] }
      }
      const result = await respondDispatchOrder(task.order_id, session.userId, action, position)
      message.success(result.message)
      await load()
    } catch (err: any) { message.error(err?.message || '响应失败') } finally { setWorking(null) }
  }
  const savePreferences = async (autoAccept: boolean) => {
    if (!session) return
    setWorking(-2)
    try {
      const result = await updateVolunteerDispatchPreferences({
        volunteerId: session.userId,
        homeLng: state.home_lng ?? undefined,
        homeLat: state.home_lat ?? undefined,
        autoAcceptEnabled: autoAccept,
      })
      message.success(result.message)
      await load()
    } catch (err: any) {
      message.error(err?.message || '保存调度设置失败')
    } finally {
      setWorking(null)
    }
  }
  const statusText = state.availability === 'idle' ? '空闲，可参与派单' : state.availability === 'returning' ? '返程中，可参与派单' : state.availability === 'serving' ? '服务进行中' : state.availability === 'offline' ? '暂停参与派单' : '已接单，正在前往'
  const mySkills = tracking?.volunteers[0]?.skills ?? []
  const nextPreview = tracking?.next_assignment_preview
  const autoAssignment = tracking?.auto_assignment
  const activeTasks = tasks.filter((task) => ['accepted', 'in_progress'].includes(task.status))
  const inviteTasks = tasks.filter((task) => task.status === 'pending' || task.response_status === 'invited')
  const skillLabel = (skill: string) => {
    const catalog = (tracking?.service_catalog ?? []).find((item) => item.skills.includes(skill))
    const index = catalog?.skills.indexOf(skill) ?? -1
    return index >= 0 ? catalog?.skill_labels[index] ?? skill : skill
  }
  const renderTaskActions = (task: VolunteerDispatchTask) => (
    <Space wrap>
      {task.amap_marker_url ? <Button size="small" onClick={() => window.open(task.amap_marker_url, '_blank', 'noopener,noreferrer')}>高德查看服务点</Button> : null}
      {task.amap_navigation_url ? <Button size="small" type="primary" ghost onClick={() => window.open(task.amap_navigation_url, '_blank', 'noopener,noreferrer')}>打开高德导航</Button> : null}
      {task.response_status === 'invited' ? (
        <>
          <Button type="primary" icon={<CheckCircleOutlined />} loading={working === task.order_id} onClick={() => respond(task, 'accept')}>
            {task.dispatch_phase === 'top1' ? '确认接单' : '自主接单'}
          </Button>
          <Button danger icon={<CloseCircleOutlined />} disabled={task.forced_assignment} onClick={() => respond(task, 'decline')}>拒绝</Button>
        </>
      ) : null}
      {(task.response_status === 'accepted' || task.response_status === 'forced') && task.status === 'accepted' ? (
        <Button type="primary" loading={working === task.order_id} onClick={() => respond(task, 'start')}>确认到达并开始服务</Button>
      ) : null}
      {task.status === 'in_progress' && state.availability !== 'serving' ? (
        <Button type="primary" loading={working === task.order_id} onClick={() => respond(task, 'start')}>确认到达并开始服务</Button>
      ) : null}
      {task.status === 'in_progress' && state.availability === 'serving' ? (
        <Button type="primary" size="large" loading={working === task.order_id} onClick={() => respond(task, 'complete')}>
          完成服务并返家
        </Button>
      ) : null}
      {['accepted', 'in_progress'].includes(task.status) ? (
        <>
          <Button danger size="small" loading={issueWorking === task.order_id} onClick={() => reportIssueRedispatch(task)}>服务异常·换人重派</Button>
          <Button size="small" loading={issueWorking === task.order_id} onClick={() => reportIssueAdmin(task)}>联系管理员</Button>
        </>
      ) : null}
    </Space>
  )
  return (
    <div className="mobile-compact-page space-y-6">
      <div className="dispatch-page-hero">
        <div className="role-home-kicker">志愿者智能调度</div>
        <Typography.Title level={2} className="!mb-1 !text-slate-900">智能推荐接单中心</Typography.Title>
        <Typography.Text className="!text-slate-600">接单后共享本人实时位置并根据当前位置规划路线；到达服务点 100 米范围内才能开始服务。</Typography.Text>
      </div>
      <Alert
        showIcon
        type="info"
        message="抢单与自动分配说明"
        description={(
          <ul className="mb-0 list-disc pl-4 text-sm">
            <li>普通单：Top1→Top3→Top10 扩圈；曾获邀的人排名掉出后仍可继续抢，扩圈只增加名额不撤旧邀请。</li>
            <li>35 秒后兜底：Top10 抢单与「自动接单」并行；被自动分配或已接单后，须完成服务并空闲/返家才能再抢或再自动接。</li>
            <li>SOS：系统只自动派给「已开自动接单」的人，不会出现在抢单列表；你只会看到已经派给你的 SOS 行程。</li>
            <li>技能不符的订单不会出现在候选列表。</li>
            <li>同优先级多单可同时邀请同一人，先点先得；更高优先级（SOS）可撤回普通单邀请。</li>
          </ul>
        )}
      />
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="!rounded-2xl"><div className="text-slate-500">当前接单状态</div><b className="text-xl">{statusText}</b><div className="mt-1 text-xs text-slate-400">这是派单状态，与是否登录无关</div></Card>
        <Card className="!rounded-2xl"><div className="text-slate-500">疲劳度</div><Progress percent={state.fatigue_score} status={state.fatigue_score > 70 ? 'exception' : 'active'} /></Card>
        <Card className="!rounded-2xl"><div className="text-slate-500">服务评分</div><b className="text-xl">{Number(state.service_rating || 0).toFixed(2)} / 5</b></Card>
        <Card className="!rounded-2xl"><div className="text-slate-500">今日已接</div><b className="text-xl">{state.assigned_today} 单</b></Card>
      </div>
      <Card className="!rounded-2xl border-blue-200 bg-blue-50" title="我的已认证服务技能">
        <Space wrap>{mySkills.length ? mySkills.map((skill) => <Tag color="green" key={skill}>{skillLabel(skill)}</Tag>) : <span className="text-slate-500">暂无已认证技能；未认证技能不会进入智能派单候选。</span>}</Space>
      </Card>
      <Card className="!rounded-2xl border-cyan-200 bg-cyan-50" title="自动接单">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-medium">空闲或返程时允许系统自动分配最合适的订单</div>
            <div className="mt-1 text-xs text-slate-500">前往和服务中不会再派新单；当前位置和返家点由系统维护，不显示经纬度设置。</div>
          </div>
          <Switch
            checked={state.auto_accept_enabled}
            loading={working === -2}
            checkedChildren="已开启"
            unCheckedChildren="已关闭"
            onChange={(enabled) => void savePreferences(enabled)}
          />
        </div>
      </Card>
      {tracking?.return_route ? (
        <Card className="!rounded-2xl border-violet-200 bg-violet-50" title="自动返家路线">
          <Space>
            <Tag color="purple">已推进 {tracking.return_route.progress ?? 0}%</Tag>
            <span>正在沿高德路线连续返家；位置按服务端统一时间线推进，切换页面不会重置。</span>
            {state.auto_accept_enabled ? <Tag color="blue">自动接单：返程中可接新单</Tag> : <Tag>返家完成后重新进入候选队列</Tag>}
          </Space>
        </Card>
      ) : null}
      {autoAssignment ? (
        <Card className="!rounded-2xl border-cyan-300 bg-cyan-50" title="系统已自动接下一单">
          <Space wrap>
            <Tag color={autoAssignment.urgency === 'sos' ? 'red' : 'cyan'}>{autoAssignment.urgency === 'sos' ? 'SOS 自动强制派单' : '自动接单成功'}</Tag>
            <b>#{autoAssignment.order_id} · {autoAssignment.elder_name} · {autoAssignment.service_type}</b>
            <span>{autoAssignment.address || '老人固定住址'}</span>
            <Tag color="green">已从当前服务点/返程位置重新规划路线</Tag>
          </Space>
        </Card>
      ) : null}
      {nextPreview ? (
        <Card className="!rounded-2xl border-amber-200 bg-amber-50" title="下一单智能预告">
          <Space wrap>
            <Tag color={nextPreview.urgency === 'sos' ? 'red' : 'gold'}>{nextPreview.urgency === 'sos' ? 'SOS 优先' : '完成后优先推荐'}</Tag>
            <b>{nextPreview.elder_name} · {nextPreview.service_type}</b>
            <span>{nextPreview.address || '老人固定住址'}</span>
            <span>{nextPreview.distance_km} km / 约 {nextPreview.eta_minutes} 分钟</span>
            <Tag color="green">技能：{nextPreview.required_skill_labels.join('、')}</Tag>
          </Space>
          <div className="mt-2 text-xs text-amber-800">这是服务结束前的动态预告，不会提前锁单；完成当前服务时系统会按当时路况、位置与所有志愿者的综合权重重新确认并自动派单。</div>
        </Card>
      ) : null}

      <div>
        <Typography.Title level={3}>我的进行中服务</Typography.Title>
        <div className="grid gap-4 lg:grid-cols-2">
          {activeTasks.length ? activeTasks.map((task) => (
            <Card
              key={task.order_id}
              className="mobile-progress-card !overflow-hidden !rounded-2xl !border-blue-200"
              title={<div className="flex flex-wrap items-center gap-2"><span className="text-lg font-semibold text-slate-900">{task.service_type}</span><Tag color="green">{task.status === 'in_progress' ? (state.availability === 'serving' ? '正在服务' : '前往中') : '已接单'}</Tag></div>}
              extra={<Tag color={task.urgency === 'sos' ? 'red' : 'blue'}>{task.urgency === 'sos' ? 'SOS' : '普通'}</Tag>}
            >
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">服务对象</div><div className="mt-1 font-semibold text-slate-900">{task.elder_name}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">距离</div><div className="mt-1 font-semibold text-slate-900">{task.distance_km == null ? '-' : `${task.distance_km} km`}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">预计到达</div><div className="mt-1 font-semibold text-slate-900">{task.eta_minutes == null ? '-' : `${task.eta_minutes} 分钟`}</div></div>
                </div>
                {task.notes ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                    <div className="mb-1 text-xs font-medium text-amber-700">老人说明</div>{task.notes}
                  </div>
                ) : null}
                {task.personality_bio ? (
                  <div className="rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-600"><div className="mb-1 text-xs font-medium text-slate-500">沟通提示</div>{task.personality_bio}</div>
                ) : null}
                <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-sm">
                  <div className="mb-1 text-xs font-medium text-blue-700">订单服务地点</div>
                  <EnvironmentOutlined className="mr-1" />
                  服务点：{task.address || '老人固定住址'}
                </div>
                {state.availability === 'serving' ? (
                  <Alert type="success" showIcon message="已到达：可点击下方完成服务并返家" />
                ) : (
                  <Alert type="info" showIcon message="路线会按您的实时位置规划；到达服务点附近后可确认开始服务" />
                )}
                <div className="border-t border-slate-100 pt-4">{renderTaskActions(task)}</div>
              </div>
            </Card>
          )) : (
            <Card className="!rounded-2xl text-slate-500">当前没有进行中的服务。接单后会出现在这里，可确认到达并完成服务。</Card>
          )}
        </div>
      </div>

      {inviteTasks.length ? (
        <div>
          <Typography.Title level={3}>我的候选请求</Typography.Title>
          <div className="grid gap-4 lg:grid-cols-2">
            {inviteTasks.map((task) => (
            <Card
              key={task.order_id}
              className="!rounded-2xl"
              title={<Space><Tag color={task.urgency === 'sos' ? 'red' : task.dispatch_phase === 'top1' ? 'purple' : 'blue'}>{task.urgency === 'sos' ? 'SOS强制派单' : task.dispatch_phase === 'top1' ? 'Top1 专属确认' : task.dispatch_phase === 'top3' ? 'Top3 抢单' : task.dispatch_phase === 'top10' ? 'Top10 扩散抢单' : `推荐 #${task.candidate_rank}`}</Tag><span>{task.service_type}</span></Space>}
              extra={<Tag color="orange">待响应</Tag>}
            >
              <div className="space-y-3">
                <div className="text-sm text-slate-600">服务对象：{task.elder_name} · {task.distance_km} km · 预计 {task.eta_minutes} 分钟</div>
                {task.notes ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                    <b>老人说明：</b>{task.notes}
                  </div>
                ) : null}
                {task.personality_bio ? (
                  <div className="text-xs text-gray-500">📝 {task.personality_bio}</div>
                ) : null}
                <div className="rounded-xl bg-slate-50 p-2 text-sm"><EnvironmentOutlined className="mr-1" />服务地点：{task.address || '老人固定住址'}。接单后可查看路线导航。</div>
                <div className="rounded-xl bg-blue-50 p-3 text-sm text-blue-800"><SafetyCertificateOutlined className="mr-2" />技能验证：{task.required_skill_labels.join('、')} <b>已精准匹配</b></div>
                <div className="grid grid-cols-4 gap-2 text-center text-xs"><div>距离<b className="block text-base">{task.distance_score}</b></div><div>路况<b className="block text-base">{task.traffic_score}</b></div><div>公平<b className="block text-base">{task.fatigue_score}</b></div><div>评分<b className="block text-base">{task.rating_score}</b></div></div>
                <div className="rounded-lg bg-slate-100 p-2 text-sm">综合适配：<b>{task.total_score}</b>（距离40% · 路况25% · 疲劳10% · 评分25%）</div>
                {renderTaskActions(task)}
              </div>
            </Card>
            ))}
          </div>
        </div>
      ) : null}

      <Card
        className="mobile-map-card !overflow-hidden !rounded-2xl !border-blue-100"
        title="服务地图"
        extra={<Button size="small" type="primary" onClick={() => setMapExpanded(true)}>{canOpenNavigation ? '展开导航' : '展开地图'}</Button>}
      >
        <DispatchMap overview={tracking} height={440} />
      </Card>

      <Modal
        open={mapExpanded}
        onCancel={() => setMapExpanded(false)}
        footer={null}
        width="min(1200px, 98vw)"
        title={canOpenNavigation ? '实时导航' : '服务地图'}
        destroyOnClose
        styles={{ body: { paddingTop: 12 } }}
      >
        {canOpenNavigation ? (
          <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
            <VolunteerNavMap
              overview={tracking}
              height={Math.min(640, typeof window !== 'undefined' ? window.innerHeight - 220 : 560)}
              steps={navSteps}
              routeOverride={plannedRoute}
              navigationMode={returningHome ? 'driving' : navigationMode}
              navigationModeLocked={returningHome || state.availability === 'serving' || switchingNavigationMode}
              navigationModeLockLabel={state.availability === 'serving' ? '已到达服务点' : '返程固定驾车'}
              distanceKm={navMeta.distanceKm}
              etaMinutes={navMeta.etaMinutes}
              onNavigationModeChange={(mode) => void changeNavigationMode(mode)}
            />
            <div className="space-y-3">
              <Alert
                type="info"
                showIcon
                message="按实时位置规划路线"
                description="去程可切换驾车、骑行或步行；位置变化后系统会重新计算。拖动地图可暂时取消跟随。"
              />
              {upcomingHint ? (
                <Alert
                  type="success"
                  showIcon
                  message={`下一段：约 ${formatNavDistance(upcomingHint.distanceMeters)}后 ${upcomingHint.instruction || '继续前行'}`}
                />
              ) : null}
              <NavStepsList steps={navSteps} title="路线提示" />
              {!returningHome && activeNavTask?.amap_navigation_url ? (
                <Button block type="primary" onClick={() => window.open(activeNavTask.amap_navigation_url, '_blank', 'noopener,noreferrer')}>
                  在高德 App / 网页打开导航
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <DispatchMap overview={tracking} height={Math.min(640, typeof window !== 'undefined' ? window.innerHeight - 180 : 560)} />
        )}
      </Modal>
    </div>
  )
}
