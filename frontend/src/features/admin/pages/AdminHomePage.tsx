import { Card, Typography } from 'antd'
import {
  DashboardOutlined,
  DeploymentUnitOutlined,
  TeamOutlined,
  AlertOutlined,
  TrophyOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  orderHomeFeatures,
  type HomeFeatureItem,
} from '@/features/shared/order-home-features'

const features: HomeFeatureItem[] = [
  {
    icon: <DeploymentUnitOutlined className="text-5xl text-cyan-600" />,
    title: '实时调度指挥台',
    desc: '查看宝山区共享地图上的50位老人和20名志愿者，观察A*路线、模拟路况、SOS重规划、候选队列、疲劳度及技能硬匹配评分。',
    path: '/admin/dispatch-board',
    color: 'border-cyan-200 bg-cyan-50/50',
  },
  {
    icon: <DashboardOutlined className="text-5xl text-blue-600" />,
    title: '总览看板',
    desc: '查看平台核心运营数据：注册用户数、活跃告警数、已完成服务数、活跃志愿者数，以及用户角色分布和每周服务趋势图表。',
    path: '/admin/dashboard',
    color: 'border-blue-200 bg-blue-50/50',
  },
  {
    icon: <TeamOutlined className="text-5xl text-indigo-600" />,
    title: '用户管理',
    desc: '管理平台所有用户账号，按角色筛选和搜索，审核志愿者注册申请（通过/拒绝），查看用户详细信息和状态。',
    path: '/admin/users',
    color: 'border-indigo-200 bg-indigo-50/50',
  },
  {
    icon: <AlertOutlined className="text-5xl text-red-500" />,
    title: '告警中心',
    desc: '处理平台告警事件，包括老人 SOS 紧急求助和健康指标异常告警，按优先级排序，一键标记为已处理。',
    path: '/admin/alerts',
    color: 'border-red-200 bg-red-50/50',
  },
  {
    icon: <TrophyOutlined className="text-5xl text-amber-500" />,
    title: '荣誉墙',
    desc: '查看志愿者本周排行、荣誉记录，以及待审核的荣誉申请，统一进行评审管理。',
    path: '/admin/honor-wall',
    color: 'border-amber-200 bg-amber-50/50',
  },
  {
    icon: <RobotOutlined className="text-5xl text-sky-600" />,
    title: '智能陪聊配置',
    desc: '管理老人端智能陪聊的 Groq 大模型、语音转写 API 和 Edge TTS 朗读参数。',
    path: '/admin/ai-settings',
    color: 'border-sky-200 bg-sky-50/50',
  },
  {
    icon: <DashboardOutlined className="text-5xl text-blue-600" />,
    title: '任务大厅',
    desc: '查看平台公开的公益服务任务，了解各项任务的发布、接单和完成情况，便于统一管理。',
    path: '/task-hall',
    color: 'border-blue-200 bg-blue-50/50',
  },
]

export default function AdminHomePage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const orderedFeatures = orderHomeFeatures('admin', features, {
    isRoot: Boolean(session?.isRoot),
  })

  return (
    <div className="space-y-8">
      {/* Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-800 p-10 md:p-12 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-3 !text-3xl md:!text-4xl">
          平台管理中心
        </Typography.Title>
        <Typography.Paragraph className="!text-blue-100 !text-lg md:!text-xl !mb-0 max-w-2xl">
          欢迎回来。在这里您可以查看运营数据、管理用户、处理告警，全面掌控社区照护平台的运行状况。
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
