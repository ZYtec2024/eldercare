import { useEffect, useMemo, useState } from 'react'
import { App, Button, Card, Progress, Select, Table, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

import { DispatchSimulationPanel } from '@/features/admin/components/DispatchSimulationPanel'
import { RealDispatchPanel } from '@/features/admin/components/RealDispatchPanel'
import { useSession } from '@/features/auth/useSession'
import type { DispatchOverview } from '@/features/dispatch/dispatch-types'
import { fetchAdminDispatchRegions, fetchDispatchOverview, manuallyAssignDispatchOrder } from '@/services/adapters/dispatch-adapter'

const queueStateLabel: Record<string, string> = {
  matching: '计算候选中',
  waiting_response: '等待候选响应',
  queued_waiting_capacity: '等待技能匹配志愿者空闲',
  admin_escalated: '请管理员人工关注',
}

export default function AdminDispatchBoardPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [overview, setOverview] = useState<DispatchOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [regions, setRegions] = useState<Array<{ adcode: string; name: string }>>([])
  const [regionAdcode, setRegionAdcode] = useState<string>()
  const load = async () => {
    if (!session) return
    setLoading(true)
    try { setOverview(await fetchDispatchOverview(session.userId, regionAdcode)) } finally { setLoading(false) }
  }
  const handleManualAssign = async (orderId: number, volunteerId: number) => {
    if (!session) return
    const reason = window.prompt('请输入人工介入原因（将写入调度审计记录）：', '本区管理员人工兜底')
    if (!reason?.trim()) return
    try {
      await manuallyAssignDispatchOrder(orderId, { adminUserId: session.userId, volunteerId, reason })
      message.success('人工派单成功，路线已从志愿者实时位置生成')
      await load()
    } catch (error: any) {
      message.error(error?.message || '人工派单失败')
    }
  }
  useEffect(() => {
    if (!session) return
    fetchAdminDispatchRegions(session.userId).then((items) => {
      setRegions(items)
      setRegionAdcode((current) => current || items[0]?.adcode)
    }).catch(() => {})
  }, [session?.userId])
  useEffect(() => {
    if (!session) return
    load().catch(() => {})
    // Admin, elder and family all read the same persisted route progress.
    // Poll at the same cadence as the journey update so the command map keeps
    // its marker interpolation continuous instead of visibly catching up.
    const timer = window.setInterval(() => load().catch(() => {}), 3_000)
    return () => window.clearInterval(timer)
  }, [session?.userId, regionAdcode])
  const columns = useMemo(() => [
    { title: '订单', render: (_: unknown, row: DispatchOverview['candidates'][number]) => <span>#{row.order_id} · {row.service_type}</span> },
    { title: '最适配志愿者', dataIndex: 'volunteer_name' },
    { title: '技能', dataIndex: 'skill_match', render: (value: string) => <Tag color="green">{value}</Tag> },
    { title: '距离 / ETA', render: (_: unknown, row: DispatchOverview['candidates'][number]) => `${row.distance_km ?? '-'} km / ${row.eta_minutes ?? '-'} 分钟` },
    { title: '综合分', dataIndex: 'total_score', render: (value: number | null) => value == null ? '-' : <b>{value}</b> },
  ], [])
  return <div className="space-y-6">
    <div className="rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-900 to-blue-900 p-6 text-white shadow-xl">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><Typography.Title level={2} className="!mb-1 !text-white">高德实时调度指挥台</Typography.Title><Typography.Text className="!text-indigo-200">沙盘：3 名近距离 + 2 名远距离志愿者、15 位老人 · Top1 / Top3 / Top10 / 自动兜底 · SOS 队首 · 连续高德道路动画</Typography.Text></div><Button icon={<ReloadOutlined />} loading={loading} onClick={() => load().catch(() => {})}>刷新真实订单数据</Button></div>
    </div>
    <div className="grid gap-4 md:grid-cols-5">{[['待调度', overview?.summary.pending ?? 0, '#f59e0b'], ['服务中', overview?.summary.assigned ?? 0, '#2563eb'], ['SOS', overview?.summary.sos ?? 0, '#ef4444'], ['等待容量', overview?.summary.admin_watch ?? 0, '#7c3aed'], ['空闲志愿者', overview?.summary.idle_volunteers ?? 0, '#10b981']].map(([name, value, color]) => <Card key={String(name)} className="!rounded-2xl"><div className="text-sm text-slate-500">{name}</div><div className="text-3xl font-bold" style={{ color: String(color) }}>{value}</div></Card>)}</div>
    <Card className="!rounded-2xl" size="small"><div className="flex flex-wrap items-center gap-3"><b>当前管理区县</b><Select className="min-w-52" value={regionAdcode} options={regions.map((item) => ({ value: item.adcode, label: item.name }))} onChange={setRegionAdcode} /><span className="text-slate-500">候选、订单、SOS 和路线均严格限制在这个区县内。</span></div></Card>
    <RealDispatchPanel overview={overview} onManualAssign={handleManualAssign} />
    <div className="border-t border-dashed border-slate-300 pt-6"><div className="mb-3"><Typography.Title level={3} className="!mb-1">模拟调度沙盘</Typography.Title><Typography.Text type="secondary">以下请求与位置均为系统自动生成，仅用于演示并行派单、SOS 重规划、返程截单和连续路线动画。</Typography.Text></div><DispatchSimulationPanel overview={overview} /></div>
    <div className="grid gap-6 xl:grid-cols-[1.45fr_.85fr]">
      <Card className="!rounded-2xl" title="真实订单：技能合格候选评分"><Table rowKey={(row) => `${row.order_id}-${row.volunteer_id}`} size="small" pagination={{ pageSize: 7 }} columns={columns} dataSource={(overview?.candidates ?? []).filter((candidate) => candidate.eligible)} /></Card>
      <Card className="!rounded-2xl" title="真实订单队列"><div className="space-y-3">{overview?.orders.filter((order) => order.status === 'pending').slice(0, 8).map((order) => <div key={order.order_id} className="rounded-xl border border-slate-200 p-3"><div className="flex justify-between"><b>#{order.order_id} {order.service_type}</b><Tag color={order.urgency === 'sos' ? 'red' : 'orange'}>{order.urgency === 'sos' ? 'SOS' : `第 ${order.search_stage} 轮`}</Tag></div><div className="mt-1 text-xs text-slate-500">{order.elder_name} · {queueStateLabel[order.dispatch_state] || order.dispatch_state}</div></div>) || <span className="text-slate-400">真实订单队列为空</span>}</div></Card>
    </div>
    <Card className="!rounded-2xl" title="真实账号疲劳度（完成服务累积，休息每小时恢复 4 点，零点清零）"><div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">{overview?.volunteers.slice(0, 8).map((volunteer) => <div key={volunteer.volunteer_id} className="rounded-xl bg-slate-50 p-3"><div className="flex justify-between"><b>{volunteer.name}</b><Tag color={volunteer.availability === 'idle' ? 'green' : 'blue'}>{volunteer.availability}</Tag></div><Progress size="small" percent={volunteer.fatigue} status={volunteer.fatigue > 70 ? 'exception' : 'active'} /><div className="text-xs text-slate-500">评分 {volunteer.rating} · 今日完成 {volunteer.assigned_today} 单</div></div>)}</div></Card>
  </div>
}
