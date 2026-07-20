import { useEffect, useState, useCallback } from 'react'
import { Card, Tag, Typography, Button, Empty, App, Segmented, Statistic, Row, Col, Modal, Checkbox } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  ClockCircleOutlined,
  EnvironmentOutlined,
  UserOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  InboxOutlined,
  DeleteOutlined,
  LoginOutlined,
} from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { http, type ApiEnvelope } from '@/services/http'

interface PublicTask {
  order_id: number
  elder_name: string
  service_type: string
  service_time: string
  service_hours: number
  address_preview: string
  status: string
  created_at: string
  volunteer_name: string | null
}

interface TaskStats {
  total: number
  pending: number
  in_progress: number
  completed: number
}

const statusConfig: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
  pending: { color: 'orange', text: '招募志愿者中', icon: <InboxOutlined /> },
  accepted: { color: 'blue', text: '已有志愿者接单', icon: <UserOutlined /> },
  in_progress: { color: 'processing', text: '服务进行中', icon: <SyncOutlined spin /> },
  completed: { color: 'green', text: '已完成', icon: <CheckCircleOutlined /> },
}

type FilterValue = 'all' | 'pending' | 'in_progress' | 'completed'

export default function PublicTaskHallPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const { message, modal } = App.useApp()
  const [tasks, setTasks] = useState<PublicTask[]>([])
  const [stats, setStats] = useState<TaskStats>({ total: 0, pending: 0, in_progress: 0, completed: 0 })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterValue>('all')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  const [grabbingId, setGrabbingId] = useState<number | null>(null)

  const isVolunteer = session?.role === 'volunteer'
  const isAdmin = session?.role === 'admin'

  const load = useCallback(() => {
    setLoading(true)
    const params = {
      ...(filter !== 'all' ? { status: filter === 'in_progress' ? 'accepted' : filter } : {}),
      viewer_user_id: session?.userId,
    }
    http
      .get<ApiEnvelope<{ tasks: PublicTask[]; stats: TaskStats }>>('/public/tasks', { params })
      .then((res) => {
        const data = res.data.data
        let taskList = data.tasks ?? []
        // For in_progress filter, also include actual in_progress status
        if (filter === 'in_progress') {
          // Re-fetch without filter and filter client-side
          http.get<ApiEnvelope<{ tasks: PublicTask[]; stats: TaskStats }>>('/public/tasks', { params: { viewer_user_id: session?.userId } }).then((allRes) => {
            const allTasks = allRes.data.data.tasks ?? []
            setTasks(allTasks.filter((t) => t.status === 'accepted' || t.status === 'in_progress'))
            setStats(allRes.data.data.stats)
            setLoading(false)
          })
          return
        }
        setTasks(taskList)
        setStats(data.stats)
      })
      .catch(() => {
        setTasks([])
      })
      .finally(() => setLoading(false))
  }, [filter, session?.userId])

  useEffect(() => {
    load()
  }, [load])

  const handleGrab = async (orderId: number) => {
    if (!session) {
      message.warning('请先登录后再接单')
      navigate('/login')
      return
    }
    if (session.role !== 'volunteer') {
      message.info('只有注册的志愿者才能接单，请先注册志愿者账号')
      return
    }
    if (grabbingId === orderId) return
    setGrabbingId(orderId)
    try {
      await http.post('/volunteer/orders/grab', {
        order_id: orderId,
        volunteer_id: session.userId,
      })
      message.success('抢单成功！')
      load()
    } catch (err: any) {
      message.error(err?.message || '抢单失败')
    } finally {
      setGrabbingId(null)
    }
  }

  const handleBatchDelete = () => {
    if (selectedIds.length === 0) {
      message.warning('请先选择要删除的已完成任务')
      return
    }
    modal.confirm({
      title: '确认删除',
      content: `确定要删除选中的 ${selectedIds.length} 个已完成任务吗？此操作不可撤销。`,
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        try {
          await http.post('/public/tasks/batch-delete', { order_ids: selectedIds, viewer_user_id: session?.userId })
          message.success(`成功删除 ${selectedIds.length} 个任务`)
          setSelectedIds([])
          load()
        } catch (err: any) {
          message.error(err?.message || '删除失败')
        } finally {
          setDeleting(false)
        }
      },
    })
  }

  const toggleSelect = (orderId: number) => {
    setSelectedIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    )
  }

  const completedTasks = tasks.filter((t) => t.status === 'completed')

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-sky-50">
      {/* Header */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-md">
            <InboxOutlined className="text-white text-xl" />
          </div>
          <div>
            <Typography.Text className="!text-lg !font-bold text-gray-900 block leading-tight">
              任务大厅
            </Typography.Text>
            <Typography.Text className="text-gray-500 text-xs">
              智慧伴老平台 - 公益服务任务一览
            </Typography.Text>
          </div>
        </div>
        <div className="flex gap-2">
          {session ? (
            <Button onClick={() => navigate(-1)}>返回</Button>
          ) : (
            <>
              <Button onClick={() => navigate('/')} icon={<InboxOutlined />}>
                首页
              </Button>
              <Button onClick={() => navigate('/login')} icon={<LoginOutlined />}>
                登录
              </Button>
              <Button type="primary" onClick={() => navigate('/register')}>
                注册志愿者
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 md:px-6 pb-12">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card className="!rounded-xl">
            <Statistic title="全部任务" value={stats.total} valueStyle={{ color: '#1677ff' }} />
          </Card>
          <Card className="!rounded-xl">
            <Statistic
              title="招募中"
              value={stats.pending}
              valueStyle={{ color: '#fa8c16' }}
              prefix={<InboxOutlined />}
            />
          </Card>
          <Card className="!rounded-xl">
            <Statistic
              title="进行中"
              value={stats.in_progress}
              valueStyle={{ color: '#1677ff' }}
              prefix={<SyncOutlined />}
            />
          </Card>
          <Card className="!rounded-xl">
            <Statistic
              title="已完成"
              value={stats.completed}
              valueStyle={{ color: '#52c41a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </div>

        {/* Filter */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <Segmented
            value={filter}
            onChange={(val) => {
              setFilter(val as FilterValue)
              setSelectedIds([])
            }}
            options={[
              { label: '全部', value: 'all' },
              { label: '招募志愿者', value: 'pending' },
              { label: '进行中', value: 'in_progress' },
              { label: '已完成', value: 'completed' },
            ]}
            size="large"
          />
          {isAdmin && filter === 'completed' && completedTasks.length > 0 && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleBatchDelete}
              loading={deleting}
              disabled={selectedIds.length === 0}
            >
              删除选中 ({selectedIds.length})
            </Button>
          )}
        </div>

        {/* Task List */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <Card key={i} loading className="!rounded-2xl" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <Card className="!rounded-2xl">
            <Empty description="暂无任务" />
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {tasks.map((task) => {
              const st = statusConfig[task.status] || { color: 'default', text: task.status, icon: null }
              const isCompleted = task.status === 'completed'
              return (
                <Card
                  key={task.order_id}
                  className="!rounded-2xl hover:shadow-md transition-shadow"
                  actions={
                    task.status === 'pending'
                      ? [
                          !session ? (
                            <Button
                              key="grab-login"
                              size="small"
                              onClick={() => navigate('/login')}
                            >
                              登录后可接单
                            </Button>
                          ) : isVolunteer ? (
                            <Button
                              key="grab"
                              type="primary"
                              size="small"
                              loading={grabbingId === task.order_id}
                              disabled={!!grabbingId && grabbingId !== task.order_id}
                              onClick={() => handleGrab(task.order_id)}
                            >
                              立即接单
                            </Button>
                          ) : (
                            <Button key="grab-disabled" size="small" disabled>
                              仅志愿者可接取
                            </Button>
                          ),
                        ]
                      : undefined
                  }
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {isAdmin && isCompleted && (
                        <Checkbox
                          checked={selectedIds.includes(task.order_id)}
                          onChange={() => toggleSelect(task.order_id)}
                        />
                      )}
                      <Typography.Title level={4} className="!mb-0">
                        {task.service_type}
                      </Typography.Title>
                    </div>
                    <Tag color={st.color} icon={st.icon}>
                      {st.text}
                    </Tag>
                  </div>
                  <div className="space-y-1 text-sm text-gray-600 mt-3">
                    <div>
                      <ClockCircleOutlined className="mr-1" />
                      {task.service_time} · {task.service_hours}小时
                    </div>
                    <div>
                      <EnvironmentOutlined className="mr-1" />
                      {task.address_preview || '地址待补充'}
                    </div>
                    {task.elder_name && <div>服务对象：{task.elder_name}</div>}
                    {task.volunteer_name && (
                      <div>
                        <UserOutlined className="mr-1" />
                        志愿者：{task.volunteer_name}
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}

        {/* Tip for non-volunteers */}
        {!session && (
          <div className="mt-8 text-center">
            <Card className="!rounded-2xl bg-blue-50 border-blue-200">
              <Typography.Title level={4} className="!mb-2">
                想要参与志愿服务？
              </Typography.Title>
              <Typography.Paragraph className="text-gray-600 mb-4">
                注册成为志愿者，即可在任务大厅接单，积累志愿时长与荣誉
              </Typography.Paragraph>
              <Button type="primary" size="large" onClick={() => navigate('/register')}>
                立即注册
              </Button>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
