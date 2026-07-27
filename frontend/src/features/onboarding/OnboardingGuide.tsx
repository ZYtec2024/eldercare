import { useState } from 'react'
import { Modal, Steps, Button, Checkbox, Typography, Image } from 'antd'
import { useNavigate } from 'react-router-dom'

import type { Role } from '@/types/domain'
import { onboardingContent } from './onboarding-content'

interface OnboardingGuideProps {
  open: boolean
  role: Role
  onClose: () => void
  onDontShowAgain: () => void
}

export default function OnboardingGuide({ open, role, onClose, onDontShowAgain }: OnboardingGuideProps) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [imgErrorMap, setImgErrorMap] = useState<Record<string, boolean>>({})

  const steps = onboardingContent[role] ?? []
  const isLastStep = currentStep === steps.length - 1

  const handleNext = () => {
    if (isLastStep) {
      if (dontShowAgain) {
        onDontShowAgain()
      }
      setCurrentStep(0)
      setDontShowAgain(false)
      onClose()
    } else {
      setCurrentStep(currentStep + 1)
    }
  }

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleClose = () => {
    if (dontShowAgain) {
      onDontShowAgain()
    }
    setCurrentStep(0)
    setDontShowAgain(false)
    onClose()
  }

  const current = steps[currentStep]
  const hasValidImage = current?.image && !imgErrorMap[current.image]

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      width={1120}
      style={{ top: 25 }}
      footer={[
        <Checkbox
          key="dont-show"
          checked={dontShowAgain}
          onChange={(e) => setDontShowAgain(e.target.checked)}
          className="float-left mt-1 text-slate-600"
        >
          不再主动弹窗
        </Checkbox>,
        <Button key="prev" onClick={handlePrev} disabled={currentStep === 0}>
          上一步
        </Button>,
        isLastStep ? (
          <Button key="done" type="primary" onClick={handleNext}>
            完成使用引导
          </Button>
        ) : (
          <Button key="next" type="primary" onClick={handleNext}>
            下一步
          </Button>
        ),
      ]}
      title={
        <div className="flex items-center gap-2 text-lg font-semibold text-gray-800 border-b border-slate-100 pb-3">
          <span>💡 新手使用引导</span>
          <span className="text-xs font-normal px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
            {currentStep + 1} / {steps.length}
          </span>
        </div>
      }
    >
      <div className="flex flex-col md:flex-row gap-6 my-2 min-h-[520px]">
        {/* 左侧步骤导航 */}
        <div className="w-full md:w-72 shrink-0 bg-slate-50 rounded-xl p-5 border border-slate-100 flex flex-col justify-between">
          <Steps
            direction="vertical"
            current={currentStep}
            size="small"
            onChange={(step) => setCurrentStep(step)}
            className="[&_.ant-steps-item]:cursor-pointer"
            items={steps.map((s) => ({
              title: (
                <span className="font-medium text-sm text-slate-700">
                  {s.icon} {s.title}
                </span>
              ),
            }))}
          />
        </div>

        {/* 右侧图文/纯文本指引内容 */}
        {current && (
          <div className="flex-1 flex flex-col justify-between rounded-xl bg-white border border-gray-100 p-6 shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-3">
                <Typography.Title level={4} className="!mb-0 text-slate-800 flex items-center gap-2">
                  <span className="text-2xl">{current.icon}</span>
                  <span>{current.title}</span>
                </Typography.Title>
                {current.ctaPath && (
                  <Button
                    type="primary"
                    ghost
                    size="middle"
                    className="font-medium"
                    onClick={() => {
                      handleClose()
                      navigate(current.ctaPath!)
                    }}
                  >
                    前往体验 →
                  </Button>
                )}
              </div>

              {/* 详细文本描述（彻底无遮挡、无简写） */}
              <Typography.Paragraph className="!mb-5 text-slate-700 text-base leading-relaxed bg-blue-50/50 p-4 rounded-xl border border-blue-100/60">
                {current.description}
              </Typography.Paragraph>

              {/* 高清标注图展示区域（仅在有有效图片且未加载失败时渲染，彻底无任何无图片占位框） */}
              {hasValidImage && (
                <div className="w-full rounded-xl overflow-hidden border border-slate-200 bg-slate-900 flex items-center justify-center p-1.5 shadow-sm mt-3">
                  <Image
                    src={current.image}
                    alt={current.title}
                    className="w-full object-contain max-h-[460px] rounded-lg"
                    onError={() => {
                      if (current.image) {
                        setImgErrorMap((prev) => ({ ...prev, [current.image!]: true }))
                      }
                    }}
                    preview={{
                      mask: <div className="text-sm text-white flex items-center gap-1.5 font-medium">🔍 点击查看高清标注全图</div>,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
