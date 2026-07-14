import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, Form, Input, List, Modal, Rate, Spin, Statistic, Tag, Typography } from 'antd'
import {
  ClockCircleOutlined,
  HeartOutlined,
  TrophyOutlined,
  CheckCircleOutlined,
  StarOutlined,
  PlusOutlined,
} from '@ant-design/icons'

import {
  fetchVolunteerProfile,
  fetchMyTasks,
  fetchMyReviews,
  submitVolunteerAwardRequest,
  type VolunteerReview,
} from '@/services/adapters/volunteer-adapter'
import { useSession } from '@/features/auth/useSession'
import type { VolunteerProfile, VolunteerTaskCard } from '@/types/domain'

const statusLabels: Record<string, { color: string; text: string }> = {
  accepted: { color: 'blue', text: '已接单' },
  in_progress: { color: 'processing', text: '进行中' },
  completed: { color: 'green', text: '已完成' },
}

export default function VolunteerProfilePage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [profile, setProfile] = useState<VolunteerProfile | null>(null)
  const [tasks, setTasks] = useState<VolunteerTaskCard[]>([])
  const [reviews, setReviews] = useState<VolunteerReview[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [awardModalOpen, setAwardModalOpen] = useState(false)
  const [submittingAward, setSubmittingAward] = useState(false)
  const [awardForm] = Form.useForm()

  const averageRating = reviews.length
    ? (reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length).toFixed(1)
    : '0.0'

  const loadData = useCallback(async () => {
    if (!session?.userId) {
      setLoading(false)
      return
    }

    setRefreshing(true)
    try {
      const [profileResult, tasksResult, reviewsResult] = await Promise.allSettled([
        fetchVolunteerProfile(session.userId),
        fetchMyTasks(session.userId),
        fetchMyReviews(session.userId),
      ])

      if (profileResult.status === 'fulfilled') {
        setProfile(profileResult.value)
      }
      if (tasksResult.status === 'fulfilled') {
        setTasks(tasksResult.value)
      }
      if (reviewsResult.status === 'fulfilled') {
        setReviews(reviewsResult.value)
      }

      if (
        profileResult.status === 'rejected' ||
        tasksResult.status === 'rejected' ||
        reviewsResult.status === 'rejected'
      ) {
        message.warning('部分成就数据加载失败，已显示可用内容')
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [message, session?.userId])

  useEffect(() => {
    loadData()

    const timer = window.setInterval(() => {
      loadData()
    }, 10000)

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadData()
      }
    }

    window.addEventListener('focus', loadData)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', loadData)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadData])

  const handleSubmitAwardRequest = async () => {
    if (!session?.userId) return

    try {
      const values = await awardForm.validateFields()
      setSubmittingAward(true)
      await submitVolunteerAwardRequest({
        volunteerId: session.userId,
        awardTitle: values.awardTitle,
        reason: values.reason,
      })
      message.success('荣誉申请已提交，等待管理员审核')
      setAwardModalOpen(false)
      awardForm.resetFields()
      loadData()
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(err?.message || '提交失败')
    } finally {
      setSubmittingAward(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>
  if (!profile) return <Typography.Text>暂无成就数据</Typography.Text>

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">我的成就</Typography.Title>
        <Typography.Text className="text-gray-500">查看您的志愿服务贡献，系统会自动刷新最新荣誉与时长</Typography.Text>
      </div>

      <div className="flex justify-end">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAwardModalOpen(true)} loading={refreshing}>
          申请新增荣誉
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-5">
        <Card className="!rounded-2xl text-center">
          <Statistic title="总服务时长" value={profile.totalHours} suffix="小时" prefix={<ClockCircleOutlined />} />
        </Card>
        <Card className="!rounded-2xl text-center">
          <Statistic title="本周时长" value={profile.weeklyHours} suffix="小时" prefix={<ClockCircleOutlined />} />
        </Card>
        <Card className="!rounded-2xl text-center">
          <Statistic title="完成任务" value={profile.completedCount} suffix="次" prefix={<CheckCircleOutlined />} />
        </Card>
        <Card className="!rounded-2xl text-center">
          <Statistic title="获赞数" value={profile.likesCount} prefix={<HeartOutlined />} />
        </Card>
        <Card className="!rounded-2xl text-center">
          <Statistic title="平均评分" value={averageRating} suffix="分" prefix={<StarOutlined />} />
        </Card>
      </div>

      {profile.awards.length > 0 && (
        <Card title={<span><TrophyOutlined className="mr-2" />荣誉奖项</span>} className="!rounded-2xl">
          <div className="flex flex-wrap gap-2">
            {profile.awards.map((award, index) => (
              <Tag key={index} color="gold" className="!text-sm !px-3 !py-1">{award}</Tag>
            ))}
          </div>
        </Card>
      )}

      <Card title={<span><TrophyOutlined className="mr-2" />荣誉申请记录</span>} className="!rounded-2xl">
        <Typography.Text className="text-gray-500">
          如需新增荣誉，可提交申请并等待管理员审核通过后写入个人成就。
        </Typography.Text>
      </Card>

      <Card title={<span><CheckCircleOutlined className="mr-2" />我的任务</span>} className="!rounded-2xl">
        <List
          dataSource={tasks}
          locale={{ emptyText: '暂无任务记录' }}
          renderItem={(task) => {
            const status = statusLabels[task.status] || { color: 'default', text: task.status }
            return (
              <List.Item>
                <List.Item.Meta
                  title={
                    <span>
                      {task.serviceType}
                      {task.elderName && ` · ${task.elderName}`}
                      <Tag className="ml-2" color={status.color}>{status.text}</Tag>
                    </span>
                  }
                  description={<span>{task.scheduledTime} · {task.serviceHours}小时 · {task.addressPreview}</span>}
                />
              </List.Item>
            )
          }}
        />
      </Card>

      <Card title={<span><StarOutlined className="mr-2" />收到的评价</span>} className="!rounded-2xl">
        <List
          dataSource={reviews}
          locale={{ emptyText: '暂无评价' }}
          renderItem={(review) => (
            <List.Item>
              <List.Item.Meta
                title={<span>{review.serviceType}{review.elderName && ` · ${review.elderName}`}</span>}
                description={
                  <div>
                    <Rate disabled value={review.rating} className="!text-sm" />
                    <div className="mt-1 text-gray-600">{review.comment}</div>
                    <div className="text-xs text-gray-400 mt-1">{review.serviceTime}</div>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal
        title="申请新增荣誉"
        open={awardModalOpen}
        onCancel={() => {
          setAwardModalOpen(false)
          awardForm.resetFields()
        }}
        onOk={handleSubmitAwardRequest}
        confirmLoading={submittingAward}
        okText="提交申请"
      >
        <Form form={awardForm} layout="vertical">
          <Form.Item
            name="awardTitle"
            label="荣誉名称"
            rules={[{ required: true, message: '请输入荣誉名称' }]}
          >
            <Input placeholder="例如：社区暖心服务奖" />
          </Form.Item>
          <Form.Item name="reason" label="申请说明（可选）">
            <Input.TextArea rows={4} placeholder="说明您的服务贡献或申请理由" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
