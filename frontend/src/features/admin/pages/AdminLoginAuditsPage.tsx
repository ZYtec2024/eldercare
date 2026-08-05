import { useEffect, useState } from 'react'
import { Alert, Button, Card, Descriptions, Modal, Pagination, Space, Table, Tag, Typography } from 'antd'
import { Navigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { fetchLoginAudits, type LoginAuditItem } from '@/services/adapters/admin-adapter'

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
}

export default function AdminLoginAuditsPage() {
  const { session } = useSession()
  const [items, setItems] = useState<LoginAuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<LoginAuditItem | null>(null)
  const pageSize = 30

  useEffect(() => {
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
  }, [page, session])

  if (session && !session.isRoot) return <Navigate to="/admin/home" replace />

  return (
    <div className="space-y-5">
      <div>
        <Typography.Title level={2} className="!mb-1">登录记录</Typography.Title>
        <Typography.Text type="secondary">列表默认脱敏展示；总管理员可打开详情查看完整 IP 用于风险排查。</Typography.Text>
      </div>
      <Alert
        showIcon
        type="info"
        message="连续失败、陌生 IP 或同账号频繁切换可作为风险提醒；上线经 Nginx 时需传递 X-Forwarded-For / X-Real-IP。"
      />
      <Card className="!rounded-2xl">
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
        footer={<Button type="primary" onClick={() => setDetail(null)}>知道了</Button>}
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
    </div>
  )
}
