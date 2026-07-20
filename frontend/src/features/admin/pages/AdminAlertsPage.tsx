import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import { AlertOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'

import { fetchAdminAlerts, handleAdminAlert } from '@/services/adapters/admin-adapter'
import { manuallyAssignDispatchOrder, startManualSosService, type ManualSosCandidate } from '@/services/adapters/dispatch-adapter'
import { AdminRegionScopeNotice } from '@/features/admin/components/AdminRegionScopeNotice'
import { useSession } from '@/features/auth/useSession'
import type { AlertItem } from '@/types/domain'

const statusPresentation: Record<string, { label: string; color: string }> = {
  reported: { label: '待社区接警', color: 'red' },
  acknowledged: { label: '已接警，正在处置', color: 'blue' },
  dispatching: { label: '志愿服务调度中', color: 'orange' },
  awaiting_admin_close: { label: '服务已完成，待确认关闭', color: 'gold' },
  resolved: { label: '已处理并关闭', color: 'green' },
}

export default function AdminAlertsPage() {
  const { message } = App.useApp()
  const { session } = useSession()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<number | null>(null)
  const [closeTarget, setCloseTarget] = useState<AlertItem | null>(null)
  const [assignmentTarget, setAssignmentTarget] = useState<{ orderId: number; candidates: ManualSosCandidate[] } | null>(null)
  const [closeForm] = Form.useForm<{ summary: string }>()

  const load = async () => {
    if (!session) return
    setLoading(true)
    try { setAlerts(await fetchAdminAlerts(session.userId)) } catch { message.error('告警中心加载失败') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [session?.userId])

  const acknowledge = async (item: AlertItem) => {
    if (!session) return
    setActionId(item.alertId)
    try { message.success((await handleAdminAlert(item.alertId, session.userId, 'acknowledge')).message); await load() }
    catch (error: any) { message.error(error?.message || '确认接警失败') }
    finally { setActionId(null) }
  }
  const startService = async (item: AlertItem) => {
    if (!session || !item.incidentId) return
    setActionId(item.alertId)
    try {
      const result = await startManualSosService(item.incidentId, session.userId)
      setAssignmentTarget({ orderId: result.data.order_id, candidates: result.data.candidates || [] })
      message.success('已计算本区技能匹配候选人，请确认派单')
      await load()
    } catch (error: any) { message.error(error?.message || '启动志愿服务失败') }
    finally { setActionId(null) }
  }
  const assignVolunteer = async (candidate: ManualSosCandidate) => {
    if (!session || !assignmentTarget) return
    setActionId(candidate.volunteer_id)
    try {
      message.success((await manuallyAssignDispatchOrder(assignmentTarget.orderId, {
        adminUserId: session.userId, volunteerId: candidate.volunteer_id,
        reason: '管理员在 SOS 告警中心人工指定技能匹配志愿者',
      })).message)
      setAssignmentTarget(null); await load()
    } catch (error: any) { message.error(error?.message || '人工派单失败') }
    finally { setActionId(null) }
  }
  const confirmClose = async () => {
    if (!session || !closeTarget) return
    const values = await closeForm.validateFields()
    setActionId(closeTarget.alertId)
    try {
      message.success((await handleAdminAlert(closeTarget.alertId, session.userId, 'close', values.summary)).message)
      closeForm.resetFields(); setCloseTarget(null); await load()
    } catch (error: any) { message.error(error?.message || '关闭 SOS 事件失败') }
    finally { setActionId(null) }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>
  return <div className="space-y-6">
    <AdminRegionScopeNotice />
    <div><Typography.Title level={3} className="!mb-1"><AlertOutlined className="mr-2 text-red-500" />告警中心</Typography.Title><Typography.Text type="secondary">本区管理员主处置；总管理员同步查看。SOS 的接警、派单、服务完成和关闭全程留痕。</Typography.Text></div>
    <Alert showIcon type="info" message="SOS 闭环规则" description="确认接警不等于关闭；服务完成后系统自动提示管理员确认风险是否解除。只有填写处置结果后，SOS 才会关闭。" />
    <Card className="!rounded-2xl">
      <List dataSource={alerts} locale={{ emptyText: '暂无告警' }} renderItem={(item) => {
        const isSos = item.category === 'sos' && Boolean(item.incidentId)
        const incident = item.incidentStatus || (item.status === 'handled' ? 'resolved' : 'reported')
        const display = statusPresentation[incident] || { label: incident, color: 'default' }
        const active = isSos && incident !== 'resolved'
        const serviceState = item.linkedOrderStatus === 'completed' ? '服务已完成' : item.linkedOrderStatus === 'in_progress' ? '正在服务' : item.linkedOrderStatus === 'accepted' ? '志愿者正在前往' : null
        return <List.Item actions={active ? [
          ...(incident === 'reported' ? [<Button key="ack" type="primary" size="small" loading={actionId === item.alertId} onClick={() => void acknowledge(item)}>确认接警</Button>] : []),
          ...(!item.linkedOrderId ? [<Button key="service" type="primary" size="small" loading={actionId === item.alertId} onClick={() => void startService(item)}>安排志愿者</Button>] : []),
          <Button key="close" danger={incident !== 'awaiting_admin_close'} type={incident === 'awaiting_admin_close' ? 'primary' : 'default'} size="small" loading={actionId === item.alertId} onClick={() => setCloseTarget(item)}>{incident === 'awaiting_admin_close' ? '确认已处理' : '关闭事件'}</Button>,
        ] : [<Tag key="closed" icon={<CheckCircleOutlined />} color="green">已处理</Tag>] }>
          <List.Item.Meta
            avatar={item.category === 'sos' ? <AlertOutlined className="text-2xl text-red-500" /> : <WarningOutlined className="text-2xl text-orange-500" />}
            title={<Space wrap><b>{item.category === 'sos' ? 'SOS 紧急求助' : '健康异常告警'}</b><Tag color={display.color}>{display.label}</Tag><span className="text-xs text-slate-400">{item.sourceLabel}</span></Space>}
            description={<div className="space-y-1"><div>{item.createdAt}</div><div>{item.resolutionSummary || '等待处置记录'}</div>{item.linkedOrderId ? <div className="text-blue-700">关联服务 #{item.linkedOrderId} · {item.linkedVolunteerName || '待指派志愿者'} · {serviceState || '正在调度'}</div> : null}</div>}
          />
        </List.Item>
      }} />
    </Card>
    <Modal open={Boolean(assignmentTarget)} title="为 SOS 指定志愿者" footer={null} onCancel={() => setAssignmentTarget(null)}>
      <Typography.Paragraph type="secondary">仅显示本区、技能精确匹配且当前可用的志愿者；确认后系统会锁定订单并从其当前实时位置生成路线。</Typography.Paragraph>
      <div className="space-y-2">{(assignmentTarget?.candidates || []).map((candidate) => <div key={candidate.volunteer_id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div><b>{candidate.volunteer_name}</b><div className="mt-1 text-xs text-slate-500">{candidate.skill_match} · {candidate.distance_km} km · ETA {candidate.eta_minutes} 分钟 · 综合 {candidate.total_score}</div></div><Button type="primary" loading={actionId === candidate.volunteer_id} onClick={() => void assignVolunteer(candidate)}>确认派单</Button></div>)}{!assignmentTarget?.candidates?.length ? <Typography.Text type="secondary">当前没有技能匹配且可用的志愿者，SOS 会保留在本区等待资源。</Typography.Text> : null}</div>
    </Modal>
    <Modal open={Boolean(closeTarget)} title="确认 SOS 已处理" okText="确认关闭" cancelText="取消" onCancel={() => { closeForm.resetFields(); setCloseTarget(null) }} onOk={() => void confirmClose()}>
      <Typography.Paragraph type="secondary">请确认老人风险已经解除。若志愿服务已完成，建议填写服务结果、老人或家属确认情况。</Typography.Paragraph>
      <Form form={closeForm} layout="vertical"><Form.Item name="summary" label="处置结果" rules={[{ required: true, message: '请填写处置结果' }]}><Input.TextArea rows={4} maxLength={1000} placeholder="例如：志愿者已完成陪护，家属确认老人安全。" /></Form.Item></Form>
    </Modal>
  </div>
}
