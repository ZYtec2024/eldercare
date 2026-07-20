import { useEffect, useState } from 'react'
import { App, Button, Card, Form, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { EnvironmentOutlined, PlusOutlined, ReloadOutlined, UserAddOutlined, UserDeleteOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  bindManagedDispatchRegionManager,
  createManagedDispatchRegion,
  fetchCandidateDistrictManagers,
  fetchDispatchRegionChildren,
  fetchManagedDispatchRegions,
  patchManagedDispatchRegion,
  unbindManagedDispatchRegionManager,
  type CandidateDistrictManager,
  type ManagedDispatchRegion,
  type RegionCatalogNode,
} from '@/services/adapters/dispatch-adapter'

type AdminMode = 'existing' | 'create'

type DistrictAdminForm = {
  username: string
  password: string
  real_name: string
  phone: string
  email: string
}

export default function AdminRegionsPage() {
  const { session } = useSession()
  const { message, modal } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [regions, setRegions] = useState<ManagedDispatchRegion[]>([])
  const [candidates, setCandidates] = useState<CandidateDistrictManager[]>([])
  const [provinces, setProvinces] = useState<RegionCatalogNode[]>([])
  const [cities, setCities] = useState<RegionCatalogNode[]>([])
  const [districts, setDistricts] = useState<RegionCatalogNode[]>([])
  const [province, setProvince] = useState<RegionCatalogNode>()
  const [city, setCity] = useState<RegionCatalogNode>()
  const [district, setDistrict] = useState<RegionCatalogNode>()
  const [adminMode, setAdminMode] = useState<AdminMode>('create')
  const [managerUserId, setManagerUserId] = useState<number>()
  const [saving, setSaving] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<ManagedDispatchRegion>()
  const [unbindSelectedIds, setUnbindSelectedIds] = useState<number[]>([])
  const [unbinding, setUnbinding] = useState(false)
  const [form] = Form.useForm<DistrictAdminForm>()

  const loadManaged = async () => {
    if (!session) return
    setLoading(true)
    try {
      const [managed, managers] = await Promise.all([
        fetchManagedDispatchRegions(session.userId),
        fetchCandidateDistrictManagers(session.userId),
      ])
      setRegions(managed)
      setCandidates(managers)
    } catch (err: any) {
      message.error(err?.message || '加载区域失败（需要总管理员权限）')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadManaged().catch(() => {})
    if (!session) return
    fetchDispatchRegionChildren(session.userId, '中华人民共和国')
      .then(setProvinces)
      .catch((err: any) => message.warning(err?.message || '无法加载省级目录，请检查高德 Web Key'))
  }, [session?.userId])

  const onProvince = async (adcode: string) => {
    if (!session) return
    const selected = provinces.find((item) => item.adcode === adcode)
    setProvince(selected)
    setCity(undefined)
    setDistrict(undefined)
    setCities([])
    setDistricts([])
    const children = await fetchDispatchRegionChildren(session.userId, adcode)
    // Municipalities sometimes return districts directly.
    if (children.some((item) => item.level === 'district')) {
      setCities([{ adcode, name: selected?.name || adcode, level: 'city', center: selected?.center }])
      setCity({ adcode, name: selected?.name || adcode, level: 'city', center: selected?.center })
      setDistricts(children.filter((item) => item.level === 'district' || item.level === 'biz_area'))
    } else {
      setCities(children)
    }
  }

  const onCity = async (adcode: string) => {
    if (!session) return
    const selected = cities.find((item) => item.adcode === adcode)
    setCity(selected)
    setDistrict(undefined)
    const children = await fetchDispatchRegionChildren(session.userId, adcode)
    setDistricts(children.filter((item) => item.level === 'district' || item.level === 'biz_area' || item.level === 'city'))
  }

  const resolveAdminPayload = async () => {
    if (adminMode === 'existing') {
      if (!managerUserId) {
        throw new Error('请选择已有区管理员')
      }
      return { managerUserId }
    }
    const values = await form.validateFields()
    return { districtAdmin: values }
  }

  const addRegion = async () => {
    if (!session || !district) {
      message.warning('请先选择到区县')
      return
    }
    setSaving(true)
    try {
      const adminPayload = await resolveAdminPayload()
      const result = await createManagedDispatchRegion({
        adminUserId: session.userId,
        adcode: district.adcode,
        provinceName: province?.name,
        cityName: city?.name,
        ...adminPayload,
      })
      message.success(result.message || '已开通区域')
      form.resetFields()
      setManagerUserId(undefined)
      await loadManaged()
    } catch (err: any) {
      message.error(err?.message || '开通失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (row: ManagedDispatchRegion, active: boolean) => {
    if (!session) return
    try {
      await patchManagedDispatchRegion(row.adcode, { adminUserId: session.userId, active })
      message.success(active ? '已启用，可接受新业务' : '已停用，该区将无法新下单/落点')
      await loadManaged()
    } catch (err: any) {
      message.error(err?.message || '更新失败')
    }
  }

  const refreshPolygon = async (row: ManagedDispatchRegion) => {
    if (!session) return
    try {
      await patchManagedDispatchRegion(row.adcode, { adminUserId: session.userId, refreshPolygon: true })
      message.success('已从高德刷新官方边界')
      await loadManaged()
    } catch (err: any) {
      message.error(err?.message || '刷新边界失败')
    }
  }

  const openUnbindManager = (row: ManagedDispatchRegion) => {
    if (!row.managers?.length) {
      message.warning('该区县暂无已绑定的区管理员')
      return
    }
    setUnbindTarget(row)
    setUnbindSelectedIds([])
  }

  const confirmUnbindManagers = async () => {
    if (!session || !unbindTarget) return
    if (!unbindSelectedIds.length) {
      message.warning('请先勾选要解绑的区管理员')
      return
    }
    const selectedNames = (unbindTarget.managers || [])
      .filter((item) => unbindSelectedIds.includes(item.user_id))
      .map((item) => `${item.real_name}（${item.username}）`)
    setUnbinding(true)
    try {
      for (const managerUserId of unbindSelectedIds) {
        await unbindManagedDispatchRegionManager(unbindTarget.adcode, managerUserId, session.userId)
      }
      message.success(
        selectedNames.length === 1
          ? `已解绑「${selectedNames[0]}」`
          : `已解绑 ${selectedNames.length} 名区管理员`,
      )
      setUnbindTarget(undefined)
      setUnbindSelectedIds([])
      await loadManaged()
    } catch (err: any) {
      message.error(err?.message || '解绑失败')
      await loadManaged()
    } finally {
      setUnbinding(false)
    }
  }

  const bindManager = (row: ManagedDispatchRegion) => {
    if (!session) return
    let mode: AdminMode = 'existing'
    let selectedId: number | undefined
    let createValues: DistrictAdminForm = {
      username: '',
      password: '',
      real_name: '',
      phone: '',
      email: '',
    }

    modal.confirm({
      title: `为 ${row.name} 绑定区管理员`,
      width: 520,
      content: (
        <div className="space-y-3 pt-2">
          <Radio.Group
            defaultValue="existing"
            onChange={(event) => {
              mode = event.target.value
            }}
          >
            <Radio value="existing">绑定已有管理员</Radio>
            <Radio value="create">新建区管理员</Radio>
          </Radio.Group>
          <Select
            className="w-full"
            placeholder="选择已有区管理员"
            options={candidates.map((item) => ({
              value: item.user_id,
              label: `${item.real_name}（${item.username}）`,
            }))}
            onChange={(value) => {
              selectedId = value
            }}
            showSearch
            optionFilterProp="label"
          />
          <Typography.Paragraph type="secondary" className="!mb-0 text-xs">
            若选「新建」，请在确认前先在下方填写账号（弹窗确认时会再次校验；建议优先绑定已有账号）。
          </Typography.Paragraph>
          <Input placeholder="新建用户名" onChange={(e) => { createValues = { ...createValues, username: e.target.value } }} />
          <Input.Password placeholder="新建密码" onChange={(e) => { createValues = { ...createValues, password: e.target.value } }} />
          <Input placeholder="姓名" onChange={(e) => { createValues = { ...createValues, real_name: e.target.value } }} />
          <Input placeholder="手机" onChange={(e) => { createValues = { ...createValues, phone: e.target.value } }} />
          <Input placeholder="邮箱" onChange={(e) => { createValues = { ...createValues, email: e.target.value } }} />
        </div>
      ),
      onOk: async () => {
        try {
          const payload =
            mode === 'existing'
              ? { adminUserId: session.userId, managerUserId: selectedId }
              : { adminUserId: session.userId, districtAdmin: createValues }
          if (mode === 'existing' && !selectedId) {
            message.warning('请选择已有管理员')
            return Promise.reject()
          }
          if (mode === 'create' && !Object.values(createValues).every(Boolean)) {
            message.warning('请完整填写新区管理员信息')
            return Promise.reject()
          }
          const result = await bindManagedDispatchRegionManager(row.adcode, payload)
          message.success(result.message || '已绑定')
          await loadManaged()
        } catch (err: any) {
          message.error(err?.message || '绑定失败')
          return Promise.reject(err)
        }
      },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">区域管理</Typography.Title>
        <Typography.Text type="secondary">
          总管理员先开通区县并绑定区管理员；仅已启用区县可落点、下单与 SOS。停用后该区不再接受新业务。
        </Typography.Text>
      </div>

      <Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />开通调度区域</Space>}>
        <Space wrap size="middle" className="w-full mb-4">
          <Select
            className="min-w-48"
            placeholder="省 / 直辖市"
            value={province?.adcode}
            options={provinces.map((item) => ({ value: item.adcode, label: item.name }))}
            onChange={(value) => void onProvince(value)}
            showSearch
            optionFilterProp="label"
          />
          <Select
            className="min-w-48"
            placeholder="市"
            value={city?.adcode}
            options={cities.map((item) => ({ value: item.adcode, label: item.name }))}
            onChange={(value) => void onCity(value)}
            disabled={!province}
            showSearch
            optionFilterProp="label"
          />
          <Select
            className="min-w-48"
            placeholder="区 / 县"
            value={district?.adcode}
            options={districts.map((item) => ({ value: item.adcode, label: `${item.name} (${item.adcode})` }))}
            onChange={(value) => setDistrict(districts.find((item) => item.adcode === value))}
            disabled={!city && districts.length === 0}
            showSearch
            optionFilterProp="label"
          />
        </Space>

        <div className="mb-3">
          <Typography.Text strong>区管理员（开通时必填）</Typography.Text>
          <div className="mt-2">
            <Radio.Group value={adminMode} onChange={(event) => setAdminMode(event.target.value)}>
              <Radio value="create">新建区管理员</Radio>
              <Radio value="existing">绑定已有管理员</Radio>
            </Radio.Group>
          </div>
        </div>

        {adminMode === 'existing' ? (
          <Select
            className="min-w-72 mb-4"
            placeholder="选择区管理员账号"
            value={managerUserId}
            options={candidates.map((item) => ({
              value: item.user_id,
              label: `${item.real_name}（${item.username}${item.region_adcodes.length ? ` · 已管 ${item.region_adcodes.join('/')}` : ''}）`,
            }))}
            onChange={setManagerUserId}
            showSearch
            optionFilterProp="label"
            allowClear
          />
        ) : (
          <Form form={form} layout="vertical" className="max-w-xl">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <Form.Item name="username" label="登录用户名" rules={[{ required: true, message: '必填' }]}>
                <Input placeholder="例如 admin_pudong" />
              </Form.Item>
              <Form.Item name="password" label="初始密码" rules={[{ required: true, message: '必填' }]}>
                <Input.Password placeholder="设置初始密码" />
              </Form.Item>
              <Form.Item name="real_name" label="姓名" rules={[{ required: true, message: '必填' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="phone" label="手机" rules={[{ required: true, message: '必填' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="email" label="邮箱" className="md:col-span-2" rules={[{ required: true, message: '必填' }]}>
                <Input />
              </Form.Item>
            </div>
          </Form>
        )}

        <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={() => void addRegion()}>
          开通区县并绑定管理员
        </Button>
      </Card>

      <Card
        className="!rounded-2xl"
        title="已配置区域"
        extra={<Button icon={<ReloadOutlined />} onClick={() => void loadManaged()}>刷新</Button>}
      >
        <Table
          rowKey="adcode"
          loading={loading}
          dataSource={regions}
          pagination={false}
          columns={[
            { title: '区县', dataIndex: 'name' },
            { title: 'adcode', dataIndex: 'adcode', width: 110 },
            {
              title: '省市',
              render: (_, row) => `${row.province_name || ''} ${row.city_name || ''}`.trim() || '—',
            },
            {
              title: '区管理员',
              width: 280,
              render: (_, row) =>
                row.managers?.length
                  ? (
                      <Space size={[4, 4]} wrap>
                        {row.managers.map((item) => (
                          <Tag key={item.user_id}>{item.real_name}（{item.username}）</Tag>
                        ))}
                      </Space>
                    )
                  : <Tag color="orange">未绑定</Tag>,
            },
            {
              title: '官方多边形',
              dataIndex: 'has_polygon',
              width: 110,
              render: (value: boolean) => (value ? <Tag color="green">已就绪</Tag> : <Tag color="orange">仅矩形</Tag>),
            },
            {
              title: '启用',
              dataIndex: 'active',
              width: 90,
              render: (value: boolean, row) => (
                <Switch checked={value} onChange={(checked) => void toggleActive(row, checked)} />
              ),
            },
            {
              title: '操作',
              width: 280,
              render: (_, row) => (
                <Space wrap>
                  <Button size="small" onClick={() => void refreshPolygon(row)}>刷新边界</Button>
                  <Button size="small" icon={<UserAddOutlined />} onClick={() => bindManager(row)}>绑定管理员</Button>
                  <Button
                    size="small"
                    danger
                    icon={<UserDeleteOutlined />}
                    disabled={!row.managers?.length}
                    onClick={() => openUnbindManager(row)}
                  >
                    解绑管理员
                  </Button>
                </Space>
              ),
            },
          ]}
          scroll={{ x: 1100 }}
        />
      </Card>

      <Modal
        title={unbindTarget ? `解绑区管理员 · ${unbindTarget.name}` : '解绑区管理员'}
        open={!!unbindTarget}
        onCancel={() => {
          if (unbinding) return
          setUnbindTarget(undefined)
          setUnbindSelectedIds([])
        }}
        onOk={() => void confirmUnbindManagers()}
        okText={unbindSelectedIds.length > 1 ? `确认解绑（${unbindSelectedIds.length}）` : '确认解绑'}
        okButtonProps={{ danger: true, disabled: !unbindSelectedIds.length }}
        confirmLoading={unbinding}
        destroyOnClose
        width={520}
      >
        <Typography.Paragraph type="secondary" className="!mb-3">
          该区县可能有多名区管理员。请勾选要解绑的账号；解绑后对方将无法管理该区县，之后可再绑定到正确区县。
        </Typography.Paragraph>
        <Select
          className="w-full"
          mode="multiple"
          allowClear
          placeholder="选择要解绑的区管理员"
          value={unbindSelectedIds}
          onChange={setUnbindSelectedIds}
          options={(unbindTarget?.managers || []).map((item) => ({
            value: item.user_id,
            label: `${item.real_name}（${item.username}）`,
          }))}
          optionFilterProp="label"
          showSearch
        />
      </Modal>
    </div>
  )
}
