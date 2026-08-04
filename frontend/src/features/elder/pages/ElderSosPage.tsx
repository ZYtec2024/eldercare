import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, Segmented, Select, Space, Tag, Typography } from 'antd'
import { AimOutlined, AlertOutlined, EnvironmentOutlined, PhoneOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { createEmergencyIncident, fetchEmergencyIncidents, type EmergencyIncident } from '@/services/adapters/elder-adapter'
import { fetchDispatchTracking, updateElderDispatchLocation } from '@/services/adapters/dispatch-adapter'
import { resolveBrowserLocation, type ResolvedLiveLocation } from '@/services/adapters/profile-adapter'
import { captureBrowserLocation, formatAccuracyHint, type BrowserGeoFix } from '@/utils/browser-geolocation'

const volunteerSkillOptions = [
  { value: 'emergency_response', label: '急救响应' },
  { value: 'medical_support', label: '医疗陪护' },
  { value: 'mobility_assist', label: '行动辅助' },
  { value: 'errand', label: '代办采购' },
  { value: 'companion', label: '陪伴沟通' },
  { value: 'rehab', label: '康复训练' },
  { value: 'digital_assist', label: '智能设备协助' },
  { value: 'grooming', label: '生活照护' },
]

function statusLabel(status: string) {
  if (status === 'reported') return '已通知家人，请稍等'
  if (status === 'acknowledged') return '社区已收到，正在处理'
  if (status === 'dispatching') return '正在找志愿者上门'
  return '这件事已经结束'
}

export default function ElderSosPage() {
  const { session } = useSession()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [showVolunteerForm, setShowVolunteerForm] = useState(false)
  const [incidents, setIncidents] = useState<EmergencyIncident[]>([])
  const [defaultAddress, setDefaultAddress] = useState('尚未设置当前地址')
  const [locationMode, setLocationMode] = useState<'address' | 'live'>('address')
  const [draftLive, setDraftLive] = useState<ResolvedLiveLocation | null>(null)
  const [locationAccuracy, setLocationAccuracy] = useState<number | null>(null)
  const [locationSource, setLocationSource] = useState<BrowserGeoFix['source'] | null>(null)
  const [confirmedMode, setConfirmedMode] = useState<'address' | 'live' | null>(null)
  const [confirmedLive, setConfirmedLive] = useState<ResolvedLiveLocation | null>(null)
  const [locating, setLocating] = useState(false)
  const [form] = Form.useForm()

  const locationConfirmed = confirmedMode === locationMode
    && (locationMode === 'address' || (locationMode === 'live' && !!confirmedLive && confirmedLive.lng === draftLive?.lng && confirmedLive.lat === draftLive?.lat))

  const loadIncidents = () => {
    if (!session) return
    fetchEmergencyIncidents(session.userId).then(setIncidents).catch(() => {})
  }

  useEffect(() => {
    loadIncidents()
    const timer = window.setInterval(loadIncidents, 5000)
    return () => window.clearInterval(timer)
  }, [session?.userId])

  const refreshDefaultAddress = async (): Promise<string> => {
    if (!session) return defaultAddress
    try {
      const tracking = await fetchDispatchTracking('elder', session.userId)
      const elder = tracking.elders[0]
      const next = elder?.default_address || elder?.address || '尚未设置当前地址'
      setDefaultAddress((prev) => {
        if (prev && prev !== next && confirmedMode === 'address') {
          setConfirmedMode(null)
        }
        return next
      })
      return next
    } catch {
      return defaultAddress
    }
  }

  useEffect(() => {
    void refreshDefaultAddress()
    const onFocus = () => { void refreshDefaultAddress() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [session?.userId])

  const switchMode = (value: 'address' | 'live') => {
    setLocationMode(value)
    if (value === 'live' && confirmedMode === 'live' && confirmedLive) {
      setDraftLive(confirmedLive)
    }
  }

  const locateLive = (interactive: boolean) => {
    if (!session) return
    if (interactive) setLocating(true)
    captureBrowserLocation()
      .then((fix) =>
        resolveBrowserLocation(session.userId, 'elder', fix.lng, fix.lat, { fromGps: fix.fromGps }).then(async (resolved) => {
          await updateElderDispatchLocation({
            userId: session.userId,
            lng: resolved.lng,
            lat: resolved.lat,
            address: resolved.formattedAddress,
            source: 'browser_gps',
            syncDisplay: false,
          })
          setDraftLive(resolved)
          setLocationAccuracy(fix.accuracyMeters)
          setLocationSource(fix.source)
          if (interactive) setLocationMode('live')
          if (interactive && confirmedMode === 'live') {
            setConfirmedMode(null)
            setConfirmedLive(null)
          }
          if (interactive) message.success(`${formatAccuracyHint(fix.accuracyMeters, fix.source)}，请点确认`)
        }),
      )
      .catch((err: any) => { if (interactive) message.warning(err?.message || '定位失败，可改用默认地址') })
      .finally(() => { if (interactive) setLocating(false) })
  }

  const captureLiveLocation = () => locateLive(true)

  useEffect(() => {
    locateLive(false)
  }, [session?.userId])

  const confirmLocation = async () => {
    if (locationMode === 'address') {
      const latest = await refreshDefaultAddress()
      if (!latest || latest.includes('尚未设置')) {
        message.warning('请先在个人中心设置默认地址')
        return
      }
      setDefaultAddress(latest)
      setConfirmedMode('address')
      setConfirmedLive(null)
      message.success('已确认使用默认地址')
      return
    }
    if (!draftLive) {
      message.warning('请先获取实时位置')
      return
    }
    setConfirmedMode('live')
    setConfirmedLive(draftLive)
    message.success('已确认实时位置')
  }

  const remindConfirmLocation = () => {
    modal.warning({
      title: '必须确认地址',
      content: locationMode === 'live'
        ? (!draftLive
          ? '发出求助前，请先获取实时位置并点「确认本次地址」。'
          : '请先点击「确认本次地址」，确认后再发出求助。')
        : '发出求助前，请先确认服务地址。也可切换实时位置后再确认。',
      okText: '知道了',
      centered: true,
    })
  }

  const submit = async (dispatchService: boolean) => {
    if (!session) return
    if (!locationConfirmed) {
      remindConfirmLocation()
      return
    }
    const values = dispatchService
      ? await form.validateFields()
      : { incidentType: 'general_help', description: '一键紧急求助' }
    setLoading(true)
    try {
      await createEmergencyIncident({
        reporterUserId: session.userId,
        incidentType: values.incidentType,
        description: values.description,
        dispatchService,
        requiredSkills: values.requiredSkills,
        locationMode: locationMode === 'live' ? 'current' : 'address',
        lng: locationMode === 'live' ? confirmedLive?.lng : undefined,
        lat: locationMode === 'live' ? confirmedLive?.lat : undefined,
        address: locationMode === 'live'
          ? confirmedLive?.formattedAddress
          : defaultAddress,
      })
      message.success(dispatchService ? '已通知家人，并开始帮您找志愿者' : '已通知家人和社区')
      if (dispatchService) {
        form.resetFields()
        setShowVolunteerForm(false)
      }
      loadIncidents()
    } catch (err: any) {
      message.error(err?.message || '求助发送失败，请再试一次')
    } finally {
      setLoading(false)
    }
  }

  const handleOneClickAlert = () => {
    if (!locationConfirmed) {
      remindConfirmLocation()
      return
    }
    modal.confirm({
      title: '确认发出求助？',
      content: '会马上通知您的家人和本社区工作人员。如果有生命危险，请同时拨打 120。',
      okText: '确认求助',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => submit(false),
    })
  }

  const locationCard = (
    <Card size="small" className="!rounded-xl" title={<Space><EnvironmentOutlined />本次求助位置（必填）</Space>}>
      <Segmented
        block
        value={locationMode}
        options={[
          { label: '使用默认地址', value: 'address' },
          { label: '使用实时位置', value: 'live' },
        ]}
        onChange={(value) => switchMode(value as 'address' | 'live')}
      />
      <div className="mt-3 rounded-xl bg-slate-50 p-3 text-base text-slate-700">
        {locationMode === 'live'
          ? (draftLive?.formattedAddress || '尚未获取实时位置')
          : defaultAddress}
        {locationMode === 'live' && locationAccuracy != null ? (
          <div className="mt-1 text-sm text-slate-500">{formatAccuracyHint(locationAccuracy, locationSource || undefined)}</div>
        ) : null}
        <div className="mt-1 text-sm text-slate-500">
          {locationConfirmed
            ? (locationMode === 'live' ? '已确认实时位置' : '已确认默认地址')
            : (locationMode === 'live' ? '定位后请点确认' : '请确认后才能发出求助')}
        </div>
      </div>
      {locationMode === 'live' ? (
        <Button className="mt-3" block icon={<AimOutlined />} loading={locating} onClick={captureLiveLocation}>
          {draftLive ? '重新定位' : '获取实时位置'}
        </Button>
      ) : (
        <Button className="mt-3" block onClick={() => navigate('/profile')}>去个人中心改默认地址</Button>
      )}
      <Button className="mt-2" type="primary" block onClick={confirmLocation}>确认本次地址</Button>
      {!locationConfirmed ? (
        <div className="mt-2 text-center text-sm text-amber-700">通知家人或找志愿者前，都必须先确认地址</div>
      ) : null}
    </Card>
  )

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Typography.Title level={2} className="!mb-1">紧急求助</Typography.Title>
        <Typography.Text className="text-gray-500 text-base">
          先确认位置，再通知家人；需要上门时再补充说明并找志愿者。
        </Typography.Text>
      </div>

      <Alert
        type="error"
        showIcon
        icon={<PhoneOutlined />}
        message="有生命危险请先拨打 120"
        description="本平台会通知家人和社区，但不能代替急救电话。"
      />

      {locationCard}

      <Card className="!rounded-2xl !border-2 !border-red-300 !bg-red-50">
        <div className="text-center space-y-4 py-2">
          <AlertOutlined className="text-5xl text-red-500" />
          <Typography.Title level={3} className="!mb-0">我需要帮助</Typography.Title>
          <Typography.Paragraph className="!text-base !text-gray-700 !mb-0">
            确认地址后，一键通知家人和社区工作人员。
          </Typography.Paragraph>
          <Button
            danger
            type="primary"
            size="large"
            block
            loading={loading}
            disabled={!locationConfirmed}
            className="!h-14 !text-xl !font-semibold"
            onClick={handleOneClickAlert}
          >
            马上通知家人
          </Button>
        </div>
      </Card>

      <Card className="!rounded-2xl">
        {!showVolunteerForm ? (
          <div className="space-y-3">
            <Typography.Text className="text-base text-gray-700">
              还需要志愿者上门帮忙？（例如陪同就医、跌倒起身）
            </Typography.Text>
            <Button size="large" block disabled={!locationConfirmed} onClick={() => setShowVolunteerForm(true)}>
              是的，还要找志愿者
            </Button>
            {!locationConfirmed ? (
              <div className="text-center text-sm text-amber-700">请先在上方确认本次求助位置</div>
            ) : null}
          </div>
        ) : (
          <Form form={form} layout="vertical" initialValues={{ incidentType: 'unwell', requiredSkills: ['emergency_response', 'medical_support'] }}>
            <Typography.Title level={4} className="!mt-0">说明一下情况</Typography.Title>
            <Alert
              className="!mb-4"
              type="info"
              showIcon
              message={locationMode === 'live' ? '将使用已确认的实时位置派单' : '将使用已确认的默认地址派单'}
              description={locationMode === 'live'
                ? (confirmedLive?.formattedAddress || '已确认实时位置')
                : defaultAddress}
            />
            <Form.Item name="incidentType" label="遇到了什么" rules={[{ required: true }]}>
              <Select
                size="large"
                options={[
                  { value: 'fall', label: '跌倒或起不来' },
                  { value: 'unwell', label: '身体不舒服' },
                  { value: 'hospital', label: '要人陪着去医院' },
                  { value: 'lost_risk', label: '怕走丢、迷路' },
                  { value: 'other', label: '其他紧急情况' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="requiredSkills"
              label="想找什么类型的志愿者"
              rules={[{ required: true, message: '请至少选一种能力' }]}
            >
              <Select mode="multiple" size="large" options={volunteerSkillOptions} placeholder="可多选" />
            </Form.Item>
            <Form.Item
              name="description"
              label="说明情况"
              rules={[{ required: true, message: '请简单说一下需要什么帮助' }]}
            >
              <Input.TextArea
                rows={3}
                maxLength={500}
                placeholder="例如：头晕站不稳，希望有人陪我去医院"
                className="!text-base"
              />
            </Form.Item>
            <Space direction="vertical" className="w-full" size="middle">
              <Button
                type="primary"
                danger
                size="large"
                block
                loading={loading}
                className="!h-12"
                onClick={() => {
                  if (!locationConfirmed) {
                    remindConfirmLocation()
                    return
                  }
                  void submit(true)
                }}
              >
                通知家人，并找志愿者
              </Button>
              <Button size="large" block onClick={() => setShowVolunteerForm(false)}>
                返回
              </Button>
            </Space>
          </Form>
        )}
      </Card>

      <Card className="!rounded-2xl" title="求助进度">
        {incidents.length ? (
          <div className="space-y-3">
            {incidents.slice(0, 5).map((incident) => {
              const active = incident.status !== 'resolved'
              return (
                <div key={incident.incidentId} className="rounded-xl border border-slate-100 p-4">
                  <Space wrap>
                    {active ? (
                      <Tag color="red" className="!text-sm !px-2 !py-0.5">
                        {statusLabel(incident.status)}
                      </Tag>
                    ) : (
                      <Tag color="success" className="!text-sm !px-2 !py-0.5 !border-emerald-300 !bg-emerald-50 !text-emerald-700">
                        这件事已经结束
                      </Tag>
                    )}
                    <span className="text-gray-500">{incident.createdAt}</span>
                  </Space>
                  <div className="mt-2 text-base text-slate-700">{incident.description}</div>
                  {incident.address ? (
                    <div className="mt-1 text-sm text-slate-500">服务位置：{incident.address}</div>
                  ) : null}
                  {incident.resolutionSummary ? (
                    <div className="mt-1 text-sm text-emerald-700">结果：{incident.resolutionSummary}</div>
                  ) : null}
                  {active && incident.conversationId ? (
                    <Button
                      className="mt-3"
                      size="large"
                      type="default"
                      onClick={() => navigate(`/conversations?id=${incident.conversationId}`)}
                    >
                      打开求助群聊
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <Typography.Text type="secondary" className="text-base">
            暂时还没有求助记录。
          </Typography.Text>
        )}
      </Card>
    </div>
  )
}
