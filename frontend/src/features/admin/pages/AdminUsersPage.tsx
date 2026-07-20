import { useEffect, useState } from 'react'
import { Card, Table, Tag, Typography, Button, Select, App, Space } from 'antd'
import { CheckOutlined, CloseOutlined } from '@ant-design/icons'

import { fetchAdminUsers, auditVolunteer, deleteAdminUser } from '@/services/adapters/admin-adapter'
import type { AdminUserRow, Role } from '@/types/domain'
import { useSession } from '@/features/auth/useSession'
import { AdminRegionScopeNotice } from '@/features/admin/components/AdminRegionScopeNotice'

const roleColors: Record<Role, string> = {
  family: 'blue',
  elder: 'green',
  volunteer: 'purple',
  admin: 'red',
}
const roleLabels: Record<Role, string> = {
  family: '家属',
  elder: '老人',
  volunteer: '志愿者',
  admin: '管理员',
}
const statusMap: Record<string, { color: string; text: string }> = {
  active: { color: 'green', text: '正常' },
  pending: { color: 'orange', text: '需要审核' },
  pending_review: { color: 'orange', text: '待审核' },
  rejected: { color: 'red', text: '已拒绝' },
  archived: { color: 'default', text: '已归档' },
}

export default function AdminUsersPage() {
  const { message } = App.useApp()
  const { session } = useSession()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [roleFilter, setRoleFilter] = useState<Role | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    if (!session) return
    fetchAdminUsers({ adminUserId: session.userId, role: roleFilter, page, pageSize: 20 })
      .then((res: any) => {
        if (Array.isArray(res)) {
          setUsers(res)
          setTotal(res.length)
        } else {
          setUsers(res.items ?? [])
          setTotal(res.total ?? 0)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(load, [session?.userId, roleFilter, page])

  const handleAudit = async (userId: number, action: 'approve' | 'reject') => {
    try {
      const res = await auditVolunteer(userId, action, session!.userId)
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '操作失败')
    }
  }

  const handleDelete = async (user: AdminUserRow) => {
    setDeletingId(user.userId)
    try {
      const res = await deleteAdminUser(user.userId, session!.userId)
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    {
      title: 'ID',
      dataIndex: 'userId',
      key: 'userId',
      width: 70,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
    },
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: Role) => <Tag color={roleColors[role]}>{roleLabels[role]}</Tag>,
    },
    {
      title: '手机',
      dataIndex: 'phone',
      key: 'phone',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const st = statusMap[status] || { color: 'default', text: status }
        return <Tag color={st.color}>{st.text}</Tag>
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: AdminUserRow) => {
        if (record.role === 'admin') {
          return <span className="text-gray-400 text-sm">不可删除</span>
        }

        return (
          <Space>
            {record.role === 'volunteer' && record.status === 'pending_review' && (
              <>
                <Button
                  type="primary"
                  size="small"
                  icon={<CheckOutlined />}
                  onClick={() => handleAudit(record.userId, 'approve')}
                >
                  通过
                </Button>
                <Button
                  danger
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={() => handleAudit(record.userId, 'reject')}
                >
                  拒绝
                </Button>
              </>
            )}
            <Button
              danger
              size="small"
              loading={deletingId === record.userId}
              onClick={() => handleDelete(record)}
            >
              删除
            </Button>
          </Space>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <AdminRegionScopeNotice />
      <div>
        <Typography.Title level={3} className="!mb-1">用户管理</Typography.Title>
        <Typography.Text className="text-gray-500">查看和管理平台用户</Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        <div className="mb-4">
          <Select
            placeholder="按角色筛选"
            allowClear
            style={{ width: 160 }}
            value={roleFilter}
            onChange={(v) => { setRoleFilter(v); setPage(1) }}
            options={[
              { label: '家属', value: 'family' },
              { label: '老人', value: 'elder' },
              { label: '志愿者', value: 'volunteer' },
              { label: '管理员', value: 'admin' },
            ]}
          />
        </div>
        <Table
          dataSource={users}
          columns={columns}
          rowKey="userId"
          loading={loading}
          pagination={{
            current: page,
            pageSize: 20,
            total,
            onChange: setPage,
          }}
          size="middle"
        />
      </Card>
    </div>
  )
}
