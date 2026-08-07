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
      width="min(1120px, 96vw)"
      className="onboarding-guide-modal"
      style={{ top: 25 }}
      styles={{ body: { maxHeight: 'min(72vh, 760px)', overflowY: 'auto', paddingTop: 12 } }}
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
        <div className="flex items-center gap-2 text-base md:text-lg font-semibold text-gray-800 border-b border-slate-100 pb-3">
          <span>新手使用引导</span>
          <span className="text-xs font-normal px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
            {currentStep + 1} / {steps.length}
          </span>
        </div>
      }
    >
      <div className="onboarding-guide-body flex flex-col md:flex-row gap-4 md:gap-6 my-1 md:min-h-[520px] min-h-0">
        {/* 左侧步骤导航：桌面竖排，手机紧凑横滑 */}
        <div className="onboarding-guide-steps w-full md:w-72 shrink-0 rounded-xl border border-slate-100 bg-white p-3 md:bg-slate-50 md:p-5">
          <Steps
            direction="vertical"
            current={currentStep}
            size="small"
            onChange={(step) => setCurrentStep(step)}
            className="onboarding-guide-steps-list [&_.ant-steps-item]:cursor-pointer"
            items={steps.map((s) => ({
              title: (
                <span className="font-medium text-sm text-slate-700">
                  {s.icon} {s.title}
                </span>
              ),
            }))}
          />
        </div>

        {current && (
          <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-4 md:p-6">
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <Typography.Title level={4} className="!mb-0 !text-base md:!text-xl text-slate-800 flex items-center gap-2">
                  <span className="text-xl md:text-2xl">{current.icon}</span>
                  <span>{current.title}</span>
                </Typography.Title>
                {current.ctaPath && (
                  <Button
                    type="primary"
                    ghost
                    size="small"
                    className="font-medium md:!h-8"
                    onClick={() => {
                      handleClose()
                      navigate(current.ctaPath!)
                    }}
                  >
                    前往体验
                  </Button>
                )}
              </div>

              <Typography.Paragraph className="!mb-4 text-slate-700 text-sm md:text-base leading-relaxed bg-blue-50/50 p-3 md:p-4 rounded-xl border border-blue-100/60">
                {current.description}
              </Typography.Paragraph>

              {hasValidImage && (
                <div className="mt-2 flex w-full items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-900 p-1 shadow-sm">
                  <Image
                    src={current.image}
                    alt={current.title}
                    className="onboarding-guide-image w-full rounded-lg object-contain"
                    onError={() => {
                      if (current.image) {
                        setImgErrorMap((prev) => ({ ...prev, [current.image!]: true }))
                      }
                    }}
                    preview={{
                      mask: <div className="text-sm text-white flex items-center gap-1.5 font-medium">点击查看高清标注全图</div>,
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
