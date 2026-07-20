import { useEffect, useState } from 'react'
import { Button, Card, Empty, Form, Input, InputNumber, Select, DatePicker, Typography, App, List, Tag, Popconfirm, Modal, Rate } from 'antd'
import { LikeOutlined, LikeFilled } from '@ant-design/icons'
import { PlusOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { fetchFamilyElders, createFamilyServiceRequest, fetchFamilyOrders, cancelFamilyOrder, confirmFamilyOrderHours, reviewFamilyOrder } from '@/services/adapters/family-adapter'
import { likeVolunteer } from '@/services/adapters/volunteer-adapter'
import type { ElderSummary, ServiceRequestCard } from '@/types/domain'

const statusMap: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '等待接单' },
  accepted: { color: 'blue', text: '已接单' },
  in_progress: { color: 'processing', text: '服务中' },
  completed: { color: 'green', text: '已完成' },
  cancelled: { color: 'default', text: '已取消' },
}

export default function FamilyOrdersPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [orders, setOrders] = useState<ServiceRequestCard[]>([])
  const [elders, setElders] = useState<ElderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ServiceRequestCard | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<ServiceRequestCard | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [likedOrders, setLikedOrders] = useState<Set<number>>(new Set())
  const [form] = Form.useForm()
  const [confirmForm] = Form.useForm()
  const [reviewForm] = Form.useForm()

  const load = () => {
    if (!session) return
    setLoading(true)
    Promise.allSettled([
      fetchFamilyOrders(session.userId),
      fetchFamilyElders(session.userId),
    ])
      .then(([ordersResult, eldersResult]) => {
        if (ordersResult.status === 'fulfilled') {
          setOrders(ordersResult.value)
        }
        if (eldersResult.status === 'fulfilled') {
          setElders(eldersResult.value)
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [session])

  const handlePublish = async (values: any) => {
    if (!session) return
    setPublishing(true)
    try {
      await createFamilyServiceRequest({
        familyUserId: session.userId,
        elderId: values.elderId,
        serviceType: values.serviceType,
        serviceTime: values.serviceTime.format('YYYY-MM-DD HH:mm:ss'),
        serviceHours: values.serviceHours,
        address: values.address || '',
        notes: values.notes || '',
      })
      message.success('服务需求已发布！')
      form.resetFields()
      setShowForm(false)
      load()
    } catch (err: any) {
      message.error(err?.message || '发布失败')
    } finally {
      setPublishing(false)
    }
  }

  const handleCancel = async (orderId: number) => {
    if (!session) return
    try {
      await cancelFamilyOrder(orderId, session.userId)
      message.success('订单已撤销')
      load()
    } catch (err: any) {
      message.error(err?.message || '撤销失败')
    }
  }

  const handleConfirmHours = async () => {
    if (!session || !confirmTarget) return
    const values = await confirmForm.validateFields()
    setConfirming(true)
    try {
      await confirmFamilyOrderHours({
        orderId: confirmTarget.requestId,
        familyUserId: session.userId,
        actualHours: values.actualHours,
        reviewNote: values.reviewNote,
      })
      message.success('时长确认成功')
      setConfirmTarget(null)
      confirmForm.resetFields()
      load()
    } catch (err: any) {
      message.error(err?.message || '确认失败')
    } finally {
      setConfirming(false)
    }
  }

  const handleLike = async (item: ServiceRequestCard) => {
    if (!session || !item.assignedVolunteerId) return
    try {
      await likeVolunteer(session.userId, item.assignedVolunteerId)
      message.success('点赞成功！')
      setLikedOrders((prev) => new Set(prev).add(item.requestId))
    } catch (err: any) {
      message.error(err?.message || '点赞失败')
    }
  }

  const handleReview = async () => {
    if (!session || !reviewTarget) return
    const values = await reviewForm.validateFields()
    setReviewing(true)
    try {
      await reviewFamilyOrder({ orderId: reviewTarget.requestId, familyUserId: session.userId, rating: values.rating, comment: values.comment })
      message.success('评价已提交，志愿者评分已更新')
      setReviewTarget(null); reviewForm.resetFields(); load()
    } catch (err: any) { message.error(err?.message || '评价提交失败') } finally { setReviewing(false) }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={3} className="!mb-1">服务管理</Typography.Title>
          <Typography.Text className="text-gray-500">发布服务需求并跟踪状态</Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? '收起' : '发布需求'}
        </Button>
      </div>

      {/* Publish Form */}
      {showForm && (
        <Card title="发布新需求" className="!rounded-2xl">
          <Form form={form} layout="vertical" onFinish={handlePublish} size="large" className="max-w-xl">
            <Form.Item name="elderId" label="选择长辈" rules={[{ required: true, message: '请选择长辈' }]}>
              <Select placeholder="请选择" options={elders.map((e) => ({ value: e.elderId, label: `${e.name}（${e.addressPreview}）` }))} />
            </Form.Item>
            <Form.Item name="serviceType" label="服务类型" rules={[{ required: true, message: '请选择服务类型' }]}>
              <Select placeholder="请选择" options={[
                { value: '陪同就医', label: '陪同就医' },
                { value: '上门陪聊', label: '上门陪聊' },
                { value: '代买药品', label: '代买药品' },
                { value: '代买物资', label: '代买物资' },
                { value: '上门理发', label: '上门理发' },
                { value: '陪同复诊', label: '陪同复诊' },
              ]} />
            </Form.Item>
            <div className="grid grid-cols-2 gap-x-4">
              <Form.Item name="serviceTime" label="服务时间" rules={[{ required: true, message: '请选择时间' }]}>
                <DatePicker showTime className="!w-full" placeholder="选择日期时间" />
              </Form.Item>
              <Form.Item name="serviceHours" label="预计时长(小时)" rules={[{ required: true, message: '请输入时长' }]}>
                <InputNumber min={0.5} step={0.5} className="!w-full" placeholder="如 2" />
              </Form.Item>
            </div>
            <Form.Item name="address" label="服务地址" rules={[{ required: false }]}>
              <Input placeholder="请输入详细服务地址（可选，留空则使用长辈登记地址）" />
            </Form.Item>
            <Form.Item name="notes" label="备注">
              <Input.TextArea rows={3} placeholder="如：需要带轮椅" />
            </Form.Item>
            <div className="flex gap-3">
              <Button type="primary" htmlType="submit" loading={publishing}>发布需求</Button>
              <Button onClick={() => { setShowForm(false); form.resetFields() }}>取消</Button>
            </div>
          </Form>
        </Card>
      )}

      {/* Orders List */}
      <Card title="需求列表" className="!rounded-2xl" loading={loading}>
        <List
          dataSource={orders}
          locale={{ emptyText: <Empty description="暂无服务需求" /> }}
          renderItem={(item) => {
            const st = statusMap[item.status] || { color: 'default', text: item.status }
            const isLiked = likedOrders.has(item.requestId)
            const actions: React.ReactNode[] = []

            if (item.status === 'pending' || item.status === 'accepted') {
              actions.push(
                <Popconfirm
                  key="cancel"
                  title="确认撤销此订单？"
                  onConfirm={() => handleCancel(item.requestId)}
                  okText="确认"
                  cancelText="取消"
                >
                  <Button size="small" danger>撤销</Button>
                </Popconfirm>,
              )
            }

            if (item.status === 'completed') {
              if (item.hourReviewStatus === 'pending_admin') {
                actions.push(<Tag key="pending-admin" color="gold">待管理员审核时长</Tag>)
              } else if (item.hourReviewStatus === 'approved') {
                actions.push(<Tag key="approved-hours" color="green">已确认时长</Tag>)
              }

              const canConfirmHours = item.hourReviewStatus === 'pending_family' || !item.hourReviewStatus

              if (canConfirmHours) {
                actions.push(
                  <Button
                    key="confirm-hours"
                    size="small"
                    type="primary"
                    onClick={() => {
                      setConfirmTarget(item)
                      confirmForm.setFieldsValue({ actualHours: item.serviceHours, reviewNote: '' })
                    }}
                  >
                    确认服务时长
                  </Button>,
                )
              }
            }

            if (item.status === 'completed' && item.assignedVolunteerId) {
              actions.push(
                <Button
                  key="like"
                  type={isLiked ? 'primary' : 'default'}
                  size="small"
                  icon={isLiked ? <LikeFilled /> : <LikeOutlined />}
                  disabled={isLiked}
                  onClick={() => handleLike(item)}
                >
                  {isLiked ? '已点赞' : '点赞志愿者'}
                </Button>,
              )
              actions.push(<Button key="review" size="small" onClick={() => { setReviewTarget(item); reviewForm.setFieldsValue({ rating: 5, comment: '' }) }}>评价服务</Button>)
            }

            return (
              <List.Item actions={actions}>
                <List.Item.Meta
                  title={
                    <span>
                      {item.serviceType} · {item.elderName}
                      <Tag className="ml-2" color={st.color}>{st.text}</Tag>
                    </span>
                  }
                  description={
                    <span>
                      {item.serviceTime} · {item.serviceHours}小时
                      {item.assignedVolunteerName && ` · 志愿者：${item.assignedVolunteerName}`}
                      {item.notes && ` · ${item.notes}`}
                    </span>
                  }
                />
              </List.Item>
            )
          }}
        />
      </Card>

      <Modal
        title="确认最终服务时长"
        open={!!confirmTarget}
        onCancel={() => {
          setConfirmTarget(null)
          confirmForm.resetFields()
        }}
        onOk={handleConfirmHours}
        confirmLoading={confirming}
        okText="确认提交"
      >
        <Form form={confirmForm} layout="vertical">
          <Form.Item
            name="actualHours"
            label="最终服务时长（小时）"
            rules={[{ required: true, message: '请输入最终时长' }]}
          >
            <InputNumber min={0.5} step={0.5} className="!w-full" />
          </Form.Item>
          <Form.Item name="reviewNote" label="备注（可选）">
            <Input.TextArea rows={3} placeholder="可填写时长说明" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="评价志愿服务" open={!!reviewTarget} onCancel={() => { setReviewTarget(null); reviewForm.resetFields() }} onOk={handleReview} confirmLoading={reviewing} okText="提交评价">
        <Form form={reviewForm} layout="vertical"><Form.Item name="rating" label="服务评分" rules={[{ required: true }]}><Rate /></Form.Item><Form.Item name="comment" label="评价内容"><Input.TextArea rows={3} placeholder="写下本次服务体验" /></Form.Item></Form>
      </Modal>
    </div>
  )
}
