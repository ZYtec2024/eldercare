import { useState } from 'react'
import { Button, Card, Typography, App } from 'antd'
import { AlertOutlined, CheckCircleOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { triggerElderSos } from '@/services/adapters/elder-adapter'

export default function ElderSosPage() {
  const { session } = useSession()
  const { message, modal } = App.useApp()
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSos = () => {
    modal.confirm({
      title: '确认发送紧急求助？',
      content: '系统将立即通知您的家属和社区管理员',
      okText: '确认发送',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true)
        try {
          await triggerElderSos(session?.userId)
          message.success('紧急求助已发送，家属和社区会尽快联系您')
          setSent(true)
        } catch (err: any) {
          message.error(err?.message || '发送失败，请重试')
        } finally {
          setLoading(false)
        }
      },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">紧急求助</Typography.Title>
        <Typography.Text className="text-gray-500 text-lg">如果您需要帮助，请按下方按钮</Typography.Text>
      </div>

      <Card className="!rounded-2xl !border-red-200 !bg-red-50">
        <div className="text-center py-8">
          {sent ? (
            <>
              <CheckCircleOutlined className="text-7xl text-green-500 mb-6" />
              <Typography.Title level={2} className="!text-green-700 !mb-2">
                求助已发送
              </Typography.Title>
              <Typography.Paragraph className="text-green-600 text-lg max-w-md mx-auto">
                您的家属和社区管理员已收到通知，请保持电话畅通，等待联系。
              </Typography.Paragraph>
              <Button size="large" className="!mt-4" onClick={() => setSent(false)}>
                再次求助
              </Button>
            </>
          ) : (
            <>
              <AlertOutlined className="text-7xl text-red-500 mb-6" />
              <Typography.Title level={2} className="!text-red-700 !mb-2">
                需要帮助吗？
              </Typography.Title>
              <Typography.Paragraph className="text-red-600 text-lg max-w-md mx-auto">
                按下按钮后，系统会立即通知您的家属和社区管理员前来帮助。
              </Typography.Paragraph>
              <Button
                danger
                type="primary"
                size="large"
                loading={loading}
                onClick={handleSos}
                className="!mt-4 !min-w-[280px] !h-20 !text-2xl !font-bold !rounded-2xl"
              >
                立即发送 SOS
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
