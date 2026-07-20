import { Button, Card, Progress, Tag } from 'antd'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import type { DispatchOverview } from '@/features/dispatch/dispatch-types'

export function RealDispatchPanel({ overview, onManualAssign }: { overview: DispatchOverview | null; onManualAssign?: (orderId: number, volunteerId: number) => void }) {
  const realOrders = (overview?.orders ?? []).filter((order) => !order.is_simulated && !(order as typeof order & { isSimulated?: boolean }).isSimulated)
  const realOrderIds = new Set(realOrders.map((order) => order.order_id))
  const realOverview = overview ? { ...overview, orders: realOrders, routes: overview.routes.filter((route) => realOrderIds.has(route.order_id)) } : null
  const active = realOrders.filter((order) => ['accepted', 'in_progress'].includes(order.status))
  const waiting = realOrders.filter((order) => order.status === 'pending')
  const manualOrders = waiting.filter((order) => ['admin_escalated', 'queued_waiting_capacity'].includes(order.dispatch_state))
  return <Card className="!rounded-2xl" title="真实调度看板（真实账号与位置）" extra={<Tag color="blue">非自动生成数据</Tag>}>
    <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">这里仅显示老人端真实发布的请求、志愿者真实接单后的当前位置，以及正在进行中的服务路线。老人、家属、志愿者和管理员看到的是同一笔订单状态；服务完成后家属端与老人端会自动锁定志愿者位置。</div>
    <DispatchMap overview={realOverview} height={430} />
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <Card size="small" title={`正在出发 / 服务 (${active.length})`}><div className="space-y-2 text-sm">{active.slice(0, 6).map((order) => <div key={order.order_id} className="rounded-lg bg-blue-50 p-2"><b>{order.volunteer_name || '待确认志愿者'}</b> → <b>{order.elder_name}</b><div className="mt-1 text-xs text-blue-800">#{order.order_id} · {order.status === 'in_progress' ? '服务中' : '正在前往'} · {order.route?.eta_minutes ? `预计 ${order.route.eta_minutes} 分钟` : '路线规划中'}</div>{order.route?.progress != null ? <Progress size="small" percent={Math.round(order.route.progress)} showInfo={false} /> : null}</div>) || <span className="text-slate-400">暂无真实进行中的服务</span>}</div></Card>
      <Card size="small" title={`真实请求队列 (${waiting.length})`}><div className="space-y-2 text-sm">{waiting.slice(0, 6).map((order) => <div key={order.order_id} className="rounded-lg bg-amber-50 p-2"><b>{order.elder_name}</b> · {order.service_type}<Tag className="ml-2" color={order.urgency === 'sos' ? 'red' : 'orange'}>{order.urgency === 'sos' ? 'SOS' : order.dispatch_phase === 'top1' ? 'Top1 专属' : order.dispatch_phase === 'top3' ? 'Top3 抢单' : order.dispatch_phase === 'top10' ? 'Top10 扩散' : '自动兜底'}</Tag><div className="mt-1 text-xs text-amber-800">地址坐标已上图 · 当前第 {order.search_stage} 轮调度</div></div>) || <span className="text-slate-400">真实请求队列为空</span>}</div></Card>
    </div>
    {manualOrders.length ? <Card className="mt-4" size="small" title="人工兜底派单（仅本区、技能匹配且空闲的候选人）"><div className="space-y-2">{manualOrders.slice(0, 4).map((order) => <div key={order.order_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-50 p-2 text-sm"><span>#{order.order_id} · {order.elder_name} · {order.service_type}</span><div className="flex flex-wrap gap-1">{(overview?.candidates ?? []).filter((candidate) => candidate.order_id === order.order_id).slice(0, 3).map((candidate) => <Button key={candidate.volunteer_id} size="small" onClick={() => onManualAssign?.(order.order_id, candidate.volunteer_id)}>派给 {candidate.volunteer_name}</Button>)}</div></div>)}</div></Card> : null}
  </Card>
}
