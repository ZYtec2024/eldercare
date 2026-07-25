import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Select, Typography, App } from 'antd'
import { Link, useNavigate } from 'react-router-dom'

import { fetchPublicRegionChildren, registerAccount, type PublicRegionNode } from '@/services/adapters/auth-adapter'
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
  const [provinces, setProvinces] = useState<PublicRegionNode[]>([])
  const [cities, setCities] = useState<PublicRegionNode[]>([])
  const [districts, setDistricts] = useState<PublicRegionNode[]>([])
  const [form] = Form.useForm()
  const selectedRole = (Form.useWatch('role', form) as Role | undefined) ?? 'family'

  useEffect(() => {
    fetchPublicRegionChildren().then(setProvinces).catch(() => setProvinces([]))
  }, [])

  const chooseProvince = async (adcode: string) => {
    const province = provinces.find((item) => item.adcode === adcode)
    form.setFieldsValue({ provinceName: province?.name, cityAdcode: undefined, cityName: undefined, regionAdcode: undefined, districtName: undefined })
    setCities([])
    setDistricts([])
    const children = await fetchPublicRegionChildren(adcode)
    const directDistricts = children.filter((item) => item.level === 'district' || item.level === 'biz_area')
    if (directDistricts.length) {
      const municipality = { adcode, name: '市辖区', level: 'city' }
      setCities([municipality])
      setDistricts(directDistricts)
      form.setFieldsValue({ cityAdcode: adcode, cityName: province?.name })
    } else {
      setCities(children)
    }
  }

  const chooseCity = async (adcode: string) => {
    const city = cities.find((item) => item.adcode === adcode)
    const provinceName = form.getFieldValue('provinceName')
    form.setFieldsValue({ cityName: city?.name === '市辖区' ? provinceName : city?.name, regionAdcode: undefined, districtName: undefined })
    setDistricts((await fetchPublicRegionChildren(adcode)).filter((item) => ['district', 'biz_area', 'city'].includes(item.level)))
  }

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
        provinceName: values.provinceName,
        cityName: values.cityName,
        districtName: values.districtName,
        regionAdcode: values.regionAdcode,
        detailAddress: values.detailAddress,
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
          <Form form={form} layout="vertical" onFinish={onFinish} size="large" autoComplete="off" initialValues={{ role: 'family' }}>
            <Form.Item name="role" label="注册角色" rules={[{ required: true }]}>
              <Select options={roleOptions} />
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
                <div className="grid grid-cols-2 gap-x-4">
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
                </div>
                <Typography.Title level={5} className="!mb-3">老人居住地址（按省 / 市 / 区县筛选）</Typography.Title>
                <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-3">
                  <Form.Item name="provinceAdcode" label="省 / 直辖市" rules={[{ required: true, message: '请选择省份' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={provinces.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => void chooseProvince(value)}
                    />
                  </Form.Item>
                  <Form.Item name="cityAdcode" label="市" rules={[{ required: true, message: '请选择城市' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      disabled={!cities.length}
                      options={cities.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => void chooseCity(value)}
                    />
                  </Form.Item>
                  <Form.Item name="regionAdcode" label="区 / 县" rules={[{ required: true, message: '请选择区县' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      disabled={!districts.length}
                      options={districts.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => form.setFieldValue('districtName', districts.find((item) => item.adcode === value)?.name)}
                    />
                  </Form.Item>
                </div>
                <Form.Item name="detailAddress" label="详细地址" rules={[{ required: true, message: '请输入可在高德地图检索的真实地址' }]}>
                  <Input placeholder="例如：锦秋路699弄锦秋花园1号楼301室" />
                </Form.Item>
                <Form.Item name="provinceName" hidden><Input /></Form.Item>
                <Form.Item name="cityName" hidden><Input /></Form.Item>
                <Form.Item name="districtName" hidden><Input /></Form.Item>
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
                <Typography.Title level={5} className="!mb-3">志愿服务区县（注册后仅在本区参与派单）</Typography.Title>
                <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-3">
                  <Form.Item name="provinceAdcode" label="省 / 直辖市" rules={[{ required: true, message: '请选择省份' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={provinces.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => void chooseProvince(value)}
                    />
                  </Form.Item>
                  <Form.Item name="cityAdcode" label="市" rules={[{ required: true, message: '请选择城市' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      disabled={!cities.length}
                      options={cities.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => void chooseCity(value)}
                    />
                  </Form.Item>
                  <Form.Item name="regionAdcode" label="服务区 / 县" rules={[{ required: true, message: '请选择服务区县' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      disabled={!districts.length}
                      options={districts.map((item) => ({ value: item.adcode, label: item.name }))}
                      onChange={(value) => form.setFieldValue('districtName', districts.find((item) => item.adcode === value)?.name)}
                    />
                  </Form.Item>
                </div>
                <Form.Item label="技能与经验说明" required>
                  <Typography.Paragraph type="secondary" className="!mb-2 !text-sm">
                    请描述会做什么、是否有证书或经验。管理员会根据说明分配并认证可接单技能。
                  </Typography.Paragraph>
                  <Form.Item
                    name="skills"
                    noStyle
                    rules={[{ required: true, message: '请填写技能与经验说明' }]}
                  >
                    <Input.TextArea
                      rows={4}
                      maxLength={500}
                      showCount
                      placeholder="例如：持有红十字急救证；照护老人3年；可协助轮椅出行和陪同就医。"
                    />
                  </Form.Item>
                </Form.Item>
                <Form.Item name="provinceName" hidden><Input /></Form.Item>
                <Form.Item name="cityName" hidden><Input /></Form.Item>
                <Form.Item name="districtName" hidden><Input /></Form.Item>
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
