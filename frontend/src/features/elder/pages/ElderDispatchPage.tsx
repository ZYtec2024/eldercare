import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Tag, Typography } from 'antd'
import { AimOutlined, EnvironmentOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import type { DispatchTracking } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { cancelElderDispatchOrder, completeElderDispatchOrder, createDispatchOrder, fetchDispatchTracking, updateElderDispatchLocation } from '@/services/adapters/dispatch-adapter'

const stateLabel: Record<string, string> = {
  matching: '正在找人', waiting_response: '等待志愿者答应', accepted: '志愿者正在赶来', serving: '志愿者正在帮忙',
  forced_assigned: '已安排紧急志愿者', completed: '已经完成', admin_escalated: '社区正在协助', queued_waiting_capacity: '稍等，合适的人忙完就来',
  cancelled: '已取消',
}
const phaseLabel: Record<string, string> = { top1: '正在联系最近的人', top3: '正在扩大寻找', top10: '继续寻找志愿者', fallback: '社区会帮忙安排' }
const volunteerStateLabel: Record<string, string> = { idle: '空闲', en_route: '正在前往', serving: '正在服务', returning: '正在返家', offline: '离线' }
const volunteerStateColor: Record<string, string> = { idle: 'green', en_route: 'blue', serving: 'purple', returning: 'magenta', offline: 'default' }
const skillLabel: Record<string, string> = { medical_support: '医疗陪护', emergency_response: '应急救援', mobility_assist: '行动协助', errand: '代办采购', rehab: '康复辅助', companion: '陪伴聊天', digital_assist: '智能设备协助', grooming: '生活照料' }

export default function ElderDispatchPage() {
  const { session } = useSession()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [locationForm] = Form.useForm()
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [sending, setSending] = useState(false)
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
      <Typography.Title level={2} className="!mb-2 !text-white">请人帮忙</Typography.Title>
      <Typography.Paragraph className="!text-blue-100 !mb-4 !text-base">
        先选好家里地址，再说需要什么帮助。着急时请去「紧急求助」。
      </Typography.Paragraph>
      <Button danger size="large" onClick={() => navigate('/elder/sos')}>我很着急，去紧急求助</Button>
    </div>
    <Alert showIcon type="info" message="大概会怎样" description="系统会先找附近合适的志愿者。有人答应后，您可以在下面看到谁正在赶来。" />
    <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
      <div className="space-y-6">
        <Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />我家地址</Space>}>
          <Form form={locationForm} layout="vertical" onFinish={saveLocation}>
            <Form.Item name="address" label="详细地址" rules={[{ required: true, message: '请填写地址' }]}><Input placeholder="例如：上海市宝山区友谊路 88 号" /></Form.Item>
            <div className="grid grid-cols-2 gap-3"><Form.Item name="lng" label="经度" rules={[{ required: true }]}><InputNumber precision={6} className="!w-full" /></Form.Item><Form.Item name="lat" label="纬度" rules={[{ required: true }]}><InputNumber precision={6} className="!w-full" /></Form.Item></div>
            <Button htmlType="submit" block size="large" loading={savingLocation}>保存地址</Button>
          </Form>
        </Card>
        <Card className="!rounded-2xl"><Typography.Title level={4}>我要什么帮助</Typography.Title><Form form={form} layout="vertical" onFinish={submit} initialValues={{ serviceHours: 1 }}>
          <Form.Item name="serviceType" label="帮助类型" rules={[{ required: true, message: '请选择' }]}><Select size="large" placeholder="请选择" options={tracking?.service_catalog.filter((item) => !item.urgent).map((item) => ({ value: item.code, label: item.label }))} /></Form.Item>
          <Form.Item noStyle shouldUpdate>{() => { const selected = tracking?.service_catalog.find((item) => item.code === form.getFieldValue('serviceType')); return selected ? <div className="mb-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800"><AimOutlined className="mr-2" />这类帮助通常需要：{selected.skill_labels.map((skill) => <Tag color="blue" key={skill}>{skill}</Tag>)}</div> : null }}</Form.Item>
          <Form.Item name="serviceHours" label="大概多久"><InputNumber min={0.5} max={8} step={0.5} className="!w-full" addonAfter="小时" /></Form.Item>
          <Form.Item name="notes" label="还有什么要说的"><Input.TextArea rows={3} placeholder="例如：需要轮椅、要带医保卡" /></Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={sending} icon={<ThunderboltOutlined />}>开始找人</Button>
        </Form></Card>
      </div>
      <div><DispatchMap overview={tracking} /><div className="mt-3 rounded-xl bg-sky-50 p-3 text-sm text-sky-900">{tracking?.privacy_message || '正在载入位置说明…'}<div className="mt-2"><Tag color="green">绿色：路况好</Tag><Tag color="gold">黄色：有点堵</Tag><Tag color="red">红色：很堵</Tag></div></div></div>
    </div>
    <div><Typography.Title level={3}>进行中的帮助</Typography.Title><div className="grid gap-4 md:grid-cols-2">{orders.length ? orders.map((order) => <Card key={order.order_id} className="!rounded-2xl" title={<Space><Tag color={order.urgency === 'sos' ? 'red' : 'blue'}>{order.urgency === 'sos' ? '紧急' : '普通'}</Tag><span>{order.service_type}</span></Space>} extra={<Tag color={order.status === 'completed' ? 'default' : order.status === 'accepted' || order.status === 'in_progress' ? 'green' : 'orange'}>{stateLabel[order.dispatch_state] || order.dispatch_state}</Tag>}><div className="space-y-2 text-base text-slate-600"><div>地点：{order.address || '家里地址'}</div><div>进度：{phaseLabel[order.dispatch_phase || ''] || '正在安排'}</div><div>来帮忙的人：{order.volunteer_name || '还在寻找中'}</div>{order.volunteer_name ? <div className="rounded-xl bg-emerald-50 p-3"><div className="font-medium text-emerald-900">{order.volunteer_name} · 评分 {Number(order.volunteer_rating || 0).toFixed(1)}</div><Space className="mt-2" wrap>{(order.volunteer_skills || []).map((skill) => <Tag color="green" key={skill}>{skillLabel[skill] || skill}</Tag>)}</Space></div> : null}{order.volunteer_availability ? <Tag color={volunteerStateColor[order.volunteer_availability] || 'blue'}>{volunteerStateLabel[order.volunteer_availability] || order.volunteer_availability}</Tag> : null}{order.location_sharing_active ? <Tag color="green">正在共享位置</Tag> : order.status === 'completed' ? <Tag>已结束</Tag> : null}<Space wrap>{order.amap_navigation_url ? <Button size="large" onClick={() => window.open(order.amap_navigation_url, '_blank', 'noopener,noreferrer')}>查看路线</Button> : null}{order.status === 'in_progress' ? <Button size="large" type="primary" loading={completingOrder === order.order_id} onClick={() => completeOrder(order.order_id)}>确认已经帮完</Button> : null}{['pending', 'accepted'].includes(order.status) ? <Button size="large" danger loading={cancellingOrder === order.order_id} onClick={() => cancelOrder(order.order_id)}>取消</Button> : null}</Space></div></Card>) : <Card className="!rounded-2xl text-slate-500 text-base">还没有进行中的帮助。提交需求后，进度会出现在这里。</Card>}</div></div>
  </div>
}
