import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Modal, Space, Tag, Typography } from 'antd'
import { EnvironmentOutlined, LockOutlined, SyncOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import { LiveArrivalEstimate } from '@/features/dispatch/components/LiveArrivalEstimate'
import type { DispatchTracking } from '@/features/dispatch/dispatch-types'
import { fetchDispatchTracking } from '@/services/adapters/dispatch-adapter'

const statusLabel: Record<string, string> = { accepted: '志愿者正在出发', in_progress: '正在服务', completed: '服务完成', pending: '正在匹配' }
const volunteerStateLabel: Record<string, string> = { idle: '空闲', en_route: '正在前往', serving: '正在服务', returning: '正在返家', offline: '离线' }
const volunteerStateColor: Record<string, string> = { idle: 'green', en_route: 'blue', serving: 'purple', returning: 'magenta', offline: 'default' }

const ACTIVE_ORDER_STATUSES = new Set(['pending', 'accepted', 'in_progress'])

export default function FamilyLiveTrackingPage() {
  const { session } = useSession()
  const [tracking, setTracking] = useState<DispatchTracking | null>(null)
  const [loading, setLoading] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)
  const load = async () => {
    if (!session) return
    setLoading(true)
    try { setTracking(await fetchDispatchTracking('family', session.userId)) } finally { setLoading(false) }
  }
  useEffect(() => { load().catch(() => {}); const timer = window.setInterval(() => load().catch(() => {}), 1200); return () => window.clearInterval(timer) }, [session?.userId])

  const liveOrders = useMemo(() => {
    const orders = tracking?.orders ?? []
    return orders.filter((order) => {
      if (!ACTIVE_ORDER_STATUSES.has(order.status)) return false
      if (order.volunteer_availability === 'offline') return false
      return true
    })
  }, [tracking?.orders])

  return (
    <div className="space-y-6">
      <div className="section-page-hero flex flex-wrap items-center justify-between gap-3 p-6">
        <div>
          <div className="role-home-kicker">老人位置与服务进度</div>
          <Typography.Title level={2} className="!m-0 !text-slate-900">家属实时守护</Typography.Title>
        </div>
        <Button icon={<SyncOutlined />} loading={loading} onClick={() => load().catch(() => {})}>刷新</Button>
      </div>
      <Alert showIcon type="info" icon={<LockOutlined />} message={tracking?.privacy_message || '可一直查看绑定老人的固定或授权位置；当前无进行中服务时，地图不显示志愿者。'} />
      <Card
        className="mobile-map-card !overflow-hidden !rounded-2xl !border-blue-100"
        title="服务地图"
        extra={<Button type="primary" size="small" className="map-expand-btn" onClick={() => setMapExpanded(true)}>展开地图</Button>}
      >
        <DispatchMap overview={tracking} height={440} />
      </Card>
      <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">
        <Tag color="green">绿色：畅通</Tag>
        <Tag color="gold">黄色：缓行</Tag>
        <Tag color="red">红色：拥堵</Tag>
        <span className="ml-2">有进行中服务时，路线颜色与志愿者状态与老人端同步。</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {tracking?.elders.map((elder) => {
          return (
            <Card key={elder.elder_id} className="!rounded-2xl family-live-elder-card" title={<Space><EnvironmentOutlined /><span>{elder.name}</span></Space>}>
              <div className="text-sm text-slate-600">
                <div className="service-address-line overflow-x-auto">
                  <span className="inline-block whitespace-nowrap">{elder.address || '位置待更新'}</span>
                </div>
                <Tag className="mt-2" color="gold">实时位置</Tag>
              </div>
            </Card>
          )
        })}
      </div>
      <div>
        <Typography.Title level={3}>服务订单与志愿者状态</Typography.Title>
        <div className="grid gap-4 md:grid-cols-2">
          {liveOrders.length ? liveOrders.map((order) => (
            <Card
              key={order.order_id}
              className="!rounded-2xl"
              title={<span className="whitespace-nowrap">{order.service_type}</span>}
              extra={<Tag color={order.location_sharing_active ? 'green' : 'orange'}>{statusLabel[order.status] || order.status}</Tag>}
            >
              <div className="space-y-2 text-sm text-slate-600">
                <div>老人：{order.elder_name}</div>
                <div className="service-address-line overflow-x-auto">
                  <span className="inline-block whitespace-nowrap">{order.address || '固定住址'}</span>
                </div>
                <div>志愿者：{order.volunteer_name || '尚未接单'}</div>
                {order.volunteer_availability ? (
                  <Tag color={volunteerStateColor[order.volunteer_availability] || 'blue'}>
                    当前状态：{volunteerStateLabel[order.volunteer_availability] || order.volunteer_availability}
                  </Tag>
                ) : null}
                {order.location_sharing_active ? (
                  <div className="flex flex-col gap-2">
                    <div>
                      <Tag color="green">志愿者位置与服务路线正在共享</Tag>
                    </div>
                    <LiveArrivalEstimate
                      route={tracking?.routes.find((route) => route.order_id === order.order_id)}
                      compact
                      action={
                        order.amap_navigation_url ? (
                          <Button
                            type="link"
                            className="family-live-amap-btn"
                            onClick={() => window.open(order.amap_navigation_url, '_blank', 'noopener,noreferrer')}
                          >
                            高德查看路线
                          </Button>
                        ) : (
                          <span className="text-slate-400">暂无路线</span>
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
            </Card>
          )) : (
            <Card className="!rounded-2xl text-slate-500">暂无进行中的在线服务订单。</Card>
          )}
        </div>
      </div>
      <Modal
        open={mapExpanded}
        onCancel={() => setMapExpanded(false)}
        footer={null}
        width="min(1100px, 96vw)"
        title="服务地图"
        destroyOnClose
      >
        <DispatchMap overview={tracking} height={Math.min(680, typeof window !== 'undefined' ? window.innerHeight - 190 : 560)} />
      </Modal>
    </div>
  )
}
