import { useState } from 'react'
import { Button, Card, Form, Input, Typography, App } from 'antd'
import { Link, useNavigate } from 'react-router-dom'

import { resetPassword } from '@/services/adapters/auth-adapter'

export default function ForgotPasswordPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)

  const onFinish = async (values: { username: string; phone: string; email: string; newPassword: string }) => {
    setLoading(true)
    try {
      await resetPassword(values)
      message.success('密码已重置，请使用新密码登录')
      navigate('/login')
    } catch (err: any) {
      message.error(err?.message || '重置失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Typography.Title level={2} className="!mb-1 !text-gray-800">
            找回密码
          </Typography.Title>
          <Typography.Text className="text-gray-500">
            通过用户名、手机号和预留邮箱核对身份
          </Typography.Text>
        </div>

        <Card className="shadow-lg !rounded-2xl border-0">
          <Form layout="vertical" onFinish={onFinish} size="large" autoComplete="off">
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input placeholder="请输入注册时的用户名" />
            </Form.Item>
            <Form.Item
              name="phone"
              label="手机号"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^\d{11}$/, message: '请输入11位手机号' },
              ]}
            >
              <Input placeholder="请输入注册时的手机号" maxLength={11} />
            </Form.Item>
            <Form.Item
              name="email"
              label="预留邮箱"
              rules={[
                { required: true, message: '请输入预留邮箱' },
                { type: 'email', message: '请输入正确的邮箱地址' },
              ]}
            >
              <Input placeholder="请输入注册时的邮箱" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 8, message: '密码至少8位' },
                { pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, message: '密码必须同时包含字母和数字' },
              ]}
            >
              <Input.Password placeholder="请输入新密码" />
            </Form.Item>
            <Form.Item className="!mb-3">
              <Button type="primary" htmlType="submit" block loading={loading} className="!h-11 !font-semibold">
                重置密码
              </Button>
            </Form.Item>
          </Form>
          <div className="text-center text-sm">
            <Link to="/login" className="text-blue-600 hover:text-blue-700">
              返回登录
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}
