import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, App, Button, Card, Empty, Modal, Spin, Table, Tag, Typography } from 'antd'
import { BellOutlined, WarningOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { ackFamilyAlert, fetchFamilyAlerts, type FamilyAlertItem } from '@/services/adapters/family-adapter'

const statusText: Record<string, string> = {
  reported: '已通知，等待社区接警',
  acknowledged: '社区已接警处置中',
  dispatching: '正在安排志愿者',
  awaiting_admin_close: '等待社区结案',
  resolved: '已结束',
}

export default function FamilyAlertsPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState<FamilyAlertItem[]>([])
  const [loading, setLoading] = useState(true)
  const [ackingId, setAckingId] = useState<number | null>(null)
  const [detailAlert, setDetailAlert] = useState<FamilyAlertItem | null>(null)

  const loadAlerts = async () => {
    if (!session) return
    try {
      setAlerts(await fetchFamilyAlerts(session.userId))
    } catch (err: any) {
      message.error(err?.message || '加载告警列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAlerts()
    const timer = window.setInterval(() => void loadAlerts(), 5000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  const unread = alerts.filter((item) => item.unread)
  const handleAck = async (item: FamilyAlertItem) => {
    if (!session) return
    setAckingId(item.notificationId)
    try {
      await ackFamilyAlert(session.userId, item.notificationId, item.category)
      message.success('已确认收到')
      await loadAlerts()
    } catch (err: any) {
      message.error(err?.message || '确认失败')
    } finally {
      setAckingId(null)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>

  const alertTypeConfig: Record<string, { color: string; icon: ReactNode; text: string }> = {
    sos: { color: 'red', icon: <WarningOutlined />, text: 'SOS请求' },
    health_warning: { color: 'gold', icon: <BellOutlined />, text: '健康异常' },
  }

  const resolveStatusLabel = (record: FamilyAlertItem) => {
    const healthStatus = record.category === 'health_warning'
      ? (record.unread ? '待确认' : '已确认')
      : (statusText[record.status] || record.status)
    if (record.category === 'health_warning') return healthStatus
    return `${record.unread ? '未读 · ' : ''}${healthStatus}`
  }

  const columns = [
    {
      title: '告警类型',
      dataIndex: 'category',
      key: 'category',
      width: 120,
      render: (category: FamilyAlertItem['category']) => {
        const config = alertTypeConfig[category] || { color: 'default', icon: <BellOutlined />, text: category }
        return <Tag color={config.color} icon={config.icon} className="!m-0 mobile-single-line">{config.text}</Tag>
      },
    },
    {
      title: '长辈',
      dataIndex: 'elderName',
      key: 'elderName',
      width: 100,
      render: (name: string) => <span className="mobile-single-line">{name}</span>,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (description: string) => (
        <Typography.Text ellipsis={{ tooltip: description }} className="max-w-full text-slate-700">
          {description}
        </Typography.Text>
      ),
    },
    {
      title: '发生时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (time: string) => <span className="text-gray-500 text-sm whitespace-nowrap">{time}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status: string, record: FamilyAlertItem) => {
        const unreadColor = record.category === 'health_warning' ? 'gold' : 'red'
        return (
          <Tag color={record.unread ? unreadColor : status === 'resolved' ? 'green' : 'blue'} className="!m-0 whitespace-nowrap">
            {resolveStatusLabel(record)}
          </Tag>
        )
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      align: 'left' as const,
      render: (_: unknown, record: FamilyAlertItem) => (
        <div className="family-alert-actions">
          <Button size="small" type="link" className="family-alert-detail-btn !px-0 shrink-0" onClick={() => setDetailAlert(record)}>
            查看详情
          </Button>
          {record.conversationId ? (
            <Button size="small" className="shrink-0" onClick={() => navigate(`/conversations?id=${record.conversationId}`)}>
              打开求助群聊
            </Button>
          ) : null}
          {record.unread ? (
            <Button
              type="primary"
              size="small"
              className="shrink-0"
              loading={ackingId === record.notificationId}
              onClick={() => void handleAck(record)}
            >
              {record.category === 'health_warning' ? '确认已知晓' : '我知道了'}
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1 flex items-center gap-2">
          <BellOutlined className="text-amber-500" />
          异常告警
        </Typography.Title>
        <Typography.Text className="text-gray-500">
          长辈一键求助或健康打卡异常后，这里和右上角都会出现提示（健康异常为黄色）。健康异常需点击「我知道了」才算确认，仅关闭右上角提示不算。
        </Typography.Text>
      </div>

      {unread.length ? (
        <Alert
          type={unread.some((item) => item.category === 'sos') ? 'error' : 'warning'}
          showIcon
          message={`您有 ${unread.length} 条未读提醒`}
          description={unread.slice(0, 3).map((item) => `${item.elderName}：${item.description}`).join('；')}
          action={
            unread.find((item) => item.conversationId)?.conversationId ? (
              <Button
                size="small"
                danger={unread.some((item) => item.category === 'sos')}
                onClick={() => {
                  const target = unread.find((item) => item.conversationId)
                  if (target?.conversationId) navigate(`/conversations?id=${target.conversationId}`)
                }}
              >
                立即查看
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <Card className="!rounded-2xl family-alerts-card">
        {alerts.length === 0 ? (
          <Empty description="暂无告警" />
        ) : (
          <div className="mobile-table-scroll">
            <Table
              dataSource={alerts}
              columns={columns}
              rowKey={(record) => `${record.category}-${record.notificationId}`}
              pagination={{ pageSize: 20 }}
              size="middle"
              tableLayout="fixed"
            />
          </div>
        )}
      </Card>

      <Modal
        title="告警详情"
        open={!!detailAlert}
        onCancel={() => setDetailAlert(null)}
        footer={<Button type="primary" onClick={() => setDetailAlert(null)}>知道了</Button>}
      >
        {detailAlert ? (
          <div className="space-y-3 text-sm text-slate-700">
            <div className="mobile-single-line">
              <Typography.Text type="secondary">类型：</Typography.Text>
              {alertTypeConfig[detailAlert.category]?.text || detailAlert.category}
            </div>
            <div className="mobile-single-line">
              <Typography.Text type="secondary">长辈：</Typography.Text>
              {detailAlert.elderName}
            </div>
            <div className="mobile-single-line">
              <Typography.Text type="secondary">状态：</Typography.Text>
              {resolveStatusLabel(detailAlert)}
            </div>
            <div className="mobile-single-line">
              <Typography.Text type="secondary">时间：</Typography.Text>
              {detailAlert.createdAt}
            </div>
            <div>
              <Typography.Text type="secondary">描述：</Typography.Text>
              <div className="mt-1 rounded-lg bg-slate-50 p-3 leading-relaxed">{detailAlert.description}</div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
