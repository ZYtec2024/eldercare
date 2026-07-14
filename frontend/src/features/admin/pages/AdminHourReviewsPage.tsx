import { useEffect, useState } from 'react'
import { App, Button, Card, Empty, Form, Input, InputNumber, Spin, Table, Tag, Typography } from 'antd'

import { fetchHourReviews, reviewHourRequest } from '@/services/adapters/admin-adapter'
import type { HourReviewItem } from '@/types/domain'

export default function AdminHourReviewsPage() {
  const { message } = App.useApp()
  const [reviews, setReviews] = useState<HourReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [activeReview, setActiveReview] = useState<HourReviewItem | null>(null)
  const [form] = Form.useForm()

  const load = () => {
    setLoading(true)
    fetchHourReviews()
      .then(setReviews)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const openApprove = (review: HourReviewItem) => {
    setActiveReview(review)
    form.setFieldsValue({
      approvedHours: review.declaredHours,
      reviewNote: '',
    })
  }

  const handleApprove = async () => {
    if (!activeReview) return

    setReviewing(true)
    try {
      const values = await form.validateFields()
      const res = await reviewHourRequest({
        reviewId: activeReview.reviewId,
        action: 'approve',
        approvedHours: values.approvedHours,
        reviewNote: values.reviewNote,
      })
      message.success(res.message)
      setActiveReview(null)
      form.resetFields()
      load()
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(err?.message || '审核失败')
    } finally {
      setReviewing(false)
    }
  }

  const handleReject = async (review: HourReviewItem) => {
    setReviewing(true)
    try {
      const res = await reviewHourRequest({
        reviewId: review.reviewId,
        action: 'reject',
        reviewNote: '管理员驳回',
      })
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '审核失败')
    } finally {
      setReviewing(false)
    }
  }

  const columns = [
    {
      title: '志愿者',
      key: 'volunteer',
      render: (_: unknown, record: HourReviewItem) => (
        <div>
          <div className="font-medium">{record.volunteerName || `志愿者 #${record.volunteerId}`}</div>
          <div className="text-xs text-gray-400">家属：{record.familyName || `用户 #${record.familyUserId}`}</div>
        </div>
      ),
    },
    {
      title: '服务内容',
      key: 'service',
      render: (_: unknown, record: HourReviewItem) => (
        <div>
          <div>{record.serviceType}</div>
          <div className="text-xs text-gray-400">{record.serviceTime}</div>
        </div>
      ),
    },
    {
      title: '时长',
      key: 'hours',
      render: (_: unknown, record: HourReviewItem) => (
        <div>
          <div>申报：{record.declaredHours} 小时</div>
          <div className="text-xs text-gray-400">预计：{record.expectedHours} 小时 / 自动上限：{record.maxAutoHours} 小时</div>
        </div>
      ),
    },
    {
      title: '提交时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value: string) => value || '-',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: HourReviewItem) => (
        <div className="flex gap-2">
          <Button type="primary" size="small" onClick={() => openApprove(record)}>
            通过
          </Button>
          <Button danger size="small" loading={reviewing} onClick={() => handleReject(record)}>
            驳回
          </Button>
        </div>
      ),
    },
  ]

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">时长审核</Typography.Title>
        <Typography.Text className="text-gray-500">处理超出预计范围的服务时长申请</Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        <Table
          dataSource={reviews}
          columns={columns}
          rowKey="reviewId"
          pagination={false}
          locale={{ emptyText: <Empty description="暂无待审核的时长记录" /> }}
        />
      </Card>

      <Form form={form} component={false}>
        <></>
      </Form>

      <Card title="审核说明" className="!rounded-2xl">
        <ul className="list-disc pl-5 text-gray-600 space-y-1">
          <li>志愿者完成任务后，家属先确认最终时长。</li>
          <li>若最终时长超过预计时长 1.5 倍，会进入这里等待管理员审核。</li>
          <li>通过后会立即计入志愿者总时长；驳回后将保留审核记录。</li>
        </ul>
      </Card>

      <ModalLike
        open={!!activeReview}
        review={activeReview}
        form={form}
        reviewing={reviewing}
        onCancel={() => {
          setActiveReview(null)
          form.resetFields()
        }}
        onOk={handleApprove}
      />
    </div>
  )
}

function ModalLike({
  open,
  review,
  form,
  reviewing,
  onCancel,
  onOk,
}: {
  open: boolean
  review: HourReviewItem | null
  form: ReturnType<typeof Form.useForm>[0]
  reviewing: boolean
  onCancel: () => void
  onOk: () => Promise<void>
}) {
  return (
    <div>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4">
              <Typography.Title level={4} className="!mb-1">审核时长</Typography.Title>
              <Typography.Text className="text-gray-500">{review?.volunteerName || '未命名志愿者'} · {review?.serviceType || ''}</Typography.Text>
            </div>
            <Form form={form} layout="vertical">
              <Form.Item
                name="approvedHours"
                label="最终认可时长（小时）"
                rules={[{ required: true, message: '请输入最终认可时长' }]}
              >
                <InputNumber min={0} step={0.5} className="!w-full" />
              </Form.Item>
              <Form.Item name="reviewNote" label="审核备注（可选）">
                <Input.TextArea rows={3} placeholder="填写审核说明" />
              </Form.Item>
            </Form>
            <div className="flex justify-end gap-2 mt-4">
              <Button onClick={onCancel}>取消</Button>
              <Button danger loading={reviewing} onClick={() => review && void review && onCancel()}>
                关闭
              </Button>
              <Button type="primary" loading={reviewing} onClick={() => void onOk()}>
                通过并计入
              </Button>
            </div>
            {review && (
              <div className="mt-3 text-xs text-gray-400">
                当前申报：{review.declaredHours} 小时，自动上限：{review.maxAutoHours} 小时
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
