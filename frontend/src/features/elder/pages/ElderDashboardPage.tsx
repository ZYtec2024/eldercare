import { useEffect, useState } from 'react'
import { Alert, Button, Card, Typography } from 'antd'
import {
  AimOutlined,
  HeartOutlined,
  MedicineBoxOutlined,
  AlertOutlined,
  MessageOutlined,
  SoundOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  orderHomeFeatures,
  type HomeFeatureItem,
} from '@/features/shared/order-home-features'
import { fetchPendingServices } from '@/services/adapters/elder-adapter'
import type { PendingService } from '@/types/domain'
import { proxyActorName, proxyOrderAlertTitle } from '@/features/elder/proxy-order-labels'

const features: HomeFeatureItem[] = [
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
  {
    icon: <SoundOutlined className="text-5xl text-teal-600" />,
    title: '智能陪聊',
    desc: '按一下录音键就能和助手聊天，还可以把回复读给您听。',
    path: '/elder/companion',
    color: 'border-teal-200 bg-teal-50/50',
  },
  {
    icon: <FileTextOutlined className="text-5xl text-violet-600" />,
    title: '智能周报',
    desc: 'AI 自动帮您总结近7天的健康变化和服务情况。',
    path: '/elder/weekly-report',
    color: 'border-violet-200 bg-violet-50/50',
  },
]

export default function ElderDashboardPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const [proxyOrders, setProxyOrders] = useState<PendingService[]>([])
  const orderedFeatures = orderHomeFeatures('elder', features)

  useEffect(() => {
    if (!session) return
    const load = () => {
      fetchPendingServices(session.userId)
        .then((list) => {
          setProxyOrders(list.filter((item) => item.isProxy && ['pending', 'accepted', 'in_progress'].includes(item.status)))
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  return (
    <div className="role-home elder-commercial-page space-y-6 md:space-y-8">
      <div className="elder-commercial-hero">
        <div className="elder-commercial-hero-copy">
          <div className="role-home-kicker">银龄智配 · 长辈服务台</div>
          <Typography.Title level={1} className="!mb-2 !text-3xl md:!text-4xl !text-slate-950">
            {session?.displayName}，今天需要什么帮助？
          </Typography.Title>
          <Typography.Paragraph className="!text-slate-600 !text-base md:!text-lg !mb-0 max-w-2xl">
            常用服务放在下面。身体不舒服或遇到危险，请直接点红色按钮。
          </Typography.Paragraph>
        </div>
        <Button
          danger
          type="primary"
          size="large"
          icon={<AlertOutlined />}
          className="elder-sos-primary-btn"
          onClick={() => navigate('/elder/sos')}
        >
          紧急求助
        </Button>
      </div>

      <div className="elder-trust-strip">
        {[
          ['家人可见', '服务进度会同步给家属'],
          ['社区响应', '异常情况可联系管理员'],
          ['位置分离', '实时位置和订单地址分开保护'],
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

      {proxyOrders.length ? (
        <Alert
          showIcon
          type="warning"
          message={proxyOrderAlertTitle(proxyOrders.map((item) => item.proxyCreatorRole))}
          description={(
            <div className="space-y-2">
              <div>
                {proxyOrders.slice(0, 3).map((item) => (
                  `${proxyActorName(item.proxyCreatorName, item.proxyCreatorRole)} · ${item.serviceType}`
                )).join('；')}
              </div>
              <Button size="small" type="link" className="!px-0" onClick={() => navigate('/elder/services')}>
                去「谁在帮我」查看
              </Button>
            </div>
          )}
        />
      ) : null}

      <div className="elder-feature-grid">
        {orderedFeatures.map((f) => (
          <Card
            key={f.path}
            hoverable
            className="elder-feature-card cursor-pointer"
            onClick={() => navigate(f.path)}
          >
            <div className="flex items-start gap-4">
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
