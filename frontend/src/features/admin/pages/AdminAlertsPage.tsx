import { useEffect, useState } from 'react'
import { Card, List, Tag, Typography, Button, App, Spin } from 'antd'
import { AlertOutlined, WarningOutlined, CheckCircleOutlined } from '@ant-design/icons'

import { fetchAdminAlerts, handleAdminAlert } from '@/services/adapters/admin-adapter'
import type { AlertItem } from '@/types/domain'

const categoryLabels: Record<string, { icon: React.ReactNode; text: string }> = {
  sos: { icon: <AlertOutlined className="text-red-500" />, text: 'SOS 求助' },
  health_abnormal: { icon: <WarningOutlined className="text-orange-500" />, text: '健康异常' },
}

const priorityColors: Record<string, string> = {
  high: 'red',
  medium: 'orange',
  low: 'green',
}
const priorityLabels: Record<string, string> = {
  high: '紧急',
  medium: '一般',
  low: '低',
}

export default function AdminAlertsPage() {
  const { message } = App.useApp()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loading, setLoading] = useState(true)
  const [handlingId, setHandlingId] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    fetchAdminAlerts()
      .then(setAlerts)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const handleAlert = async (alertId: number) => {
    setHandlingId(alertId)
    try {
      const res = await handleAdminAlert(alertId)
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '处理失败')
    } finally {
      setHandlingId(null)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">
          <AlertOutlined className="mr-2 text-red-500" />告警中心
        </Typography.Title>
        <Typography.Text className="text-gray-500">处理 SOS 求助和健康异常告警</Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        <List
          dataSource={alerts}
          locale={{ emptyText: '暂无告警' }}
          renderItem={(item) => {
            const cat = categoryLabels[item.category] || { icon: <AlertOutlined />, text: item.category }
            return (
              <List.Item
                actions={
                  item.status === 'new'
                    ? [
                        <Button
                          key="handle"
                          type="primary"
                          size="small"
                          loading={handlingId === item.alertId}
                          onClick={() => handleAlert(item.alertId)}
                        >
                          处理
                        </Button>,
                      ]
                    : [
                        <Tag key="done" icon={<CheckCircleOutlined />} color="green">已处理</Tag>,
                      ]
                }
              >
                <List.Item.Meta
                  avatar={cat.icon}
                  title={
                    <span>
                      {cat.text}
                      <Tag className="ml-2" color={priorityColors[item.priority]}>
                        {priorityLabels[item.priority]}
                      </Tag>
                      <span className="text-xs text-gray-400 ml-2">{item.sourceLabel}</span>
                    </span>
                  }
                  description={
                    <span>
                      {item.createdAt}
                      {item.resolutionSummary && ` · ${item.resolutionSummary}`}
                    </span>
                  }
                />
              </List.Item>
            )
          }}
        />
      </Card>
    </div>
  )
}
