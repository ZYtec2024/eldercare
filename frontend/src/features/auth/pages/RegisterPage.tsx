import { useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Select, Typography, App } from 'antd'
import { Link, useNavigate } from 'react-router-dom'

import { registerAccount } from '@/services/adapters/auth-adapter'
import type { Role } from '@/types/domain'

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

const roleOptions = [
  { value: 'family', label: '家属' },
  { value: 'elder', label: '老人' },
  { value: 'volunteer', label: '志愿者' },
  { value: 'admin', label: '管理员' },
]

export default function RegisterPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [selectedRole, setSelectedRole] = useState<Role>('family')

  const onFinish = async (values: any) => {
    setLoading(true)
    try {
      await registerAccount({
        username: values.username,
        password: values.password,
        role: values.role,
        realName: values.realName,
        phone: values.phone,
        email: values.email,
        age: values.age ? Number(values.age) : undefined,
        gender: values.gender,
        address: values.address,
        idCard: values.idCard,
        skills: values.skills,
        inviteCode: values.inviteCode,
      })
      message.success('注册成功！请登录')
      navigate('/login')
    } catch (err: any) {
      message.error(err?.message || '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-sky-50 p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <ElderLogo className="w-8 h-8 text-white" />
          </div>
          <Typography.Title level={2} className="!mb-1 !text-gray-800">
            注册账号
          </Typography.Title>
          <Typography.Text className="text-gray-500">
            选择您的角色，加入智慧伴老平台
          </Typography.Text>
        </div>

        <Card className="shadow-lg !rounded-2xl border-0">
          <Form layout="vertical" onFinish={onFinish} size="large" autoComplete="off" initialValues={{ role: 'family' }}>
            <Form.Item name="role" label="注册角色" rules={[{ required: true }]}>
              <Select options={roleOptions} onChange={(v) => setSelectedRole(v as Role)} />
            </Form.Item>

            <div className="grid grid-cols-2 gap-x-4">
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="请输入用户名" />
              </Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password placeholder="请输入密码" />
              </Form.Item>
            </div>

            <div className="grid grid-cols-2 gap-x-4">
              <Form.Item name="realName" label="真实姓名" rules={[{ required: true, message: '请输入姓名' }]}>
                <Input placeholder="请输入真实姓名" />
              </Form.Item>
              <Form.Item
                name="phone"
                label="手机号"
                rules={[
                  { required: true, message: '请输入手机号' },
                  { pattern: /^\d{11}$/, message: '请输入11位手机号' },
                ]}
              >
                <Input placeholder="请输入手机号" maxLength={11} />
              </Form.Item>
            </div>

            <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
              <Input placeholder="请输入邮箱" />
            </Form.Item>

            {selectedRole === 'elder' && (
              <>
                <div className="grid grid-cols-3 gap-x-4">
                  <Form.Item
                    name="age"
                    label="年龄"
                    rules={[
                      { required: true, message: '请输入年龄' },
                      { type: 'number', min: 0, message: '年龄不能为负数' },
                    ]}
                  >
                    <InputNumber min={0} precision={0} className="!w-full" placeholder="年龄" />
                  </Form.Item>
                  <Form.Item name="gender" label="性别" rules={[{ required: true, message: '请选择性别' }]}>
                    <Select options={[{ value: '男', label: '男' }, { value: '女', label: '女' }]} placeholder="性别" />
                  </Form.Item>
                  <Form.Item name="address" label="住址" rules={[{ required: true, message: '请输入住址' }]}>
                    <Input placeholder="住址" />
                  </Form.Item>
                </div>
              </>
            )}

            {selectedRole === 'volunteer' && (
              <>
                <Form.Item
                  name="idCard"
                  label="身份证号"
                  rules={[
                    { required: true, message: '请输入身份证号' },
                    { pattern: /^\d{17}[\dXx]$/, message: '请输入18位身份证号' },
                  ]}
                >
                  <Input placeholder="请输入身份证号" maxLength={18} />
                </Form.Item>
                <Form.Item name="skills" label="技能特长" rules={[{ required: true, message: '请输入技能特长' }]}>
                  <Input placeholder="如：会理发、懂急救" />
                </Form.Item>
              </>
            )}

            {selectedRole === 'admin' && (
              <Form.Item name="inviteCode" label="管理员邀请码" rules={[{ required: true, message: '请输入邀请码' }]}>
                <Input placeholder="请输入邀请码" />
              </Form.Item>
            )}

            <Form.Item className="!mb-3">
              <Button type="primary" htmlType="submit" block loading={loading} className="!h-11 !font-semibold">
                注册
              </Button>
            </Form.Item>
          </Form>
          <div className="text-center text-sm">
            <Link to="/login" className="text-blue-600 hover:text-blue-700">
              已有账号？去登录
            </Link>
          </div>
        </Card>

        <div className="text-center mt-6">
          <Link to="/" className="text-gray-400 text-sm hover:text-gray-600">返回首页</Link>
        </div>
      </div>
    </div>
  )
}
