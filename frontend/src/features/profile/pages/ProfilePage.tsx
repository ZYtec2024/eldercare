import { useEffect, useRef, useState } from 'react'
import { AutoComplete, Card, Typography, Spin, Form, Input, Button, App, Descriptions, Tag, Divider, Space, Select, Modal } from 'antd'
import { AimOutlined, UserOutlined, EditOutlined, SaveOutlined, LockOutlined, EnvironmentOutlined, PlusOutlined } from '@ant-design/icons'

import {
  addElderAddress,
  fetchAddressSuggestions,
  fetchElderAddresses,
  fetchProfileInfo,
  selectElderAddress,
  updateElderAddress,
  updateProfileInfo,
  updateVolunteerLiveLocation,
  type AddressPoiSuggestion,
  type ElderAddress,
} from '@/services/adapters/profile-adapter'
import { useSession } from '@/features/auth/useSession'
import type { ProfileSnapshot } from '@/types/domain'
import { roleLabels } from '@/types/domain'
import { changePassword } from '@/services/adapters/auth-adapter'
import { fetchDispatchTracking } from '@/services/adapters/dispatch-adapter'
import { fetchPublicRegionChildren, type PublicRegionNode } from '@/services/adapters/auth-adapter'

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
  const [addresses, setAddresses] = useState<ElderAddress[]>([])
  const [addressOpen, setAddressOpen] = useState(false)
  const [editingAddress, setEditingAddress] = useState<ElderAddress | null>(null)
  const [addressSaving, setAddressSaving] = useState(false)
  const [poiSuggestions, setPoiSuggestions] = useState<AddressPoiSuggestion[]>([])
  const [selectedPoi, setSelectedPoi] = useState<AddressPoiSuggestion | null>(null)
  const [poiSearching, setPoiSearching] = useState(false)
  const [locationSaving, setLocationSaving] = useState(false)
  const poiTimerRef = useRef<number | null>(null)
  const [provinces, setProvinces] = useState<PublicRegionNode[]>([])
  const [cities, setCities] = useState<PublicRegionNode[]>([])
  const [districts, setDistricts] = useState<PublicRegionNode[]>([])
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()
  const [addressForm] = Form.useForm()

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
    if (session.role === 'elder') {
      fetchElderAddresses(session.userId).then(setAddresses).catch(() => setAddresses([]))
      fetchPublicRegionChildren().then(setProvinces).catch(() => setProvinces([]))
    }
  }, [session])

  const chooseAddressProvince = async (adcode: string) => {
    const province = provinces.find((item) => item.adcode === adcode)
    addressForm.setFieldsValue({ provinceName: province?.name, cityAdcode: undefined, cityName: undefined, regionAdcode: undefined, districtName: undefined })
    setCities([])
    setDistricts([])
    const children = await fetchPublicRegionChildren(adcode)
    const direct = children.filter((item) => item.level === 'district' || item.level === 'biz_area')
    if (direct.length) {
      setCities([{ adcode, name: '市辖区', level: 'city' }])
      setDistricts(direct)
      addressForm.setFieldsValue({ cityAdcode: adcode, cityName: province?.name })
    } else {
      setCities(children)
    }
  }

  const chooseAddressCity = async (adcode: string) => {
    const city = cities.find((item) => item.adcode === adcode)
    const provinceName = addressForm.getFieldValue('provinceName')
    addressForm.setFieldsValue({ cityName: city?.name === '市辖区' ? provinceName : city?.name, regionAdcode: undefined, districtName: undefined })
    setDistricts((await fetchPublicRegionChildren(adcode)).filter((item) => ['district', 'biz_area', 'city'].includes(item.level)))
  }

  const saveAddress = async () => {
    if (!session) return
    setAddressSaving(true)
    try {
      const values = await addressForm.validateFields()
      const payload = {
        userId: session.userId,
        label: values.label,
        provinceName: values.provinceName,
        cityName: values.cityName,
        districtName: values.districtName,
        regionAdcode: values.regionAdcode,
        detailAddress: selectedPoi?.name || values.poiKeyword,
        addressSupplement: values.addressSupplement,
        poi: selectedPoi || undefined,
      }
      const result = editingAddress
        ? await updateElderAddress({ ...payload, addressId: editingAddress.addressId, isCurrent: editingAddress.isCurrent })
        : await addElderAddress(payload)
      message.success(result.message)
      setAddresses(await fetchElderAddresses(session.userId))
      setAddressOpen(false)
      setEditingAddress(null)
      addressForm.resetFields()
    } catch (err: any) {
      if (!err?.errorFields) message.error(err?.message || '保存地址失败')
    } finally {
      setAddressSaving(false)
    }
  }

  const openNewAddress = () => {
    setEditingAddress(null)
    setSelectedPoi(null)
    setPoiSuggestions([])
    setCities([])
    setDistricts([])
    addressForm.resetFields()
    addressForm.setFieldsValue({ label: '家' })
    setAddressOpen(true)
  }

  const openEditAddress = async (address: ElderAddress) => {
    setEditingAddress(address)
    setSelectedPoi(null)
    setPoiSuggestions([])
    setAddressOpen(true)
    setCities([])
    setDistricts([])
    const provinceNode = provinces.find((item) => item.name === address.provinceName)
    if (!provinceNode) {
      message.error('无法加载该地址的省级目录，请刷新后重试')
      return
    }
    try {
      const provinceChildren = await fetchPublicRegionChildren(provinceNode.adcode)
      const directDistricts = provinceChildren.filter((item) => item.level === 'district' || item.level === 'biz_area')
      let cityAdcode = provinceNode.adcode
      if (directDistricts.length) {
        setCities([{ adcode: provinceNode.adcode, name: '市辖区', level: 'city' }])
        setDistricts(directDistricts)
      } else {
        setCities(provinceChildren)
        const cityNode = provinceChildren.find((item) => item.name === address.cityName)
        cityAdcode = cityNode?.adcode || ''
        if (cityAdcode) {
          setDistricts((await fetchPublicRegionChildren(cityAdcode)).filter((item) => ['district', 'biz_area', 'city'].includes(item.level)))
        }
      }
      addressForm.setFieldsValue({
        label: address.label,
        provinceAdcode: provinceNode.adcode,
        provinceName: address.provinceName,
        cityAdcode,
        cityName: address.cityName,
        regionAdcode: address.regionAdcode,
        districtName: address.districtName,
        poiKeyword: address.detailAddress,
        addressSupplement: '',
      })
    } catch (err: any) {
      message.error(err?.message || '加载地址行政区划失败')
    }
  }

  const switchAddress = async (addressId: number) => {
    if (!session) return
    try {
      message.success((await selectElderAddress(session.userId, addressId)).message)
      setAddresses(await fetchElderAddresses(session.userId))
    } catch (err: any) {
      message.error(err?.message || '切换地址失败')
    }
  }

  const searchPoi = (keywords: string) => {
    setSelectedPoi(null)
    if (poiTimerRef.current != null) window.clearTimeout(poiTimerRef.current)
    const regionAdcode = String(addressForm.getFieldValue('regionAdcode') || '')
    if (keywords.trim().length < 2 || !regionAdcode) {
      setPoiSuggestions([])
      return
    }
    poiTimerRef.current = window.setTimeout(() => {
      setPoiSearching(true)
      fetchAddressSuggestions(keywords, regionAdcode)
        .then(setPoiSuggestions)
        .catch(() => setPoiSuggestions([]))
        .finally(() => setPoiSearching(false))
    }, 350)
  }

  const captureVolunteerLocation = () => {
    if (!session || !navigator.geolocation) {
      message.warning('当前浏览器未提供定位能力；按钮和后端接口已保留，正式联网环境可直接使用')
      return
    }
    setLocationSaving(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        updateVolunteerLiveLocation(session.userId, position.coords.longitude, position.coords.latitude)
          .then((result) => message.success(result.message))
          .catch((err: any) => message.error(err?.message || '当前位置不在注册服务区县内'))
          .finally(() => setLocationSaving(false))
      },
      () => {
        message.warning('暂未获得定位授权；正式部署时允许浏览器定位即可使用')
        setLocationSaving(false)
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 10_000 },
    )
  }

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
                <Descriptions.Item label="实时接单位置" span={2}>
                  <Space wrap>
                    <Button icon={<AimOutlined />} loading={locationSaving} onClick={captureVolunteerLocation}>获取实时位置</Button>
                    <Typography.Text type="secondary">当前离线演示可不授权；正式部署后此按钮会把浏览器定位同步到所属服务区县。</Typography.Text>
                  </Space>
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

      {profile.role === 'elder' ? (
        <Card
          className="!rounded-2xl"
          title={<span><EnvironmentOutlined className="mr-2" />我的地址</span>}
          extra={<Button icon={<PlusOutlined />} onClick={openNewAddress}>添加地址</Button>}
        >
          <div className="space-y-3">
            {addresses.map((address) => (
              <div key={address.addressId} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${address.isCurrent ? 'border-blue-300 bg-blue-50' : 'border-slate-200'}`}>
                <div>
                  <div className="font-medium">{address.label} {address.isCurrent ? <Tag color="blue">当前地址</Tag> : null}</div>
                  <div className="mt-1 text-sm text-slate-600">{address.fullAddress}</div>
                  <div className="mt-1 text-xs text-slate-400">{address.provinceName} / {address.cityName} / {address.districtName}</div>
                </div>
                <Space>
                  <Button icon={<EditOutlined />} onClick={() => void openEditAddress(address)}>编辑</Button>
                  {!address.isCurrent ? <Button onClick={() => void switchAddress(address.addressId)}>设为当前地址</Button> : null}
                </Space>
              </div>
            ))}
            {!addresses.length ? <Typography.Text type="secondary">暂无地址，请添加一个可在高德地图检索的真实地址。</Typography.Text> : null}
          </div>
        </Card>
      ) : null}

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

      <Modal
        title={editingAddress ? '编辑真实地址' : '添加真实地址'}
        open={addressOpen}
        onCancel={() => { setAddressOpen(false); setEditingAddress(null); setSelectedPoi(null); setPoiSuggestions([]); addressForm.resetFields() }}
        onOk={() => void saveAddress()}
        confirmLoading={addressSaving}
        okText={editingAddress ? '核验并更新' : '核验并保存'}
        destroyOnClose
      >
        <Form form={addressForm} layout="vertical" initialValues={{ label: '家' }}>
          <Form.Item name="label" label="地址标签" rules={[{ required: true }]}><Input placeholder="家、子女家、常住地" /></Form.Item>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Form.Item name="provinceAdcode" label="省" rules={[{ required: true, message: '请选择省份' }]}>
              <Select showSearch optionFilterProp="label" options={provinces.map((item) => ({ value: item.adcode, label: item.name }))} onChange={(value) => void chooseAddressProvince(value)} />
            </Form.Item>
            <Form.Item name="cityAdcode" label="市" rules={[{ required: true, message: '请选择城市' }]}>
              <Select disabled={!cities.length} options={cities.map((item) => ({ value: item.adcode, label: item.name }))} onChange={(value) => void chooseAddressCity(value)} />
            </Form.Item>
            <Form.Item name="regionAdcode" label="区县" rules={[{ required: true, message: '请选择区县' }]}>
              <Select
                disabled={!districts.length}
                options={districts.map((item) => ({ value: item.adcode, label: item.name }))}
                onChange={(value) => {
                  addressForm.setFieldsValue({
                    districtName: districts.find((item) => item.adcode === value)?.name,
                    poiKeyword: undefined,
                    addressSupplement: undefined,
                  })
                  setSelectedPoi(null)
                  setPoiSuggestions([])
                }}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="poiKeyword"
            label="搜索并选择地图地点"
            extra="例如输入“上海大学”，可以继续选择校门、楼宇等高德地点；没有合适结果时也可直接填写完整地址。"
            rules={[{ required: true, message: '请输入并选择地点' }]}
          >
            <AutoComplete
              options={poiSuggestions.map((item) => ({
                value: item.displayName,
                label: (
                  <div className="py-2">
                    <div className="font-semibold leading-6">{item.name}</div>
                    <div className="mt-3 text-xs leading-5 text-slate-500">{item.fullAddress}</div>
                  </div>
                ),
              }))}
              onSearch={searchPoi}
              onSelect={(value) => {
                const poi = poiSuggestions.find((item) => item.displayName === value) || null
                setSelectedPoi(poi)
              }}
              notFoundContent={poiSearching ? '正在搜索高德地点…' : '可继续输入“门 / 楼 / 栋”等关键词'}
              placeholder="例如：上海大学、上海大学北门、锦秋花园"
            />
          </Form.Item>
          <Form.Item name="addressSupplement" label="楼栋 / 门牌 / 房间（可补充）">
            <Input placeholder="例如：1号楼301室；选择校门时可留空" />
          </Form.Item>
          <Form.Item name="provinceName" hidden><Input /></Form.Item>
          <Form.Item name="cityName" hidden><Input /></Form.Item>
          <Form.Item name="districtName" hidden><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
