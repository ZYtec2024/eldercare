import { Card, Typography } from 'antd'
import {
  DashboardOutlined,
  HeartOutlined,
  MedicineBoxOutlined,
  AlertOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'

const features = [
  {
    icon: <HeartOutlined className="text-5xl text-blue-600" />,
    title: '健康打卡',
    desc: '每日记录血压、血氧、血糖、体温、体重、心率等健康数据，系统自动生成趋势图表，异常指标会及时提醒家属和社区。',
    path: '/elder/checkin',
    color: 'border-blue-200 bg-blue-50/50',
  },
  {
    icon: <MedicineBoxOutlined className="text-5xl text-sky-600" />,
    title: '我的服务',
    desc: '查看家属为您安排的服务（陪诊、上门陪聊等），了解服务时间、志愿者信息和当前进度，服务完成后可以为志愿者点赞。',
    path: '/elder/services',
    color: 'border-sky-200 bg-sky-50/50',
  },
  {
    icon: <AlertOutlined className="text-5xl text-red-500" />,
    title: '紧急求助',
    desc: '遇到突发状况时一键发送 SOS 求助信号，系统会立即通知家属和社区管理员，确保第一时间获得帮助。',
    path: '/elder/sos',
    color: 'border-red-200 bg-red-50/50',
  },
  {
    icon: <DashboardOutlined className="text-5xl text-blue-600" />,
    title: '任务大厅',
    desc: '查看社区公益服务任务，了解最新服务安排和志愿者接单情况，也可以随时浏览平台公开任务。',
    path: '/task-hall',
    color: 'border-blue-200 bg-blue-50/50',
  },
]

export default function ElderDashboardPage() {
  const navigate = useNavigate()
  const { session } = useSession()

  return (
    <div className="space-y-8">
      {/* Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-800 p-10 md:p-12 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-3 !text-3xl md:!text-4xl">
          您好，{session?.displayName}
        </Typography.Title>
        <Typography.Paragraph className="!text-blue-100 !text-lg md:!text-xl !mb-0 max-w-2xl">
          欢迎使用智慧伴老平台。您可以在这里进行每日健康打卡、查看服务安排、以及在紧急情况下一键求助。
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
