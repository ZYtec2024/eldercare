import { Card, Typography } from 'antd'
import {
  CompassOutlined,
  DashboardOutlined,
  UserOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  orderHomeFeatures,
  type HomeFeatureItem,
} from '@/features/shared/order-home-features'

const features: HomeFeatureItem[] = [
  {
    icon: <CompassOutlined className="text-5xl text-emerald-600" />,
    title: '智能推荐接单',
    desc: '系统先验证服务技能，再结合距离、共享路况、疲劳度和服务评分推荐订单。可自主接单或拒绝，系统会自动补位下一位候选。',
    path: '/volunteer/dispatch',
    color: 'border-emerald-200 bg-emerald-50/50',
  },
  {
    icon: <DashboardOutlined className="text-5xl text-blue-600" />,
    title: '任务大厅',
    desc: '浏览社区发布的所有服务任务（陪诊、上门陪聊、代购等），查看任务详情、紧急程度和服务地点，一键抢单为老人提供服务。',
    path: '/volunteer/tasks',
    color: 'border-blue-200 bg-blue-50/50',
  },
  {
    icon: <UserOutlined className="text-5xl text-indigo-600" />,
    title: '我的成就',
    desc: '查看您的志愿服务统计：总服务时长、本周时长、完成任务数、获赞数，以及获得的荣誉奖项和徽章。',
    path: '/volunteer/profile',
    color: 'border-indigo-200 bg-indigo-50/50',
  },
  {
    icon: <TrophyOutlined className="text-5xl text-amber-500" />,
    title: '荣誉墙',
    desc: '志愿者服务时长排行榜，展示社区最活跃的志愿者。每周结算后更新排名，优秀志愿者将获得荣誉称号。',
    path: '/volunteer/leaderboard',
    color: 'border-amber-200 bg-amber-50/50',
  },
]

export default function VolunteerDashboardPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const orderedFeatures = orderHomeFeatures('volunteer', features)

  return (
    <div className="space-y-8">
      {/* Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-800 p-10 md:p-12 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-3 !text-3xl md:!text-4xl">
          志愿服务，温暖社区
        </Typography.Title>
        <Typography.Paragraph className="!text-blue-100 !text-lg md:!text-xl !mb-0 max-w-2xl">
          欢迎回来，{session?.displayName}。感谢您的每一次付出，每一份服务都是对社区老人的温暖守护。
        </Typography.Paragraph>
      </div>

      {/* Feature Cards */}
      <div className="space-y-5">
        {orderedFeatures.map((f) => (
          <Card
            key={f.path}
            hoverable
            className={`!rounded-2xl !border-2 ${f.color} cursor-pointer transition-shadow`}
            onClick={() => navigate(f.path)}
          >
            <div className="flex items-start gap-6 py-2">
              <div className="flex-shrink-0 w-20 h-20 rounded-2xl bg-white shadow-sm flex items-center justify-center">
                {f.icon}
              </div>
              <div className="flex-1 min-w-0">
                <Typography.Title level={2} className="!mb-2 !text-gray-800">
                  {f.title}
                </Typography.Title>
                <Typography.Paragraph className="!text-gray-600 !text-lg !mb-0 leading-relaxed">
                  {f.desc}
                </Typography.Paragraph>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
