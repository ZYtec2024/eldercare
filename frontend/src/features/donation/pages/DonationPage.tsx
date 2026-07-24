import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Result,
  Space,
  Tag,
  Typography,
} from 'antd'
import { AlipayCircleOutlined, HeartFilled, WechatOutlined } from '@ant-design/icons'
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

export default function DonationPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm<DonationForm>()
  const [preview, setPreview] = useState<DonationForm | null>(null)
  const [paying, setPaying] = useState(false)
  const [receipt, setReceipt] = useState<DonationRecord | null>(null)

  const confirmPayment = async () => {
    if (!preview) return
    setPaying(true)
    try {
      const response = await simulateDonation(preview)
      setReceipt(response.data)
      setPreview(null)
      message.success(response.message)
    } catch (error: any) {
      message.error(error?.message || '沙盘支付失败')
    } finally {
      setPaying(false)
    }
  }

  if (receipt) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-rose-50 via-white to-sky-50 p-4">
        <div className="mx-auto max-w-2xl pt-12">
          <Card className="!rounded-3xl shadow-xl">
            <Result
              status="success"
              icon={<HeartFilled className="text-rose-500" />}
              title="感谢您的爱心"
              subTitle={`沙盘支付 ¥${Number(receipt.amount).toFixed(2)} 已记录，总管理员现在可以看到这条信息。`}
              extra={[
                <Button type="primary" key="again" onClick={() => {
                  setReceipt(null)
                  form.resetFields()
                }}>再次模拟捐赠</Button>,
                <Link key="login" to="/login"><Button>返回登录</Button></Link>,
              ]}
            />
            <div className="mx-auto max-w-md rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
              <div>沙盘流水号：{receipt.transaction_no}</div>
              <div>支付渠道：{receipt.payment_method === 'wechat' ? '微信沙盘' : '支付宝沙盘'}</div>
              <div className="mt-2 text-xs text-slate-400">本功能仅用于系统演示，没有发生真实资金交易。</div>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-sky-50 p-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-rose-500 shadow-lg shadow-rose-200">
            <HeartFilled className="text-3xl text-white" />
          </div>
          <Typography.Title level={2} className="!mb-1">爱心捐款沙盘</Typography.Title>
          <Typography.Text type="secondary">每一份关爱，都让社区养老服务走得更远</Typography.Text>
        </div>
        <Alert
          className="!mb-5 !rounded-2xl"
          type="info"
          showIcon
          message="演示模式"
          description="微信与支付宝均为沙盘模拟，不生成真实二维码、不扣款；确认后只写入一条演示捐赠记录。"
        />
        <Card className="!rounded-3xl shadow-xl">
          <Form<DonationForm>
            form={form}
            layout="vertical"
            size="large"
            initialValues={{ amount: 50, paymentMethod: 'wechat' }}
            onFinish={setPreview}
          >
            <Form.Item label="捐赠金额">
              <Space wrap className="mb-3">
                {presetAmounts.map((amount) => (
                  <Button key={amount} onClick={() => form.setFieldValue('amount', amount)}>
                    ¥{amount}
                  </Button>
                ))}
              </Space>
              <Form.Item name="amount" noStyle rules={[{ required: true, message: '请输入捐赠金额' }]}>
                <InputNumber min={1} max={99999} precision={2} prefix="¥" className="!w-full" />
              </Form.Item>
            </Form.Item>
            <div className="grid gap-4 md:grid-cols-2">
              <Form.Item name="donorName" label="爱心姓名" rules={[{ required: true, message: '请填写姓名' }]}>
                <Input placeholder="可填写个人或团队名称" />
              </Form.Item>
              <Form.Item name="contact" label="联系方式（选填）">
                <Input placeholder="手机号或邮箱" />
              </Form.Item>
            </div>
            <Form.Item name="paymentMethod" label="沙盘支付方式" rules={[{ required: true }]}>
              <Radio.Group buttonStyle="solid">
                <Radio.Button value="wechat"><WechatOutlined /> 微信支付沙盘</Radio.Button>
                <Radio.Button value="alipay"><AlipayCircleOutlined /> 支付宝沙盘</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="message" label="爱心寄语（选填）">
              <Input.TextArea rows={3} maxLength={500} showCount placeholder="写一句对老人和志愿者的祝福" />
            </Form.Item>
            <Button type="primary" danger block htmlType="submit" className="!h-12 !font-semibold">
              <HeartFilled /> 进入沙盘支付
            </Button>
          </Form>
          <div className="mt-5 text-center"><Link to="/login">返回登录</Link></div>
        </Card>
      </div>

      <Modal
        open={Boolean(preview)}
        title="确认沙盘支付"
        onCancel={() => setPreview(null)}
        onOk={confirmPayment}
        confirmLoading={paying}
        okText="确认模拟支付"
        cancelText="返回修改"
      >
        <div className="py-2 text-center">
          <div className={`mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-3xl ${
            preview?.paymentMethod === 'wechat' ? 'bg-emerald-500' : 'bg-blue-500'
          }`}>
            {preview?.paymentMethod === 'wechat'
              ? <WechatOutlined className="text-5xl text-white" />
              : <AlipayCircleOutlined className="text-5xl text-white" />}
          </div>
          <Typography.Title level={2} className="!mb-1">¥{Number(preview?.amount || 0).toFixed(2)}</Typography.Title>
          <Tag color="orange">沙盘模拟 · 不会真实扣款</Tag>
          <Typography.Paragraph type="secondary" className="!mt-4">
            点击确认后，系统会生成演示流水并通知总管理员。
          </Typography.Paragraph>
        </div>
      </Modal>
    </div>
  )
}
