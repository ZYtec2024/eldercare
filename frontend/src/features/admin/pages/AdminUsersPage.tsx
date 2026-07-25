import { useEffect, useState } from 'react'
import {
  App,
  Button,
  Card,
  Descriptions,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import { CheckOutlined, CloseOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'

import { auditVolunteer, deleteAdminUser, fetchAdminUsers } from '@/services/adapters/admin-adapter'
import { SOS_SKILL_OPTIONS } from '@/services/adapters/dispatch-adapter'
import type { AdminUserRow, Role } from '@/types/domain'
import { useSession } from '@/features/auth/useSession'
import { AdminRegionScopeNotice } from '@/features/admin/components/AdminRegionScopeNotice'
import { AdminGeoScopeFilters, type AdminGeoScope } from '@/features/admin/components/AdminGeoScopeFilters'

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
  approved: { color: 'green', text: '已认证' },
  pending: { color: 'orange', text: '需要审核' },
  pending_review: { color: 'orange', text: '待审核' },
  rejected: { color: 'red', text: '已拒绝' },
  archived: { color: 'default', text: '已归档' },
}

// Keep labels identical to backend SKILL_LABELS / SOS_SKILL_OPTIONS.
const skillOptions = SOS_SKILL_OPTIONS.map((item) => ({ value: item.code, label: item.label }))

const skillLabels = Object.fromEntries(skillOptions.map((item) => [item.value, item.label]))

export default function AdminUsersPage() {
  const [searchParams] = useSearchParams()
  const { message } = App.useApp()
  const { session } = useSession()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const requestedRole = searchParams.get('role')
  const [roleFilter, setRoleFilter] = useState<Role | undefined>(
    requestedRole === 'volunteer' || requestedRole === 'family'
      || requestedRole === 'elder' || requestedRole === 'admin'
      ? requestedRole
      : 'elder',
  )
  const [geoScope, setGeoScope] = useState<AdminGeoScope>({})
  const [page, setPage] = useState(1)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [reviewingUser, setReviewingUser] = useState<AdminUserRow | null>(null)
  const [reviewingSkills, setReviewingSkills] = useState<string[]>([])
  const [reviewing, setReviewing] = useState(false)

  const load = () => {
    if (!session) return
    setLoading(true)
    fetchAdminUsers({
      adminUserId: session.userId,
      role: roleFilter,
      regionAdcode: geoScope.regionAdcode,
      provinceName: !geoScope.regionAdcode ? geoScope.provinceName : undefined,
      cityName: !geoScope.regionAdcode ? geoScope.cityName : undefined,
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

  useEffect(load, [
    session?.userId,
    roleFilter,
    geoScope.regionAdcode,
    geoScope.provinceName,
    geoScope.cityName,
    page,
  ])

  useEffect(() => {
    if (requestedRole === 'volunteer' || requestedRole === 'family'
      || requestedRole === 'elder' || requestedRole === 'admin') {
      setRoleFilter(requestedRole)
      setPage(1)
    }
  }, [requestedRole])

  const openSkillReview = (user: AdminUserRow) => {
    setReviewingUser(user)
    setReviewingSkills(user.verifiedSkills ?? [])
  }

  const approveVolunteer = async () => {
    if (!reviewingUser || !session) return
    if (!reviewingSkills.length) {
      message.warning('请至少分配一项认证技能')
      return
    }
    setReviewing(true)
    try {
      const res = await auditVolunteer(reviewingUser.userId, 'approve', session.userId, reviewingSkills)
      message.success(res.message)
      setReviewingUser(null)
      load()
    } catch (err: any) {
      message.error(err?.message || '技能认证失败')
    } finally {
      setReviewing(false)
    }
  }

  const rejectVolunteer = async (userId: number) => {
    if (!session) return
    try {
      const res = await auditVolunteer(userId, 'reject', session.userId)
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '审核失败')
    }
  }

  const handleDelete = async (user: AdminUserRow) => {
    if (!session) return
    setDeletingId(user.userId)
    try {
      const res = await deleteAdminUser(user.userId, session.userId)
      message.success(res.message)
      load()
    } catch (err: any) {
      message.error(err?.message || '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 150 },
    { title: '姓名', dataIndex: 'name', key: 'name', width: 150 },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role: Role) => <Tag color={roleColors[role]}>{roleLabels[role]}</Tag>,
    },
    {
      title: '注册区县',
      key: 'regions',
      width: 160,
      render: (_: unknown, record: AdminUserRow) => record.regionNames?.length ? (
        <Space size={[4, 4]} wrap>
          {record.regionNames.map((name, index) => (
            <Tag key={`${record.userId}-${record.regionAdcodes?.[index] || name}`}>{name}</Tag>
          ))}
        </Space>
      ) : <span className="text-gray-400">{record.role === 'admin' ? '尚未指派' : '—'}</span>,
    },
    {
      title: '关联老人 / 地址',
      key: 'related',
      render: (_: unknown, record: AdminUserRow) => {
        if (record.role === 'family') {
          if (!record.relatedElders?.length) return <span className="text-gray-400">未绑定老人</span>
          return (
            <div className="space-y-2">
              {record.relatedElders.map((elder) => (
                <div key={elder.elderId} className="text-sm leading-5">
                  <Space size={[4, 4]} wrap>
                    <span>{elder.name}</span>
                    {elder.relationType ? <Tag>{elder.relationType}</Tag> : null}
                    {elder.regionName ? <Tag color="blue">{elder.regionName}</Tag> : null}
                    {elder.inAdminScope === false ? <Tag color="orange">跨区关联</Tag> : null}
                    {elder.inAdminScope === true ? <Tag color="green">本区</Tag> : null}
                  </Space>
                  {elder.address ? <div className="text-xs text-gray-400">{elder.address}</div> : null}
                </div>
              ))}
              {record.relatedElders.some((elder) => elder.inAdminScope === false) ? (
                <div className="text-xs text-slate-500">跨区关联完整展示，便于排障核对</div>
              ) : null}
            </div>
          )
        }
        if (record.role === 'elder') return <span className="text-sm text-gray-600">{record.address || '—'}</span>
        return <span className="text-gray-400">—</span>
      },
    },
    {
      title: '技能说明 / 认证技能',
      key: 'skills',
      width: 290,
      render: (_: unknown, record: AdminUserRow) => (
        <div className="space-y-1.5">
          <div className="text-sm text-slate-600">{record.skillsDescription || '注册时未填写技能说明'}</div>
          <Space size={[4, 4]} wrap>
            {record.verifiedSkills?.length
              ? record.verifiedSkills.map((skill) => (
                <Tag color="green" key={skill}>{skillLabels[skill] || skill}</Tag>
              ))
              : <Tag>尚未认证</Tag>}
          </Space>
        </div>
      ),
    },
    { title: '手机', dataIndex: 'phone', key: 'phone', width: 130 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const item = statusMap[status] || { color: 'default', text: status }
        return <Tag color={item.color}>{item.text}</Tag>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, record: AdminUserRow) => {
        if (record.role === 'admin') {
          if (!session?.isRoot) return null
          if (record.regionAdcodes?.length) return <span className="text-gray-400 text-sm">请先解绑区域</span>
          if (record.userId === session.userId) return <span className="text-gray-400 text-sm">当前账号</span>
          return (
            <Popconfirm
              title="删除未指派管理员"
              description={`确认删除 ${record.name || record.username}？此操作不可撤销。`}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(record)}
            >
              <Button danger size="small" loading={deletingId === record.userId}>删除</Button>
            </Popconfirm>
          )
        }
        return (
          <Space wrap>
            {record.role === 'volunteer' && (
              <Button
                type={record.status === 'pending_review' ? 'primary' : 'default'}
                size="small"
                icon={record.status === 'pending_review' ? <CheckOutlined /> : <SafetyCertificateOutlined />}
                onClick={() => openSkillReview(record)}
              >
                {record.status === 'pending_review' ? '审核并分配技能' : '调整认证技能'}
              </Button>
            )}
            {record.role === 'volunteer' && record.status === 'pending_review' && (
              <Button danger size="small" icon={<CloseOutlined />} onClick={() => rejectVolunteer(record.userId)}>
                拒绝
              </Button>
            )}
            <Button danger size="small" loading={deletingId === record.userId} onClick={() => handleDelete(record)}>
              删除
            </Button>
          </Space>
        )
      },
    },
  ]

  const visibleColumns = columns.filter((column) => {
    if (column.key === 'related') return roleFilter === 'elder' || roleFilter === 'family'
    if (column.key === 'skills') return roleFilter === 'volunteer'
    return true
  })

  return (
    <div className="space-y-6">
      <AdminRegionScopeNotice />
      <div>
        <Typography.Title level={3} className="!mb-1">用户管理</Typography.Title>
        <Typography.Text className="text-gray-500">
          总管理员按全国 → 省 → 市 → 区县查看；区域管理员仅能查看本区数据。
        </Typography.Text>
      </div>
      <Card className="!rounded-2xl">
        <div className="mb-4 flex flex-wrap gap-3">
          <AdminGeoScopeFilters
            value={geoScope}
            onChange={(next) => {
              setGeoScope(next)
              setPage(1)
            }}
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
              ...(session?.isRoot ? [{ label: '管理员', value: 'admin' as Role }] : []),
            ]}
          />
        </div>
        <Table
          dataSource={users}
          columns={visibleColumns}
          rowKey="userId"
          loading={loading}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage }}
          size="small"
          scroll={{ x: 1180 }}
        />
      </Card>

      <Modal
        title="志愿者技能审核"
        open={Boolean(reviewingUser)}
        onCancel={() => setReviewingUser(null)}
        onOk={approveVolunteer}
        okText="保存认证并通过审核"
        cancelText="取消"
        confirmLoading={reviewing}
      >
        <Descriptions size="small" column={1} bordered className="mb-4">
          <Descriptions.Item label="志愿者">
            {reviewingUser?.name || reviewingUser?.username}
          </Descriptions.Item>
          <Descriptions.Item label="注册区县">
            {reviewingUser?.regionNames?.join('、') || '未配置'}
          </Descriptions.Item>
          <Descriptions.Item label="注册说明">
            {reviewingUser?.skillsDescription || '未填写'}
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text strong>由管理员核验后分配技能（可多选）</Typography.Text>
        <Select
          mode="multiple"
          className="mt-2 w-full"
          placeholder="请选择至少一项认证技能"
          value={reviewingSkills}
          onChange={setReviewingSkills}
          options={skillOptions}
        />
        <Typography.Paragraph type="secondary" className="!mt-3 !mb-0">
          只有审核通过且具备订单所需认证技能的志愿者，才会进入智能派单候选。
        </Typography.Paragraph>
      </Modal>
    </div>
  )
}
