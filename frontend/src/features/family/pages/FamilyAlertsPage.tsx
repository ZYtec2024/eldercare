import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, App, Button, Card, Empty, Spin, Table, Tag, Typography } from 'antd'
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
      await ackFamilyAlert(session.userId, item.notificationId)
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
    sos: { color: 'red', icon: <WarningOutlined />, text: 'SOS 求助' },
    health_warning: { color: 'orange', icon: <BellOutlined />, text: '健康异常' },
  }

  const columns = [
    {
      title: '告警类型',
      dataIndex: 'category',
      key: 'category',
      render: (category: FamilyAlertItem['category']) => {
        const config = alertTypeConfig[category] || { color: 'default', icon: <BellOutlined />, text: category }
        return <Tag color={config.color} icon={config.icon}>{config.text}</Tag>
      },
    },
    {
      title: '长辈',
      dataIndex: 'elderName',
      key: 'elderName',
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: '发生时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (time: string) => <span className="text-gray-500 text-sm">{time}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string, record: FamilyAlertItem) => (
        <Tag color={record.unread ? 'red' : status === 'resolved' ? 'green' : 'blue'}>
          {record.unread ? '未读 · ' : ''}{statusText[status] || status}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: FamilyAlertItem) => (
        <div className="flex flex-wrap gap-2">
          {record.conversationId ? (
            <Button size="small" onClick={() => navigate(`/conversations?id=${record.conversationId}`)}>
              打开求助群聊
            </Button>
          ) : null}
          {record.unread ? (
            <Button
              type="primary"
              size="small"
              loading={ackingId === record.notificationId}
              onClick={() => void handleAck(record)}
            >
              我知道了
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
          长辈一键求助后，这里和右上角都会出现提示
        </Typography.Text>
      </div>

      {unread.length ? (
        <Alert
          type="error"
          showIcon
          message={`您有 ${unread.length} 条未读求助提醒`}
          description={unread.slice(0, 3).map((item) => `${item.elderName}：${item.description}`).join('；')}
          action={
            unread[0]?.conversationId ? (
              <Button size="small" danger onClick={() => navigate(`/conversations?id=${unread[0].conversationId}`)}>
                立即查看
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <Card className="!rounded-2xl">
        {alerts.length === 0 ? (
          <Empty description="暂无告警" />
        ) : (
          <Table
            dataSource={alerts}
            columns={columns}
            rowKey="notificationId"
            pagination={{ pageSize: 20 }}
            size="middle"
          />
        )}
      </Card>
    </div>
  )
}
