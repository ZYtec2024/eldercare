import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, Select, Space, Tag, Typography } from 'antd'
import { AlertOutlined, SafetyCertificateOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { createEmergencyIncident, fetchEmergencyIncidents, type EmergencyIncident } from '@/services/adapters/elder-adapter'

export default function ElderSosPage() {
  const { session } = useSession()
  const { message, modal } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [incidents, setIncidents] = useState<EmergencyIncident[]>([])
  const [form] = Form.useForm()

  const loadIncidents = () => {
    if (!session) return
    fetchEmergencyIncidents(session.userId).then(setIncidents).catch(() => {})
  }

  useEffect(() => {
    loadIncidents()
    const timer = window.setInterval(loadIncidents, 5000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  const submit = async (dispatchService: boolean) => {
    if (!session) return
    const values = dispatchService ? await form.validateFields() : { incidentType: 'general_help', description: '一键紧急求助' }
    setLoading(true)
    try {
      const result = await createEmergencyIncident({
        reporterUserId: session.userId,
        incidentType: values.incidentType,
        description: values.description,
        dispatchService,
      })
      message.success(result.message)
      if (dispatchService) form.resetFields()
      loadIncidents()
    } catch (err: any) {
      message.error(err?.message || '紧急求助发送失败')
    } finally {
      setLoading(false)
    }
  }

  const handleOneClickAlert = () => {
    modal.confirm({
      title: '确认发送一键紧急告警？',
      content: '系统将立即通知绑定家属和本区管理员，并建立紧急协同会话。若有生命危险，请同步联系 120。',
      okText: '立即告警', okType: 'danger', cancelText: '取消',
      onOk: () => submit(false),
    })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Typography.Title level={2} className="!mb-1">紧急求助</Typography.Title>
        <Typography.Text className="text-gray-500">一键告警通知家属与本区管理员；需要志愿者到场时，请填写具体情况并启动 SOS 服务调度。</Typography.Text>
      </div>

      <Alert type="error" showIcon message="如存在生命危险，请立即拨打 120" description="平台会同步记录事件、提醒家属和本区管理员，但不能替代专业急救服务。" />

      <div className="grid gap-5 md:grid-cols-2">
        <Card className="!rounded-2xl !border-red-200 !bg-red-50" title={<Space><AlertOutlined className="text-red-500" />一键紧急告警</Space>}>
          <Typography.Paragraph>保留原有 SOS 告警能力：不生成普通服务订单，只通知家属和本区管理员并开启协同会话。</Typography.Paragraph>
          <Button danger type="primary" block size="large" loading={loading} onClick={handleOneClickAlert}>立即发送 SOS 告警</Button>
        </Card>

        <Card className="!rounded-2xl !border-orange-200" title={<Space><SafetyCertificateOutlined className="text-orange-500" />紧急服务调度</Space>}>
          <Form form={form} layout="vertical" initialValues={{ incidentType: 'unwell' }}>
            <Form.Item name="incidentType" label="紧急情况" rules={[{ required: true }]}>
              <Select options={[
                { value: 'fall', label: '跌倒或行动困难' },
                { value: 'unwell', label: '身体不适' },
                { value: 'hospital', label: '需陪同就医' },
                { value: 'lost_risk', label: '走失风险' },
                { value: 'other', label: '其他紧急情况' },
              ]} />
            </Form.Item>
            <Form.Item name="description" label="具体情况" rules={[{ required: true, message: '请简要说明需要什么帮助' }]}>
              <Input.TextArea rows={3} maxLength={500} placeholder="例如：头晕无法下楼，需要志愿者陪同前往医院" />
            </Form.Item>
            <Button type="primary" danger block loading={loading} onClick={() => void submit(true)}>通知并启动本区 SOS 派单</Button>
          </Form>
        </Card>
      </div>

      <Card className="!rounded-2xl" title="我的 SOS 事件进度">
        {incidents.length ? (
          <div className="space-y-3">
            {incidents.slice(0, 5).map((incident) => {
              const active = incident.status !== 'resolved'
              const label = incident.status === 'reported' ? '等待社区接警'
                : incident.status === 'acknowledged' ? '社区已接警，处理中'
                  : incident.status === 'dispatching' ? '志愿服务调度中'
                    : '事件已关闭'
              return <div key={incident.incidentId} className="rounded-xl border border-slate-100 p-3">
                <Space wrap><Tag color={active ? 'red' : 'green'}>{label}</Tag><span className="font-medium">{incident.createdAt}</span></Space>
                <div className="mt-2 text-slate-600">{incident.description}</div>
                {incident.acknowledgedAt ? <div className="mt-1 text-xs text-blue-700">已接警：{incident.acknowledgedAt}</div> : null}
                {incident.resolutionSummary ? <div className="mt-1 text-xs text-emerald-700">处置结果：{incident.resolutionSummary}</div> : null}
                {active && incident.conversationId ? <Button className="mt-2" size="small" onClick={() => { window.location.href = '/conversations' }}>进入 SOS 协同沟通</Button> : null}
              </div>
            })}
          </div>
        ) : <Typography.Text type="secondary">暂无 SOS 事件记录。</Typography.Text>}
      </Card>
    </div>
  )
}
