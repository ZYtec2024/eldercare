import { useEffect, useRef, useState } from 'react'
import { App, Button, Card, Form, InputNumber, Progress, Space, Switch, Tag, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, CompassOutlined, EnvironmentOutlined, HomeOutlined, SafetyCertificateOutlined } from '@ant-design/icons'

import { DispatchMap, getAmapPointAtProgress } from '@/features/dispatch/components/DispatchMap'
import type { DispatchTracking, VolunteerDispatchTask } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { fetchDispatchTracking, fetchVolunteerDispatchFeed, respondDispatchOrder, updateVolunteerDispatchLocation, updateVolunteerDispatchPreferences } from '@/services/adapters/dispatch-adapter'

export default function VolunteerDispatchPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [tasks, setTasks] = useState<VolunteerDispatchTask[]>([])
  const [completedTasks, setCompletedTasks] = useState<Array<{ order_id: number; service_type: string; elder_name: string; address?: string; completed_at?: string | null }>>([])
  const [state, setState] = useState({ availability: 'idle', fatigue_score: 0, service_rating: 0, assigned_today: 0, auto_accept_enabled: false, home_lng: null as number | null, home_lat: null as number | null })
  const [working, setWorking] = useState<number | 'return' | null>(null)
  const [locationForm] = Form.useForm()
  const [settingsForm] = Form.useForm()
  const autoAccept = Form.useWatch('autoAccept', settingsForm)
  const savedAutoAccept = useRef<boolean | undefined>(undefined)
  const announcedAutoOrder = useRef<number | null>(null)
  // Virtual travel is the default for the acceptance demo.  It can still be
  // paused with the switch, but an accepted task now starts its journey without
  // requiring a second click.

  const load = async () => {
    if (!session) return
    const [map, feed] = await Promise.all([fetchDispatchTracking('volunteer', session.userId), fetchVolunteerDispatchFeed(session.userId)])
    setTracking(map); setTasks(feed.tasks); setCompletedTasks(feed.completed_tasks ?? []); setState(feed.state as typeof state)
    const autoOrder = map.auto_assignment
    if (autoOrder && announcedAutoOrder.current !== autoOrder.order_id) {
      announcedAutoOrder.current = autoOrder.order_id
      message.success(`系统已自动接单：${autoOrder.elder_name}的${autoOrder.service_type}，已从当前位置规划路线。`, 6)
    }
    if (!autoOrder) announcedAutoOrder.current = null
    const me = map.volunteers[0]
    if (me) {
      savedAutoAccept.current = me.auto_accept_enabled ?? (me as typeof me & { autoAcceptEnabled?: boolean }).autoAcceptEnabled ?? false
      locationForm.setFieldsValue({ lng: me.lng, lat: me.lat })
      settingsForm.setFieldsValue({ homeLng: me.home_lng ?? me.lng, homeLat: me.home_lat ?? me.lat, autoAccept: savedAutoAccept.current })
    }
  }
  useEffect(() => { load().catch(() => {}); const timer = window.setInterval(() => load().catch(() => {}), 5000); return () => window.clearInterval(timer) }, [session?.userId])

  const respond = async (task: VolunteerDispatchTask, action: 'accept' | 'decline' | 'start' | 'simulate_move' | 'complete' | 'cancel') => {
    if (!session) return
    setWorking(task.order_id)
    try {
      let position: { lng: number; lat: number } | undefined
      const activeRoute = task.route
      if (action === 'simulate_move' && activeRoute && Array.isArray(activeRoute.path) && activeRoute.path.length >= 2) {
        const progress = Math.min(95, (activeRoute.progress ?? 0) + 15)
        const point = await getAmapPointAtProgress(activeRoute.path[0], activeRoute.path[activeRoute.path.length - 1], progress)
        position = { lng: point[0], lat: point[1] }
      }
      const result = await respondDispatchOrder(task.order_id, session.userId, action, position)
      message.success(result.message)
      await load()
    } catch (err: any) { message.error(err?.message || '响应失败') } finally { setWorking(null) }
  }
  const updateLocation = async (values: { lng: number; lat: number }) => {
    if (!session) return
    setWorking(-1)
    try { const result = await updateVolunteerDispatchLocation({ volunteerId: session.userId, ...values, source: 'virtual' }); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '更新虚拟位置失败') } finally { setWorking(null) }
  }
  const savePreferences = async (values: { homeLng?: number; homeLat?: number; autoAccept: boolean }) => {
    if (!session) return
    setWorking(-2)
    try { const result = await updateVolunteerDispatchPreferences({ volunteerId: session.userId, homeLng: values.homeLng, homeLat: values.homeLat, autoAcceptEnabled: values.autoAccept }); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '保存调度设置失败') } finally { setWorking(null) }
  }
  const toggleAutoAccept = async (enabled: boolean) => {
    const values = settingsForm.getFieldsValue()
    settingsForm.setFieldValue('autoAccept', enabled)
    savedAutoAccept.current = enabled
    await savePreferences({ homeLng: values.homeLng, homeLat: values.homeLat, autoAccept: enabled })
  }
  useEffect(() => {
    if (autoAccept === undefined || savedAutoAccept.current === undefined || autoAccept === savedAutoAccept.current) return
    void toggleAutoAccept(autoAccept)
  }, [autoAccept])
  const statusText = state.availability === 'idle' ? '空闲可接单' : state.availability === 'returning' ? '虚拟返家中（可接单）' : state.availability === 'serving' ? '正在服务' : '已接单，正在出发'
  const mySkills = tracking?.volunteers[0]?.skills ?? []
  const nextPreview = tracking?.next_assignment_preview
  const autoAssignment = tracking?.auto_assignment
  const skillLabel = (skill: string) => {
    const catalog = (tracking?.service_catalog ?? []).find((item) => item.skills.includes(skill))
    const index = catalog?.skills.indexOf(skill) ?? -1
    return index >= 0 ? catalog?.skill_labels[index] ?? skill : skill
  }
  return <div className="space-y-6"><div className="rounded-3xl bg-gradient-to-r from-emerald-700 via-teal-700 to-cyan-700 p-6 text-white shadow-xl"><Typography.Title level={2} className="!mb-1 !text-white">智能推荐接单中心</Typography.Title><Typography.Text className="!text-emerald-100">虚拟实时定位适合验收演示：从设置的起点出发、沿高德真实道路路线推进、服务完成后返家，返家途中也可接单。</Typography.Text></div>
    <div className="grid gap-4 md:grid-cols-4"><Card className="!rounded-2xl"><div className="text-slate-500">当前状态</div><b className="text-xl">{statusText}</b></Card><Card className="!rounded-2xl"><div className="text-slate-500">疲劳度</div><Progress percent={state.fatigue_score} status={state.fatigue_score > 70 ? 'exception' : 'active'} /></Card><Card className="!rounded-2xl"><div className="text-slate-500">服务评分</div><b className="text-xl">{Number(state.service_rating || 0).toFixed(2)} / 5</b></Card><Card className="!rounded-2xl"><div className="text-slate-500">今日已接</div><b className="text-xl">{state.assigned_today} 单</b></Card></div>
    <Card className="!rounded-2xl border-emerald-200 bg-emerald-50" title="我的已认证服务技能"><Space wrap>{mySkills.length ? mySkills.map((skill) => <Tag color="green" key={skill}>{skillLabel(skill)}</Tag>) : <span className="text-slate-500">暂无已认证技能；未认证技能不会进入智能派单候选。</span>}</Space></Card>
    <div className="grid gap-4 lg:grid-cols-2"><Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />虚拟当前位置</Space>}><Form form={locationForm} layout="inline" onFinish={updateLocation}><Form.Item name="lng" label="经度" rules={[{ required: true }]}><InputNumber precision={6} /></Form.Item><Form.Item name="lat" label="纬度" rules={[{ required: true }]}><InputNumber precision={6} /></Form.Item><Button htmlType="submit" loading={working === -1}>设为虚拟出发点</Button></Form><div className="mt-2 text-xs text-slate-500">演示默认使用虚拟位置；后端也保留浏览器授权定位接口，正式部署时可启用。</div></Card>
      <Card className="!rounded-2xl" title={<Space><HomeOutlined />返家与自动接单</Space>}><Form form={settingsForm} layout="inline" onFinish={savePreferences}><Form.Item name="homeLng" label="家庭经度" rules={[{ required: true }]}><InputNumber precision={6} /></Form.Item><Form.Item name="homeLat" label="家庭纬度" rules={[{ required: true }]}><InputNumber precision={6} /></Form.Item><Form.Item name="autoAccept" label="最优时自动接单" valuePropName="checked"><Switch /></Form.Item><Button htmlType="submit" loading={working === -2}>保存设置</Button></Form><div className="mt-2 text-xs text-slate-500">前往/服务中即使开了自动接单也不会被派新单；空闲或已结束服务正在返程时，可按实时位置参与匹配与兜底。</div></Card></div>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"><div><b>接单后自动出发</b><div className="text-xs text-emerald-800">行程由后端统一时间轴推进；切换页面或家属端刷新都不会重置路线进度。</div></div><Switch checked disabled checkedChildren="自动出发" /></div>
    <DispatchMap overview={tracking} height={330} />
    <Card className="!rounded-2xl border-sky-200 bg-sky-50" title="当前位置到服务点：高德实时路况">
      <Space wrap size="middle"><Tag color="green">绿色：畅通</Tag><Tag color="gold">黄色：缓行</Tag><Tag color="red">红色：拥堵</Tag><span className="text-sm text-sky-900">接单并出发后，地图会以你当前虚拟/授权位置为起点，按高德实时路况推荐路线；路况图层每 60 秒共享更新。</span></Space>
    </Card>
    {tracking?.return_route ? <Card className="!rounded-2xl border-violet-200 bg-violet-50" title="自动返家路线"><Space><Tag color="purple">已推进 {tracking.return_route.progress ?? 0}%</Tag><span>正在沿高德路线连续返家；位置按服务端统一时间线推进，切换页面不会重置。</span>{state.auto_accept_enabled ? <Tag color="blue">自动接单：返程中可接新单</Tag> : <Tag>返家完成后重新进入候选队列</Tag>}</Space></Card> : null}
    {autoAssignment ? <Card className="!rounded-2xl border-cyan-300 bg-cyan-50" title="系统已自动接下一单"><Space wrap><Tag color={autoAssignment.urgency === 'sos' ? 'red' : 'cyan'}>{autoAssignment.urgency === 'sos' ? 'SOS 自动强制派单' : '自动接单成功'}</Tag><b>#{autoAssignment.order_id} · {autoAssignment.elder_name} · {autoAssignment.service_type}</b><span>{autoAssignment.address || '老人固定住址'}</span><Tag color="green">已从当前服务点/返程位置重新规划路线</Tag></Space></Card> : null}
    {nextPreview ? <Card className="!rounded-2xl border-amber-200 bg-amber-50" title="下一单智能预告"><Space wrap><Tag color={nextPreview.urgency === 'sos' ? 'red' : 'gold'}>{nextPreview.urgency === 'sos' ? 'SOS 优先' : '完成后优先推荐'}</Tag><b>{nextPreview.elder_name} · {nextPreview.service_type}</b><span>{nextPreview.address || '老人固定住址'}</span><span>{nextPreview.distance_km} km / 约 {nextPreview.eta_minutes} 分钟</span><Tag color="green">技能：{nextPreview.required_skill_labels.join('、')}</Tag></Space><div className="mt-2 text-xs text-amber-800">这是服务结束前的动态预告，不会提前锁单；完成当前服务时系统会按当时路况、位置与所有志愿者的综合权重重新确认并自动派单。</div></Card> : null}
    <div><Typography.Title level={3}>我的候选请求</Typography.Title><div className="grid gap-4 lg:grid-cols-2">{tasks.length ? tasks.map((task) => <Card key={task.order_id} className="!rounded-2xl" title={<Space><Tag color={task.urgency === 'sos' ? 'red' : task.dispatch_phase === 'top1' ? 'purple' : 'blue'}>{task.urgency === 'sos' ? 'SOS强制派单' : task.dispatch_phase === 'top1' ? 'Top1 专属确认' : task.dispatch_phase === 'top3' ? 'Top3 抢单' : task.dispatch_phase === 'top10' ? 'Top10 扩散抢单' : `推荐 #${task.candidate_rank}`}</Tag><span>{task.service_type}</span></Space>} extra={<Tag color={task.status === 'in_progress' ? 'green' : task.response_status === 'invited' ? 'orange' : 'blue'}>{task.status === 'in_progress' ? '服务中' : task.response_status === 'invited' ? '待响应' : task.response_status}</Tag>}><div className="space-y-3"><div className="text-sm text-slate-600">服务对象：{task.elder_name} · {task.distance_km} km · 预计 {task.eta_minutes} 分钟</div><div className="rounded-xl bg-slate-50 p-2 text-sm"><EnvironmentOutlined className="mr-1" />服务点：{task.address || '老人固定住址'} {task.lng ? `（${task.lng.toFixed(5)}, ${task.lat?.toFixed(5)}）` : ''}</div><div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800"><SafetyCertificateOutlined className="mr-2" />技能验证：{task.required_skill_labels.join('、')} <b>已精准匹配</b></div><div className="grid grid-cols-4 gap-2 text-center text-xs"><div>距离<b className="block text-base">{task.distance_score}</b></div><div>路况<b className="block text-base">{task.traffic_score}</b></div><div>公平<b className="block text-base">{task.fatigue_score}</b></div><div>评分<b className="block text-base">{task.rating_score}</b></div></div><div className="rounded-lg bg-slate-100 p-2 text-sm">综合适配：<b>{task.total_score}</b>（距离40% · 路况25% · 疲劳10% · 评分25%）</div><Space wrap>{task.amap_marker_url ? <Button size="small" onClick={() => window.open(task.amap_marker_url, '_blank', 'noopener,noreferrer')}>高德查看服务点</Button> : null}{task.response_status === 'invited' ? <><Button type="primary" icon={<CheckCircleOutlined />} loading={working === task.order_id} onClick={() => respond(task, 'accept')}>{task.dispatch_phase === 'top1' ? '确认接单' : '自主接单'}</Button><Button danger icon={<CloseCircleOutlined />} disabled={task.forced_assignment} onClick={() => respond(task, 'decline')}>拒绝</Button></> : null}{(task.response_status === 'accepted' || task.response_status === 'forced') && task.status === 'accepted' ? <><span className="text-sm text-emerald-700">已接单：后端正在按统一时间线自动出发。</span>{!task.forced_assignment ? <Button danger size="small" loading={working === task.order_id} onClick={() => respond(task, 'cancel')}>取消并重新派单</Button> : null}</> : null}{task.status === 'in_progress' ? <Button type="primary" ghost loading={working === task.order_id} onClick={() => respond(task, 'complete')}>完成服务并返家</Button> : null}</Space></div></Card>) : <Card className="!rounded-2xl text-slate-500">{state.auto_accept_enabled ? '自动接单已开启：前35秒仍遵循Top1、Top3、Top10人工确认窗口；超时后系统才会自动兜底。' : '暂无向你开放的技能匹配任务。系统会在候选范围变化时自动刷新。'}</Card>}</div></div>
    <Card className="!rounded-2xl" title="已完成服务记录（按完成时间倒序）"><div className="space-y-2">{completedTasks.length ? completedTasks.map((task) => <div key={task.order_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm"><span><Tag color="green">已完成</Tag><b>{task.service_type}</b> · {task.elder_name}</span><span className="text-slate-500">{task.completed_at || '待家属确认时长'}</span></div>) : <span className="text-slate-500">暂无完成记录。</span>}</div></Card>
  </div>
}
