import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Select, Typography, App, List, Tag, Modal, Popconfirm } from 'antd'
import { useNavigate } from 'react-router-dom'
import { UserOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  bindFamilyElder,
  fetchFamilyElders,
  unbindFamilyElder,
  updateFamilyElderRelation,
} from '@/services/adapters/family-adapter'
import type { ElderSummary } from '@/types/domain'

const riskColors: Record<string, string> = {
  normal: 'green',
  attention: 'orange',
  urgent: 'red',
}
const riskLabels: Record<string, string> = {
  normal: '正常',
  attention: '关注',
  urgent: '紧急',
}

const relationOptions = [
  { value: '父子', label: '父子' },
  { value: '母子', label: '母子' },
  { value: '父女', label: '父女' },
  { value: '母女', label: '母女' },
  { value: '其他', label: '其他' },
]

export default function BindElderPage() {
  const navigate = useNavigate()
  const { session } = useSession()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [elders, setElders] = useState<ElderSummary[]>([])
  const [eldersLoading, setEldersLoading] = useState(true)
  const [relationModalOpen, setRelationModalOpen] = useState(false)
  const [editingElder, setEditingElder] = useState<ElderSummary | null>(null)
  const [editingRelation, setEditingRelation] = useState<string>('')
  const [actionLoading, setActionLoading] = useState(false)

  const loadElders = () => {
    if (!session) return
    setEldersLoading(true)
    fetchFamilyElders(session.userId)
      .then(setElders)
      .catch(() => {})
      .finally(() => setEldersLoading(false))
  }

  useEffect(loadElders, [session])

  const onFinish = async (values: { elderPhone: string; relationType: string; personalityBio?: string }) => {
    if (!session) return
    setLoading(true)
    try {
      await bindFamilyElder({
        familyUserId: session.userId,
        elderPhone: values.elderPhone,
        relationType: values.relationType,
        personalityBio: values.personalityBio,
      })
      message.success('绑定成功！')
      loadElders()
    } catch (err: any) {
      message.error(err?.message || '绑定失败')
    } finally {
      setLoading(false)
    }
  }

  const openRelationModal = (elder: ElderSummary) => {
    setEditingElder(elder)
    setEditingRelation(elder.relationType || elder.relationLabel || '其他')
    setRelationModalOpen(true)
  }

  const handleUpdateRelation = async () => {
    if (!session || !editingElder || !editingRelation) return
    setActionLoading(true)
    try {
      await updateFamilyElderRelation({
        familyUserId: session.userId,
        elderId: editingElder.elderId,
        relationType: editingRelation,
      })
      message.success('关系修改成功')
      setRelationModalOpen(false)
      loadElders()
    } catch (err: any) {
      message.error(err?.message || '关系修改失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleUnbind = async (elderId: number) => {
    if (!session) return
    setActionLoading(true)
    try {
      await unbindFamilyElder({
        familyUserId: session.userId,
        elderId,
      })
      message.success('解绑成功')
      loadElders()
    } catch (err: any) {
      message.error(err?.message || '解绑失败')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Typography.Title level={3} className="!mb-1">绑定长辈</Typography.Title>
        <Typography.Text className="text-gray-500">通过长辈的手机号建立关联</Typography.Text>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left: Bind Form */}
        <Card title="绑定新长辈" className="!rounded-2xl">
          <Form layout="vertical" onFinish={onFinish} size="large">
            <Form.Item
              name="elderPhone"
              label="长辈手机号"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^\d{11}$/, message: '请输入11位手机号' },
              ]}
            >
              <Input placeholder="请输入长辈注册时的手机号" maxLength={11} />
            </Form.Item>
            <Form.Item name="relationType" label="关系" rules={[{ required: true, message: '请选择关系' }]}>
              <Select placeholder="请选择" options={relationOptions} />
            </Form.Item>
            <Form.Item name="personalityBio" label="老人性格简介（选填，200字内）">
              <Input.TextArea
                rows={3}
                maxLength={200}
                showCount
                placeholder="简单介绍老人的性格、喜好、习惯等，便于志愿者提供更贴心的服务"
              />
            </Form.Item>
            <div className="flex gap-3">
              <Button type="primary" htmlType="submit" loading={loading}>确认绑定</Button>
              <Button onClick={() => navigate('/family/dashboard')}>返回</Button>
            </div>
          </Form>
        </Card>

        {/* Right: Bound Elders List */}
        <Card title="已绑定长辈" className="!rounded-2xl" loading={eldersLoading}>
          <List
            dataSource={elders}
            locale={{ emptyText: '暂未绑定长辈' }}
            renderItem={(elder) => (
              <List.Item
                actions={[
                  <Button
                    key="view"
                    type="link"
                    size="small"
                    onClick={() => navigate(`/family/elders/${elder.elderId}`)}
                  >
                    查看详情
                  </Button>,
                  <Button
                    key="edit-relation"
                    type="link"
                    size="small"
                    onClick={() => openRelationModal(elder)}
                  >
                    修改关系
                  </Button>,
                  <Popconfirm
                    key="unbind"
                    title="确认解绑这位长辈吗？"
                    description="解绑后将不再在你的列表中显示"
                    okText="确认"
                    cancelText="取消"
                    onConfirm={() => handleUnbind(elder.elderId)}
                  >
                    <Button type="link" danger size="small">解绑</Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                      <UserOutlined className="text-blue-600" />
                    </div>
                  }
                  title={
                    <span>
                      {elder.name}
                      <Tag className="ml-2" color={riskColors[elder.riskLevel]}>
                        {riskLabels[elder.riskLevel]}
                      </Tag>
                    </span>
                  }
                  description={
                    <span>
                      {elder.relationLabel || elder.relationType} · {elder.addressPreview}
                      {elder.latestCheckinAt && ` · 最近打卡：${elder.latestCheckinAt}`}
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      </div>

      <Modal
        title="修改关系"
        open={relationModalOpen}
        onCancel={() => setRelationModalOpen(false)}
        onOk={handleUpdateRelation}
        confirmLoading={actionLoading}
        okText="保存"
        cancelText="取消"
      >
        <div className="space-y-2">
          <Typography.Text className="text-gray-500">
            当前长辈：{editingElder?.name || '-'}
          </Typography.Text>
          <Select
            className="!w-full"
            value={editingRelation}
            options={relationOptions}
            onChange={setEditingRelation}
            placeholder="请选择关系"
          />
        </div>
      </Modal>
    </div>
  )
}
