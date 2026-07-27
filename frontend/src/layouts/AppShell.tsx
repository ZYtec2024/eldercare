import { useEffect, useMemo, useState } from 'react'
import {
  BellOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  QuestionCircleOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App, Avatar, Badge, Breadcrumb, Button, Layout, Menu, Space, Tooltip, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { LiveNoticeHost } from '@/features/shared/LiveNoticeHost'
import OnboardingGuide from '@/features/onboarding/OnboardingGuide'
import { hasSeenOnboarding, markOnboardingSeen } from '@/features/onboarding/onboarding-store'
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

const { Header, Sider, Content, Footer } = Layout

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
  const [onboardingOpen, setOnboardingOpen] = useState(false)

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

  // 新手引导：首次登录后自动弹出（系统管理员 isRoot 无需新手引导，普通管理员及其他角色弹出）
  useEffect(() => {
    if (!session || session.tokenState !== 'active') return
    if (session.isRoot) return
    if (hasSeenOnboarding(session.userId, session.role)) return
    const timer = window.setTimeout(() => setOnboardingOpen(true), 300)
    return () => window.clearTimeout(timer)
  }, [session?.userId, session?.role, session?.tokenState, session?.isRoot])

  const handleOnboardingClose = () => setOnboardingOpen(false)
  const handleOnboardingDontShowAgain = () => {
    if (session) {
      markOnboardingSeen(session.userId, session.role)
    }
    setOnboardingOpen(false)
  }

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
        className="!bg-gradient-to-b !from-slate-900 !via-blue-950 !to-slate-900 shadow-xl"
        style={{ backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgba(37,99,235,.12) 0%, transparent 60%)' }}
      >
        <div className={`px-5 py-5 border-b border-white/10 ${collapsed ? 'flex justify-center' : ''}`}>
          {collapsed ? (
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center">
              <ElderLogo className="w-5 h-5 text-white" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-500/30">
                  <ElderLogo className="w-5 h-5 text-white" />
                </div>
                <div>
                  <Typography.Text className="!text-white !text-base !font-semibold block leading-tight">
                    智慧伴老
                  </Typography.Text>
                  <Typography.Text className="!text-blue-300/80 !text-xs">
                    社区照护平台
                  </Typography.Text>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 px-1 py-2 rounded-xl bg-white/5">
                <Avatar size={30} className="bg-blue-600 flex-shrink-0" icon={<UserOutlined />} />
                <div className="min-w-0">
                  <Typography.Text className="!text-blue-100 !text-sm block truncate">
                    {session.displayName}
                  </Typography.Text>
                  <Typography.Text className="!text-blue-400/80 !text-xs">
                    {session.isRoot ? '系统管理员' : roleLabels[session.role]}
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
          className="!bg-transparent !border-none mt-2 [&_.ant-menu-item]:!text-base [&_.ant-menu-item]:!h-12 [&_.ant-menu-item]:!leading-[48px] [&_.ant-menu-item]:!rounded-xl [&_.ant-menu-item]:!mx-2 [&_.ant-menu-item-selected]:!bg-blue-600/40 [&_.ant-menu-item]:!transition-colors [&_.anticon]:!text-lg"
          items={navigationItems.map((item) => ({
            key: item.key,
            icon: item.icon,
            label: item.label,
            onClick: () => navigate(item.path),
          }))}
        />
      </Sider>
      <Layout>
        <Header className="!bg-white !px-4 md:!px-6 !h-16 flex items-center justify-between border-b border-slate-100 shadow-[0_1px_3px_rgba(0,0,0,.04)]">
          <div className="flex items-center gap-4 min-w-0">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined className="!text-xl" /> : <MenuFoldOutlined className="!text-xl" />}
              onClick={() => setCollapsed(!collapsed)}
              className="lg:hidden !text-slate-500 !flex-shrink-0"
            />
            <Breadcrumb
              className="hidden sm:block"
              items={activeRoute
                ? [{ title: <HomeOutlined /> }, { title: <span className="text-slate-500">{activeRoute.title}</span> }]
                : [{ title: <HomeOutlined /> }, { title: '智慧伴老' }]
              }
            />
            <Typography.Text className="font-semibold text-lg text-slate-800 sm:hidden truncate">
              {activeRoute?.title ?? '智慧伴老'}
            </Typography.Text>
          </div>
          <Space size={4} className="flex-shrink-0">
            <Tooltip title="通知">
              <Badge count={0} size="small">
                <Button
                  type="text"
                  icon={<BellOutlined className="!text-xl" />}
                  className="!w-10 !h-10 flex items-center justify-center !text-slate-500 hover:!bg-slate-100"
                />
              </Badge>
            </Tooltip>
            {!session.isRoot && (
              <Tooltip title="新手引导">
                <Button
                  type="text"
                  icon={<QuestionCircleOutlined className="!text-xl" />}
                  className="!w-10 !h-10 flex items-center justify-center !text-slate-500 hover:!bg-slate-100"
                  onClick={() => setOnboardingOpen(true)}
                />
              </Tooltip>
            )}
            <Tooltip title="首页">
              <Button
                type="text"
                icon={<HomeOutlined className="!text-xl" />}
                className="!w-10 !h-10 flex items-center justify-center !text-slate-500 hover:!bg-slate-100"
                onClick={() => navigate(getDefaultRoute(session.role))}
              />
            </Tooltip>
            <Tooltip title="个人中心">
              <Button
                type="text"
                icon={<UserOutlined className="!text-xl" />}
                className="!w-10 !h-10 flex items-center justify-center !text-slate-500 hover:!bg-slate-100"
                onClick={() => navigate('/profile')}
              />
            </Tooltip>
            <div className="w-px h-6 bg-slate-200 mx-1" />
            <Tooltip title="退出登录">
              <Button
                type="text"
                icon={<LogoutOutlined className="!text-xl" />}
                className="!w-10 !h-10 flex items-center justify-center !text-slate-400 hover:!bg-red-50 hover:!text-red-500"
                onClick={() => { logout(); navigate('/') }}
              />
            </Tooltip>
          </Space>
        </Header>
        <Content className={`p-4 md:p-6 ${session.role === 'elder' ? 'elder-mode' : ''}`}>
          <LiveNoticeHost />
          <div className="max-w-6xl mx-auto page-fade-in">
            <Outlet />
          </div>
        </Content>
        <Footer className="!bg-transparent !py-4 text-center text-xs text-slate-400 border-t border-slate-100">
          智慧伴老 · 社区照护平台 &copy; {new Date().getFullYear()} — 纯公益项目
        </Footer>
      </Layout>
      <OnboardingGuide
        open={onboardingOpen}
        role={session.role}
        onClose={handleOnboardingClose}
        onDontShowAgain={handleOnboardingDontShowAgain}
      />
    </Layout>
  )
}
