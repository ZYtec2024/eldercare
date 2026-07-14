import { useEffect, useState } from 'react'
import { Card, Typography, Spin, Tag } from 'antd'
import { useParams } from 'react-router-dom'
import ReactEChartsCore from 'echarts-for-react'

import { fetchFamilyElderDetail, fetchFamilyHealthTrend } from '@/services/adapters/family-adapter'
import { useSession } from '@/features/auth/useSession'
import { buildHealthTrendOptions } from '@/charts/health-trend-options'
import type { ElderSummary, HealthTrendSnapshot } from '@/types/domain'

export default function ElderDetailPage() {
  const { elderId } = useParams<{ elderId: string }>()
  const { session } = useSession()
  const [elder, setElder] = useState<ElderSummary | null>(null)
  const [trend, setTrend] = useState<HealthTrendSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!elderId || !session) return
    const id = Number(elderId)
    Promise.all([
      fetchFamilyElderDetail(id, session.userId),
      fetchFamilyHealthTrend(id),
    ])
      .then(([e, t]) => { setElder(e); setTrend(t) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [elderId, session])

  if (loading) {
    return <div className="flex justify-center py-20"><Spin size="large" /></div>
  }

  if (!elder) {
    return <Typography.Text>长辈信息不存在</Typography.Text>
  }

  return (
    <div className="space-y-6">
      <Card className="!rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Typography.Title level={3} className="!mb-1">{elder.name}</Typography.Title>
            <Typography.Text className="text-gray-500">
              {elder.age}岁 · {elder.gender} · {elder.addressPreview}
            </Typography.Text>
          </div>
          <Tag color={elder.riskLevel === 'urgent' ? 'red' : elder.riskLevel === 'attention' ? 'orange' : 'green'}>
            {elder.riskLevel === 'urgent' ? '紧急' : elder.riskLevel === 'attention' ? '需关注' : '正常'}
          </Tag>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-sm">
          <div><span className="text-gray-500">最近打卡：</span>{elder.latestCheckinAt || '暂无'}</div>
          <div><span className="text-gray-500">待办服务：</span>{elder.pendingServiceCount} 项</div>
          <div><span className="text-gray-500">SOS 状态：</span>{elder.latestSosStatus || '暂无'}</div>
          <div><span className="text-gray-500">提醒：</span>{elder.latestAlertSummary || '暂无'}</div>
        </div>
      </Card>

      {trend && (
        <Card title="健康趋势（近7天）" className="!rounded-2xl">
          {trend.abnormalFlag && (
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-4 text-orange-700 text-sm">
              {trend.annotationText}
            </div>
          )}
          <ReactEChartsCore option={buildHealthTrendOptions(trend)} style={{ height: 350 }} />
        </Card>
      )}
    </div>
  )
}
