import { Button, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { ArrowRightOutlined, LoginOutlined, ReadOutlined } from '@ant-design/icons'

function ElderLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="5" r="3" />
      <path d="M12 8v6" />
      <path d="M9 21l3-7 3 7" />
      <path d="M7.5 12.5C6 13.5 5 15 5 17" />
      <path d="M16.5 12.5C18 13.5 19 15 19 17" />
      <path d="M8 17h8" />
    </svg>
  )
}

export default function HomePage() {
  const navigate = useNavigate()

  return (
    <div className="public-home min-h-screen bg-[#f4f8ff]">
      {/* Top Bar */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#3b82f6] flex items-center justify-center shadow-sm">
            <ElderLogo className="w-6 h-6 text-white" />
          </div>
          <Typography.Text className="!text-lg !font-bold text-gray-900 block leading-tight">
            银铃智配
          </Typography.Text>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/login')} icon={<LoginOutlined />}>
            登录
          </Button>
          <Button type="primary" onClick={() => navigate('/register')}>
            免费注册
          </Button>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-12 md:py-20">
        <div className="public-home-hero p-8 md:p-14">
          <div className="role-home-kicker">社区智慧养老服务平台</div>
          <Typography.Title level={1} className="!text-slate-900 !text-3xl md:!text-5xl !font-extrabold !mb-4 !leading-tight">
            让每一位老人
            <br />
            都被温暖守护
          </Typography.Title>
          <Typography.Paragraph className="!text-slate-600 !text-base md:!text-lg max-w-xl !mb-8">
            家属远程监护、老人一键求助、志愿者爱心接单、社区统一管理 —— 四方协同，构建有温度的照护网络。
          </Typography.Paragraph>
          <div className="flex flex-wrap gap-3">
            <Button
              type="primary"
              size="large"
              className="!font-semibold"
              onClick={() => navigate('/register')}
            >
              立即加入
            </Button>
            <Button
              size="large"
              icon={<ArrowRightOutlined />}
              onClick={() => navigate('/task-hall')}
            >
              任务大厅
            </Button>
            <Button
              size="large"
              icon={<ReadOutlined />}
              onClick={() => navigate('/health-knowledge')}
            >
              健康知识手册
            </Button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-10">
            <div className="public-home-stat">
              <div className="text-3xl font-bold">350+</div>
              <div className="text-slate-500 text-sm mt-1">注册用户</div>
            </div>
            <div className="public-home-stat">
              <div className="text-3xl font-bold">1,200+</div>
              <div className="text-slate-500 text-sm mt-1">累计服务时长(小时)</div>
            </div>
            <div className="public-home-stat">
              <div className="text-3xl font-bold">98%</div>
              <div className="text-slate-500 text-sm mt-1">服务好评率</div>
            </div>
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 pb-12">
        <Typography.Title level={2} className="!text-center !mb-2 !text-gray-800">
          四方协同，全面守护
        </Typography.Title>
        <Typography.Paragraph className="text-center text-gray-500 mb-10 max-w-lg mx-auto">
          平台连接家属、老人、志愿者与社区管理员，形成完整的照护闭环
        </Typography.Paragraph>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[
            { icon: '👨\u200d👩\u200d👧', title: '家属端', desc: '远程绑定长辈、查看健康趋势、发布服务需求' },
            { icon: '👴', title: '老人端', desc: '每日健康打卡、查看服务安排、一键紧急求助' },
            { icon: '🦸', title: '志愿者端', desc: '浏览任务大厅、抢单服务、积累志愿时长与荣誉' },
            { icon: '🏛️', title: '管理员端', desc: '审核志愿者、处理告警、数据统计与运营管理' },
          ].map((item) => (
            <div
              key={item.title}
              className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="text-3xl mb-3">{item.icon}</div>
              <Typography.Title level={4} className="!mb-2 !text-gray-800">
                {item.title}
              </Typography.Title>
              <Typography.Text className="text-gray-500 text-sm">
                {item.desc}
              </Typography.Text>
            </div>
          ))}
        </div>
      </div>

      {/* Health Knowledge Teaser */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 pb-16">
        <div className="rounded-2xl bg-gradient-to-r from-blue-50 to-sky-50 border border-blue-100 p-8 md:p-12 text-center">
          <ReadOutlined className="text-5xl text-blue-500 mb-4" />
          <Typography.Title level={2} className="!mb-2 !text-gray-800">
            健康知识手册
          </Typography.Title>
          <Typography.Paragraph className="text-gray-500 mb-6 max-w-lg mx-auto">
            了解血压、血氧、血糖、体温、体重、心率六大健康指标的正常范围与日常护理要点
          </Typography.Paragraph>
          <Button
            type="primary"
            size="large"
            icon={<ArrowRightOutlined />}
            onClick={() => navigate('/health-knowledge')}
          >
            查看完整手册
          </Button>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-50 border-t border-gray-100 py-8 text-center">
        <Typography.Text className="text-gray-400 text-sm">
          银铃智配 · 社区照护平台
        </Typography.Text>
      </div>
    </div>
  )
}
