import { useEffect, useState } from 'react'
import { Card, Typography, Spin, Form, Input, Button, App, Descriptions, Tag, Divider, Space } from 'antd'
import { UserOutlined, EditOutlined, SaveOutlined, LockOutlined } from '@ant-design/icons'

import { fetchProfileInfo, updateProfileInfo } from '@/services/adapters/profile-adapter'
import { useSession } from '@/features/auth/useSession'
import type { ProfileSnapshot } from '@/types/domain'
import { roleLabels } from '@/types/domain'
import { changePassword } from '@/services/adapters/auth-adapter'
import { fetchDispatchTracking } from '@/services/adapters/dispatch-adapter'

const dispatchSkillLabels: Record<string, string> = {
  medical_support: '医疗陪护', emergency_response: '紧急响应', mobility_assist: '行动协助',
  errand: '代办采购', companion: '陪伴沟通', rehab: '康复训练',
  digital_assist: '智能设备协助', grooming: '生活照护',
}

export default function ProfilePage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [profile, setProfile] = useState<ProfileSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [changingPwd, setChangingPwd] = useState(false)
  const [pwdSaving, setPwdSaving] = useState(false)
  const [verifiedSkills, setVerifiedSkills] = useState<string[]>([])
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()

  useEffect(() => {
    if (!session) return
    fetchProfileInfo(session.userId, session.role)
      .then((p) => {
        setProfile(p)
        form.setFieldsValue(p)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    if (session.role === 'volunteer') {
      fetchDispatchTracking('volunteer', session.userId)
        .then((tracking) => setVerifiedSkills(tracking.volunteers[0]?.skills ?? []))
        .catch(() => setVerifiedSkills([]))
    } else {
      setVerifiedSkills([])
    }
  }, [session])

  const handleSave = async () => {
    if (!session || !profile) return
    setSaving(true)
    try {
      const values = await form.validateFields()
      await updateProfileInfo({
        userId: session.userId,
        role: session.role,
        ...values,
      })
      const latest = await fetchProfileInfo(session.userId, session.role)
      setProfile(latest)
      form.setFieldsValue(latest)
      setEditing(false)
      message.success('保存成功')
    } catch (err: any) {
      if (err?.message) message.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleChangePwd = async () => {
    if (!session) return
    setPwdSaving(true)
    try {
      const values = await pwdForm.validateFields()
      await changePassword({
        userId: session.userId,
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      })
      message.success('密码修改成功')
      setChangingPwd(false)
      pwdForm.resetFields()
    } catch (err: any) {
      message.error(err?.message || '密码修改失败')
    } finally {
      setPwdSaving(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spin size="large" /></div>
  if (!profile) return <Typography.Text>无法加载个人信息</Typography.Text>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={3} className="!mb-1">
            <UserOutlined className="mr-2" />个人信息
          </Typography.Title>
          <Typography.Text className="text-gray-500">查看和编辑您的账户信息</Typography.Text>
        </div>
        {!editing ? (
          <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>编辑</Button>
        ) : (
          <div className="flex gap-2">
            <Button onClick={() => { setEditing(false); form.setFieldsValue(profile) }}>取消</Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存</Button>
          </div>
        )}
      </div>

      {!editing ? (
        <Card className="!rounded-2xl">
          <Descriptions column={{ xs: 1, sm: 2 }} labelStyle={{ fontWeight: 600 }}>
            <Descriptions.Item label="姓名">{profile.realName}</Descriptions.Item>
            <Descriptions.Item label="角色">
              <Tag color="blue">{roleLabels[profile.role]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="手机">{profile.phone}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{profile.email || '-'}</Descriptions.Item>
            {profile.role === 'elder' && (
              <Descriptions.Item label="病史">{profile.medicalHistory || '无'}</Descriptions.Item>
            )}
            {profile.role === 'volunteer' && (
              <>
                <Descriptions.Item label="技能简介">{profile.skills || '-'}</Descriptions.Item>
                <Descriptions.Item label="调度认证技能" span={2}>
                  {verifiedSkills.length ? <Space wrap>{verifiedSkills.map((skill) => <Tag color="green" key={skill}>{dispatchSkillLabels[skill] ?? skill}</Tag>)}</Space> : <span className="text-slate-500">暂无认证技能，无法参与智能派单</span>}
                </Descriptions.Item>
                <Descriptions.Item label="总服务时长">{profile.totalHours ?? 0} 小时</Descriptions.Item>
                <Descriptions.Item label="获赞">{profile.likesCount ?? 0}</Descriptions.Item>
              </>
            )}
          </Descriptions>
        </Card>
      ) : (
        <Card className="!rounded-2xl">
          <Form form={form} layout="vertical" className="max-w-lg">
            <Form.Item label="姓名" name="realName" rules={[{ required: true, message: '请输入姓名' }]}>
              <Input />
            </Form.Item>
            <Form.Item
              label="手机"
              name="phone"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^\d{11}$/, message: '请输入11位手机号' },
              ]}
            >
              <Input maxLength={11} />
            </Form.Item>
            <Form.Item label="邮箱" name="email">
              <Input />
            </Form.Item>
            {profile.role === 'elder' && (
              <Form.Item label="病史" name="medicalHistory">
                <Input.TextArea rows={3} />
              </Form.Item>
            )}
            {profile.role === 'volunteer' && (
              <Form.Item label="技能" name="skills">
                <Input />
              </Form.Item>
            )}
          </Form>
        </Card>
      )}

      {/* Change Password */}
      <Card
        className="!rounded-2xl"
        title={<span><LockOutlined className="mr-2" />修改密码</span>}
        extra={
          !changingPwd ? (
            <Button onClick={() => setChangingPwd(true)}>修改密码</Button>
          ) : null
        }
      >
        {changingPwd ? (
          <Form form={pwdForm} layout="vertical" className="max-w-md">
            <Form.Item
              label="当前密码"
              name="oldPassword"
              rules={[{ required: true, message: '请输入当前密码' }]}
            >
              <Input.Password placeholder="请输入当前密码" />
            </Form.Item>
            <Form.Item
              label="新密码"
              name="newPassword"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 6, message: '密码至少6位' },
              ]}
            >
              <Input.Password placeholder="请输入新密码" />
            </Form.Item>
            <Form.Item
              label="确认新密码"
              name="confirmPassword"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请确认新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) {
                      return Promise.resolve()
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password placeholder="请再次输入新密码" />
            </Form.Item>
            <div className="flex gap-3">
              <Button type="primary" loading={pwdSaving} onClick={handleChangePwd}>确认修改</Button>
              <Button onClick={() => { setChangingPwd(false); pwdForm.resetFields() }}>取消</Button>
            </div>
          </Form>
        ) : (
          <Typography.Text className="text-gray-500">点击右上角按钮修改您的登录密码</Typography.Text>
        )}
      </Card>
    </div>
  )
}
