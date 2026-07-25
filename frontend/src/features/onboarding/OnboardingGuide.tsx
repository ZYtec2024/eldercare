import { useState } from 'react'
import { Modal, Steps, Button, Checkbox, Typography } from 'antd'
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

  const steps = onboardingContent[role] ?? []
  const isLastStep = currentStep === steps.length - 1

  const handleNext = () => {
    if (isLastStep) {
      // 完成
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

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      width={520}
      footer={[
        <Checkbox
          key="dont-show"
          checked={dontShowAgain}
          onChange={(e) => setDontShowAgain(e.target.checked)}
          className="float-left"
        >
          不再主动弹窗
        </Checkbox>,
        <Button key="prev" onClick={handlePrev} disabled={currentStep === 0}>
          上一步
        </Button>,
        isLastStep ? (
          <Button key="done" type="primary" onClick={handleNext}>
            完成
          </Button>
        ) : (
          <Button key="next" type="primary" onClick={handleNext}>
            下一步
          </Button>
        ),
      ]}
      title="新手引导"
    >
      <Steps
        direction="vertical"
        current={currentStep}
        size="small"
        className="mb-4"
        items={steps.map((s) => ({
          title: `${s.icon} ${s.title}`,
        }))}
      />
      {current && (
        <div className="rounded-xl bg-slate-50 p-4">
          <Typography.Title level={5} className="!mb-2">
            {current.icon} {current.title}
          </Typography.Title>
          <Typography.Paragraph className="!mb-0 text-gray-600">
            {current.description}
          </Typography.Paragraph>
          {current.ctaPath && (
            <Button
              type="link"
              size="small"
              className="!px-0 mt-2"
              onClick={() => {
                handleClose()
                navigate(current.ctaPath!)
              }}
            >
              前往体验 →
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}
