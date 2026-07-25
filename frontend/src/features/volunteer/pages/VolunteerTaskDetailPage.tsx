import { useEffect, useState } from 'react'
import { Card, Tag, Typography, Button, Spin, App } from 'antd'
import { useParams, useNavigate } from 'react-router-dom'
import { ClockCircleOutlined, EnvironmentOutlined } from '@ant-design/icons'

import { fetchVolunteerTaskDetail, updateVolunteerTaskAction } from '@/services/adapters/volunteer-adapter'
import { useSession } from '@/features/auth/useSession'
import type { VolunteerTaskCard } from '@/types/domain'

export default function VolunteerTaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { session } = useSession()
  const [task, setTask] = useState<VolunteerTaskCard | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)

  useEffect(() => {
    if (!taskId) return
    fetchVolunteerTaskDetail(Number(taskId), session?.userId)
      .then(setTask)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [taskId, session?.userId])

  const handleAction = async (action: 'accept' | 'start' | 'complete' | 'cancel') => {
    if (!taskId) return
    setActing(true)
    try {
      const result = await updateVolunteerTaskAction(Number(taskId), action, session?.userId)
      message.success(result.message)
      setTask(result.task)
    } catch (err: any) {
      message.error(err?.message || '操作失败')
    } finally {
      setActing(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>
  if (!task) return <Typography.Text>任务不存在</Typography.Text>

  const actionLabels: Record<string, string> = { accept: '接受任务', start: '开始服务', complete: '完成服务', cancel: '中止任务' }

  return (
    <div className="space-y-6">
      <Button type="link" onClick={() => navigate('/volunteer/tasks')} className="!px-0">返回任务大厅</Button>
      <Card className="!rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
          <div>
            <Typography.Title level={3} className="!mb-1">{task.serviceType}</Typography.Title>
            <Tag color={task.status === 'completed' ? 'green' : task.status === 'pending' ? 'orange' : 'blue'}>
              {task.status === 'pending'
                ? '待接单'
                : task.status === 'accepted'
                  ? '已接单'
                  : task.status === 'in_progress'
                    ? '进行中'
                    : task.status === 'completed'
                      ? '已完成'
                      : task.status === 'cancelled'
                        ? '已取消'
                        : task.status}
            </Tag>
          </div>
          <Tag color={task.urgencyLevel === 'high' ? 'red' : task.urgencyLevel === 'medium' ? 'orange' : 'green'}>
            {task.urgencyLevel === 'high' ? '紧急' : task.urgencyLevel === 'medium' ? '一般' : '不急'}
          </Tag>
        </div>
        <div className="space-y-2 text-base text-gray-600 mb-6">
          <div><ClockCircleOutlined className="mr-2" />服务时间：{task.scheduledTime}</div>
          <div><ClockCircleOutlined className="mr-2" />预计时长：{task.serviceHours} 小时</div>
          <div><EnvironmentOutlined className="mr-2" />地址：{task.addressPreview}</div>
          {task.elderName && <div>服务对象：{task.elderName}</div>}
          {task.personalityBio && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              <b>📝 老人简介：</b>{task.personalityBio}
            </div>
          )}
        </div>
        {task.availableActions.length > 0 && (
          <div className="flex gap-3">
            {task.availableActions.map((action) => (
              <Button
                key={action}
                type="primary"
                size="large"
                loading={acting}
                onClick={() => handleAction(action)}
              >
                {actionLabels[action] || action}
              </Button>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
