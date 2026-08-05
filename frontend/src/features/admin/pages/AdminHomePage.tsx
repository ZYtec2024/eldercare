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
    desc: '查看当前待调度及服务中的订单位置、志愿者路线、SOS优先级、候选队列、疲劳度及技能硬匹配评分。',
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
    <div className="role-home space-y-6 md:space-y-8">
      <div className="role-home-hero">
        <div className="role-home-kicker">社区运营中心</div>
        <Typography.Title level={1} className="!mb-3 !text-3xl md:!text-4xl !text-slate-900">
          平台管理中心
        </Typography.Title>
        <Typography.Paragraph className="!text-slate-600 !text-lg md:!text-xl !mb-0 max-w-2xl">
          欢迎回来。在这里您可以查看运营数据、管理用户、处理告警，全面掌控社区照护平台的运行状况。
        </Typography.Paragraph>
      </div>

      <div className="elder-trust-strip">
        {[
          ['区域调度', '订单、志愿者、路线统一看板'],
          ['风险处置', 'SOS 与健康异常分级处理'],
          ['运营分析', '用户、服务、荣誉数据沉淀'],
        ].map(([title, desc]) => (
          <div key={title} className="elder-trust-item">
            <div className="elder-trust-dot" />
            <div>
              <div className="elder-trust-title">{title}</div>
              <div className="elder-trust-desc">{desc}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="role-home-features">
        {orderedFeatures.map((f) => (
          <Card
            key={f.path}
            hoverable
            className="role-home-feature cursor-pointer"
            onClick={() => navigate(f.path)}
          >
            <div className="flex items-start gap-5">
              <div className="role-home-feature-icon">
                {f.icon}
              </div>
              <div className="flex-1 min-w-0">
                <Typography.Title level={3} className="!mb-1 !text-slate-800">
                  {f.title}
                </Typography.Title>
                <Typography.Paragraph className="!text-slate-600 !text-base !mb-0 leading-relaxed">
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
