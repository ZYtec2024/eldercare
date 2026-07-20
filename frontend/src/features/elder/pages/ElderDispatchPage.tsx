import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Tag, Typography } from 'antd'
import { AlertOutlined, AimOutlined, EnvironmentOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import type { DispatchTracking } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { cancelElderDispatchOrder, completeElderDispatchOrder, createDispatchOrder, fetchDispatchTracking, updateElderDispatchLocation } from '@/services/adapters/dispatch-adapter'

const stateLabel: Record<string, string> = {
  matching: '正在计算候选', waiting_response: '等待候选响应', accepted: '志愿者正在出发', serving: '志愿者正在服务',
  forced_assigned: 'SOS已强制派单', completed: '服务完成', admin_escalated: '管理员介入中', queued_waiting_capacity: '等待合适志愿者空闲',
  cancelled: '已取消',
}
const phaseLabel: Record<string, string> = { top1: 'Top1 专属确认（8秒）', top3: 'Top3 手动抢单（至20秒）', top10: 'Top10 扩散抢单（至35秒）', fallback: '自动兜底 / 管理员介入' }
const volunteerStateLabel: Record<string, string> = { idle: '空闲', en_route: '正在前往', serving: '正在服务', returning: '正在返家', offline: '离线' }
const volunteerStateColor: Record<string, string> = { idle: 'green', en_route: 'blue', serving: 'purple', returning: 'magenta', offline: 'default' }
const skillLabel: Record<string, string> = { medical_support: '医疗陪护', emergency_response: '应急救援', mobility_assist: '行动协助', errand: '代办采购', rehab: '康复辅助', companion: '陪伴聊天', digital_assist: '智能设备协助', grooming: '生活照料' }

export default function ElderDispatchPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [locationForm] = Form.useForm()
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [sending, setSending] = useState(false)
  const [sosDetail, setSosDetail] = useState('突发身体不适，需要医疗急救响应')
  const [savingLocation, setSavingLocation] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState<number | null>(null)
  const [completingOrder, setCompletingOrder] = useState<number | null>(null)

  const load = async () => {
    if (!session) return
    const data = await fetchDispatchTracking('elder', session.userId)
    setTracking(data)
    const elder = data.elders[0]
    if (elder) locationForm.setFieldsValue({ address: elder.address, lng: elder.lng, lat: elder.lat })
  }
  useEffect(() => { load().catch(() => {}); const timer = window.setInterval(() => load().catch(() => {}), 3500); return () => window.clearInterval(timer) }, [session?.userId])

  const submit = async (values: { serviceType: string; serviceHours?: number; notes?: string }) => {
    if (!session) return
    setSending(true)
    try {
      const result = await createDispatchOrder({ userId: session.userId, serviceType: values.serviceType, serviceHours: values.serviceHours, notes: values.notes })
      message.success(result.message)
      form.resetFields(['notes'])
      await load()
    } catch (err: any) { message.error(err?.message || '请求创建失败') } finally { setSending(false) }
  }
  const saveLocation = async (values: { address: string; lng: number; lat: number }) => {
    if (!session) return
    setSavingLocation(true)
    try {
      const result = await updateElderDispatchLocation({ userId: session.userId, address: values.address, lng: values.lng, lat: values.lat, source: 'fixed_home' })
      message.success(result.message)
      await load()
    } catch (err: any) { message.error(err?.message || '保存固定住址失败') } finally { setSavingLocation(false) }
  }
  const sos = async () => {
    if (!session) return
    setSending(true)
    try {
      const result = await createDispatchOrder({ userId: session.userId, serviceType: 'SOS紧急救助', urgent: true, notes: `SOS具体需求：${sosDetail}` })
      message.success(result.message)
      await load()
    } catch (err: any) { message.error(err?.message || 'SOS派单失败') } finally { setSending(false) }
  }
  const cancelOrder = async (orderId: number) => {
    if (!session) return
    setCancellingOrder(orderId)
    try { const result = await cancelElderDispatchOrder(orderId, session.userId); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '取消订单失败') } finally { setCancellingOrder(null) }
  }
  const completeOrder = async (orderId: number) => {
    if (!session) return
    setCompletingOrder(orderId)
    try { const result = await completeElderDispatchOrder(orderId, session.userId); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '确认服务完成失败') } finally { setCompletingOrder(null) }
  }

  const orders = tracking?.orders ?? []
  return <div className="space-y-6">
    <div className="rounded-3xl bg-gradient-to-r from-indigo-700 via-blue-700 to-cyan-700 p-6 text-white shadow-xl">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><Typography.Title level={2} className="!mb-1 !text-white">智能安心求助</Typography.Title><Typography.Text className="!text-blue-100">固定家庭服务点，系统按技能、距离、路况、疲劳度和评分安排响应。</Typography.Text></div><Space wrap><Select value={sosDetail} onChange={setSosDetail} className="min-w-56" options={['突发身体不适，需要医疗急救响应', '跌倒受伤，需要急救与行动协助', '迷路或走失风险，需要紧急陪护', '突发用药问题，需要紧急代购药品'].map((value) => ({ value, label: value }))} /><Button danger size="large" icon={<AlertOutlined />} loading={sending} onClick={sos} className="!h-12 !rounded-xl !font-bold">发送具体 SOS 求助</Button></Space></div>
    </div>
    <Alert showIcon type="info" icon={<SafetyCertificateOutlined />} message="智能派单时间轴" description="普通请求先由综合评分最高者专属确认 8 秒；未确认则依次开放 Top3（至20秒）、Top10（至35秒）抢单；仍无人接单时，系统只会把订单自动派给已开启自动接单且技能匹配的空闲志愿者。若所有合适志愿者正在服务，订单会继续排队等待，不会丢失。SOS 不等待，立即强制调度。" />
    <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
      <div className="space-y-6">
        <Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />固定家庭服务点</Space>}>
          <Form form={locationForm} layout="vertical" onFinish={saveLocation}>
            <Form.Item name="address" label="家庭固定服务地址" rules={[{ required: true, message: '请输入家庭服务地址' }]}><Input placeholder="例如：上海市宝山区友谊路 88 号" /></Form.Item>
            <div className="grid grid-cols-2 gap-3"><Form.Item name="lng" label="经度" rules={[{ required: true }]}><InputNumber precision={6} className="!w-full" /></Form.Item><Form.Item name="lat" label="纬度" rules={[{ required: true }]}><InputNumber precision={6} className="!w-full" /></Form.Item></div>
            <Button htmlType="submit" block loading={savingLocation}>保存固定服务点</Button>
          </Form>
        </Card>
        <Card className="!rounded-2xl"><Typography.Title level={4}>发起服务请求</Typography.Title><Form form={form} layout="vertical" onFinish={submit} initialValues={{ serviceHours: 1 }}>
          <Form.Item name="serviceType" label="需要什么帮助" rules={[{ required: true, message: '请选择服务' }]}><Select placeholder="选择服务类型" options={tracking?.service_catalog.filter((item) => !item.urgent).map((item) => ({ value: item.code, label: `${item.label} · 需${item.skill_labels.join('、')}` }))} /></Form.Item>
          <Form.Item noStyle shouldUpdate>{() => { const selected = tracking?.service_catalog.find((item) => item.code === form.getFieldValue('serviceType')); return selected ? <div className="mb-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800"><AimOutlined className="mr-2" />必需技能：{selected.skill_labels.map((skill) => <Tag color="blue" key={skill}>{skill}</Tag>)}</div> : null }}</Form.Item>
          <Form.Item name="serviceHours" label="预计服务时长"><InputNumber min={0.5} max={8} step={0.5} className="!w-full" addonAfter="小时" /></Form.Item>
          <Form.Item name="notes" label="补充说明"><Input.TextArea rows={3} placeholder="例如：需要轮椅辅助、携带医保卡" /></Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={sending} icon={<ThunderboltOutlined />}>启动智能推荐</Button>
        </Form></Card>
      </div>
      <div><DispatchMap overview={tracking} /><div className="mt-3 rounded-xl bg-sky-50 p-3 text-sm text-sky-900">{tracking?.privacy_message || '正在载入位置隐私策略…'}<div className="mt-2"><Tag color="green">绿色：畅通</Tag><Tag color="gold">黄色：缓行</Tag><Tag color="red">红色：拥堵</Tag><Tag color="purple">紫色：志愿者返家</Tag></div></div></div>
    </div>
    <div><Typography.Title level={3}>我的实时调度</Typography.Title><div className="grid gap-4 md:grid-cols-2">{orders.length ? orders.map((order) => <Card key={order.order_id} className="!rounded-2xl" title={<Space><Tag color={order.urgency === 'sos' ? 'red' : 'blue'}>{order.urgency === 'sos' ? 'SOS' : '智能推荐'}</Tag><span>{order.service_type}</span></Space>} extra={<Tag color={order.status === 'completed' ? 'default' : order.status === 'accepted' || order.status === 'in_progress' ? 'green' : 'orange'}>{stateLabel[order.dispatch_state] || order.dispatch_state}</Tag>}><div className="space-y-2 text-sm text-slate-600"><div>服务地址：{order.address || '固定住址'}</div><div>当前调度：{phaseLabel[order.dispatch_phase || ''] || `第 ${order.search_stage} 轮候选`}</div><div>服务志愿者：{order.volunteer_name || '正在匹配技能合适的志愿者'}</div>{order.volunteer_name ? <div className="rounded-xl bg-emerald-50 p-3"><div className="font-medium text-emerald-900">志愿者服务资料：{order.volunteer_name} · 评分 {Number(order.volunteer_rating || 0).toFixed(2)} / 5</div><Space className="mt-2" wrap>{(order.volunteer_skills || []).map((skill) => <Tag color="green" key={skill}>{skillLabel[skill] || skill}</Tag>)}</Space></div> : null}{order.volunteer_availability ? <Tag color={volunteerStateColor[order.volunteer_availability] || 'blue'}>志愿者状态：{volunteerStateLabel[order.volunteer_availability] || order.volunteer_availability}</Tag> : null}{order.location_sharing_active ? <Tag color="green">位置和路线正在共享</Tag> : order.status === 'completed' ? <Tag>服务已结束，志愿者位置已锁定</Tag> : null}<Space wrap>{order.amap_navigation_url ? <Button size="small" onClick={() => window.open(order.amap_navigation_url, '_blank', 'noopener,noreferrer')}>在高德查看服务路线</Button> : null}{order.status === 'in_progress' ? <Button size="small" type="primary" loading={completingOrder === order.order_id} onClick={() => completeOrder(order.order_id)}>确认服务完成</Button> : null}{['pending', 'accepted'].includes(order.status) ? <Button size="small" danger loading={cancellingOrder === order.order_id} onClick={() => cancelOrder(order.order_id)}>取消订单</Button> : null}</Space></div></Card>) : <Card className="!rounded-2xl text-slate-500">暂时没有调度请求。发布需求后可在这里查看接单和出发状态。</Card>}</div></div>
  </div>
}
