import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { App, Button, Card, Empty, Spin, Table, Tag, Typography } from 'antd'
import { BellOutlined, WarningOutlined } from '@ant-design/icons'

type FamilyAlertRow = {
  alertId: number
  category: 'sos' | 'health_warning'
  elderName: string
  description: string
  timestamp: string
  handled: boolean
}

function normalizeCategory(value: unknown): 'sos' | 'health_warning' {
  return String(value) === 'sos' ? 'sos' : 'health_warning'
}

function normalizeTime(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toLocaleString('zh-CN', { hour12: false })
  return ''
}

export default function FamilyAlertsPage() {
  const { message } = App.useApp()
  const [alerts, setAlerts] = useState<FamilyAlertRow[]>([])
  const [loading, setLoading] = useState(true)
  const [handlingId, setHandlingId] = useState<number | null>(null)

  const loadAlerts = async () => {
    try {
      const response = await fetch('/api/admin/alerts', {
        headers: {
          'Content-Type': 'application/json',
        },
      })
      const json = await response.json()
      if (json.code === 200 && Array.isArray(json.data)) {
        const mapped = json.data.map((item: Record<string, unknown>) => ({
          alertId: Number(item.alert_id ?? item.alertId ?? 0),
          category: normalizeCategory(item.alert_type ?? item.category),
          elderName: String(item.elder_name ?? item.elderName ?? '长辈'),
          description: String(item.description ?? ''),
          timestamp: normalizeTime(item.created_at ?? item.createdAt),
          handled: Boolean(item.is_handled ?? item.handled),
        }))
        setAlerts(mapped)
      }
    } catch (err) {
      message.error('加载告警列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAlerts()
    const timer = setInterval(loadAlerts, 5000)
    return () => clearInterval(timer)
  }, [message])

  const handleAlert = async (alertId: number) => {
    setHandlingId(alertId)
    try {
      const response = await fetch('/api/admin/alerts/handle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ alert_id: alertId }),
      })
      const json = await response.json()
      if (json.code === 200) {
        message.success(json.message || '处理成功')
        await loadAlerts()
      } else {
        message.error(json.message || '处理失败')
      }
    } catch (err) {
      message.error('处理失败')
    } finally {
      setHandlingId(null)
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
      render: (category: string) => {
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
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (time: string) => <span className="text-gray-500 text-sm">{time}</span>,
    },
    {
      title: '状态',
      dataIndex: 'handled',
      key: 'handled',
      render: (handled: boolean) => (
        <Tag color={handled ? 'green' : 'blue'}>
          {handled ? '已处理' : '待处理'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: FamilyAlertRow) => (
        record.handled ? null : (
          <Button
            type="primary"
            size="small"
            loading={handlingId === record.alertId}
            onClick={() => handleAlert(record.alertId)}
          >
            处理
          </Button>
        )
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
          查看长辈的健康异常与 SOS 求助等重要告警事件
        </Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        {alerts.length === 0 ? (
          <Empty description="暂无告警" />
        ) : (
          <Table
            dataSource={alerts}
            columns={columns}
            rowKey="alertId"
            pagination={{ pageSize: 20 }}
            size="middle"
          />
        )}
      </Card>
    </div>
  )
}
