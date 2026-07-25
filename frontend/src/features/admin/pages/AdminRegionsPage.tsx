import { useEffect, useMemo, useState } from 'react'
import { App, Button, Card, Checkbox, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { EnvironmentOutlined, PlusOutlined, ReloadOutlined, UserAddOutlined, UserDeleteOutlined } from '@ant-design/icons'
import { Navigate } from 'react-router-dom'

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
  const [managerUserId, setManagerUserId] = useState<number>()
  const [saving, setSaving] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<ManagedDispatchRegion>()
  const [unbindSelectedIds, setUnbindSelectedIds] = useState<number[]>([])
  const [unbindAlsoDeactivate, setUnbindAlsoDeactivate] = useState(true)
  const [unbinding, setUnbinding] = useState(false)
  const [configuredProvince, setConfiguredProvince] = useState<string>()
  const [configuredCity, setConfiguredCity] = useState<string>()
  const [configuredAdcode, setConfiguredAdcode] = useState<string>()

  const configuredProvinceOptions = useMemo(
    () => Array.from(new Set(regions.map((item) => item.province_name).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((name) => ({ label: name, value: name })),
    [regions],
  )
  const configuredCityOptions = useMemo(
    () => Array.from(new Set(regions
      .filter((item) => !configuredProvince || item.province_name === configuredProvince)
      .map((item) => item.city_name)
      .filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((name) => ({ label: name === configuredProvince ? '市辖区' : name, value: name })),
    [configuredProvince, regions],
  )
  const configuredDistrictOptions = useMemo(
    () => regions
      .filter((item) => (!configuredProvince || item.province_name === configuredProvince)
        && (!configuredCity || item.city_name === configuredCity))
      .map((item) => ({ label: `${item.name}（${item.adcode}）`, value: item.adcode })),
    [configuredCity, configuredProvince, regions],
  )
  const filteredRegions = useMemo(
    () => regions.filter((item) => (!configuredProvince || item.province_name === configuredProvince)
      && (!configuredCity || item.city_name === configuredCity)
      && (!configuredAdcode || item.adcode === configuredAdcode)),
    [configuredAdcode, configuredCity, configuredProvince, regions],
  )

  const loadManaged = async () => {
    if (!session) return
    setLoading(true)
    try {
      const [managed, managers] = await Promise.all([
        fetchManagedDispatchRegions(session.userId),
        fetchCandidateDistrictManagers(session.userId),
      ])
      setRegions([...managed].sort((a, b) => {
        const provinceCmp = String(a.province_name || '').localeCompare(String(b.province_name || ''), 'zh-CN')
        if (provinceCmp) return provinceCmp
        const cityCmp = String(a.city_name || '').localeCompare(String(b.city_name || ''), 'zh-CN')
        if (cityCmp) return cityCmp
        const nameCmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
        if (nameCmp) return nameCmp
        return String(a.adcode).localeCompare(String(b.adcode))
      }))
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

  const addRegion = async () => {
    if (!session || !district) {
      message.warning('请先选择到区县')
      return
    }
    if (!managerUserId) {
      message.warning('请选择已有区管理员')
      return
    }
    setSaving(true)
    try {
      const result = await createManagedDispatchRegion({
        adminUserId: session.userId,
        adcode: district.adcode,
        provinceName: province?.name,
        cityName: city?.name,
        managerUserId,
      })
      message.success(result.message || '已开通区域')
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

  const openUnbindManager = (row: ManagedDispatchRegion) => {
    if (!row.managers?.length) {
      message.warning('该区县暂无已绑定的区管理员')
      return
    }
    setUnbindTarget(row)
    setUnbindSelectedIds([])
    setUnbindAlsoDeactivate(true)
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
    const remainingManagers = (unbindTarget.managers || []).filter(
      (item) => !unbindSelectedIds.includes(item.user_id),
    )
    setUnbinding(true)
    try {
      for (const managerUserId of unbindSelectedIds) {
        await unbindManagedDispatchRegionManager(unbindTarget.adcode, managerUserId, session.userId)
      }
      let successText = selectedNames.length === 1
        ? `已解绑「${selectedNames[0]}」`
        : `已解绑 ${selectedNames.length} 名区管理员`
      if (unbindAlsoDeactivate && remainingManagers.length === 0 && unbindTarget.active) {
        await patchManagedDispatchRegion(unbindTarget.adcode, {
          adminUserId: session.userId,
          active: false,
        })
        successText += '，并已解除开通（停用该区域）'
      }
      message.success(successText)
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
    let selectedId: number | undefined

    modal.confirm({
      title: `为 ${row.name} 绑定区管理员`,
      width: 520,
      content: (
        <div className="space-y-3 pt-2">
          <Select
            className="w-full"
            placeholder="选择已有区管理员"
            options={candidates
              .filter((item) => !item.region_adcodes.includes(row.adcode))
              .map((item) => ({
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
            这里只绑定已有管理员；已绑定当前区县的账号已自动排除。
          </Typography.Paragraph>
        </div>
      ),
      onOk: async () => {
        try {
          if (!selectedId) {
            message.warning('请选择已有管理员')
            return Promise.reject()
          }
          const result = await bindManagedDispatchRegionManager(row.adcode, {
            adminUserId: session.userId,
            managerUserId: selectedId,
          })
          message.success(result.message || '已绑定')
          await loadManaged()
        } catch (err: any) {
          message.error(err?.message || '绑定失败')
          return Promise.reject(err)
        }
      },
    })
  }

  if (session && !session.isRoot) {
    return <Navigate to="/admin/dashboard" replace />
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">区域管理</Typography.Title>
        <Typography.Text type="secondary">
          上方只负责开通新区县；下方负责启用、停用、绑定和解绑。区域管理不再创建管理员账号。
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

        <div className="mb-3"><Typography.Text strong>绑定已有区管理员（开通时必填）</Typography.Text></div>
        <Select
          className="min-w-72 mb-4"
          placeholder="选择已有区管理员账号"
          value={managerUserId}
          options={candidates.map((item) => ({
            value: item.user_id,
            label: `${item.real_name}（${item.username}${item.region_adcodes.length ? ` · 已管 ${item.region_adcodes.join('/')}` : ' · 尚未指派'}）`,
          }))}
          onChange={setManagerUserId}
          showSearch
          optionFilterProp="label"
          allowClear
        />

        <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={() => void addRegion()}>
          开通区县并绑定管理员
        </Button>
      </Card>

      <Card
        className="!rounded-2xl"
        title={`已配置区域（${filteredRegions.length}/${regions.length}）`}
        extra={<Button icon={<ReloadOutlined />} onClick={() => void loadManaged()}>刷新</Button>}
      >
        <Space wrap size="middle" className="mb-4 w-full">
          <Select
            className="min-w-48"
            placeholder="全部省 / 直辖市"
            allowClear
            value={configuredProvince}
            options={configuredProvinceOptions}
            onChange={(value) => {
              setConfiguredProvince(value)
              setConfiguredCity(undefined)
              setConfiguredAdcode(undefined)
            }}
          />
          <Select
            className="min-w-48"
            placeholder="全部市"
            allowClear
            value={configuredCity}
            options={configuredCityOptions}
            onChange={(value) => {
              setConfiguredCity(value)
              setConfiguredAdcode(undefined)
            }}
          />
          <Select
            className="min-w-56"
            placeholder="全部区 / 县"
            allowClear
            showSearch
            optionFilterProp="label"
            value={configuredAdcode}
            options={configuredDistrictOptions}
            onChange={setConfiguredAdcode}
          />
        </Space>
        <Table<ManagedDispatchRegion>
          rowKey="adcode"
          loading={loading}
          dataSource={filteredRegions}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: '省 / 直辖市',
              dataIndex: 'province_name',
              width: 150,
            },
            {
              title: '市',
              dataIndex: 'city_name',
              width: 140,
              render: (value, row) => value === row.province_name ? '市辖区' : (value || '—'),
            },
            {
              title: '区 / 县',
              width: 190,
              render: (_, row) => <><b>{row.name}</b><div className="text-xs text-slate-400">{row.adcode}</div></>,
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
              title: '状态',
              width: 110,
              render: (_, row) => (
                <Space>
                  <Switch checked={row.active} onChange={(checked) => void toggleActive(row, checked)} />
                  <Tag color={row.active ? 'green' : 'default'}>{row.active ? '启用' : '停用'}</Tag>
                </Space>
              ),
            },
            {
              title: '操作',
              width: 300,
              render: (_, row) => (
                  <Space wrap>
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
                    {row.active ? (
                      <Button size="small" danger onClick={() => void toggleActive(row, false)}>解除开通</Button>
                    ) : (
                      <Button size="small" type="primary" ghost onClick={() => void toggleActive(row, true)}>重新开通</Button>
                    )}
                  </Space>
                ),
            },
          ]}
          scroll={{ x: 980 }}
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
        <Checkbox
          className="mt-4"
          checked={unbindAlsoDeactivate}
          onChange={(event) => setUnbindAlsoDeactivate(event.target.checked)}
          disabled={
            !unbindTarget?.active
            || ((unbindTarget?.managers || []).filter((item) => !unbindSelectedIds.includes(item.user_id)).length > 0)
          }
        >
          解绑后若该区无剩余管理员，同时解除开通（停用）
        </Checkbox>
      </Modal>
    </div>
  )
}
