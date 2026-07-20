import { useEffect, useState } from 'react'
import { App, Button, Card, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { EnvironmentOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  createManagedDispatchRegion,
  fetchDispatchRegionChildren,
  fetchManagedDispatchRegions,
  patchManagedDispatchRegion,
  type ManagedDispatchRegion,
  type RegionCatalogNode,
} from '@/services/adapters/dispatch-adapter'

export default function AdminRegionsPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [regions, setRegions] = useState<ManagedDispatchRegion[]>([])
  const [provinces, setProvinces] = useState<RegionCatalogNode[]>([])
  const [cities, setCities] = useState<RegionCatalogNode[]>([])
  const [districts, setDistricts] = useState<RegionCatalogNode[]>([])
  const [province, setProvince] = useState<RegionCatalogNode>()
  const [city, setCity] = useState<RegionCatalogNode>()
  const [district, setDistrict] = useState<RegionCatalogNode>()
  const [saving, setSaving] = useState(false)

  const loadManaged = async () => {
    if (!session) return
    setLoading(true)
    try {
      setRegions(await fetchManagedDispatchRegions(session.userId))
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
    setSaving(true)
    try {
      const result = await createManagedDispatchRegion({
        adminUserId: session.userId,
        adcode: district.adcode,
        provinceName: province?.name,
        cityName: city?.name,
      })
      message.success(result.message || '已添加区域')
      await loadManaged()
    } catch (err: any) {
      message.error(err?.message || '添加失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (row: ManagedDispatchRegion, active: boolean) => {
    if (!session) return
    try {
      await patchManagedDispatchRegion(row.adcode, { adminUserId: session.userId, active })
      message.success(active ? '已启用' : '已停用')
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

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">区域管理</Typography.Title>
        <Typography.Text type="secondary">
          仅总管理员可用。按省 → 市 → 区县选择后，系统拉取高德官方多边形边界，用于派单落点判断。
        </Typography.Text>
      </div>

      <Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />添加调度区域</Space>}>
        <Space wrap size="middle" className="w-full">
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
          <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={() => void addRegion()}>
            添加并拉取官方边界
          </Button>
        </Space>
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
              title: '官方多边形',
              dataIndex: 'has_polygon',
              width: 120,
              render: (value: boolean) => (value ? <Tag color="green">已就绪</Tag> : <Tag color="orange">仅矩形</Tag>),
            },
            {
              title: '启用',
              dataIndex: 'active',
              width: 100,
              render: (value: boolean, row) => (
                <Switch checked={value} onChange={(checked) => void toggleActive(row, checked)} />
              ),
            },
            {
              title: '操作',
              width: 140,
              render: (_, row) => (
                <Button size="small" onClick={() => void refreshPolygon(row)}>刷新边界</Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
