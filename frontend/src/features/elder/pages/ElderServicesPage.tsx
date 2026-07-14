import { useEffect, useState } from 'react'
import { Card, List, Tag, Typography, Button, Modal, Form, Input, Rate, App } from 'antd'
import { LikeOutlined, LikeFilled } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { fetchPendingServices, submitServiceReview } from '@/services/adapters/elder-adapter'
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

  useEffect(load, [session])

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

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">我的服务</Typography.Title>
        <Typography.Text className="text-gray-500 text-lg">查看服务安排和评价已完成的服务</Typography.Text>
      </div>

      <Card className="!rounded-2xl" loading={loading}>
        <List
          dataSource={services}
          locale={{ emptyText: '暂无服务记录' }}
          renderItem={(item) => {
            const st = statusMap[item.status] || { color: 'default', text: item.status }
            const isLiked = likedOrders.has(item.orderId)
            const actions: React.ReactNode[] = []

            if (item.status === 'completed' && item.volunteerName) {
              actions.push(
                <Button
                  key="like"
                  type={isLiked ? 'primary' : 'default'}
                  size="small"
                  icon={isLiked ? <LikeFilled /> : <LikeOutlined />}
                  disabled={isLiked}
                  onClick={() => handleLike(item)}
                >
                  {isLiked ? '已点赞' : '点赞'}
                </Button>
              )
            }

            if (item.canReview && !item.reviewSubmitted) {
              actions.push(
                <Button key="review" type="primary" size="small" onClick={() => setReviewTarget(item)}>
                  评价
                </Button>
              )
            } else if (item.reviewSubmitted) {
              actions.push(<Tag key="done" color="green">已评价</Tag>)
            }

            return (
              <List.Item actions={actions}>
                <List.Item.Meta
                  title={
                    <span className="text-lg">
                      {item.serviceType}
                      <Tag className="ml-2" color={st.color}>{st.text}</Tag>
                    </span>
                  }
                  description={
                    <span className="text-base">
                      {item.time}
                      {item.volunteerName && ` · 志愿者：${item.volunteerName}`}
                    </span>
                  }
                />
              </List.Item>
            )
          }}
        />
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
