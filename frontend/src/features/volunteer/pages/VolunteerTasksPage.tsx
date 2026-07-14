import { useEffect, useState } from 'react'
import { Card, Tag, Typography, Button, Empty, App } from 'antd'
import { useNavigate } from 'react-router-dom'
import { ClockCircleOutlined, EnvironmentOutlined } from '@ant-design/icons'

import { fetchVolunteerTasks, grabVolunteerTask } from '@/services/adapters/volunteer-adapter'
import { useSession } from '@/features/auth/useSession'
import type { VolunteerTaskCard } from '@/types/domain'

const urgencyColors: Record<string, string> = { high: 'red', medium: 'orange', low: 'green' }
const urgencyLabels: Record<string, string> = { high: '紧急', medium: '一般', low: '不急' }
const statusLabels: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '待接单' },
  accepted: { color: 'blue', text: '已接单' },
  in_progress: { color: 'processing', text: '进行中' },
  completed: { color: 'green', text: '已完成' },
  cancelled: { color: 'default', text: '已取消' },
  unavailable: { color: 'default', text: '不可用' },
}

export default function VolunteerTasksPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const { message } = App.useApp()
  const [tasks, setTasks] = useState<VolunteerTaskCard[]>([])
  const [loading, setLoading] = useState(true)
  const [grabbingId, setGrabbingId] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    fetchVolunteerTasks(session?.userId)
      .then(setTasks)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(load, [session?.userId])

  const handleGrab = async (orderId: number) => {
    if (grabbingId === orderId) return
    setGrabbingId(orderId)
    try {
      await grabVolunteerTask(orderId, session?.userId)
      message.success('抢单成功！')
      load()
    } catch (err: any) {
      message.error(err?.message || '抢单失败')
    } finally {
      setGrabbingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">任务大厅</Typography.Title>
        <Typography.Text className="text-gray-500">浏览可接的服务任务</Typography.Text>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => <Card key={i} loading className="!rounded-2xl" />)}
        </div>
      ) : tasks.length === 0 ? (
        <Card className="!rounded-2xl"><Empty description="暂无可接任务" /></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {tasks.map((task) => {
            const st = statusLabels[task.status] || { color: 'default', text: task.status }
            const isGrabbing = grabbingId === task.orderId
            return (
              <Card
                key={task.orderId}
                className="!rounded-2xl hover:shadow-md transition-shadow"
                actions={[
                  task.status === 'pending' ? (
                    <Button
                      key="grab"
                      type="primary"
                      size="small"
                      loading={isGrabbing}
                      disabled={!!grabbingId && grabbingId !== task.orderId}
                      onClick={() => handleGrab(task.orderId)}
                    >
                      立即抢单
                    </Button>
                  ) : (
                    <Button key="detail" type="link" size="small" onClick={() => navigate(`/volunteer/tasks/${task.orderId}`)}>
                      查看详情
                    </Button>
                  ),
                ]}
              >
                <div className="flex items-start justify-between mb-2">
                  <Typography.Title level={4} className="!mb-0">{task.serviceType}</Typography.Title>
                  <Tag color={urgencyColors[task.urgencyLevel]}>{urgencyLabels[task.urgencyLevel]}</Tag>
                </div>
                <Tag color={st.color} className="mb-3">{st.text}</Tag>
                <div className="space-y-1 text-sm text-gray-600">
                  <div><ClockCircleOutlined className="mr-1" />{task.scheduledTime} · {task.serviceHours}小时</div>
                  <div><EnvironmentOutlined className="mr-1" />{task.addressPreview}</div>
                  {task.elderName && <div>服务对象：{task.elderName}</div>}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
