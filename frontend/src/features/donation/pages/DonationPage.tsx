import { useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Radio,
  Result,
  Space,
  Tag,
  Typography,
} from 'antd'
import { AlipayCircleOutlined, WechatOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'

import { simulateDonation, type DonationRecord } from '@/services/adapters/donation-adapter'

type DonationForm = {
  donorName: string
  contact?: string
  amount: number
  paymentMethod: 'wechat' | 'alipay'
  message?: string
}

const presetAmounts = [20, 50, 100, 200]

const QR_SOURCES = {
  wechat: '/donate/wechat-qr.png',
  alipay: '/donate/alipay-qr.png',
} as const

export default function DonationPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm<DonationForm>()
  const [paymentMethod, setPaymentMethod] = useState<'wechat' | 'alipay'>('wechat')
  const [amount, setAmount] = useState(50)
  const [qrBroken, setQrBroken] = useState<Record<string, boolean>>({})
  const [recording, setRecording] = useState(false)
  const [receipt, setReceipt] = useState<DonationRecord | null>(null)

  const qrSrc = QR_SOURCES[paymentMethod]
  const hasQr = !qrBroken[paymentMethod]

  const methodLabel = useMemo(
    () => (paymentMethod === 'wechat' ? '微信收款码' : '支付宝收款码'),
    [paymentMethod],
  )

  const recordSupport = async (values: DonationForm) => {
    setRecording(true)
    try {
      const response = await simulateDonation(values)
      setReceipt(response.data)
      message.success('感谢支持！已为管理员留下捐助记录。')
    } catch (error: any) {
      message.error(error?.message || '记录失败，请稍后再试')
    } finally {
      setRecording(false)
    }
  }

  if (receipt) {
    return (
      <div className="donate-page min-h-screen p-4">
        <div className="mx-auto max-w-2xl pt-12">
          <Card className="donate-card !rounded-3xl">
            <Result
              status="success"
              title="谢谢您的支持"
              subTitle={`已记录意向金额 ¥${Number(receipt.amount).toFixed(2)}。若已完成扫码支付，工作人员会尽快核对。`}
              extra={[
                <Button
                  type="primary"
                  key="again"
                  className="!bg-sky-600 hover:!bg-sky-700"
                  onClick={() => {
                    setReceipt(null)
                    form.resetFields()
                  }}
                >
                  继续支持
                </Button>,
                <Link key="login" to="/login"><Button>返回登录</Button></Link>,
              ]}
            />
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="donate-page min-h-screen p-4 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 text-center">
          <Typography.Title level={2} className="!mb-2 !text-slate-800">爱心捐助</Typography.Title>
          <Typography.Paragraph className="mx-auto max-w-xl !mb-0 text-base text-slate-500">
            守护身边的银发笑容。请选择金额后扫码完成支付。
          </Typography.Paragraph>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <Card className="donate-card !rounded-3xl">
            <Form<DonationForm>
              form={form}
              layout="vertical"
              size="large"
              initialValues={{ amount: 50, paymentMethod: 'wechat', donorName: '爱心人士' }}
              onValuesChange={(_, all) => {
                if (all.paymentMethod) setPaymentMethod(all.paymentMethod)
                if (typeof all.amount === 'number') setAmount(all.amount)
              }}
              onFinish={(values) => void recordSupport(values)}
            >
              <Form.Item label="支持金额">
                <Space wrap className="mb-3">
                  {presetAmounts.map((value) => (
                    <Button
                      key={value}
                      className={amount === value ? 'donate-amount-active' : 'donate-amount-btn'}
                      onClick={() => {
                        form.setFieldValue('amount', value)
                        setAmount(value)
                      }}
                    >
                      ¥{value}
                    </Button>
                  ))}
                </Space>
                <Form.Item name="amount" noStyle rules={[{ required: true, message: '请输入捐赠金额' }]}>
                  <InputNumber min={1} max={99999} precision={2} prefix="¥" className="!w-full" />
                </Form.Item>
              </Form.Item>

              <Form.Item name="paymentMethod" label="支付方式" rules={[{ required: true }]}>
                <Radio.Group buttonStyle="solid" className="donate-pay-method">
                  <Radio.Button value="wechat"><WechatOutlined /> 微信支付</Radio.Button>
                  <Radio.Button value="alipay"><AlipayCircleOutlined /> 支付宝</Radio.Button>
                </Radio.Group>
              </Form.Item>

              <div className="grid gap-4 md:grid-cols-2">
                <Form.Item name="donorName" label="爱心署名" rules={[{ required: true, message: '请填写署名' }]}>
                  <Input placeholder="可填写个人或团队名称" />
                </Form.Item>
                <Form.Item name="contact" label="联系方式（选填）">
                  <Input placeholder="手机号或邮箱" />
                </Form.Item>
              </div>

              <Form.Item name="message" label="寄语（选填）">
                <Input.TextArea rows={3} maxLength={500} showCount placeholder="写一句对老人和志愿者的祝福" />
              </Form.Item>

              <Button
                type="primary"
                block
                htmlType="submit"
                loading={recording}
                className="!h-12 !border-0 !bg-sky-600 !font-semibold hover:!bg-sky-700"
              >
                我已扫码支持，留下记录
              </Button>
              <div className="mt-3 text-center text-xs text-slate-400">
                请先扫收款码完成支付，再点上方按钮留下记录。
              </div>
            </Form>
          </Card>

          <Card className="donate-card donate-qr-card !rounded-3xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Typography.Title level={4} className="!mb-0 !text-slate-800">{methodLabel}</Typography.Title>
              <Tag color="blue">建议 ¥{Number(amount || 0).toFixed(2)}</Tag>
            </div>

            <div className="donate-qr-frame">
              {hasQr ? (
                <img
                  src={qrSrc}
                  alt={methodLabel}
                  className={`donate-qr-image ${paymentMethod === 'alipay' ? 'donate-qr-image--alipay' : 'donate-qr-image--wechat'}`}
                  onError={() => setQrBroken((prev) => ({ ...prev, [paymentMethod]: true }))}
                />
              ) : (
                <div className="donate-qr-placeholder">
                  <div className="mb-2 text-3xl text-sky-600/80">
                    {paymentMethod === 'wechat' ? <WechatOutlined /> : <AlipayCircleOutlined />}
                  </div>
                  <div className="font-medium text-slate-700">收款码加载中</div>
                </div>
              )}
            </div>

            <div className="mt-4 text-center text-sm text-slate-500">
              打开{paymentMethod === 'wechat' ? '微信' : '支付宝'}扫一扫即可完成支付
            </div>
            <div className="mt-4 text-center"><Link to="/login" className="text-sky-700">返回登录</Link></div>
          </Card>
        </div>
      </div>
    </div>
  )
}
