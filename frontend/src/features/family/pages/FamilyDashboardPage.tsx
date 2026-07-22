import { Card, Typography } from 'antd'
import {
  DashboardOutlined,
  LinkOutlined,
  FileTextOutlined,
  EyeOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'

const features = [
  {
    icon: <DashboardOutlined className="text-5xl text-violet-600" />,
    title: '实时守护',
    desc: '查看绑定长辈的固定服务点；志愿者接单、出发和服务期间同步路线，服务结束后自动锁定志愿者位置。',
    path: '/family/live-tracking',
    color: 'border-violet-200 bg-violet-50/50',
  },
  {
    icon: <EyeOutlined className="text-5xl text-blue-600" />,
    title: '查看长辈健康',
    desc: '实时查看已绑定长辈的健康打卡数据、健康趋势图表和风险等级，及时了解长辈的身体状况变化。',
    path: '/family/dashboard',
    color: 'border-blue-200 bg-blue-50/50',
  },
  {
    icon: <LinkOutlined className="text-5xl text-indigo-600" />,
    title: '绑定长辈',
    desc: '通过长辈的账号信息将其绑定到您的家属端，绑定后即可远程查看健康数据、接收异常告警通知。',
    path: '/family/bind-elder',
    color: 'border-indigo-200 bg-indigo-50/50',
  },
  {
    icon: <FileTextOutlined className="text-5xl text-sky-600" />,
    title: '代长辈下单',
    desc: '为绑定长辈发布陪诊、上门陪聊、代购等服务需求，系统会按技能匹配走 Top1→Top3→Top10 智能派单。',
    path: '/family/new-request',
    color: 'border-sky-200 bg-sky-50/50',
  },
  {
    icon: <FileTextOutlined className="text-5xl text-cyan-600" />,
    title: '服务管理',
    desc: '跟踪已发布需求的状态和进度，确认完成并评价志愿者。',
    path: '/family/orders',
    color: 'border-cyan-200 bg-cyan-50/50',
  },
  {
    icon: <TrophyOutlined className="text-5xl text-amber-500" />,
    title: '荣誉墙',
    desc: '查看志愿者本周服务排行和荣誉记录，也可以为认真服务的志愿者点赞鼓励。',
    path: '/family/honor-wall',
    color: 'border-amber-200 bg-amber-50/50',
  },
  {
    icon: <DashboardOutlined className="text-5xl text-blue-600" />,
    title: '任务大厅',
    desc: '查看社区公益服务任务，了解任务内容、服务时间和志愿者接单情况，也可以随时打开查看最新任务动态。',
    path: '/task-hall',
    color: 'border-blue-200 bg-blue-50/50',
  },
]

export default function FamilyDashboardPage() {
  const navigate = useNavigate()
  const { session } = useSession()

  return (
    <div className="space-y-8">
      {/* Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-800 p-10 md:p-12 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-3 !text-3xl md:!text-4xl">
          守护家人健康
        </Typography.Title>
        <Typography.Paragraph className="!text-blue-100 !text-lg md:!text-xl !mb-0 max-w-2xl">
          欢迎回来，{session?.displayName}。您可以远程查看长辈健康状况、发布服务需求，让关爱零距离。
        </Typography.Paragraph>
      </div>

      {/* Feature Cards */}
      <div className="space-y-5">
        {features.map((f) => (
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
