import { useMemo, useEffect } from 'react'
import {
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Button, Layout, Menu, Space, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'

import { useSession } from '@/features/auth/useSession'
import {
  getNavigationForRole,
  getRouteDefinition,
} from '@/routes/route-config'
import {
  getDefaultRoute,
  isRoleAllowedPath,
} from '@/routes/role-defaults'
import { roleLabels } from '@/types/domain'

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
  const navigate = useNavigate()
  const location = useLocation()
  const { session, logout, updateLastVisitedRoute } = useSession()
  const [collapsed, setCollapsed] = useState(false)

  const navigationItems = useMemo(() => {
    if (!session) return []
    return getNavigationForRole(session.role)
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
          <div className="max-w-6xl mx-auto">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
