import { useEffect, useState } from 'react'
import { Card, Typography, Spin, Button, App, Statistic, Table, Tag, Modal, Form, InputNumber, Input } from 'antd'
import {
  UserOutlined,
  AlertOutlined,
  HeartOutlined,
  TeamOutlined,
  DollarOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'

import { fetchAdminDashboard, runWeeklySettlement, fetchHourReviews, reviewHourRequest, fetchAwardRequests, reviewAwardRequest } from '@/services/adapters/admin-adapter'
import { fetchVolunteerLeaderboard } from '@/services/adapters/volunteer-adapter'
import type { AwardRequestItem, DashboardMetric, HourReviewItem, VolunteerProfile } from '@/types/domain'

const iconMap: Record<string, React.ReactNode> = {
  total_users: <UserOutlined />,
  active_alerts: <AlertOutlined />,
  services_completed: <HeartOutlined />,
  volunteers_active: <TeamOutlined />,
}

const colorPalette = ['#2563eb', '#0284c7', '#d97706', '#dc2626', '#7c3aed', '#0891b2']

export default function AdminDashboardPage() {
  const { message } = App.useApp()
  const [metrics, setMetrics] = useState<DashboardMetric[]>([])
  const [leaderboard, setLeaderboard] = useState<VolunteerProfile[]>([])
  const [hourReviews, setHourReviews] = useState<HourReviewItem[]>([])
  const [awardRequests, setAwardRequests] = useState<AwardRequestItem[]>([])
  const [loading, setLoading] = useState(true)
  const [settling, setSettling] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [awardReviewing, setAwardReviewing] = useState(false)
  const [activeReview, setActiveReview] = useState<HourReviewItem | null>(null)
  const [reviewForm] = Form.useForm()

  useEffect(() => {
    Promise.all([
      fetchAdminDashboard(),
      fetchVolunteerLeaderboard(),
      fetchHourReviews(),
      fetchAwardRequests('pending'),
    ])
      .then(([m, lb, reviews, awards]) => {
        setMetrics(m)
        setLeaderboard(lb)
        setHourReviews(reviews)
        setAwardRequests(awards)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSettle = async () => {
    setSettling(true)
    try {
      const res = await runWeeklySettlement()
      message.success(res.message)
    } catch (err: any) {
      message.error(err?.message || '结算失败')
    } finally {
      setSettling(false)
    }
  }

  const openApproveModal = (review: HourReviewItem) => {
    setActiveReview(review)
    reviewForm.setFieldsValue({
      approvedHours: review.declaredHours,
      reviewNote: '',
    })
  }

  const handleApprove = async () => {
    if (!activeReview) return

    setReviewing(true)
    try {
      const values = await reviewForm.validateFields()
      const res = await reviewHourRequest({
        reviewId: activeReview.reviewId,
        action: 'approve',
        approvedHours: values.approvedHours,
        reviewNote: values.reviewNote,
      })
      message.success(res.message)
      setActiveReview(null)
      reviewForm.resetFields()
      const reviews = await fetchHourReviews()
      setHourReviews(reviews)
    } catch (err: any) {
      if (err?.errorFields) {
        return
      }
      message.error(err?.message || '审核失败')
    } finally {
      setReviewing(false)
    }
  }

  const handleReject = async (record: HourReviewItem) => {
    setReviewing(true)
    try {
      const res = await reviewHourRequest({
        reviewId: record.reviewId,
        action: 'reject',
        reviewNote: '管理员驳回',
      })
      message.success(res.message)
      setActiveReview(null)
      reviewForm.resetFields()
      const reviews = await fetchHourReviews()
      setHourReviews(reviews)
    } catch (err: any) {
      message.error(err?.message || '审核失败')
    } finally {
      setReviewing(false)
    }
  }

  const handleApproveAward = async (record: AwardRequestItem) => {
    setAwardReviewing(true)
    try {
      const res = await reviewAwardRequest({
        requestId: record.requestId,
        action: 'approve',
        reviewNote: '管理员审核通过',
      })
      message.success(res.message)
      setAwardRequests(await fetchAwardRequests('pending'))
      setLeaderboard(await fetchVolunteerLeaderboard())
    } catch (err: any) {
      message.error(err?.message || '审核失败')
    } finally {
      setAwardReviewing(false)
    }
  }

  const handleRejectAward = async (record: AwardRequestItem) => {
    setAwardReviewing(true)
    try {
      const res = await reviewAwardRequest({
        requestId: record.requestId,
        action: 'reject',
        reviewNote: '管理员驳回',
      })
      message.success(res.message)
      setAwardRequests(await fetchAwardRequests('pending'))
    } catch (err: any) {
      message.error(err?.message || '审核失败')
    } finally {
      setAwardReviewing(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>

  const statMetrics = metrics.filter((m) => m.visualType === 'stat')
  const chartMetrics = metrics.filter((m) => m.visualType !== 'stat')

  const leaderboardColumns = [
    {
      title: '排名',
      dataIndex: 'rank',
      key: 'rank',
      width: 80,
      render: (rank: number) => {
        if (rank === 1) return <span className="text-2xl">🥇</span>
        if (rank === 2) return <span className="text-2xl">🥈</span>
        if (rank === 3) return <span className="text-2xl">🥉</span>
        return <span className="text-gray-500 font-semibold">{rank}</span>
      },
    },
    {
      title: '本周时长',
      dataIndex: 'weeklyHours',
      key: 'weeklyHours',
      render: (v: number) => <span className="font-semibold text-blue-700">{v} 小时</span>,
    },
    {
      title: '总时长',
      dataIndex: 'totalHours',
      key: 'totalHours',
      render: (v: number) => `${v} 小时`,
    },
    {
      title: '完成任务',
      dataIndex: 'completedCount',
      key: 'completedCount',
      render: (v: number) => `${v} 次`,
    },
    {
      title: '荣誉',
      dataIndex: 'awards',
      key: 'awards',
      render: (awards: string[]) => (
        <div className="flex flex-wrap gap-1">
          {awards.map((a, i) => <Tag key={i} color="gold">{a}</Tag>)}
        </div>
      ),
    },
  ]

  const hourReviewColumns = [
    {
      title: '志愿者',
      dataIndex: 'volunteerName',
      key: 'volunteerName',
      render: (_: string, record: HourReviewItem) => (
        <div>
          <div className="font-medium">{record.volunteerName || `志愿者 #${record.volunteerId}`}</div>
          <div className="text-xs text-gray-400">家属：{record.familyName || `用户 #${record.familyUserId}`}</div>
        </div>
      ),
    },
    {
      title: '服务',
      dataIndex: 'serviceType',
      key: 'serviceType',
      render: (_: string, record: HourReviewItem) => (
        <div>
          <div>{record.serviceType}</div>
          <div className="text-xs text-gray-400">{record.serviceTime}</div>
        </div>
      ),
    },
    {
      title: '申报/上限',
      key: 'hours',
      render: (_: unknown, record: HourReviewItem) => (
        <div>
          <div>申报：{record.declaredHours} 小时</div>
          <div className="text-xs text-gray-400">预计：{record.expectedHours} 小时，自动上限：{record.maxAutoHours} 小时</div>
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: HourReviewItem) => (
        <div className="flex gap-2">
          <Button type="primary" size="small" onClick={() => openApproveModal(record)}>通过</Button>
          <Button danger size="small" loading={reviewing} onClick={() => handleReject(record)}>驳回</Button>
        </div>
      ),
    },
  ]

  const awardReviewColumns = [
    {
      title: '志愿者',
      dataIndex: 'volunteerName',
      key: 'volunteerName',
      render: (_: string, record: AwardRequestItem) => (
        <div>
          <div className="font-medium">{record.volunteerName || `志愿者 #${record.volunteerId}`}</div>
          <div className="text-xs text-gray-400">申请时间：{record.createdAt}</div>
        </div>
      ),
    },
    {
      title: '荣誉名称',
      dataIndex: 'awardTitle',
      key: 'awardTitle',
    },
    {
      title: '申请说明',
      dataIndex: 'reason',
      key: 'reason',
      render: (reason?: string) => reason || '—',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: AwardRequestItem) => (
        <div className="flex gap-2">
          <Button type="primary" size="small" loading={awardReviewing} onClick={() => handleApproveAward(record)}>通过</Button>
          <Button danger size="small" loading={awardReviewing} onClick={() => handleRejectAward(record)}>驳回</Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={3} className="!mb-1">管理控制台</Typography.Title>
          <Typography.Text className="text-gray-500">平台运营数据概览</Typography.Text>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        {statMetrics.map((m) => (
          <Card key={m.metricId} className="!rounded-2xl">
            <Statistic
              title={m.label}
              value={m.value}
              prefix={iconMap[m.metricId] || <TeamOutlined />}
            />
            <div className="text-xs text-gray-400 mt-1">{m.comparisonText}</div>
          </Card>
        ))}
      </div>

      {/* Leaderboard + Settlement */}
      <Card
        title={
          <span>
            <TrophyOutlined className="mr-2 text-amber-500" />
            本周志愿者排行
          </span>
        }
        extra={
          <Button
            type="primary"
            icon={<DollarOutlined />}
            loading={settling}
            onClick={handleSettle}
          >
            周结算
          </Button>
        }
        className="!rounded-2xl"
      >
        <Table
          dataSource={leaderboard}
          columns={leaderboardColumns}
          rowKey="rank"
          pagination={false}
          size="middle"
        />
      </Card>

      <Card
        title={<span>待审核时长</span>}
        className="!rounded-2xl"
      >
        <Table
          dataSource={hourReviews}
          columns={hourReviewColumns}
          rowKey="reviewId"
          pagination={false}
          locale={{ emptyText: '暂无待审核的时长记录' }}
        />
      </Card>

      <Card
        title={<span><TrophyOutlined className="mr-2 text-amber-500" />待审核荣誉申请</span>}
        className="!rounded-2xl"
      >
        <Table
          dataSource={awardRequests}
          columns={awardReviewColumns}
          rowKey="requestId"
          pagination={false}
          locale={{ emptyText: '暂无待审核的荣誉申请' }}
        />
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {chartMetrics.map((m) => {
          const option =
            m.visualType === 'pie'
              ? {
                  tooltip: { trigger: 'item' as const },
                  legend: { bottom: 0 },
                  series: [
                    {
                      type: 'pie',
                      radius: ['40%', '70%'],
                      avoidLabelOverlap: false,
                      itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 },
                      label: { show: false },
                      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
                      data: m.datasetPreview.map((d, i) => ({
                        name: d.label,
                        value: d.value,
                        itemStyle: { color: colorPalette[i % colorPalette.length] },
                      })),
                    },
                  ],
                }
              : {
                  tooltip: { trigger: 'axis' as const },
                  xAxis: {
                    type: 'category' as const,
                    data: m.datasetPreview.map((d) => d.label),
                    axisLabel: { fontSize: 11 },
                  },
                  yAxis: { type: 'value' as const },
                  series: [
                    {
                      type: 'bar',
                      data: m.datasetPreview.map((d, i) => ({
                        value: d.value,
                        itemStyle: { color: colorPalette[i % colorPalette.length], borderRadius: [6, 6, 0, 0] },
                      })),
                      barWidth: '50%',
                    },
                  ],
                }

          return (
            <Card key={m.metricId} title={m.label} className="!rounded-2xl">
              <ReactECharts option={option} style={{ height: 280 }} />
              <div className="text-xs text-gray-400 mt-2">{m.comparisonText}</div>
            </Card>
          )
        })}
      </div>

      <Modal
        title="审核服务时长"
        open={!!activeReview}
        onCancel={() => {
          setActiveReview(null)
          reviewForm.resetFields()
        }}
        onOk={handleApprove}
        confirmLoading={reviewing}
        okText="通过"
        cancelText="取消"
      >
        <Form form={reviewForm} layout="vertical">
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
      </Modal>
    </div>
  )
}
