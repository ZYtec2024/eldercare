import { useEffect, useState } from 'react'
import { Card, Typography, Spin, Tag, Button, Modal, Input, message } from 'antd'
import { useParams, useNavigate } from 'react-router-dom'
import ReactEChartsCore from 'echarts-for-react'

import { fetchFamilyElderDetail, fetchFamilyHealthTrend, updateFamilyElderBio } from '@/services/adapters/family-adapter'
import { useSession } from '@/features/auth/useSession'
import { buildHealthTrendOptions } from '@/charts/health-trend-options'
import type { ElderSummary, HealthTrendSnapshot } from '@/types/domain'

export default function ElderDetailPage() {
  const { elderId } = useParams<{ elderId: string }>()
  const navigate = useNavigate()
  const { session } = useSession()
  const [elder, setElder] = useState<ElderSummary | null>(null)
  const [trend, setTrend] = useState<HealthTrendSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [bioModalOpen, setBioModalOpen] = useState(false)
  const [bioEditing, setBioEditing] = useState('')
  const [bioSaving, setBioSaving] = useState(false)

  const loadElder = () => {
    if (!elderId || !session) return
    const id = Number(elderId)
    fetchFamilyElderDetail(id, session.userId)
      .then(setElder)
      .catch(() => {})
  }

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

  const openBioModal = () => {
    setBioEditing(elder?.personalityBio ?? '')
    setBioModalOpen(true)
  }

  const submitBio = async () => {
    if (!session || !elderId) return
    setBioSaving(true)
    try {
      await updateFamilyElderBio({
        familyUserId: session.userId,
        elderId: Number(elderId),
        personalityBio: bioEditing.slice(0, 200),
      })
      message.success('简介已更新')
      setBioModalOpen(false)
      loadElder()
    } catch (err: any) {
      message.error(err?.message || '更新失败')
    } finally {
      setBioSaving(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Spin size="large" /></div>
  }

  if (!elder) {
    return <Typography.Text>长辈信息不存在</Typography.Text>
  }

  return (
    <div className="space-y-6">
      <Button onClick={() => navigate('/family/bind-elder')}>← 返回绑定长辈</Button>
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

      <Card
        title="老人性格简介"
        className="!rounded-2xl"
        extra={<Button size="small" onClick={openBioModal}>编辑</Button>}
      >
        {elder.personalityBio ? (
          <Typography.Paragraph className="!mb-0 text-gray-700">
            {elder.personalityBio}
          </Typography.Paragraph>
        ) : (
          <Typography.Text className="text-gray-400">
            暂未填写，点击右上角「编辑」补充。简介将展示给接单的志愿者，便于提供更贴心的服务。
          </Typography.Text>
        )}
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

      <Modal
        title="编辑老人性格简介"
        open={bioModalOpen}
        onOk={submitBio}
        onCancel={() => setBioModalOpen(false)}
        confirmLoading={bioSaving}
        okText="保存"
        cancelText="取消"
      >
        <Input.TextArea
          rows={5}
          maxLength={200}
          showCount
          value={bioEditing}
          onChange={(e) => setBioEditing(e.target.value)}
          placeholder="简单介绍老人的性格、喜好、习惯等，便于志愿者提供更贴心的服务"
        />
        <div className="text-xs text-gray-400 mt-2">
          简介对所有绑定的家属共享，修改后志愿者接单时将看到最新内容。
        </div>
      </Modal>
    </div>
  )
}
