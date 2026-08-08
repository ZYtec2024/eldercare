import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Descriptions, Form, Input, Modal, Pagination, Space, Table, Tag, Typography } from 'antd'
import { Navigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  createIpBlock,
  deactivateIpBlock,
  fetchIpBlocks,
  fetchLoginAudits,
  type IpBlockItem,
  type LoginAuditItem,
} from '@/services/adapters/admin-adapter'

const roleLabels: Record<string, string> = {
  admin: '管理员',
  elder: '老人',
  family: '家属',
  volunteer: '志愿者',
}

const ipSourceLabels: Record<string, string> = {
  forwarded: '代理转发',
  'real-ip': '真实 IP 头',
  remote: '直接连接',
  cf: 'Cloudflare',
  'true-client': 'True-Client-IP',
}

export default function AdminLoginAuditsPage() {
  const { message } = App.useApp()
  const { session } = useSession()
  const [items, setItems] = useState<LoginAuditItem[]>([])
  const [blocks, setBlocks] = useState<IpBlockItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [blocksLoading, setBlocksLoading] = useState(true)
  const [detail, setDetail] = useState<LoginAuditItem | null>(null)
  const [banOpen, setBanOpen] = useState(false)
  const [banSubmitting, setBanSubmitting] = useState(false)
  const [form] = Form.useForm<{ ipAddress: string; reason?: string }>()
  const pageSize = 30

  const loadAudits = () => {
    if (!session?.isRoot) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchLoginAudits(session.userId, page, pageSize)
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
      })
      .finally(() => setLoading(false))
  }

  const loadBlocks = () => {
    if (!session?.isRoot) {
      setBlocksLoading(false)
      return
    }
    setBlocksLoading(true)
    fetchIpBlocks()
      .then(setBlocks)
      .finally(() => setBlocksLoading(false))
  }

  useEffect(() => {
    loadAudits()
  }, [page, session])

  useEffect(() => {
    loadBlocks()
  }, [session])

  if (session && !session.isRoot) return <Navigate to="/admin/home" replace />

  const openBan = (ip?: string) => {
    form.setFieldsValue({ ipAddress: ip || '', reason: '' })
    setBanOpen(true)
  }

  const submitBan = async () => {
    const values = await form.validateFields()
    setBanSubmitting(true)
    try {
      await createIpBlock(values.ipAddress.trim(), values.reason?.trim())
      message.success('已封禁该 IP')
      setBanOpen(false)
      setDetail(null)
      loadBlocks()
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '封禁失败')
    } finally {
      setBanSubmitting(false)
    }
  }

  const unban = async (blockId: number) => {
    try {
      await deactivateIpBlock(blockId)
      message.success('已解除封禁')
      loadBlocks()
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '操作失败')
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Typography.Title level={2} className="!mb-1">登录记录 / 风险 IP</Typography.Title>
          <Typography.Text type="secondary">
            列表默认脱敏；详情可看完整 IP。若全员都显示同一公网 IP，请在服务器 Nginx 传递真实客户端，并配置 IGNORE_CLIENT_IPS。
          </Typography.Text>
        </div>
        <Button type="primary" danger onClick={() => openBan()}>封禁风险 IP</Button>
      </div>
      <Alert
        showIcon
        type="info"
        message="连续失败、陌生 IP 可作为风险提醒。封禁后该 IP 无法登录及调用业务接口。上线经 Nginx 时请设置 X-Real-IP / X-Forwarded-For 为浏览器真实地址。"
      />
      <Card className="!rounded-2xl" title="风险 IP 封禁名单">
        <Table<IpBlockItem>
          rowKey="blockId"
          loading={blocksLoading}
          dataSource={blocks}
          pagination={false}
          locale={{ emptyText: '暂无封禁记录' }}
          columns={[
            { title: 'IP', dataIndex: 'ipAddress' },
            { title: '原因', dataIndex: 'reason', render: (value?: string) => value || '-' },
            {
              title: '状态',
              dataIndex: 'isActive',
              width: 100,
              render: (active: boolean) => <Tag color={active ? 'red' : 'default'}>{active ? '生效中' : '已解除'}</Tag>,
            },
            { title: '时间', dataIndex: 'createdAt', width: 190 },
            {
              title: '操作',
              width: 110,
              render: (_, row) => row.isActive
                ? <Button size="small" onClick={() => void unban(row.blockId)}>解除</Button>
                : <span className="text-slate-400">-</span>,
            },
          ]}
        />
      </Card>
      <Card className="!rounded-2xl" title="登录记录">
        <Table<LoginAuditItem>
          rowKey="auditId"
          loading={loading}
          dataSource={items}
          pagination={false}
          columns={[
            { title: '登录时间', dataIndex: 'createdAt', width: 190 },
            { title: '账号', dataIndex: 'username' },
            { title: '角色', dataIndex: 'role', render: (value?: string) => roleLabels[value || ''] || '未知' },
            {
              title: '脱敏 IP',
              dataIndex: 'maskedIp',
              render: (value: string, row) => (
                <span>
                  {value}
                  {(row.rawIp || value).startsWith('172.') ? <Tag className="ml-2">本地 Docker</Tag> : null}
                </span>
              ),
            },
            {
              title: '结果',
              dataIndex: 'loginSuccess',
              width: 100,
              render: (ok: boolean) => <Tag color={ok ? 'green' : 'red'}>{ok ? '成功' : '失败'}</Tag>,
            },
            {
              title: '风险查看',
              width: 110,
              render: (_, row) => <Button size="small" onClick={() => setDetail(row)}>查看详情</Button>,
            },
          ]}
        />
        <div className="mt-5 flex justify-end">
          <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={setPage} />
        </div>
      </Card>
      <Modal
        open={!!detail}
        title="登录来源详情"
        onCancel={() => setDetail(null)}
        footer={(
          <Space>
            {detail?.rawIp ? <Button danger onClick={() => openBan(detail.rawIp)}>封禁此 IP</Button> : null}
            <Button type="primary" onClick={() => setDetail(null)}>知道了</Button>
          </Space>
        )}
      >
        {detail ? (
          <Space direction="vertical" className="w-full" size="middle">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="登录时间">{detail.createdAt}</Descriptions.Item>
              <Descriptions.Item label="账号">{detail.username}</Descriptions.Item>
              <Descriptions.Item label="角色">{roleLabels[detail.role || ''] || '未知'}</Descriptions.Item>
              <Descriptions.Item label="完整 IP">{detail.rawIp || '未记录'}</Descriptions.Item>
              <Descriptions.Item label="脱敏 IP">{detail.maskedIp}</Descriptions.Item>
              <Descriptions.Item label="来源识别">{ipSourceLabels[detail.ipSource || ''] || detail.ipSource || '直接连接'}</Descriptions.Item>
              <Descriptions.Item label="结果">
                <Tag color={detail.loginSuccess ? 'green' : 'red'}>{detail.loginSuccess ? '成功' : '失败'}</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type={(detail.rawIp || detail.maskedIp).startsWith('172.') ? 'warning' : 'info'}
              showIcon
              message={(detail.rawIp || detail.maskedIp).startsWith('172.')
                ? '当前记录来自本地 Docker / 内网转发，不能代表真实公网用户 IP。'
                : '可结合连续失败、陌生地区或同账号频繁切换判断风险。'}
            />
          </Space>
        ) : null}
      </Modal>
      <Modal
        open={banOpen}
        title="封禁风险 IP"
        onCancel={() => setBanOpen(false)}
        onOk={() => void submitBan()}
        confirmLoading={banSubmitting}
        okText="确认封禁"
        okButtonProps={{ danger: true }}
      >
        <Form form={form} layout="vertical" className="mt-3">
          <Form.Item name="ipAddress" label="IP 地址" rules={[{ required: true, message: '请输入 IP' }]}>
            <Input placeholder="例如 203.0.113.8" />
          </Form.Item>
          <Form.Item name="reason" label="原因（可选）">
            <Input.TextArea rows={3} placeholder="暴力破解 / 异常地区 等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
