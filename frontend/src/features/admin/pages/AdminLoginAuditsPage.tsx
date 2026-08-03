import { useEffect, useState } from 'react'
import { Alert, Card, Pagination, Table, Tag, Typography } from 'antd'
import { Navigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { fetchLoginAudits, type LoginAuditItem } from '@/services/adapters/admin-adapter'

const roleLabels: Record<string, string> = {
  admin: '管理员',
  elder: '老人',
  family: '家属',
  volunteer: '志愿者',
}

export default function AdminLoginAuditsPage() {
  const { session } = useSession()
  const [items, setItems] = useState<LoginAuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
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
        <Typography.Text type="secondary">仅记录必要的登录结果，客户端 IP 已脱敏。</Typography.Text>
      </div>
      <Alert
        showIcon
        type="info"
        message="连续失败记录可作为账号异常提醒；本页面不保存密码、令牌或完整 IP。"
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
            { title: '脱敏 IP', dataIndex: 'maskedIp' },
            {
              title: '结果',
              dataIndex: 'loginSuccess',
              width: 100,
              render: (ok: boolean) => <Tag color={ok ? 'green' : 'red'}>{ok ? '成功' : '失败'}</Tag>,
            },
          ]}
        />
        <div className="mt-5 flex justify-end">
          <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={setPage} />
        </div>
      </Card>
    </div>
  )
}
