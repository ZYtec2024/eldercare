import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AutoComplete, Button, Card, Form, Input, InputNumber, Select, DatePicker, Typography, App, Tag,
  Modal, Alert, Segmented, Space,
} from 'antd'
import { ClockCircleOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

import { useSession } from '@/features/auth/useSession'
import {
  fetchFamilyElders, createFamilyServiceRequest,
  fetchFamilyElderAddresses, addFamilyElderAddress, updateFamilyElderAddress, selectFamilyElderAddress,
} from '@/services/adapters/family-adapter'
import { fetchAddressSuggestions, type AddressPoiSuggestion, type ElderAddress } from '@/services/adapters/profile-adapter'
import { fetchPublicRegionChildren, type PublicRegionNode } from '@/services/adapters/auth-adapter'
import type { ElderSummary } from '@/types/domain'

type Props = {
  onPublished?: () => void
}

export default function FamilyProxyOrderForm({ onPublished }: Props) {
  const { session } = useSession()
  const { message } = App.useApp()
  const [elders, setElders] = useState<ElderSummary[]>([])
  const [publishing, setPublishing] = useState(false)
  const [addresses, setAddresses] = useState<ElderAddress[]>([])
  const [currentPointAddress, setCurrentPointAddress] = useState('')
  const [currentPointLive, setCurrentPointLive] = useState(false)
  const [hasCurrentPoint, setHasCurrentPoint] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
  const [editingAddress, setEditingAddress] = useState<ElderAddress | null>(null)
  const [addressSaving, setAddressSaving] = useState(false)
  const [provinces, setProvinces] = useState<PublicRegionNode[]>([])
  const [cities, setCities] = useState<PublicRegionNode[]>([])
  const [districts, setDistricts] = useState<PublicRegionNode[]>([])
  const [poiSuggestions, setPoiSuggestions] = useState<AddressPoiSuggestion[]>([])
  const [selectedPoi, setSelectedPoi] = useState<AddressPoiSuggestion | null>(null)
  const [poiSearching, setPoiSearching] = useState(false)
  const poiTimerRef = useRef<number | null>(null)
  const [form] = Form.useForm()
  const [addressForm] = Form.useForm()
  const selectedElderId = Form.useWatch('elderId', form)
  const locationMode = Form.useWatch('locationMode', form) as 'current' | 'address' | undefined
  const selectedElder = useMemo(
    () => elders.find((item) => item.elderId === selectedElderId),
    [elders, selectedElderId],
  )

  const reloadElders = () => {
    if (!session) return
    fetchFamilyElders(session.userId).then(setElders).catch(() => setElders([]))
  }

  const loadAddresses = async (elderId: number) => {
    if (!session) return
    const result = await fetchFamilyElderAddresses(session.userId, elderId)
    setAddresses(result.addresses)
    const point = result.currentServicePoint
    const elder = elders.find((item) => item.elderId === elderId)
    const addressText = String(point?.address || '').trim()
      || String(elder?.currentServiceAddress || '').trim()
      || ''
    setHasCurrentPoint(Boolean(point))
    setCurrentPointLive(Boolean(point?.isLive || elder?.hasLiveLocation))
    setCurrentPointAddress(addressText || (point ? '当前服务点已定位（地址解析中）' : ''))
    const current = result.addresses.find((item) => item.isCurrent)
    form.setFieldsValue({
      addressId: current?.addressId,
      locationMode: point ? 'current' : 'address',
    })
  }

  useEffect(() => {
    reloadElders()
  }, [session?.userId])

  useEffect(() => {
    fetchPublicRegionChildren().then(setProvinces).catch(() => setProvinces([]))
  }, [])

  useEffect(() => {
    if (!selectedElderId) {
      setAddresses([])
      setCurrentPointAddress('')
      setHasCurrentPoint(false)
      setCurrentPointLive(false)
      return
    }
    loadAddresses(selectedElderId).catch((err: any) => {
      message.error(err?.message || '加载长辈地址失败')
      setAddresses([])
    })
  }, [selectedElderId, session?.userId])

  useEffect(() => {
    if (!selectedElder) return
    if (selectedElder.currentServiceAddress) {
      setCurrentPointAddress(selectedElder.currentServiceAddress)
      setCurrentPointLive(Boolean(selectedElder.hasLiveLocation))
      setHasCurrentPoint(Boolean(selectedElder.hasCurrentServicePoint || selectedElder.hasLiveLocation))
    }
  }, [selectedElder])

  const handlePublish = async (values: any) => {
    if (!session) return
    if (values.locationMode === 'address' && !values.addressId) {
      message.warning('请先选择一个长辈地址，或添加新地址')
      return
    }
    if (values.locationMode === 'current' && !hasCurrentPoint) {
      message.warning('长辈暂无当前服务点，请改选其他位置')
      return
    }
    setPublishing(true)
    try {
      await createFamilyServiceRequest({
        familyUserId: session.userId,
        elderId: values.elderId,
        serviceType: values.serviceType,
        serviceTime: values.serviceTime.format('YYYY-MM-DD HH:mm:ss'),
        serviceHours: values.serviceHours,
        locationMode: values.locationMode || 'current',
        addressId: values.locationMode === 'address' ? values.addressId : undefined,
        notes: values.notes || '',
      })
      message.success('已为长辈下单，长辈端会看到代下单提示')
      form.resetFields()
      form.setFieldsValue({ serviceHours: 1, serviceTime: dayjs(), locationMode: 'current' })
      setCurrentPointAddress('')
      setHasCurrentPoint(false)
      onPublished?.()
    } catch (err: any) {
      message.error(err?.message || '下单失败')
    } finally {
      setPublishing(false)
    }
  }

  const chooseAddressProvince = async (provinceAdcode: string) => {
    const province = provinces.find((item) => item.adcode === provinceAdcode)
    addressForm.setFieldsValue({
      provinceName: province?.name,
      cityAdcode: undefined,
      cityName: undefined,
      regionAdcode: undefined,
      districtName: undefined,
      poiKeyword: undefined,
    })
    setSelectedPoi(null)
    setPoiSuggestions([])
    const children = await fetchPublicRegionChildren(provinceAdcode)
    const directDistricts = children.filter((item) => item.level === 'district' || item.level === 'biz_area')
    if (directDistricts.length) {
      setCities([{ adcode: provinceAdcode, name: '市辖区', level: 'city' }])
      setDistricts(directDistricts)
      addressForm.setFieldsValue({ cityAdcode: provinceAdcode, cityName: '市辖区' })
    } else {
      setCities(children)
      setDistricts([])
    }
  }

  const chooseAddressCity = async (cityAdcode: string) => {
    const city = cities.find((item) => item.adcode === cityAdcode)
    addressForm.setFieldsValue({
      cityName: city?.name,
      regionAdcode: undefined,
      districtName: undefined,
      poiKeyword: undefined,
    })
    setSelectedPoi(null)
    setPoiSuggestions([])
    setDistricts((await fetchPublicRegionChildren(cityAdcode)).filter((item) => ['district', 'biz_area', 'city'].includes(item.level)))
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

  const openNewAddress = () => {
    if (!selectedElderId) {
      message.warning('请先选择长辈')
      return
    }
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

  const saveAddress = async () => {
    if (!session || !selectedElderId) return
    setAddressSaving(true)
    try {
      const values = await addressForm.validateFields()
      const payload = {
        familyUserId: session.userId,
        elderId: selectedElderId,
        label: values.label,
        provinceName: values.provinceName,
        cityName: values.cityName,
        districtName: values.districtName,
        regionAdcode: values.regionAdcode,
        detailAddress: selectedPoi?.name || values.poiKeyword,
        addressSupplement: values.addressSupplement,
        poi: selectedPoi || undefined,
        isCurrent: editingAddress ? editingAddress.isCurrent : true,
      }
      const result = editingAddress
        ? await updateFamilyElderAddress({ ...payload, addressId: editingAddress.addressId })
        : await addFamilyElderAddress(payload)
      message.success(`${result.message || '地址已保存'}（老人端同步可见）`)
      setAddressOpen(false)
      setEditingAddress(null)
      reloadElders()
      await loadAddresses(selectedElderId)
    } catch (err: any) {
      if (!err?.errorFields) message.error(err?.message || '保存地址失败')
    } finally {
      setAddressSaving(false)
    }
  }

  const setAsCurrent = async (addressId: number) => {
    if (!session || !selectedElderId) return
    try {
      message.success((await selectFamilyElderAddress({
        familyUserId: session.userId,
        elderId: selectedElderId,
        addressId,
      })).message)
      reloadElders()
      await loadAddresses(selectedElderId)
      form.setFieldsValue({ addressId, locationMode: 'address' })
    } catch (err: any) {
      message.error(err?.message || '切换失败')
    }
  }

  const elderOptions = elders.map((e) => {
    const place = e.currentServiceAddress || e.addressPreview || e.defaultAddress || '地址待补充'
    const tag = e.hasLiveLocation ? '实时' : '服务点'
    return { value: e.elderId, label: `${e.name}（${tag}：${place}）` }
  })

  return (
    <>
      <Card title="为长辈填写服务需求" className="!rounded-2xl">
        <Form
          form={form}
          layout="vertical"
          onFinish={handlePublish}
          size="large"
          className="max-w-2xl"
          initialValues={{ serviceHours: 1, serviceTime: dayjs(), locationMode: 'current' }}
        >
          <Form.Item name="elderId" label="选择长辈" rules={[{ required: true, message: '请选择长辈' }]}>
            <Select
              placeholder="请先选择长辈，会显示其当前服务点/实时位置"
              options={elderOptions}
              optionFilterProp="label"
              showSearch
            />
          </Form.Item>
          {selectedElder?.liveLocationHint ? (
            <Alert className="mb-4" type={selectedElder.hasLiveLocation ? 'warning' : 'info'} showIcon message={selectedElder.liveLocationHint} />
          ) : null}
          <Form.Item name="serviceType" label="服务类型" rules={[{ required: true, message: '请选择服务类型' }]}>
            <Select placeholder="请选择" options={[
              { value: '陪同就医', label: '陪同就医' },
              { value: '上门陪聊', label: '上门陪聊' },
              { value: '代买药品', label: '代买药品' },
              { value: '代购物资', label: '代购物资' },
              { value: '上门理发', label: '上门理发' },
              { value: '陪同复诊', label: '陪同复诊' },
              { value: '康复训练', label: '康复训练' },
              { value: '健康咨询', label: '健康咨询' },
              { value: '智能设备协助', label: '智能设备协助' },
            ]} />
          </Form.Item>
          <div className="grid grid-cols-2 gap-x-4">
            <Form.Item label="服务时间" extra="选现在：立刻找人。选更晚时间：到点才找人。">
              <div className="flex gap-2">
                <Form.Item name="serviceTime" noStyle rules={[{ required: true, message: '请选择时间' }]}>
                  <DatePicker showTime className="!w-full" placeholder="选择日期时间" format="YYYY-MM-DD HH:mm" />
                </Form.Item>
                <Button icon={<ClockCircleOutlined />} onClick={() => form.setFieldValue('serviceTime', dayjs())}>现在</Button>
              </div>
            </Form.Item>
            <Form.Item name="serviceHours" label="预计时长(小时)" rules={[{ required: true, message: '请输入时长' }]}>
              <InputNumber min={0.5} step={0.5} className="!w-full" placeholder="如 2" />
            </Form.Item>
          </div>

          <Form.Item name="locationMode" label="服务地址" rules={[{ required: true, message: '请选择地址来源' }]}>
            <Segmented
              block
              disabled={!selectedElderId}
              options={[
                { label: '当前服务点', value: 'current', disabled: selectedElderId ? !hasCurrentPoint : true },
                { label: '其他位置', value: 'address' },
              ]}
            />
          </Form.Item>

          {!selectedElderId ? (
            <Alert className="mb-4" type="warning" showIcon message="请先选择长辈，才能查看当前服务点或添加地址" />
          ) : locationMode === 'current' ? (
            <div className="mb-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
              {hasCurrentPoint ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">当前服务点</span>
                    <Tag color={currentPointLive ? 'gold' : 'blue'}>{currentPointLive ? '实时位置' : '服务点'}</Tag>
                  </div>
                  <div className="mt-2 leading-6">{currentPointAddress || '地址待补充'}</div>
                </>
              ) : (
                <div>暂无当前服务点，请改选「其他位置」或请长辈更新定位</div>
              )}
            </div>
          ) : (
            <div className="mb-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Typography.Text>长辈全部地址（与老人端同步）</Typography.Text>
                <Button size="small" icon={<PlusOutlined />} onClick={openNewAddress}>帮长辈添加地址</Button>
              </div>
              <Form.Item name="addressId" rules={[{ required: true, message: '请选择一个地址' }]}>
                <Select
                  placeholder="请选择服务地址"
                  options={addresses.map((item) => ({
                    value: item.addressId,
                    label: `${item.label}${item.isCurrent ? '（当前）' : ''} · ${item.fullAddress}`,
                  }))}
                />
              </Form.Item>
              <div className="space-y-2">
                {addresses.map((address) => (
                  <div key={address.addressId} className={`rounded-xl border p-3 ${address.isCurrent ? 'border-blue-300 bg-blue-50' : 'border-slate-200'}`}>
                    <div className="font-medium">{address.label} {address.isCurrent ? <Tag color="blue">当前</Tag> : null}</div>
                    <div className="mt-1 text-sm text-slate-600">{address.fullAddress}</div>
                    <Space className="mt-2">
                      <Button size="small" icon={<EditOutlined />} onClick={() => void openEditAddress(address)}>编辑</Button>
                      {!address.isCurrent ? <Button size="small" onClick={() => void setAsCurrent(address.addressId)}>设为当前服务点</Button> : null}
                      <Button size="small" type="link" onClick={() => form.setFieldsValue({ addressId: address.addressId })}>用于本单</Button>
                    </Space>
                  </div>
                ))}
                {!addresses.length ? <Typography.Text type="secondary">暂无地址，请先添加。</Typography.Text> : null}
              </div>
            </div>
          )}

          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="如：需要带轮椅" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={publishing} size="large">确认代长辈下单</Button>
        </Form>
      </Card>

      <Modal
        title={editingAddress ? '编辑长辈地址' : '帮长辈添加地址'}
        open={addressOpen}
        onCancel={() => { setAddressOpen(false); setEditingAddress(null); setSelectedPoi(null); setPoiSuggestions([]); addressForm.resetFields() }}
        onOk={() => void saveAddress()}
        confirmLoading={addressSaving}
        okText={editingAddress ? '核验并更新' : '核验并保存'}
        destroyOnClose
      >
        <Alert className="mb-3" type="info" showIcon message="保存后老人端地址簿同步更新" />
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
          <Form.Item name="poiKeyword" label="搜索并选择地图地点" rules={[{ required: true, message: '请输入并选择地点' }]}>
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
              notFoundContent={poiSearching ? '正在搜索高德地点…' : '可继续输入关键词'}
              placeholder="例如：上海大学、锦秋花园"
            />
          </Form.Item>
          <Form.Item name="addressSupplement" label="楼栋 / 门牌 / 房间（可补充）">
            <Input placeholder="例如：1号楼301室" />
          </Form.Item>
          <Form.Item name="provinceName" hidden><Input /></Form.Item>
          <Form.Item name="cityName" hidden><Input /></Form.Item>
          <Form.Item name="districtName" hidden><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}
