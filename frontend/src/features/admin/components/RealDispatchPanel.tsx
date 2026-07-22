import { useState } from 'react'
import { App, Button, Card, Progress, Tag } from 'antd'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import type { DispatchOverview } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { fetchOrderDispatchTrail, type DispatchTrail } from '@/services/adapters/dispatch-adapter'

function namesOf(list?: Array<{ volunteer_name: string }>) {
  if (!list?.length) return '（暂无）'
  return list.map((item) => item.volunteer_name).join('、')
}

export function RealDispatchPanel({ overview }: { overview: DispatchOverview | null }) {
  const { session } = useSession()
  const { message } = App.useApp()
  const [trailOrderId, setTrailOrderId] = useState<number | null>(null)
  const [trail, setTrail] = useState<DispatchTrail | null>(null)
  const [trailLoading, setTrailLoading] = useState(false)

  const realOrders = (overview?.orders ?? []).filter((order) => !order.is_simulated && !(order as typeof order & { isSimulated?: boolean }).isSimulated)
  const realOrderIds = new Set(realOrders.map((order) => order.order_id))
  const realOverview = overview ? { ...overview, orders: realOrders, routes: overview.routes.filter((route) => realOrderIds.has(route.order_id)) } : null
  const active = realOrders.filter((order) => ['accepted', 'in_progress'].includes(order.status))
  const waiting = realOrders.filter((order) => order.status === 'pending')
  const phaseLabel = (order: (typeof waiting)[number]) => {
    if (order.urgency === 'sos') return 'SOS · P0'
    if (order.dispatch_state === 'queued_waiting_capacity' || order.dispatch_phase === 'fallback') return '升级 · P1'
    if (order.dispatch_phase === 'top1') return 'Top1 专属'
    if (order.dispatch_phase === 'top3') return 'Top3 抢单'
    if (order.dispatch_phase === 'top10') return 'Top10 扩散'
    return '普通 · P2'
  }

  const openTrail = async (orderId: number) => {
    if (!session) return
    setTrailOrderId(orderId)
    setTrailLoading(true)
    try {
      const data = await fetchOrderDispatchTrail(orderId, session.userId)
      setTrail(data)
    } catch (error: any) {
      message.error(error?.message || '加载调度轨迹失败')
      setTrail(null)
    } finally {
      setTrailLoading(false)
    }
  }

  return <Card className="!rounded-2xl" title="真实调度看板（真实账号与位置）" extra={<Tag color="blue">非自动生成数据</Tag>}>
    <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      这里只看<strong>真实订单</strong>：左边是已接单/服务中，右边「真实请求队列」是还没派上人、仍在系统里排队匹配的单。
      三级优先：<strong>P0 SOS</strong> → <strong>P1 升级</strong>（35秒后兜底）→ <strong>P2 普通</strong>（Top1→Top3→Top10）。
      SOS 只派给「自动接单 + 技能匹配 + 评分≥4 + 空闲/返程」，并优先占用这些人；普通单/兜底不能抢走。管理员接警/盯进度/结案，异常时用换人重派。
    </div>
    <DispatchMap overview={realOverview} height={430} />
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <Card size="small" title={`正在出发 / 服务 (${active.length})`}>
        <div className="space-y-2 text-sm">
          {active.slice(0, 6).map((order) => (
            <div key={order.order_id} className="rounded-lg bg-blue-50 p-2">
              <b>{order.volunteer_name || '待确认志愿者'}</b> → <b>{order.elder_name}</b>
              <div className="mt-1 text-xs text-blue-800">#{order.order_id} · {order.status === 'in_progress' ? '服务中' : '正在前往'} · {order.route?.eta_minutes ? `预计 ${order.route.eta_minutes} 分钟` : '路线规划中'}</div>
              {order.route?.progress != null ? <Progress size="small" percent={Math.round(order.route.progress)} showInfo={false} /> : null}
              <Button size="small" className="mt-2" loading={trailLoading && trailOrderId === order.order_id} onClick={() => void openTrail(order.order_id)}>调度轨迹</Button>
            </div>
          )) || <span className="text-slate-400">暂无真实进行中的服务</span>}
        </div>
      </Card>
      <Card size="small" title={`真实请求队列 · 待匹配 (${waiting.length})`}>
        <div className="mb-2 text-xs text-amber-800">这里是 status=pending 的单：还在自动匹配/等空闲志愿者，不是「必须管理员手点才派」。</div>
        <div className="space-y-2 text-sm">
          {waiting.slice(0, 8).map((order) => (
            <div key={order.order_id} className="rounded-lg bg-amber-50 p-2">
              <b>{order.elder_name}</b> · {order.service_type}
              <Tag className="ml-2" color={order.urgency === 'sos' ? 'red' : order.dispatch_state === 'queued_waiting_capacity' || order.dispatch_phase === 'fallback' ? 'volcano' : 'orange'}>{phaseLabel(order)}</Tag>
              <div className="mt-1 text-xs text-amber-800">
                {order.urgency === 'sos'
                  ? (order.dispatch_state === 'queued_waiting_capacity' || order.dispatch_state === 'admin_escalated'
                    ? 'SOS：暂无空闲自动接单人选，系统排队重试中'
                    : 'SOS：系统自动强制派单中')
                  : (order.dispatch_state === 'queued_waiting_capacity' || order.dispatch_phase === 'fallback'
                    ? '普通单：等待技能匹配志愿者空闲/自动兜底'
                    : `普通单：${order.dispatch_phase || `第 ${order.search_stage} 轮`} 自动邀请中`)}
              </div>
              <Button size="small" className="mt-2" loading={trailLoading && trailOrderId === order.order_id} onClick={() => void openTrail(order.order_id)}>调度轨迹</Button>
            </div>
          )) || <span className="text-slate-400">暂无排队中的真实请求</span>}
        </div>
      </Card>
    </div>

    {trail && trailOrderId === trail.order_id ? (
      <Card className="mt-4" size="small" title={`#${trail.order_id} 调度轨迹 · ${trail.elder_name || ''} · ${trail.service_type || ''}`} extra={<Button type="link" onClick={() => { setTrail(null); setTrailOrderId(null) }}>关闭</Button>}>
        <div className="space-y-3 text-sm">
          {(['top1', 'top3', 'top10', 'fallback'] as const).map((key) => {
            const phase = trail.phases?.[key]
            if (!phase) return null
            const hasPeople = (phase.invited?.length || 0) + (phase.newly_invited?.length || 0) + (phase.kept?.length || 0) > 0
            if (!hasPeople && !phase.at) return null
            return (
              <div key={key} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="mb-1 font-medium text-slate-800">{phase.label}{phase.at ? <span className="ml-2 text-xs font-normal text-slate-500">{phase.at}</span> : null}</div>
                {key === 'top1' ? (
                  <div>邀请：{namesOf(phase.invited?.length ? phase.invited : phase.newly_invited)}</div>
                ) : (
                  <>
                    <div>本阶段新增：{namesOf(phase.newly_invited)}</div>
                    <div>粘性保留（仍可抢）：{namesOf(phase.kept)}</div>
                    <div>当前池合计：{namesOf(phase.invited)}</div>
                  </>
                )}
              </div>
            )
          })}
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
            <div className="font-medium text-emerald-900">最终派给</div>
            {trail.assignee ? (
              <div className="mt-1 text-emerald-800">
                {trail.assignee.volunteer_name}
                {trail.assignee.automatic ? ' · 系统自动/强制' : ' · 人工或自主接单'}
                {trail.assignee.message ? ` · ${trail.assignee.message}` : ''}
              </div>
            ) : (
              <div className="mt-1 text-emerald-800">尚未派成；当前仍开放：{namesOf(trail.current_invited)}</div>
            )}
          </div>
        </div>
      </Card>
    ) : null}
  </Card>
}
