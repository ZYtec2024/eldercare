import { useEffect, useState } from 'react'
import { App, Button, Card, Spin, Table, Tag, Typography } from 'antd'
import { HeartFilled, HeartOutlined, TrophyOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { AdminGeoScopeFilters, type AdminGeoScope } from '@/features/admin/components/AdminGeoScopeFilters'
import { fetchVolunteerLeaderboard } from '@/services/adapters/volunteer-adapter'
import { likeVolunteer } from '@/services/adapters/volunteer-adapter'
import type { VolunteerProfile } from '@/types/domain'

export default function VolunteerLeaderboardPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [data, setData] = useState<VolunteerProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [likedVolunteerIds, setLikedVolunteerIds] = useState<Set<number>>(new Set())
  const [geoScope, setGeoScope] = useState<AdminGeoScope>({})
  const isAdmin = session?.role === 'admin'
  const isRoot = Boolean(session?.isRoot)

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    setLoading(true)
    const request = isAdmin
      ? fetchVolunteerLeaderboard({
          adminUserId: session.userId,
          regionAdcode: geoScope.regionAdcode,
          provinceName: isRoot && !geoScope.regionAdcode ? geoScope.provinceName : undefined,
          cityName: isRoot && !geoScope.regionAdcode ? geoScope.cityName : undefined,
        })
      : fetchVolunteerLeaderboard({ viewerUserId: session.userId })

    request
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [
    session?.userId,
    isAdmin,
    isRoot,
    geoScope.regionAdcode,
    geoScope.provinceName,
    geoScope.cityName,
  ])

  const handleLike = async (item: VolunteerProfile) => {
    if (!session || !item.userId) return

    try {
      await likeVolunteer(session.userId, item.userId)
      setLikedVolunteerIds((prev) => new Set(prev).add(item.userId!))
      message.success('点赞成功！')
    } catch (err: any) {
      if (err?.status === 409 && item.userId) {
        setLikedVolunteerIds((prev) => new Set(prev).add(item.userId!))
      }
      message.error(err?.message || '点赞失败')
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>

  const roleLabel = session?.role === 'family'
    ? '家属'
    : session?.role === 'admin'
      ? '管理员'
      : '志愿者'

  const columns = [
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
      title: '志愿者',
      dataIndex: 'realName',
      key: 'realName',
      render: (name: string | undefined) => name || '—',
    },
    {
      title: '总服务时长',
      dataIndex: 'totalHours',
      key: 'totalHours',
      render: (v: number) => <span className="font-semibold text-blue-700">{v} 小时</span>,
    },
    {
      title: '本周时长',
      dataIndex: 'weeklyHours',
      key: 'weeklyHours',
      render: (v: number) => `${v} 小时`,
    },
    {
      title: <span><HeartOutlined className="mr-1" />获赞</span>,
      dataIndex: 'likesCount',
      key: 'likesCount',
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
    {
      title: '点赞',
      key: 'actions',
      width: 140,
      render: (_: unknown, item: VolunteerProfile) => {
        const currentUserId = typeof session?.userId === 'number' ? session.userId : Number(session?.userId)
        const targetUserId = typeof item.userId === 'number' ? item.userId : Number(item.userId)
        const isSelf = Number.isFinite(currentUserId) && Number.isFinite(targetUserId) && currentUserId === targetUserId
        const isLiked = item.userId ? likedVolunteerIds.has(item.userId) : false

        return (
          <Button
            size="small"
            type={isLiked ? 'primary' : 'default'}
            icon={isLiked ? <HeartFilled /> : <HeartOutlined />}
            disabled={Boolean(isSelf || isLiked || !item.userId || !session)}
            onClick={() => handleLike(item)}
          >
            {isSelf ? '不能给自己点赞' : isLiked ? '已点赞' : '点赞'}
          </Button>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Typography.Title level={3} className="!mb-1 flex items-center gap-2">
            <TrophyOutlined className="text-amber-500" />荣誉墙
          </Typography.Title>
          <Typography.Text className="text-gray-500">
            {roleLabel}可查看志愿者本周时长排行并点赞鼓励
            {isAdmin ? '；总管理员可按省市切换，区管理员仅看管辖区' : '（按所属区县）'}
          </Typography.Text>
        </div>
        {isAdmin ? (
          <AdminGeoScopeFilters
            value={geoScope}
            onChange={setGeoScope}
          />
        ) : null}
      </div>

      <Card className="!rounded-2xl">
        <Table
          dataSource={data}
          columns={columns}
          rowKey="rank"
          pagination={false}
          size="middle"
        />
      </Card>
    </div>
  )
}
