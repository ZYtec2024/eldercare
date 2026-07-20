import { useEffect, useState } from 'react'
import { Card, Table, Tag, Typography, Button, Select, App, Space } from 'antd'
import { CheckOutlined, CloseOutlined } from '@ant-design/icons'

import { fetchAdminUsers, auditVolunteer, deleteAdminUser } from '@/services/adapters/admin-adapter'
import { fetchAdminDispatchRegions } from '@/services/adapters/dispatch-adapter'
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
  const [roleFilter, setRoleFilter] = useState<Role | undefined>('elder')
  const [regionAdcode, setRegionAdcode] = useState<string>()
  const [regions, setRegions] = useState<Array<{ adcode: string; name: string }>>([])
  const [page, setPage] = useState(1)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    if (!session) return
    fetchAdminDispatchRegions(session.userId)
      .then((items) => {
        setRegions(items)
      })
      .catch(() => setRegions([]))
  }, [session?.userId])

  const load = () => {
    setLoading(true)
    if (!session) return
    fetchAdminUsers({
      adminUserId: session.userId,
      role: roleFilter,
      regionAdcode,
      page,
      pageSize: 20,
    })
      .then((res: any) => {
        if (Array.isArray(res)) {
          setUsers(res)
          setTotal(res.length)
        } else {
          setUsers(res.items ?? [])
          setTotal(res.total ?? 0)
        }
      })
      .catch((err: any) => message.error(err?.message || '加载用户失败'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [session?.userId, roleFilter, regionAdcode, page])

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
      width: 100,
      render: (role: Role) => <Tag color={roleColors[role]}>{roleLabels[role]}</Tag>,
    },
    {
      title: '所属区县',
      key: 'regions',
      render: (_: unknown, record: AdminUserRow) => {
        if (!record.regionNames?.length) {
          return <span className="text-gray-400">—</span>
        }
        return (
          <Space size={[4, 4]} wrap>
            {record.regionNames.map((name, index) => (
              <Tag key={`${record.userId}-${record.regionAdcodes?.[index] || name}`}>{name}</Tag>
            ))}
          </Space>
        )
      },
    },
    {
      title: '关联老人 / 地址',
      key: 'related',
      render: (_: unknown, record: AdminUserRow) => {
        if (record.role === 'family') {
          if (!record.relatedElders?.length) {
            return <span className="text-gray-400">未绑定老人</span>
          }
          return record.relatedElders.map((elder) => (
            <div key={elder.elderId} className="text-sm">
              {elder.name}
              {elder.regionName ? <span className="text-gray-400"> · {elder.regionName}</span> : null}
            </div>
          ))
        }
        if (record.role === 'elder') {
          return <span className="text-sm text-gray-600">{record.address || '—'}</span>
        }
        return <span className="text-gray-400">—</span>
      },
    },
    {
      title: '手机',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const st = statusMap[status] || { color: 'default', text: status }
        return <Tag color={st.color}>{st.text}</Tag>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
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
        <Typography.Text className="text-gray-500">
          总管理员可按区县查看老人与家属；区管理员仅能看到本区数据。
        </Typography.Text>
      </div>

      <Card className="!rounded-2xl">
        <div className="mb-4 flex flex-wrap gap-3">
          <Select
            placeholder="按区县筛选"
            allowClear
            style={{ width: 220 }}
            value={regionAdcode}
            onChange={(value) => {
              setRegionAdcode(value)
              setPage(1)
            }}
            options={regions.map((item) => ({ value: item.adcode, label: item.name }))}
            showSearch
            optionFilterProp="label"
          />
          <Select
            placeholder="按角色筛选"
            allowClear
            style={{ width: 160 }}
            value={roleFilter}
            onChange={(value) => {
              setRoleFilter(value)
              setPage(1)
            }}
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
