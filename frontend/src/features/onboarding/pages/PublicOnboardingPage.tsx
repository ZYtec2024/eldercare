import { useMemo, useState } from 'react'
import { Button, Card, Steps, Tabs, Typography, Image } from 'antd'
import { ArrowLeftOutlined, BookOutlined } from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'

import { onboardingContent } from '@/features/onboarding/onboarding-content'
import type { Role } from '@/types/domain'
import { roleLabels } from '@/types/domain'

const guideRoles: Role[] = ['family', 'elder', 'volunteer', 'admin']

export default function PublicOnboardingPage() {
  const navigate = useNavigate()
  const [role, setRole] = useState<Role>('family')
  const [currentStep, setCurrentStep] = useState(0)
  const [imgErrorMap, setImgErrorMap] = useState<Record<string, boolean>>({})

  const steps = useMemo(() => onboardingContent[role] ?? [], [role])
  const current = steps[currentStep]
  const hasValidImage = current?.image && !imgErrorMap[current.image]
  const isLastStep = currentStep === steps.length - 1

  const switchRole = (next: Role) => {
    setRole(next)
    setCurrentStep(0)
  }

  return (
    <div className="auth-page public-guide-page min-h-screen p-4 md:p-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="role-home-kicker">注册前先了解</div>
            <Typography.Title level={2} className="!mb-1 !text-slate-900">
              <BookOutlined className="mr-2 text-sky-600" />
              新手指引
            </Typography.Title>
            <Typography.Text className="text-slate-500">
              先看看管理员、家属、志愿者、老人各自能做什么，再决定注册哪个角色。
            </Typography.Text>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/login')}>
              返回登录
            </Button>
            <Button type="primary" onClick={() => navigate('/register')}>
              去注册
            </Button>
          </div>
        </div>

        <Card className="!rounded-2xl !border-0 shadow-lg">
          <Tabs
            activeKey={role}
            onChange={(key) => switchRole(key as Role)}
            items={guideRoles.map((item) => ({
              key: item,
              label: roleLabels[item],
            }))}
          />

          <div className="flex flex-col gap-5 md:flex-row">
            <div className="w-full shrink-0 rounded-xl border border-slate-100 bg-slate-50 p-4 md:w-64">
              <Steps
                direction="vertical"
                size="small"
                current={currentStep}
                onChange={setCurrentStep}
                items={steps.map((step) => ({
                  title: (
                    <span className="text-sm font-medium text-slate-700">
                      {step.icon} {step.title}
                    </span>
                  ),
                }))}
              />
            </div>

            {current ? (
              <div className="min-w-0 flex-1 rounded-xl border border-slate-100 bg-white p-5">
                <Typography.Title level={4} className="!mb-3 flex items-center gap-2 !text-slate-800">
                  <span className="text-2xl">{current.icon}</span>
                  <span>{current.title}</span>
                </Typography.Title>
                <Typography.Paragraph className="!mb-4 rounded-xl border border-blue-100/60 bg-blue-50/50 p-4 text-base leading-relaxed text-slate-700">
                  {current.description}
                </Typography.Paragraph>
                {hasValidImage ? (
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-900 p-1.5">
                    <Image
                      src={current.image}
                      alt={current.title}
                      className="max-h-[420px] w-full rounded-lg object-contain"
                      onError={() => {
                        if (current.image) {
                          setImgErrorMap((prev) => ({ ...prev, [current.image!]: true }))
                        }
                      }}
                    />
                  </div>
                ) : null}
                <div className="mt-5 flex flex-wrap justify-between gap-2">
                  <Button disabled={currentStep === 0} onClick={() => setCurrentStep((value) => Math.max(0, value - 1))}>
                    上一步
                  </Button>
                  {isLastStep ? (
                    <Button type="primary" onClick={() => navigate('/register')}>
                      了解完毕，去注册
                    </Button>
                  ) : (
                    <Button type="primary" onClick={() => setCurrentStep((value) => Math.min(steps.length - 1, value + 1))}>
                      下一步
                    </Button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <div className="mt-5 text-center text-sm text-slate-400">
          <Link to="/" className="hover:text-slate-600">返回首页</Link>
          <span className="mx-2">·</span>
          <Link to="/login" className="hover:text-slate-600">已有账号去登录</Link>
        </div>
      </div>
    </div>
  )
}
