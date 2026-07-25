import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Card, DatePicker, Form, Input, InputNumber, Segmented, Select, Space, Tag, Typography } from 'antd'
import { ClockCircleOutlined } from '@ant-design/icons'
import { AimOutlined, EnvironmentOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import { LiveArrivalEstimate } from '@/features/dispatch/components/LiveArrivalEstimate'
import type { DispatchTracking } from '@/features/dispatch/dispatch-types'
import { useSession } from '@/features/auth/useSession'
import { cancelElderDispatchOrder, completeElderDispatchOrder, createDispatchOrder, fetchDispatchTracking, redispatchDispatchOrder, requestAdminForDispatchOrder } from '@/services/adapters/dispatch-adapter'
import { resolveBrowserLocation, type ResolvedLiveLocation } from '@/services/adapters/profile-adapter'
import { captureBrowserLocation, formatAccuracyHint, type BrowserGeoFix } from '@/utils/browser-geolocation'

const stateLabel: Record<string, string> = {
  matching: '正在找人', waiting_response: '等待志愿者答应', accepted: '志愿者正在赶来', serving: '志愿者正在帮忙',
  forced_assigned: '已安排紧急志愿者', completed: '已经完成', admin_escalated: '社区正在协助', queued_waiting_capacity: '稍等，合适的人忙完就来',
  scheduled: '已预约，到点再找人', cancelled: '已取消',
}
const phaseLabel: Record<string, string> = { top1: '正在联系最近的人', top3: '正在扩大寻找', top10: '继续寻找志愿者', fallback: '社区会帮忙安排', scheduled: '等待预约时间' }
const volunteerStateLabel: Record<string, string> = { idle: '空闲', en_route: '正在前往', serving: '正在服务', returning: '正在返家', offline: '离线' }
const volunteerStateColor: Record<string, string> = { idle: 'green', en_route: 'blue', serving: 'purple', returning: 'magenta', offline: 'default' }
const skillLabel: Record<string, string> = { medical_support: '医疗陪护', emergency_response: '急救响应', mobility_assist: '行动辅助', errand: '代办采购', rehab: '康复训练', companion: '陪伴沟通', digital_assist: '智能设备协助', grooming: '生活照护' }

export default function ElderDispatchPage() {
  const { session } = useSession()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const [form] = Form.useForm()
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [sending, setSending] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState<number | null>(null)
  const [completingOrder, setCompletingOrder] = useState<number | null>(null)
  const [redispatchingOrder, setRedispatchingOrder] = useState<number | null>(null)
  const [requestingAdminOrder, setRequestingAdminOrder] = useState<number | null>(null)
  const [locationMode, setLocationMode] = useState<'address' | 'live'>('address')
  const [draftLive, setDraftLive] = useState<ResolvedLiveLocation | null>(null)
  const [locationAccuracy, setLocationAccuracy] = useState<number | null>(null)
  const [locationSource, setLocationSource] = useState<BrowserGeoFix['source'] | null>(null)
  const [confirmedMode, setConfirmedMode] = useState<'address' | 'live' | null>(null)
  const [confirmedLive, setConfirmedLive] = useState<ResolvedLiveLocation | null>(null)
  const [locating, setLocating] = useState(false)

  const load = async () => {
    if (!session) return
    const data = await fetchDispatchTracking('elder', session.userId)
    setTracking(data)
  }
  useEffect(() => { load().catch(() => {}); const timer = window.setInterval(() => load().catch(() => {}), 1200); return () => window.clearInterval(timer) }, [session?.userId])

  const elderProfile = tracking?.elders[0]
  const defaultAddress = elderProfile?.default_address || elderProfile?.address || '尚未设置当前地址'
  const locationConfirmed = confirmedMode === locationMode
    && (locationMode === 'address' || (locationMode === 'live' && !!confirmedLive && confirmedLive.lng === draftLive?.lng && confirmedLive.lat === draftLive?.lat))

  const mapOverview = useMemo(() => {
    if (!tracking) return null
    if (locationMode === 'live' && draftLive) {
      const elders = tracking.elders.map((item, index) => (
        index === 0
          ? { ...item, lng: draftLive.lng, lat: draftLive.lat, address: draftLive.formattedAddress, location_source: 'browser_gps', is_home_fixed: false }
          : item
      ))
      return { ...tracking, elders }
    }
    if (locationMode === 'address' && elderProfile?.default_lng != null && elderProfile?.default_lat != null) {
      const elders = tracking.elders.map((item, index) => (
        index === 0
          ? {
              ...item,
              lng: Number(elderProfile.default_lng),
              lat: Number(elderProfile.default_lat),
              address: defaultAddress,
              location_source: 'address_book',
              is_home_fixed: true,
            }
          : item
      ))
      return { ...tracking, elders }
    }
    return tracking
  }, [tracking, locationMode, draftLive, elderProfile, defaultAddress])

  const proxyOrders = (tracking?.orders ?? []).filter(
    (order) => order.proxy_created_by && ['pending', 'accepted', 'in_progress'].includes(order.status),
  )

  const switchMode = (value: 'address' | 'live') => {
    setLocationMode(value)
    if (value === 'live' && confirmedMode === 'live' && confirmedLive) {
      setDraftLive(confirmedLive)
    }
  }

  const captureLiveLocation = () => {
    if (!session) return
    setLocating(true)
    captureBrowserLocation()
      .then((fix) =>
        resolveBrowserLocation(session.userId, 'elder', fix.lng, fix.lat, { fromGps: fix.fromGps }).then((resolved) => {
          // Preview only — do not persist into default address / elders.address.
          setDraftLive(resolved)
          setLocationAccuracy(fix.accuracyMeters)
          setLocationSource(fix.source)
          setLocationMode('live')
          if (confirmedMode === 'live') {
            setConfirmedMode(null)
            setConfirmedLive(null)
          }
          message.success(`${formatAccuracyHint(fix.accuracyMeters, fix.source)}，请点确认`)
        }),
      )
      .catch((err: any) => {
        const text = String(err?.message || '')
        if (
          text.includes('安全环境')
          || text.includes('localhost')
          || text.includes('HTTPS')
          || text.includes('授权')
          || text.includes('拦截定位')
          || err?.code === 1
        ) {
          message.warning(text || '当前环境无法定位，请改用默认地址')
        } else if (text.includes('定位') || text.includes('超时') || text.includes('不可用')) {
          message.warning(text)
        } else {
          message.error(text || '该区域尚未开通服务，无法使用实时位置')
        }
      })
      .finally(() => setLocating(false))
  }

  const confirmLocation = () => {
    if (locationMode === 'address') {
      if (!elderProfile?.default_address && !elderProfile?.address) {
        message.warning('请先在个人中心设置默认地址')
        return
      }
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
    const content = locationMode === 'live'
      ? (!draftLive
        ? '请先点击「获取实时位置」，再点「确认本次地址」，然后才能开始找人。'
        : '请先点击「确认本次地址」，确认后才能开始找人。')
      : '请先点击「确认本次地址」，确认服务位置后才能开始找人。也可切换实时位置后再确认。'
    modal.warning({
      title: '必须确认地址',
      content,
      okText: '知道了',
      centered: true,
    })
  }

  const submit = async (values: { serviceType: string; serviceHours?: number; serviceTime?: dayjs.Dayjs; notes?: string; requiredSkills?: string[] }) => {
    if (!session) return
    if (!locationConfirmed || (locationMode === 'live' && !confirmedLive)) {
      remindConfirmLocation()
      return
    }
    setSending(true)
    try {
      const selected = tracking?.service_catalog.find((item) => item.code === values.serviceType)
      const requiredSkills = (values.requiredSkills?.length
        ? values.requiredSkills
        : selected?.skills) || []
      const serviceTime = (values.serviceTime || dayjs()).format('YYYY-MM-DD HH:mm:ss')
      const result = await createDispatchOrder({
        userId: session.userId,
        serviceType: values.serviceType,
        serviceHours: values.serviceHours,
        serviceTime,
        notes: values.notes,
        requiredSkills,
        locationMode,
        lng: confirmedLive?.lng,
        lat: confirmedLive?.lat,
      })
      message.success(result.message)
      form.resetFields(['notes', 'requiredSkills'])
      form.setFieldsValue({ serviceTime: dayjs() })
      await load()
    } catch (err: any) { message.error(err?.message || '请求创建失败') } finally { setSending(false) }
  }
  const cancelOrder = async (orderId: number) => {
    if (!session) return
    setCancellingOrder(orderId)
    try { const result = await cancelElderDispatchOrder(orderId, session.userId); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '取消订单失败') } finally { setCancellingOrder(null) }
  }
  const completeOrder = async (orderId: number) => {
    if (!session) return
    setCompletingOrder(orderId)
    try { const result = await completeElderDispatchOrder(orderId, session.userId); message.success(result.message); await load() } catch (err: any) { message.error(err?.message || '确认服务完成失败') } finally { setCompletingOrder(null) }
  }
  const redispatchOrder = async (orderId: number) => {
    if (!session) return
    setRedispatchingOrder(orderId)
    try {
      const result = await redispatchDispatchOrder(orderId, session.userId, '服务中出现问题，请换人')
      message.success(result.message)
      await load()
    } catch (err: any) {
      message.error(err?.message || '换人重派失败')
    } finally {
      setRedispatchingOrder(null)
    }
  }
  const requestAdmin = async (orderId: number) => {
    if (!session) return
    setRequestingAdminOrder(orderId)
    try {
      const result = await requestAdminForDispatchOrder(orderId, session.userId, {
        reason: '服务中需要管理员协助',
      })
      message.success(result.message || '已在本群联系管理员')
      if (result.data?.conversation_id) {
        navigate(`/conversations?id=${result.data.conversation_id}`)
      } else {
        await load()
      }
    } catch (err: any) {
      message.error(err?.message || '联系管理员失败')
    } finally {
      setRequestingAdminOrder(null)
    }
  }

  const orders = tracking?.orders ?? []
  const activeOrders = orders.filter((order) => ['pending', 'accepted', 'in_progress'].includes(order.status))

  return <div className="space-y-6">
    <div className="rounded-3xl bg-gradient-to-r from-indigo-700 via-blue-700 to-cyan-700 p-6 text-white shadow-xl">
      <Typography.Title level={2} className="!mb-2 !text-white">请人帮忙</Typography.Title>
      <Typography.Paragraph className="!text-blue-100 !mb-4 !text-base">
        先确认服务地址，再说需要什么帮助。着急时请去「紧急求助」。
      </Typography.Paragraph>
      <Button danger size="large" onClick={() => navigate('/elder/sos')}>我很着急，去紧急求助</Button>
    </div>
    {proxyOrders.length ? (
      <Alert
        showIcon
        type="warning"
        message="家属已为您代下服务单"
        description={proxyOrders.slice(0, 3).map((order) => (
          `${order.proxy_family_name || '家属'} · ${order.service_type} · ${order.address || '已选地址'}`
        )).join('；') + '。可在下方查看进度，也可取消。'}
      />
    ) : null}
    <Alert showIcon type="info" message="大概会怎样" description="系统会先找附近合适的志愿者。有人答应后，您可以在下面看到谁正在赶来；赶来途中可取消，也可确认完成；开始服务后请确认完成。" />
    <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
      <div className="space-y-6">
        <Card className="!rounded-2xl" title={<Space><EnvironmentOutlined />本次派单位置</Space>}>
          <Segmented
            block
            value={locationMode}
            options={[
              { label: '使用默认地址', value: 'address' },
              { label: '使用实时位置', value: 'live' },
            ]}
            onChange={(value) => switchMode(value as 'address' | 'live')}
          />
          <div className="mt-3 rounded-xl bg-slate-50 p-4 text-base text-slate-700">
            {locationMode === 'live'
              ? (draftLive?.formattedAddress || '尚未获取实时位置')
              : defaultAddress}
            {locationMode === 'live' && locationAccuracy != null ? (
              <div className="mt-2 text-sm text-slate-500">{formatAccuracyHint(locationAccuracy, locationSource || undefined)}</div>
            ) : null}
            <div className="mt-2 text-sm text-slate-500">
              {locationConfirmed
                ? (locationMode === 'live' ? '已确认实时位置' : '已确认默认地址')
                : (locationMode === 'live' ? '定位后请点确认' : '请确认后开始找人')}
            </div>
          </div>
          {locationMode === 'live' ? (
            <Space direction="vertical" className="mt-3 w-full" size="small">
              <Button block size="large" icon={<AimOutlined />} loading={locating} onClick={captureLiveLocation}>
                {draftLive ? '重新定位' : '获取实时位置'}
              </Button>
              {confirmedMode === 'live' && !locationConfirmed ? (
                <div className="text-sm text-amber-700">位置已变，请重新点确认</div>
              ) : null}
            </Space>
          ) : (
            <Button className="mt-3" block size="large" onClick={() => navigate('/profile')}>
              去个人中心改默认地址
            </Button>
          )}
          <Button className="mt-3" type="primary" block size="large" onClick={confirmLocation}>
            确认本次地址
          </Button>
        </Card>
        <Card className="!rounded-2xl"><Typography.Title level={4}>我要什么帮助</Typography.Title><Form form={form} layout="vertical" onFinish={submit} initialValues={{ serviceHours: 1, serviceTime: dayjs() }}>
          <Form.Item name="serviceType" label="帮助类型" rules={[{ required: true, message: '请选择' }]}><Select size="large" placeholder="请选择" options={tracking?.service_catalog.filter((item) => !item.urgent).map((item) => ({ value: item.code, label: item.label }))} onChange={(code) => {
            const selected = tracking?.service_catalog.find((item) => item.code === code)
            if (selected?.skills?.length) form.setFieldsValue({ requiredSkills: selected.skills })
          }} /></Form.Item>
          <Form.Item name="requiredSkills" label="想找什么类型的志愿者" rules={[{ required: true, message: '请至少选一种能力' }]}>
            <Select
              mode="multiple"
              size="large"
              placeholder="可多选，例如医疗陪护、行动辅助"
              options={(tracking?.skill_options || Object.entries(skillLabel).map(([code, label]) => ({ code, label }))).map((item) => ({
                value: item.code,
                label: item.label,
              }))}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>{() => { const selected = tracking?.service_catalog.find((item) => item.code === form.getFieldValue('serviceType')); return selected ? <div className="mb-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800"><AimOutlined className="mr-2" />这类帮助通常需要：{selected.skill_labels.map((skill) => <Tag color="blue" key={skill}>{skill}</Tag>)}，您也可以按上面自己改</div> : null }}</Form.Item>
          <Form.Item label="希望什么时候开始" extra="选现在（或约1分钟内）：立刻找人。选任意更晚时间（10分钟后、1小时后都行）：到那个点才开始找志愿者。">
            <div className="flex gap-2">
              <Form.Item name="serviceTime" noStyle rules={[{ required: true, message: '请选择时间' }]}>
                <DatePicker showTime className="!w-full" size="large" format="YYYY-MM-DD HH:mm" disabledDate={(current) => !!current && current.isBefore(dayjs().startOf('day'))} />
              </Form.Item>
              <Button size="large" icon={<ClockCircleOutlined />} onClick={() => form.setFieldValue('serviceTime', dayjs())}>现在</Button>
            </div>
          </Form.Item>
          <Form.Item name="serviceHours" label="大概多久"><InputNumber min={0.5} max={8} step={0.5} className="!w-full" addonAfter="小时" /></Form.Item>
          <Form.Item name="notes" label="说明情况" rules={[{ required: true, message: '请简单说一下情况' }]}>
            <Input.TextArea rows={3} maxLength={500} placeholder="例如：腿脚不便需要扶一把；要带医保卡；家里有宠物请注意" className="!text-base" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={sending}
            icon={<ThunderboltOutlined />}
            onClick={(event) => {
              if (!locationConfirmed) {
                event.preventDefault()
                remindConfirmLocation()
              }
            }}
          >
            开始找人
          </Button>
          {!locationConfirmed ? (
            <div className="mt-2 text-center text-sm text-amber-700">开始找人前，请先上方确认服务地址</div>
          ) : null}
        </Form></Card>
      </div>
      <div><DispatchMap overview={mapOverview} /><div className="mt-3 rounded-xl bg-sky-50 p-3 text-sm text-sky-900">{tracking?.privacy_message || '正在载入位置说明…'}<div className="mt-2"><Tag color="green">绿色：路况好</Tag><Tag color="gold">黄色：有点堵</Tag><Tag color="red">红色：很堵</Tag></div></div></div>
    </div>
    <div>
      <Typography.Title level={3}>进行中的帮助</Typography.Title>
      <div className="grid gap-4 md:grid-cols-2">
        {activeOrders.length ? activeOrders.map((order) => (
          <Card
            key={order.order_id}
            className="!rounded-2xl"
            title={<Space><Tag color={order.urgency === 'sos' ? 'red' : 'blue'}>{order.urgency === 'sos' ? '紧急' : '普通'}</Tag>{order.proxy_created_by ? <Tag color="gold">家属代下</Tag> : null}<span>{order.service_type}</span></Space>}
            extra={<Tag color={order.status === 'accepted' || order.status === 'in_progress' ? 'green' : 'orange'}>{stateLabel[order.dispatch_state] || order.dispatch_state}</Tag>}
          >
            <div className="space-y-2 text-base text-slate-600">
              {order.proxy_created_by ? (
                <div className="rounded-xl bg-amber-50 p-3 text-amber-900">
                  {order.proxy_family_name || '家属'}已为您代下此单
                </div>
              ) : null}
              <div>地点：{order.address || '家里地址'}</div>
              {order.service_time ? <div>约定时间：{order.service_time}</div> : null}
              <div>进度：{phaseLabel[order.dispatch_phase || ''] || '正在安排'}</div>
              <div>来帮忙的人：{order.volunteer_name || '还在寻找中'}</div>
              {order.volunteer_name ? (
                <div className="rounded-xl bg-emerald-50 p-3">
                  <div className="font-medium text-emerald-900">{order.volunteer_name} · 评分 {Number(order.volunteer_rating || 0).toFixed(1)}</div>
                  <Space className="mt-2" wrap>{(order.volunteer_skills || []).map((skill) => <Tag color="green" key={skill}>{skillLabel[skill] || skill}</Tag>)}</Space>
                </div>
              ) : null}
              {order.volunteer_availability && ['en_route', 'serving'].includes(order.volunteer_availability) ? (
                <Tag color={volunteerStateColor[order.volunteer_availability] || 'blue'}>
                  {volunteerStateLabel[order.volunteer_availability] || order.volunteer_availability}
                </Tag>
              ) : null}
              {order.location_sharing_active ? <Tag color="green">正在共享位置</Tag> : null}
              {order.location_sharing_active ? (
                <LiveArrivalEstimate route={tracking?.routes.find((route) => route.order_id === order.order_id)} />
              ) : null}
              <Space wrap>
                {order.amap_navigation_url ? <Button size="large" onClick={() => window.open(order.amap_navigation_url, '_blank', 'noopener,noreferrer')}>查看路线</Button> : null}
                {['accepted', 'in_progress'].includes(order.status) ? (
                  <>
                    <Button size="large" danger loading={redispatchingOrder === order.order_id} onClick={() => redispatchOrder(order.order_id)}>换人重派</Button>
                    <Button size="large" loading={requestingAdminOrder === order.order_id} onClick={() => requestAdmin(order.order_id)}>联系管理员</Button>
                  </>
                ) : null}
                {['pending', 'accepted'].includes(order.status) ? (
                  <Button size="large" danger type={order.status === 'accepted' ? 'primary' : 'default'} loading={cancellingOrder === order.order_id} onClick={() => cancelOrder(order.order_id)}>
                    {order.status === 'accepted' ? '取消这次帮助' : '取消'}
                  </Button>
                ) : null}
                {['accepted', 'in_progress'].includes(order.status) && order.volunteer_id ? (
                  <Button size="large" type="primary" loading={completingOrder === order.order_id} onClick={() => completeOrder(order.order_id)}>
                    确认完成服务
                  </Button>
                ) : null}
              </Space>
            </div>
          </Card>
        )) : <Card className="!rounded-2xl text-slate-500 text-base">还没有进行中的帮助。提交需求后，进度会出现在这里。</Card>}
      </div>
    </div>
  </div>
}
