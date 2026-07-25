import { useEffect, useState } from 'react'
import { Alert, Card, List, Tag, Typography, Button, Modal, Form, Input, Rate, App, Popconfirm, Space } from 'antd'
import { LikeOutlined, LikeFilled } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { fetchPendingServices, submitServiceReview } from '@/services/adapters/elder-adapter'
import { cancelElderDispatchOrder, completeElderDispatchOrder } from '@/services/adapters/dispatch-adapter'
import { likeVolunteer } from '@/services/adapters/volunteer-adapter'
import type { PendingService } from '@/types/domain'

const statusMap: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '等待接单' },
  accepted: { color: 'blue', text: '已接单' },
  in_progress: { color: 'processing', text: '服务中' },
  completed: { color: 'green', text: '已完成' },
  cancelled: { color: 'default', text: '已取消' },
}

export default function ElderServicesPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [services, setServices] = useState<PendingService[]>([])
  const [loading, setLoading] = useState(true)
  const [reviewTarget, setReviewTarget] = useState<PendingService | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [completingId, setCompletingId] = useState<number | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [likedOrders, setLikedOrders] = useState<Set<number>>(new Set())
  const [form] = Form.useForm()

  const load = () => {
    if (!session) return
    setLoading(true)
    fetchPendingServices(session.userId)
      .then(setServices)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 4000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  const handleReview = async () => {
    if (!reviewTarget) return
    const values = await form.validateFields()
    setSubmitting(true)
    try {
      await submitServiceReview({
        orderId: reviewTarget.orderId,
        rating: values.rating,
        comment: values.comment,
      })
      message.success('评价已提交')
      setReviewTarget(null)
      form.resetFields()
      load()
    } catch (err: any) {
      message.error(err?.message || '评价失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCompleteService = async (orderId: number) => {
    if (!session) return
    setCompletingId(orderId)
    try {
      message.success((await completeElderDispatchOrder(orderId, session.userId)).message || '已确认服务完成')
      load()
    } catch (err: any) {
      message.error(err?.message || '确认完成失败')
    } finally {
      setCompletingId(null)
    }
  }

  const handleCancelService = async (orderId: number) => {
    if (!session) return
    setCancellingId(orderId)
    try {
      message.success((await cancelElderDispatchOrder(orderId, session.userId)).message || '已取消')
      load()
    } catch (err: any) {
      message.error(err?.message || '取消失败')
    } finally {
      setCancellingId(null)
    }
  }

  const handleLike = async (item: PendingService) => {
    if (!session) return
    if (!item.volunteerId) {
      message.error('当前服务暂无可点赞的志愿者')
      return
    }
    try {
      await likeVolunteer(session.userId, item.volunteerId)
      message.success('点赞成功！')
      setLikedOrders((prev) => new Set(prev).add(item.orderId))
    } catch (err: any) {
      message.error(err?.message || '点赞失败')
    }
  }

  const active = services.filter((item) => ['pending', 'accepted', 'in_progress'].includes(item.status))
  const history = services.filter((item) => !['pending', 'accepted', 'in_progress'].includes(item.status))
  const proxyActive = active.filter((item) => item.isFamilyProxy)

  const renderActions = (item: PendingService) => {
    const isLiked = likedOrders.has(item.orderId)
    const actions: React.ReactNode[] = []
    const canCancel = ['pending', 'accepted'].includes(item.status)
    // Volunteer en route or already serving — elder may confirm done.
    const canComplete = Boolean(item.canComplete) || (['accepted', 'in_progress'].includes(item.status) && Boolean(item.volunteerId))

    if (canCancel) {
      actions.push(
        <Popconfirm
          key="cancel"
          title="确定取消这次帮助？志愿者将不再赶来。"
          onConfirm={() => handleCancelService(item.orderId)}
          okText="确定取消"
          cancelText="再想想"
        >
          <Button danger size="large" block loading={cancellingId === item.orderId} className="!h-11 !text-base">
            {item.status === 'accepted' ? '取消这次帮助（志愿者正赶来）' : '取消请求'}
          </Button>
        </Popconfirm>,
      )
    }

    if (canComplete) {
      actions.push(
        <Popconfirm
          key="complete"
          title="确认服务已经帮完？完成后会话会结束。"
          onConfirm={() => handleCompleteService(item.orderId)}
          okText="确认完成"
          cancelText="取消"
        >
          <Button type="primary" size="large" block loading={completingId === item.orderId} className="!h-11 !text-base">
            确认完成服务
          </Button>
        </Popconfirm>,
      )
    }

    if (item.status === 'completed' && item.volunteerName) {
      actions.push(
        <Button
          key="like"
          type={isLiked ? 'primary' : 'default'}
          size="large"
          icon={isLiked ? <LikeFilled /> : <LikeOutlined />}
          disabled={isLiked}
          onClick={() => handleLike(item)}
        >
          {isLiked ? '已点赞' : '点赞'}
        </Button>,
      )
    }

    if (item.canReview && !item.reviewSubmitted) {
      actions.push(
        <Button key="review" type="primary" size="large" onClick={() => setReviewTarget(item)}>
          评价
        </Button>,
      )
    } else if (item.reviewSubmitted) {
      actions.push(<Tag key="done" color="green">已评价</Tag>)
    }

    return actions
  }

  const renderItem = (item: PendingService) => {
    const st = statusMap[item.status] || { color: 'default', text: item.status }
    const actions = renderActions(item)
    return (
      <List.Item className="!block !px-0">
        <div className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-medium text-slate-900">{item.serviceType}</span>
            <Tag color={st.color}>{st.text}</Tag>
            {item.isFamilyProxy ? <Tag color="gold">家属代下</Tag> : null}
          </div>
          {item.isFamilyProxy ? (
            <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {item.proxyFamilyName || '家属'}已为您代下此单
              {item.address ? ` · ${item.address}` : ''}
            </div>
          ) : null}
          <div className="mt-1 text-base text-slate-600">
            {item.time}
            {item.volunteerName ? ` · 志愿者：${item.volunteerName}` : ' · 还在安排志愿者'}
          </div>
          {actions.length ? <Space direction="vertical" className="mt-3 w-full" size="small">{actions}</Space> : null}
        </div>
      </List.Item>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">谁在帮我</Typography.Title>
        <Typography.Text className="text-gray-500 text-lg">
          志愿者赶来途中可取消或确认完成；服务中请点「确认完成服务」；结束后可评价和点赞
        </Typography.Text>
      </div>

      {proxyActive.length ? (
        <Alert
          showIcon
          type="warning"
          message="家属已为您代下服务单"
          description={proxyActive.slice(0, 3).map((item) => (
            `${item.proxyFamilyName || '家属'} · ${item.serviceType}${item.address ? ` · ${item.address}` : ''}`
          )).join('；')}
        />
      ) : null}

      <Card title="进行中的服务" className="!rounded-2xl" loading={loading}>
        {active.length ? (
          <List dataSource={active} renderItem={renderItem} />
        ) : (
          <div className="py-8 text-center text-base text-slate-500">暂无进行中的服务</div>
        )}
      </Card>

      <Card title="历史记录" className="!rounded-2xl" loading={loading}>
        {history.length ? (
          <List dataSource={history} renderItem={renderItem} />
        ) : (
          <div className="py-8 text-center text-base text-slate-500">暂无历史记录</div>
        )}
      </Card>

      <Modal
        title="评价服务"
        open={!!reviewTarget}
        onCancel={() => { setReviewTarget(null); form.resetFields() }}
        onOk={handleReview}
        confirmLoading={submitting}
        okText="提交评价"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="rating" label="评分" rules={[{ required: true, message: '请评分' }]}>
            <Rate />
          </Form.Item>
          <Form.Item name="comment" label="评价内容" rules={[{ required: true, message: '请输入评价' }]}>
            <Input.TextArea rows={3} placeholder="请输入您的评价" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
