import { useEffect, useState } from 'react'
import { Button, Card, Empty, Form, InputNumber, Spin, Typography, App } from 'antd'
import { useNavigate } from 'react-router-dom'
import ReactEChartsCore from 'echarts-for-react'

import { useSession } from '@/features/auth/useSession'
import { fetchElderHealthTrend, submitElderCheckIn } from '@/services/adapters/elder-adapter'
import { buildHealthTrendOptions } from '@/charts/health-trend-options'
import type { HealthTrendSnapshot } from '@/types/domain'

export default function ElderCheckinPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [trend, setTrend] = useState<HealthTrendSnapshot | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)

  const loadTrend = async () => {
    if (!session?.userId) return
    setTrendLoading(true)
    try {
      // Must resolve via elder API (user_id → elder_id). Family chart expects elder_id.
      const snapshot = await fetchElderHealthTrend(session.userId)
      const hasPoints = snapshot.dateRange.some((d) => Boolean(String(d || '').trim()))
      setTrend(hasPoints ? snapshot : null)
    } catch (err: any) {
      message.error(err?.message || '健康趋势加载失败')
      setTrend(null)
    } finally {
      setTrendLoading(false)
    }
  }

  useEffect(() => {
    void loadTrend()
  }, [session?.userId])

  const onFinish = async (values: any) => {
    setLoading(true)
    try {
      const result = await submitElderCheckIn({
        userId: session?.userId,
        bloodPressureSys: values.bloodPressureSys,
        bloodPressureDia: values.bloodPressureDia,
        heartRate: values.heartRate,
        bloodOxygen: values.bloodOxygen,
        bloodSugar: values.bloodSugar,
        temperature: values.temperature,
        weight: values.weight,
      })
      if (result.data.abnormal) {
        message.warning(result.message || '部分指标异常，已记入告警')
      } else {
        message.success(result.message || '健康打卡成功！')
      }
      await loadTrend()
    } catch (err: any) {
      message.error(err?.message || '打卡失败')
    } finally {
      setLoading(false)
    }
  }

  const fields = [
    { name: 'bloodPressureSys', label: '收缩压 (mmHg)', placeholder: '如 130' },
    { name: 'bloodPressureDia', label: '舒张压 (mmHg)', placeholder: '如 85' },
    { name: 'heartRate', label: '心率 (次/分)', placeholder: '如 75' },
    { name: 'bloodOxygen', label: '血氧 (%)', placeholder: '如 98' },
    { name: 'bloodSugar', label: '血糖 (mmol/L)', placeholder: '如 5.5' },
    { name: 'temperature', label: '体温 (°C)', placeholder: '如 36.5' },
    { name: 'weight', label: '体重 (kg)', placeholder: '如 65' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={2} className="!mb-1">健康打卡</Typography.Title>
        <Typography.Text className="text-gray-500 text-lg">填写您今天的健康数据（可部分填写）</Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        <Form layout="vertical" onFinish={onFinish} size="large">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6">
            {fields.map((f) => (
              <Form.Item key={f.name} name={f.name} label={f.label}>
                <InputNumber
                  className="!w-full"
                  placeholder={f.placeholder}
                  min={0}
                  step={f.name === 'bloodSugar' || f.name === 'temperature' ? 0.1 : 1}
                />
              </Form.Item>
            ))}
          </div>
          <div className="flex gap-3 mt-4">
            <Button type="primary" htmlType="submit" loading={loading} className="!h-12 !px-10 !text-base !font-semibold">
              提交打卡
            </Button>
            <Button onClick={() => navigate('/elder/dashboard')} className="!h-12">
              返回
            </Button>
          </div>
        </Form>
      </Card>

      <Card title="健康趋势（近7天）" className="!rounded-2xl">
        {trendLoading ? (
          <div className="flex justify-center py-10">
            <Spin size="large" />
          </div>
        ) : trend ? (
          <>
            {trend.abnormalFlag && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-4 text-orange-700 text-sm">
                {trend.annotationText}
              </div>
            )}
            <ReactEChartsCore option={buildHealthTrendOptions(trend)} style={{ height: 320 }} />
          </>
        ) : (
          <Empty description="暂无健康记录" />
        )}
      </Card>
    </div>
  )
}
