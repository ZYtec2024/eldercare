import { useCallback, useEffect, useState } from 'react'
import { Card, Empty, List, Spin, Tag, Typography } from 'antd'
import { ClockCircleOutlined, EnvironmentOutlined, TeamOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import type { VolunteerDispatchTask } from '@/features/dispatch/dispatch-types'
import { fetchVolunteerDispatchFeed } from '@/services/adapters/dispatch-adapter'

type CompletedTask = {
  order_id: number
  service_type: string
  elder_name: string
  address?: string
  completed_at?: string | null
  close_status?: string
}

const activeStatuses = new Set(['accepted', 'in_progress'])
const statusMeta: Record<string, { color: string; label: string }> = {
  accepted: { color: 'blue', label: '正在赶路' },
  in_progress: { color: 'green', label: '服务中' },
}

export default function VolunteerTasksPage() {
  const { session } = useSession()
  const [tasks, setTasks] = useState<VolunteerDispatchTask[]>([])
  const [completedTasks, setCompletedTasks] = useState<CompletedTask[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!session?.userId) return
    try {
      const data = await fetchVolunteerDispatchFeed(session.userId)
      // “我的任务”只保留已经由本人接下、正在执行的订单；候选邀约属于智能推荐接单页面。
      setTasks(data.tasks.filter((task) => activeStatuses.has(task.status)))
      setCompletedTasks(data.completed_tasks)
    } finally {
      setLoading(false)
    }
  }, [session?.userId])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">我的任务</Typography.Title>
        <Typography.Text className="text-gray-500">
          这里只显示我已接下的服务和完成记录；候选邀约、抢单倒计时和自动接单请查看“智能推荐接单”。
        </Typography.Text>
      </div>

      <Card title="当前执行中的任务" className="!rounded-2xl">
        {loading ? <Spin /> : tasks.length === 0 ? (
          <Empty description="当前没有已接任务，可在“智能推荐接单”查看向你开放的候选请求" />
        ) : (
          <List
            dataSource={tasks}
            renderItem={(task) => {
              const meta = statusMeta[task.status] ?? { color: 'default', label: task.status }
              return (
                <List.Item>
                  <div className="w-full space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Typography.Text strong>{task.service_type}</Typography.Text>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      {task.urgency === 'sos' && <Tag color="red">SOS 紧急订单</Tag>}
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <div><TeamOutlined className="mr-1" />服务对象：{task.elder_name}</div>
                      <div><EnvironmentOutlined className="mr-1" />{task.address || '服务地址待确认'}</div>
                      {task.personality_bio && <div className="text-xs text-gray-500">📝 {task.personality_bio}</div>}
                      {task.route?.eta_minutes != null && <div><ClockCircleOutlined className="mr-1" />预计到达：约 {task.route.eta_minutes} 分钟</div>}
                    </div>
                  </div>
                </List.Item>
              )
            }}
          />
        )}
      </Card>

      <Card title="已结束服务记录" className="!rounded-2xl">
        {loading ? <Spin /> : completedTasks.length === 0 ? (
          <Empty description="暂无已结束服务记录" />
        ) : (
          <List
            size="small"
            dataSource={completedTasks}
            renderItem={(task) => (
              <List.Item
                className="volunteer-completed-item"
                actions={[
                  <Tag key="st" color={task.close_status === 'closed' ? 'default' : 'green'} className="!m-0">
                    {task.close_status === 'closed' ? '已关闭' : '已完成'}
                  </Tag>,
                ]}
              >
                <List.Item.Meta
                  title={(
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Typography.Text strong className="whitespace-nowrap">{task.service_type}</Typography.Text>
                      <Typography.Text type="secondary" className="whitespace-nowrap">{task.elder_name}</Typography.Text>
                      <Typography.Text type="secondary" className="whitespace-nowrap">#{task.order_id}</Typography.Text>
                      <Typography.Text type="secondary" className="whitespace-nowrap text-sm">
                        {task.completed_at || (task.close_status === 'closed' ? '已换人重派' : '')}
                      </Typography.Text>
                    </div>
                  )}
                  description={task.address ? (
                    <div className="service-address-line overflow-x-auto text-sm text-slate-500">
                      <span className="inline-block whitespace-nowrap">{task.address}</span>
                    </div>
                  ) : null}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  )
}
