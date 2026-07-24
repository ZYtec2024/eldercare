import { useEffect, useMemo, useState } from 'react'
import {
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App, Avatar, Button, Layout, Menu, Space, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { LiveNoticeHost } from '@/features/shared/LiveNoticeHost'
import {
  getNavigationForRole,
  getRouteDefinition,
} from '@/routes/route-config'
import {
  getDefaultRoute,
  isRoleAllowedPath,
} from '@/routes/role-defaults'
import { roleLabels } from '@/types/domain'
import { fetchAdminUsers } from '@/services/adapters/admin-adapter'

const { Header, Sider, Content } = Layout

function ElderLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="5" r="3" />
      <path d="M12 8v6" />
      <path d="M9 21l3-7 3 7" />
      <path d="M7.5 12.5C6 13.5 5 15 5 17" />
      <path d="M16.5 12.5C18 13.5 19 15 19 17" />
      <path d="M8 17h8" />
    </svg>
  )
}

export function AppShell() {
  const { modal } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const { session, logout, updateLastVisitedRoute } = useSession()
  const [collapsed, setCollapsed] = useState(false)

  const navigationItems = useMemo(() => {
    if (!session) return []
    return getNavigationForRole(session.role, { isRoot: Boolean(session.isRoot) })
  }, [session])

  const selectedKeys = useMemo(() => {
    const active = navigationItems.find((item) =>
      location.pathname.startsWith(item.path),
    )
    return active ? [active.key] : []
  }, [location.pathname, navigationItems])

  const activeRoute = getRouteDefinition(location.pathname)

  useEffect(() => {
    if (
      !session ||
      !activeRoute ||
      activeRoute.isPublic ||
      !isRoleAllowedPath(session.role, location.pathname)
    ) {
      return
    }
    updateLastVisitedRoute(location.pathname)
  }, [activeRoute, location.pathname, session, updateLastVisitedRoute])

  useEffect(() => {
    if (!session || session.role !== 'admin') return
    let stopped = false
    const storageKey = `pending-volunteer-review:${session.userId}`

    const checkPendingVolunteers = async () => {
      try {
        const result = await fetchAdminUsers({
          adminUserId: session.userId,
          role: 'volunteer',
          page: 1,
          pageSize: 100,
        })
        if (stopped) return
        const pending = result.items.filter((item) => item.status === 'pending_review')
        const signature = pending.map((item) => item.userId).sort((a, b) => a - b).join(',')
        if (!signature) {
          window.sessionStorage.removeItem(storageKey)
          return
        }
        if (window.sessionStorage.getItem(storageKey) === signature) return
        window.sessionStorage.setItem(storageKey, signature)
        modal.confirm({
          title: `发现 ${pending.length} 位待认证志愿者`,
          content: (
            <div className="space-y-2">
              <div>请查看注册说明、核验资质并分配可接单技能。</div>
              <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
                {pending.slice(0, 5).map((item) => item.name || item.username).join('、')}
                {pending.length > 5 ? ` 等 ${pending.length} 人` : ''}
              </div>
            </div>
          ),
          okText: '现在去认证',
          cancelText: '稍后处理',
          onOk: () => navigate('/admin/users?role=volunteer'),
        })
      } catch {
        // A transient network failure must not interrupt normal admin work.
      }
    }

    void checkPendingVolunteers()
    const timer = window.setInterval(() => void checkPendingVolunteers(), 20_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [modal, navigate, session?.role, session?.userId])

  if (!session) return null

  return (
    <Layout className="min-h-screen">
      <Sider
        breakpoint="lg"
        collapsedWidth="0"
        width={240}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        className="!bg-blue-900 shadow-lg"
      >
        <div className="px-5 py-5 border-b border-blue-800">
          {!collapsed && (
            <>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center">
                  <ElderLogo className="w-5 h-5 text-white" />
                </div>
                <div>
                  <Typography.Text className="!text-white !text-base !font-semibold block leading-tight">
                    智慧伴老
                  </Typography.Text>
                  <Typography.Text className="!text-blue-300 !text-xs">
                    社区照护平台
                  </Typography.Text>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 px-1">
                <Avatar size={28} className="bg-blue-600" icon={<UserOutlined />} />
                <div className="min-w-0">
                  <Typography.Text className="!text-blue-100 !text-sm block truncate">
                    {session.displayName}
                  </Typography.Text>
                  <Typography.Text className="!text-blue-400 !text-xs">
                    {roleLabels[session.role]}
                  </Typography.Text>
                </div>
              </div>
            </>
          )}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKeys}
          className="!bg-blue-900 !border-none mt-2 [&_.ant-menu-item]:!text-base [&_.ant-menu-item]:!h-12 [&_.ant-menu-item]:!leading-[48px] [&_.anticon]:!text-lg"
          items={navigationItems.map((item) => ({
            key: item.key,
            icon: item.icon,
            label: item.label,
            onClick: () => navigate(item.path),
          }))}
        />
      </Sider>
      <Layout>
        <Header className="!bg-white !px-4 md:!px-6 !h-16 flex items-center justify-between border-b border-gray-200 shadow-sm">
          <div className="flex items-center gap-3">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined className="!text-xl" /> : <MenuFoldOutlined className="!text-xl" />}
              onClick={() => setCollapsed(!collapsed)}
              className="lg:hidden !text-xl"
            />
            <Typography.Text className="font-semibold text-lg text-gray-800">
              {activeRoute?.title ?? '智慧伴老'}
            </Typography.Text>
          </div>
          <Space size={12}>
            <Button
              type="text"
              icon={<HomeOutlined className="!text-2xl" />}
              className="!w-10 !h-10 flex items-center justify-center"
              onClick={() => navigate(getDefaultRoute(session.role))}
            />
            <Button
              type="text"
              icon={<UserOutlined className="!text-2xl" />}
              className="!w-10 !h-10 flex items-center justify-center"
              onClick={() => navigate('/profile')}
            />
            <Button
              type="text"
              icon={<LogoutOutlined className="!text-2xl" />}
              className="!w-10 !h-10 flex items-center justify-center"
              onClick={() => {
                logout()
                navigate('/')
              }}
            />
          </Space>
        </Header>
        <Content className={`p-4 md:p-6 ${session.role === 'elder' ? 'elder-mode' : ''}`}>
          <LiveNoticeHost />
          <div className="max-w-6xl mx-auto">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
