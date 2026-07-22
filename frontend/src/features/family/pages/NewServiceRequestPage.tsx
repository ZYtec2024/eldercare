import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Select, DatePicker, Typography, App } from 'antd'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { fetchFamilyElders, createFamilyServiceRequest } from '@/services/adapters/family-adapter'
import type { ElderSummary } from '@/types/domain'

export default function NewServiceRequestPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [elders, setElders] = useState<ElderSummary[]>([])

  useEffect(() => {
    if (session) {
      fetchFamilyElders(session.userId).then(setElders).catch(() => {})
    }
  }, [session])

  const onFinish = async (values: any) => {
    if (!session) return
    setLoading(true)
    try {
      await createFamilyServiceRequest({
        familyUserId: session.userId,
        elderId: values.elderId,
        serviceType: values.serviceType,
        serviceTime: values.serviceTime.format('YYYY-MM-DD HH:mm:ss'),
        serviceHours: values.serviceHours,
        notes: values.notes || '',
      })
      message.success('服务需求已发布！')
      navigate('/family/orders')
    } catch (err: any) {
      message.error(err?.message || '发布失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">发布服务需求</Typography.Title>
          <Typography.Text className="text-gray-500">为长辈安排普通服务（不能代发 SOS 紧急求助）</Typography.Text>
      </div>
      <Card className="!rounded-2xl max-w-xl">
        <Form layout="vertical" onFinish={onFinish} size="large" initialValues={{ serviceHours: 1, serviceTime: dayjs() }}>
          <Form.Item name="elderId" label="选择长辈" rules={[{ required: true, message: '请选择长辈' }]}>
            <Select placeholder="请选择" options={elders.map((e) => ({ value: e.elderId, label: `${e.name}（${e.addressPreview}）` }))} />
          </Form.Item>
          <Form.Item name="serviceType" label="服务类型" rules={[{ required: true, message: '请选择服务类型' }]}>
            <Select placeholder="请选择" options={[
              { value: '陪同就医', label: '陪同就医' },
              { value: '上门陪聊', label: '上门陪聊' },
              { value: '代买药品', label: '代买药品' },
              { value: '代购物资', label: '代购物资' },
              { value: '上门理发', label: '上门理发' },
              { value: '陪同复诊', label: '陪同复诊' },
              { value: '康复训练', label: '康复训练' },
              { value: '健康咨询', label: '健康咨询' },
              { value: '智能设备协助', label: '智能设备协助' },
            ]} />
          </Form.Item>
          <div className="grid grid-cols-2 gap-x-4">
            <Form.Item
              name="serviceTime"
              label="服务时间"
              rules={[{ required: true, message: '请选择时间' }]}
              extra="选现在（或约1分钟内）：立刻开始找人。选任意更晚时间（如10分钟后、1小时后）：到那个时间点才开始找人。"
            >
              <DatePicker showTime className="!w-full" placeholder="选择日期时间" format="YYYY-MM-DD HH:mm" />
            </Form.Item>
            <Form.Item name="serviceHours" label="预计时长(小时)" rules={[{ required: true, message: '请输入时长' }]}>
              <InputNumber min={0.5} step={0.5} className="!w-full" placeholder="如 2" />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="如：需要带轮椅" />
          </Form.Item>
          <div className="flex gap-3">
            <Button type="primary" htmlType="submit" loading={loading}>发布需求</Button>
            <Button onClick={() => navigate('/family/dashboard')}>返回</Button>
          </div>
        </Form>
      </Card>
    </div>
  )
}
