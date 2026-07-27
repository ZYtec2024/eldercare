import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Empty, Select, Spin, Statistic, Typography } from 'antd'
import { HeartOutlined } from '@ant-design/icons'
import ReactEChartsCore from 'echarts-for-react'

import { buildHealthTrendOptions } from '@/charts/health-trend-options'
import { useSession } from '@/features/auth/useSession'
import {
  fetchFamilyElders,
  fetchFamilyHealthTrend,
} from '@/services/adapters/family-adapter'
import type { ElderSummary, HealthTrendSnapshot } from '@/types/domain'

function latestValue(values?: Array<number | null>, suffix = '') {
  if (!values?.length) return '暂无'
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
      return `${value}${suffix}`
    }
  }
  return '暂无'
}

export default function FamilyHealthPage() {
  const { session } = useSession()
  const [elders, setElders] = useState<ElderSummary[]>([])
  const [selectedElderId, setSelectedElderId] = useState<number>()
  const [trend, setTrend] = useState<HealthTrendSnapshot | null>(null)
  const [loadingElders, setLoadingElders] = useState(true)
  const [loadingTrend, setLoadingTrend] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) return
    setLoadingElders(true)
    setError('')
    fetchFamilyElders(session.userId)
      .then((items) => {
        setElders(items)
        setSelectedElderId((current) => (
          current && items.some((item) => item.elderId === current)
            ? current
            : items[0]?.elderId
        ))
      })
      .catch((reason: any) => setError(reason?.message || '长辈信息加载失败'))
      .finally(() => setLoadingElders(false))
  }, [session?.userId])

  useEffect(() => {
    if (!selectedElderId) {
      setTrend(null)
      return
    }
    setLoadingTrend(true)
    setError('')
    fetchFamilyHealthTrend(selectedElderId)
      .then(setTrend)
      .catch((reason: any) => {
        setTrend(null)
        setError(reason?.message || '健康指标加载失败')
      })
      .finally(() => setLoadingTrend(false))
  }, [selectedElderId])

  const selectedElder = elders.find((item) => item.elderId === selectedElderId)
  const latest = useMemo(() => ({
    bloodPressure: trend?.systolicSeries.length
      ? `${latestValue(trend.systolicSeries)}/${latestValue(trend.diastolicSeries)} mmHg`
      : '暂无',
    heartRate: latestValue(trend?.heartRateSeries, ' 次/分'),
    bloodOxygen: latestValue(trend?.bloodOxygenSeries, '%'),
    bloodSugar: latestValue(trend?.bloodSugarSeries, ' mmol/L'),
    temperature: latestValue(trend?.temperatureSeries, '℃'),
    weight: latestValue(trend?.weightSeries, ' kg'),
  }), [trend])

  if (loadingElders) {
    return <div className="flex justify-center py-20"><Spin size="large" /></div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Typography.Title level={3} className="!mb-1">
            <HeartOutlined className="mr-2 text-rose-500" />
            长辈健康
          </Typography.Title>
          <Typography.Text type="secondary">
            查看长辈每日打卡记录、最近一次健康指标和近 7 天变化趋势。
          </Typography.Text>
        </div>
        {elders.length ? (
          <Select
            className="min-w-48"
            value={selectedElderId}
            onChange={setSelectedElderId}
            options={elders.map((elder) => ({
              value: elder.elderId,
              label: `${elder.name}（${elder.relationLabel || elder.relationType}）`,
            }))}
          />
        ) : null}
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {!elders.length ? (
        <Card className="!rounded-2xl">
          <Empty description="尚未绑定长辈，请先在“绑定长辈”中完成绑定" />
        </Card>
      ) : (
        <>
          <Card className="!rounded-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Typography.Title level={4} className="!mb-1">{selectedElder?.name}</Typography.Title>
                <Typography.Text type="secondary">
                  最近记录：{trend?.dateRange.at(-1) || '暂无健康打卡'}
                </Typography.Text>
              </div>
              {trend?.abnormalFlag ? (
                <Alert
                  type="warning"
                  showIcon
                  message="发现异常健康指标"
                  description={trend.annotationText}
                />
              ) : null}
            </div>
          </Card>

          {loadingTrend ? (
            <div className="flex justify-center py-16"><Spin size="large" /></div>
          ) : trend?.dateRange.length ? (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Card className="!rounded-2xl"><Statistic title="血压" value={latest.bloodPressure} /></Card>
                <Card className="!rounded-2xl"><Statistic title="心率" value={latest.heartRate} /></Card>
                <Card className="!rounded-2xl"><Statistic title="血氧" value={latest.bloodOxygen} /></Card>
                <Card className="!rounded-2xl"><Statistic title="血糖" value={latest.bloodSugar} /></Card>
                <Card className="!rounded-2xl"><Statistic title="体温" value={latest.temperature} /></Card>
                <Card className="!rounded-2xl"><Statistic title="体重" value={latest.weight} /></Card>
              </div>
              <Card title="近 7 天健康趋势" className="!rounded-2xl">
                <ReactEChartsCore option={buildHealthTrendOptions(trend)} style={{ height: 380 }} />
              </Card>
            </>
          ) : (
            <Card className="!rounded-2xl">
              <Empty description="这位长辈还没有健康打卡记录" />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
