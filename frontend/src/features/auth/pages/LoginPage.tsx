import { useState } from 'react'
import { Button, Card, Form, Input, Typography, App } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { resolvePostLoginRoute } from '@/routes/role-defaults'

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

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, consumeRedirectPath } = useSession()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const session = await login(values)
      message.success(`欢迎回来，${session.displayName}`)
      const redirect = consumeRedirectPath()
      navigate(resolvePostLoginRoute(session.role, redirect), { replace: true })
    } catch (err: any) {
      message.error(err?.message || '登录失败，请检查用户名和密码')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="auth-logo w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
            <ElderLogo className="w-8 h-8 text-white" />
          </div>
          <Typography.Title level={2} className="!mb-1 !text-gray-800">
            欢迎登录
          </Typography.Title>
          <Typography.Text className="text-gray-500">
            银铃智配 · 社区照护平台
          </Typography.Text>
        </div>

        <Card className="shadow-lg !rounded-2xl border-0">
          <Form layout="vertical" onFinish={onFinish} size="large" autoComplete="off">
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input prefix={<UserOutlined className="text-gray-400" />} placeholder="请输入用户名" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password prefix={<LockOutlined className="text-gray-400" />} placeholder="请输入密码" />
            </Form.Item>
            <Form.Item className="!mb-3">
              <Button type="primary" htmlType="submit" block loading={loading} className="!h-11 !font-semibold">
                登录
              </Button>
            </Form.Item>
          </Form>
          <div className="flex justify-between text-sm">
            <Link to="/forgot-password" className="text-[#2563eb] hover:text-[#1d4ed8]">
              忘记密码？
            </Link>
            <Link to="/register" className="text-[#2563eb] hover:text-[#1d4ed8]">
              没有账号？去注册
            </Link>
          </div>
          <div className="mt-4 text-center">
            <Link to="/guide" className="text-sm font-medium text-sky-700 hover:text-sky-800">
              了解角色功能
            </Link>
          </div>
        </Card>

        <Link to="/donate" className="mt-5 block">
          <Button
            block
            size="large"
            className="donate-entry-btn !h-12 !rounded-2xl !border border-sky-200 !bg-sky-50 !text-sky-800 !shadow-none hover:!border-sky-300 hover:!bg-sky-100 hover:!text-sky-900"
          >
            守护银发，多一份安心
          </Button>
        </Link>

        <div className="text-center mt-6">
          <Link to="/" className="text-gray-400 text-sm hover:text-gray-600">
            返回首页
          </Link>
        </div>
      </div>
    </div>
  )
}
