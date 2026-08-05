import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Progress, Table, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

import { AdminGeoScopeFilters, type AdminGeoScope } from '@/features/admin/components/AdminGeoScopeFilters'
import { DispatchSimulationPanel } from '@/features/admin/components/DispatchSimulationPanel'
import { RealDispatchPanel } from '@/features/admin/components/RealDispatchPanel'
import { useSession } from '@/features/auth/useSession'
import type { DispatchOverview } from '@/features/dispatch/dispatch-types'
import { fetchDispatchOverview } from '@/services/adapters/dispatch-adapter'

const queueStateLabel: Record<string, string> = {
  scheduled: '预约待开始（未向志愿者扩散）',
  matching: '计算候选中',
  waiting_response: '等待候选响应',
  queued_waiting_capacity: '等待技能匹配志愿者空闲',
  admin_escalated: '请管理员人工关注',
}

export default function AdminDispatchBoardPage() {
  const { session } = useSession()
  const [overview, setOverview] = useState<DispatchOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [geoScope, setGeoScope] = useState<AdminGeoScope>({})
  const simulationEnabled = import.meta.env.VITE_ENABLE_SIMULATION === 'true'
  const load = async () => {
    if (!session || !geoScope.regionAdcode) return
    setLoading(true)
    try { setOverview(await fetchDispatchOverview(session.userId, geoScope.regionAdcode)) } finally { setLoading(false) }
  }
  useEffect(() => {
    if (!session || !geoScope.regionAdcode) return
    load().catch(() => {})
    // Admin, elder and family all read the same persisted route progress.
    // Poll at the same cadence as the journey update so the command map keeps
    // its marker interpolation continuous instead of visibly catching up.
    const timer = window.setInterval(() => load().catch(() => {}), 3_000)
    return () => window.clearInterval(timer)
  }, [session?.userId, geoScope.regionAdcode])
  const candidateRows = useMemo(() => {
    const seen = new Set<string>()
    const rows: DispatchOverview['candidates'] = []
    for (const candidate of overview?.candidates ?? []) {
      if (!candidate.eligible) continue
      const key = `${candidate.order_id}-${candidate.volunteer_id}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(candidate)
    }
    return rows
  }, [overview?.candidates])
  const columns = useMemo(() => [
    { title: '订单', render: (_: unknown, row: DispatchOverview['candidates'][number]) => <span>#{row.order_id} · {row.service_type}</span> },
    { title: '最适配志愿者', dataIndex: 'volunteer_name' },
    { title: '技能', dataIndex: 'skill_match', render: (value: string) => <Tag color="green">{value}</Tag> },
    { title: '距离 / ETA', render: (_: unknown, row: DispatchOverview['candidates'][number]) => `${row.distance_km ?? '-'} km / ${row.eta_minutes ?? '-'} 分钟` },
    { title: '综合分', dataIndex: 'total_score', render: (value: number | null) => value == null ? '-' : <b>{value}</b> },
  ], [])
  return <div className="space-y-6">
    <div className="section-page-hero p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="role-home-kicker">区域实时调度</div><Typography.Title level={2} className="!mb-1 !text-slate-900">高德实时调度指挥台</Typography.Title><Typography.Text className="!text-slate-600">仅展示待调度或服务中的订单位置与执行路线；订单结束后从实时地图撤下。</Typography.Text></div><Button icon={<ReloadOutlined />} loading={loading} onClick={() => load().catch(() => {})}>刷新真实订单数据</Button></div>
    </div>
    <div className="grid gap-4 md:grid-cols-5">{[['待调度', overview?.summary.pending ?? 0, '#f59e0b'], ['服务中', overview?.summary.assigned ?? 0, '#2563eb'], ['SOS', overview?.summary.sos ?? 0, '#ef4444'], ['等待容量', overview?.summary.admin_watch ?? 0, '#7c3aed'], ['空闲志愿者', overview?.summary.idle_volunteers ?? 0, '#10b981']].map(([name, value, color]) => <Card key={String(name)} className="!rounded-2xl"><div className="text-sm text-slate-500">{name}</div><div className="text-3xl font-bold" style={{ color: String(color) }}>{value}</div></Card>)}</div>
    <Card className="!rounded-2xl" size="small"><div className="flex flex-wrap items-center gap-3"><b>当前管理区县</b><AdminGeoScopeFilters className="min-w-72" value={geoScope} onChange={setGeoScope} leafOnly /><span className="text-slate-500">按“全国 → 省 → 市 → 区县”选择；候选、订单、SOS 和路线均严格限制在所选区县内。</span></div></Card>
    <RealDispatchPanel overview={overview} />
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="!rounded-2xl" title="真实订单：技能合格候选评分"><Table rowKey={(row) => `${row.order_id}-${row.volunteer_id}`} size="small" pagination={{ pageSize: 7 }} columns={columns} dataSource={candidateRows} /></Card>
      <Card className="!rounded-2xl" title="真实订单队列"><div className="space-y-3">{overview?.orders.filter((order) => order.status === 'pending').slice(0, 8).map((order) => <div key={order.order_id} className="rounded-xl border border-slate-200 p-3"><div className="flex justify-between"><b>#{order.order_id} {order.service_type}</b><Tag color={order.urgency === 'sos' ? 'red' : order.dispatch_state === 'scheduled' ? 'blue' : 'orange'}>{order.urgency === 'sos' ? 'SOS' : order.dispatch_state === 'scheduled' ? '预约' : `第 ${order.search_stage} 轮`}</Tag></div><div className="mt-1 text-xs text-slate-500">{order.elder_name} · {queueStateLabel[order.dispatch_state] || order.dispatch_state}</div>{order.service_time ? <div className="mt-1 text-xs font-medium text-slate-700">预约时间：{order.service_time.replace('T', ' ')}</div> : null}</div>) || <span className="text-slate-400">真实订单队列为空</span>}</div></Card>
    </div>
    <Card className="!rounded-2xl" title="真实账号疲劳度（完成服务累积，休息每小时恢复 4 点，零点清零）"><div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">{overview?.volunteers.slice(0, 8).map((volunteer) => <div key={volunteer.volunteer_id} className="rounded-xl bg-slate-50 p-3"><div className="flex justify-between gap-2"><b>{volunteer.name}</b><div className="flex flex-wrap justify-end gap-1"><Tag color={volunteer.availability === 'idle' ? 'green' : 'blue'}>{volunteer.availability}</Tag>{volunteer.fatigue >= 85 ? <Tag color="red">疲劳保护，暂不派单</Tag> : null}</div></div><Progress size="small" percent={volunteer.fatigue} status={volunteer.fatigue >= 85 ? 'exception' : 'active'} /><div className="text-xs text-slate-500">评分 {volunteer.rating} · 今日完成 {volunteer.assigned_today} 单{volunteer.fatigue >= 85 ? ' · 疲劳度降到 85 以下后自动恢复候选资格' : ''}</div></div>)}</div></Card>
    {session?.isRoot && simulationEnabled ? <div className="border-t border-dashed border-slate-300 pt-6">
      <div className="mb-3">
        <Typography.Title level={3} className="!mb-1">模拟调度沙盘</Typography.Title>
        <Typography.Text type="secondary">以下请求与位置均为系统自动生成，仅用于演示并行派单、SOS 重规划、返程截单和连续路线动画。</Typography.Text>
      </div>
      <DispatchSimulationPanel overview={overview} />
    </div> : null}
  </div>
}
