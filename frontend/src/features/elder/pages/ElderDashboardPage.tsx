import { Button, Card, Typography } from 'antd'
import {
  AimOutlined,
  HeartOutlined,
  MedicineBoxOutlined,
  AlertOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'

const features = [
  {
    icon: <HeartOutlined className="text-5xl text-blue-600" />,
    title: '健康打卡',
    desc: '记录今天的血压、血糖等身体情况，家人也能看到。',
    path: '/elder/checkin',
    color: 'border-blue-200 bg-blue-50/50',
  },
  {
    icon: <AimOutlined className="text-5xl text-indigo-600" />,
    title: '请人帮忙',
    desc: '需要陪诊、买药、聊天时，告诉系统要什么帮助，会帮您找志愿者。',
    path: '/elder/dispatch',
    color: 'border-indigo-200 bg-indigo-50/50',
  },
  {
    icon: <MedicineBoxOutlined className="text-5xl text-sky-600" />,
    title: '谁在帮我',
    desc: '查看已经安排好的帮助：谁来、什么时候、做到哪一步了。',
    path: '/elder/services',
    color: 'border-sky-200 bg-sky-50/50',
  },
  {
    icon: <MessageOutlined className="text-5xl text-emerald-600" />,
    title: '我的消息',
    desc: '和家人、社区、志愿者说话，都在这里。',
    path: '/conversations',
    color: 'border-emerald-200 bg-emerald-50/50',
  },
]

export default function ElderDashboardPage() {
  const navigate = useNavigate()
  const { session } = useSession()

  return (
    <div className="space-y-8">
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-800 p-8 md:p-10 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-2 !text-3xl md:!text-4xl">
          您好，{session?.displayName}
        </Typography.Title>
        <Typography.Paragraph className="!text-blue-100 !text-lg !mb-6 max-w-2xl">
          有事找家人、找志愿者，或先做今天的健康打卡。着急时请用下面的红色按钮。
        </Typography.Paragraph>
        <Button
          danger
          type="primary"
          size="large"
          icon={<AlertOutlined />}
          className="!h-14 !px-8 !text-xl !font-semibold"
          onClick={() => navigate('/elder/sos')}
        >
          我需要紧急帮助
        </Button>
      </div>

      <div className="space-y-4">
        {features.map((f) => (
          <Card
            key={f.path}
            hoverable
            className={`!rounded-2xl !border-2 ${f.color} cursor-pointer transition-shadow`}
            onClick={() => navigate(f.path)}
          >
            <div className="flex items-start gap-5 py-1">
              <div className="flex-shrink-0 w-16 h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center">
                {f.icon}
              </div>
              <div className="flex-1 min-w-0">
                <Typography.Title level={3} className="!mb-1 !text-gray-800">
                  {f.title}
                </Typography.Title>
                <Typography.Paragraph className="!text-gray-600 !text-base !mb-0 leading-relaxed">
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
