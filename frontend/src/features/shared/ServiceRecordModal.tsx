import { Descriptions, Empty, Modal, Tag } from 'antd'

import { DispatchMap } from '@/features/dispatch/components/DispatchMap'
import type { DispatchMapData, NavigationMode } from '@/features/dispatch/dispatch-types'
import type { ServiceRecordItem } from '@/services/adapters/admin-adapter'

const modeLabel: Record<NavigationMode, string> = {
  driving: '驾车',
  riding: '骑行',
  walking: '步行',
}

function recordMap(record: ServiceRecordItem): DispatchMapData | null {
  if (!record.route?.path?.length || record.serviceLng == null || record.serviceLat == null) return null
  const start = record.route.path[0]
  return {
    bounds: { west: 121.1, east: 121.9, south: 30.9, north: 31.6 },
    grid_size: 1,
    traffic_version: 0,
    traffic_cells: [],
    elders: [],
    volunteers: [{
      volunteer_id: record.volunteerId ?? 0,
      name: record.volunteerName || '志愿者',
      lng: record.volunteerStartLng ?? start[0],
      lat: record.volunteerStartLat ?? start[1],
      availability: '历史出发点',
      fatigue: 0,
      rating: 0,
      assigned_today: 0,
      skills: [],
    }],
    orders: [{
      order_id: record.orderId,
      service_type: record.serviceType,
      status: 'completed',
      elder_name: record.elderName,
      urgency: 'normal',
      dispatch_state: 'completed',
      search_stage: 10,
      forced_assignment: false,
      lng: record.serviceLng,
      lat: record.serviceLat,
      address: record.address,
    }],
    routes: [record.route],
  }
}

export function ServiceRecordModal({ record, onClose }: { record: ServiceRecordItem | null; onClose: () => void }) {
  const map = record ? recordMap(record) : null
  const routeMode = record?.route?.navigation_mode || 'driving'
  const actual = record?.route?.geometry_source === 'actual_gps'

  return <Modal
    open={Boolean(record)}
    width={920}
    title={record ? `服务记录 #${record.orderId}` : '服务记录'}
    footer={null}
    onCancel={onClose}
    destroyOnClose
  >
    {record ? <div className="space-y-4">
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="老人">{record.elderName}</Descriptions.Item>
        <Descriptions.Item label="志愿者">{record.volunteerName || '-'}</Descriptions.Item>
        <Descriptions.Item label="服务内容">{record.serviceType}</Descriptions.Item>
        <Descriptions.Item label="实际服务时长">{record.durationMinutes == null ? '-' : `${record.durationMinutes} 分钟`}</Descriptions.Item>
        <Descriptions.Item label="到达时间">{record.arrivedAt || '-'}</Descriptions.Item>
        <Descriptions.Item label="开始时间">{record.serviceStartedAt || '-'}</Descriptions.Item>
        <Descriptions.Item label="结束时间">{record.serviceEndedAt || '-'}</Descriptions.Item>
        <Descriptions.Item label="导航方式">{modeLabel[routeMode]}</Descriptions.Item>
        <Descriptions.Item label={actual ? '实际轨迹距离' : '规划距离'}>
          {actual
            ? `${record.actualDistanceKm ?? 0} 公里`
            : record.route?.distance_km == null ? '-' : `${record.route.distance_km} 公里`}
        </Descriptions.Item>
        <Descriptions.Item label="志愿者接单地点" span={2}>
          {record.volunteerStartAddress || (
            record.volunteerStartLng == null ? '-' : `${record.volunteerStartLng.toFixed(6)}, ${record.volunteerStartLat?.toFixed(6)}`
          )}
        </Descriptions.Item>
        <Descriptions.Item label="订单服务地点" span={2}>{record.address || '-'}</Descriptions.Item>
        <Descriptions.Item label="路线来源" span={2}>
          <Tag color={actual ? 'blue' : 'gold'}>{actual ? '志愿者 GPS 实际轨迹' : '高德规划路线（未采集到足够 GPS 点）'}</Tag>
        </Descriptions.Item>
      </Descriptions>
      {map ? <DispatchMap overview={map} height={430} /> : <Empty description="该历史订单没有保存路线" />}
    </div> : null}
  </Modal>
}
