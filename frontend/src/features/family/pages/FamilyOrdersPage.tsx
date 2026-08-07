import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert, App, Button, Card, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Radio, Rate, Space, Tag, Typography,
} from 'antd'
import { LikeOutlined, LikeFilled, PlusOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  fetchFamilyOrders, cancelFamilyOrder, confirmFamilyOrderHours, reviewFamilyOrder,
} from '@/services/adapters/family-adapter'
import { completeFamilyDispatchOrder } from '@/services/adapters/dispatch-adapter'
import { likeVolunteer } from '@/services/adapters/volunteer-adapter'
import type { ServiceRequestCard } from '@/types/domain'

const statusMap: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '等待接单' },
  accepted: { color: 'blue', text: '已接单' },
  in_progress: { color: 'processing', text: '服务中' },
  completed: { color: 'green', text: '已完成' },
  cancelled: { color: 'default', text: '已取消' },
}

function formatServiceDuration(item: ServiceRequestCard) {
  const minutes = item.actualDurationMinutes
  if (!minutes || minutes <= 0) return '暂无完整记录'
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (!hours) return `${remainingMinutes} 分钟`
  if (!remainingMinutes) return `${hours} 小时`
  return `${hours} 小时 ${remainingMinutes} 分钟`
}

export default function FamilyOrdersPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<ServiceRequestCard[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmTarget, setConfirmTarget] = useState<ServiceRequestCard | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<ServiceRequestCard | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [likedOrders, setLikedOrders] = useState<Set<number>>(new Set())
  const [detailTarget, setDetailTarget] = useState<ServiceRequestCard | null>(null)
  const [confirmForm] = Form.useForm()
  const [reviewForm] = Form.useForm()

  const load = (opts?: { silent?: boolean }) => {
    if (!session) return
    if (!opts?.silent) setLoading(true)
    fetchFamilyOrders(session.userId)
      .then(setOrders)
      .catch(() => setOrders([]))
      .finally(() => {
        if (!opts?.silent) setLoading(false)
      })
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(() => load({ silent: true }), 5000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  const activeOrders = orders.filter((item) => ['pending', 'accepted', 'in_progress'].includes(item.status))

  const openConfirmHours = (item: ServiceRequestCard) => {
    const hasActualDuration = typeof item.actualDurationHours === 'number' && item.actualDurationHours > 0
    setConfirmTarget(item)
    confirmForm.setFieldsValue({
      durationBasis: hasActualDuration ? 'actual' : 'expected',
      actualHours: hasActualDuration ? item.actualDurationHours : item.serviceHours,
      reviewNote: '',
    })
  }

  const selectDurationBasis = (basis: 'actual' | 'expected') => {
    if (!confirmTarget) return
    const hours = basis === 'actual'
      ? confirmTarget.actualDurationHours
      : confirmTarget.serviceHours
    if (typeof hours === 'number' && hours > 0) {
      confirmForm.setFieldValue('actualHours', hours)
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

  const handleCompleteService = async (orderId: number) => {
    if (!session) return
    try {
      message.success((await completeFamilyDispatchOrder(orderId, session.userId)).message || '已确认服务完成')
      load()
    } catch (err: any) {
      message.error(err?.message || '确认完成失败')
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
      await reviewFamilyOrder({
        orderId: reviewTarget.requestId,
        familyUserId: session.userId,
        rating: values.rating,
        comment: values.comment,
      })
      message.success('评价已提交，志愿者评分已更新')
      setReviewTarget(null)
      reviewForm.resetFields()
      load()
    } catch (err: any) {
      message.error(err?.message || '评价提交失败')
    } finally {
      setReviewing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={3} className="!mb-1">服务管理</Typography.Title>
          <Typography.Text className="text-gray-500">跟踪已发布需求的状态、确认完成并评价志愿者</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/family/new-request')}>
          代长辈下单
        </Button>
      </div>

      {activeOrders.length ? (
        <Alert
          type="info"
          showIcon
          message={`长辈当前有 ${activeOrders.length} 单进行中的服务`}
          description={activeOrders.slice(0, 3).map((item) => `${item.elderName || '长辈'} · ${item.serviceType} · ${statusMap[item.status]?.text || item.status}`).join('；')}
        />
      ) : null}

      <Card title="需求列表" className="!rounded-2xl" loading={loading}>
        <List
          dataSource={orders}
          pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="暂无服务需求，可去「代长辈下单」发布" /> }}
          renderItem={(item) => {
            const st = statusMap[item.status] || { color: 'default', text: item.status }
            const isLiked = likedOrders.has(item.requestId)
            const actions: ReactNode[] = []

            if (item.status === 'pending' || item.status === 'accepted') {
              actions.push(
                <Popconfirm key="cancel" title="确认撤销此订单？" onConfirm={() => handleCancel(item.requestId)} okText="确认" cancelText="取消">
                  <Button size="small" danger>撤销</Button>
                </Popconfirm>,
              )
            }
            if (item.status === 'accepted' || item.status === 'in_progress') {
              actions.push(
                <Popconfirm key="complete" title="确认服务已完成？完成后会话将结束。" onConfirm={() => handleCompleteService(item.requestId)} okText="确认完成" cancelText="取消">
                  <Button size="small" type="primary">确认完成服务</Button>
                </Popconfirm>,
              )
            }
            if (item.status === 'completed') {
              if (item.hourReviewStatus === 'pending_admin') {
                actions.push(<Tag key="pending-admin" color="gold">待管理员审核时长</Tag>)
              } else if (item.hourReviewStatus === 'pending_family' || !item.hourReviewStatus) {
                actions.push(<Button key="hours" size="small" onClick={() => openConfirmHours(item)}>确认时长</Button>)
              }
              if (item.assignedVolunteerId) {
                actions.push(
                  <Button key="like" size="small" icon={isLiked ? <LikeFilled /> : <LikeOutlined />} disabled={isLiked} onClick={() => handleLike(item)}>
                    {isLiked ? '已点赞' : '点赞'}
                  </Button>,
                )
                actions.push(<Button key="review" size="small" onClick={() => setReviewTarget(item)}>评价</Button>)
              }
            }

            actions.push(
              <Button key="detail" size="small" type="link" className="!px-1" onClick={() => setDetailTarget(item)}>
                查看详情
              </Button>,
            )

            return (
              <List.Item className="family-orders-list-item">
                <div className="family-orders-card">
                  <div className="family-orders-card-top">
                    <div className="family-orders-title-row">
                      <span className="family-orders-type">{item.serviceType}</span>
                      <span className="family-orders-elder-inline">{item.elderName || '长辈'}</span>
                      <Tag color={st.color} className="!m-0 shrink-0">{st.text}</Tag>
                    </div>
                    <div className="family-orders-meta-desc">
                      <span className="family-orders-meta-scroll">
                        {`${item.serviceTime || '时间待定'} · ${item.address || '已选服务点'}${item.assignedVolunteerName ? ` · ${item.assignedVolunteerName}` : ''}`}
                      </span>
                    </div>
                  </div>
                  {actions.length ? (
                    <div className="family-orders-card-actions family-order-actions">
                      {actions}
                    </div>
                  ) : null}
                </div>
              </List.Item>
            )
          }}
        />
      </Card>

      <Modal
        title="服务详情"
        open={!!detailTarget}
        onCancel={() => setDetailTarget(null)}
        footer={<Button type="primary" onClick={() => setDetailTarget(null)}>知道了</Button>}
      >
        {detailTarget ? (
          <div className="space-y-3 text-sm text-slate-700">
            <div className="mobile-single-line"><Typography.Text type="secondary">服务类型：</Typography.Text>{detailTarget.serviceType}</div>
            <div className="mobile-single-line"><Typography.Text type="secondary">长辈：</Typography.Text>{detailTarget.elderName || '长辈'}</div>
            <div className="mobile-single-line"><Typography.Text type="secondary">状态：</Typography.Text>{statusMap[detailTarget.status]?.text || detailTarget.status}</div>
            <div className="mobile-single-line"><Typography.Text type="secondary">服务时间：</Typography.Text>{detailTarget.serviceTime || '未填写'}</div>
            <div className="mobile-single-line overflow-x-auto"><Typography.Text type="secondary">服务地址：</Typography.Text>{detailTarget.address || '已选服务点'}</div>
            <div className="mobile-single-line"><Typography.Text type="secondary">志愿者：</Typography.Text>{detailTarget.assignedVolunteerName || '尚未接单'}</div>
          </div>
        ) : null}
      </Modal>

      <Modal
        title="确认服务时长"
        open={!!confirmTarget}
        onCancel={() => {
          setConfirmTarget(null)
          confirmForm.resetFields()
        }}
        onOk={() => void handleConfirmHours()}
        confirmLoading={confirming}
        okText="提交"
      >
        {confirmTarget ? (
          <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Typography.Text type="secondary">开始时间</Typography.Text>
                <div className="mt-1 font-medium">{confirmTarget.serviceStartedAt || '暂无记录'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">结束时间</Typography.Text>
                <div className="mt-1 font-medium">{confirmTarget.serviceEndedAt || '暂无记录'}</div>
              </div>
            </div>
            <div className="mt-3 border-t border-slate-200 pt-3">
              <Typography.Text type="secondary">系统计算的实际时长：</Typography.Text>
              <Typography.Text strong>{formatServiceDuration(confirmTarget)}</Typography.Text>
            </div>
          </div>
        ) : null}
        <Form form={confirmForm} layout="vertical">
          <Form.Item name="durationBasis" label="确认依据">
            <Radio.Group
              className="flex w-full flex-col gap-2"
              onChange={(event) => selectDurationBasis(event.target.value)}
            >
              <Radio
                value="actual"
                disabled={!confirmTarget?.actualDurationHours}
              >
                按实际开始与结束时间差
                {confirmTarget?.actualDurationHours ? `（${formatServiceDuration(confirmTarget)}）` : '（暂无完整记录）'}
              </Radio>
              <Radio value="expected">按预计服务时长（{confirmTarget?.serviceHours || 0} 小时）</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="actualHours"
            label="最终确认时长（小时）"
            extra="选择上方依据后会自动填写，也可以根据实际情况微调。"
            rules={[{ required: true, message: '请输入确认时长' }]}
          >
            <InputNumber min={0.01} step={0.1} precision={2} className="!w-full" />
          </Form.Item>
          <Form.Item name="reviewNote" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="评价服务" open={!!reviewTarget} onCancel={() => setReviewTarget(null)} onOk={() => void handleReview()} confirmLoading={reviewing} okText="提交">
        <Form form={reviewForm} layout="vertical">
          <Form.Item name="rating" label="评分" rules={[{ required: true }]}><Rate /></Form.Item>
          <Form.Item name="comment" label="评价" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
