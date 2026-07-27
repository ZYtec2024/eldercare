import type { ReactNode } from 'react'
import {
  AlertOutlined,
  DashboardOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  HeartOutlined,
  HomeOutlined,
  LinkOutlined,
  MedicineBoxOutlined,
  MessageOutlined,
  TeamOutlined,
  TrophyOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { matchPath } from 'react-router-dom'

import {
  AdminAlertsPage,
  AdminDispatchBoardPage,
  AdminRegionsPage,
  AdminAiSettingsPage,
  AdminDashboardPage,
  AdminHomePage,
  AdminHourReviewsPage,
  AdminUsersPage,
  AdminDonationsPage,
  BindElderPage,
  ConversationPage,
  ElderCheckinPage,
  ElderDashboardPage,
  ElderDispatchPage,
  ElderDetailPage,
  ElderServicesPage,
  ElderCompanionPage,
  ElderSosPage,
  ElderWeeklyReportPage,
  FamilyAlertsPage,
  FamilyDashboardPage,
  FamilyLiveTrackingPage,
  FamilyOrdersPage,
  NewServiceRequestPage,
  ForgotPasswordPage,
  HealthKnowledgePage,
  HomePage,
  LoginPage,
  ProfilePage,
  PublicTaskHallPage,
  RegisterPage,
  DonationPage,
  VolunteerDashboardPage,
  VolunteerDispatchPage,
  VolunteerLeaderboardPage,
  VolunteerProfilePage,
  VolunteerTaskDetailPage,
  VolunteerTasksPage,
} from '@/routes/lazy-pages'
import type { Role } from '@/types/domain'
import type { AppRouteDefinition } from '@/types/routes'
import { getDefaultRoute } from './role-defaults'

const iconMap: Record<string, ReactNode> = {
  home: <HomeOutlined />,
  dashboard: <DashboardOutlined />,
  heart: <HeartOutlined />,
  document: <FileTextOutlined />,
  team: <TeamOutlined />,
  alert: <AlertOutlined />,
  emergency: <ExclamationCircleOutlined />,
  user: <UserOutlined />,
  connect: <LinkOutlined />,
  chat: <MessageOutlined />,
  service: <MedicineBoxOutlined />,
  honor: <TrophyOutlined />,
}

export const allRoles: Role[] = ['family', 'elder', 'volunteer', 'admin']

const taskHallNavigationRoles: Role[] = ['admin']

export const appRoutes: AppRouteDefinition[] = [
  {
    key: 'public-home',
    path: '/',
    roles: allRoles,
    title: '智慧伴老平台',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: HomePage,
  },
  {
    key: 'auth-login',
    path: '/login',
    roles: allRoles,
    title: '登录',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: LoginPage,
  },
  {
    key: 'auth-register',
    path: '/register',
    roles: allRoles,
    title: '注册',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: RegisterPage,
  },
  {
    key: 'public-donation',
    path: '/donate',
    roles: allRoles,
    title: '爱心捐款沙盘',
    description: '微信和支付宝演示支付，不发生真实资金交易',
    showInNavigation: false,
    isPublic: true,
    element: DonationPage,
  },
  {
    key: 'auth-forgot-password',
    path: '/forgot-password',
    roles: allRoles,
    title: '找回密码',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: ForgotPasswordPage,
  },
  {
    key: 'health-knowledge',
    path: '/health-knowledge',
    roles: allRoles,
    title: '健康知识手册',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: HealthKnowledgePage,
  },
  {
    key: 'public-task-hall',
    path: '/task-hall',
    roles: allRoles,
    title: '任务大厅',
    description: '',
    showInNavigation: false,
    isPublic: true,
    element: PublicTaskHallPage,
  },
  {
    key: 'profile',
    path: '/profile',
    roles: allRoles,
    title: '个人信息',
    description: '',
    showInNavigation: true,
    navigationOrder: 99,
    navigation: { label: '个人信息', description: '', iconKey: 'user' },
    element: ProfilePage,
  },
  {
    key: 'conversations',
    path: '/conversations',
    roles: allRoles,
    title: '我的消息',
    description: '和家人、社区、志愿者沟通',
    showInNavigation: true,
    navigationOrder: 25,
    navigation: { label: '我的消息', description: '', iconKey: 'document' },
    element: ConversationPage,
  },
  {
    key: 'conversation-alias',
    path: '/conversation',
    roles: allRoles,
    title: '我的消息',
    description: '和家人、社区、志愿者沟通',
    showInNavigation: false,
    element: ConversationPage,
  },
  // ── Family ──
  {
    key: 'family-dashboard',
    path: '/family/dashboard',
    roles: ['family'],
    title: '家属首页',
    description: '',
    showInNavigation: true,
    navigationOrder: 10,
    navigation: { label: '家属首页', description: '', iconKey: 'home' },
    element: FamilyDashboardPage,
  },
  {
    key: 'family-elder-detail',
    path: '/family/elders/:elderId',
    roles: ['family'],
    title: '长辈详情',
    description: '',
    showInNavigation: false,
    element: ElderDetailPage,
  },
  {
    key: 'family-bind-elder',
    path: '/family/bind-elder',
    roles: ['family'],
    title: '绑定长辈',
    description: '',
    showInNavigation: true,
    navigationOrder: 20,
    isHomeAction: true,
    navigation: { label: '绑定长辈', description: '', iconKey: 'connect' },
    element: BindElderPage,
  },
  {
    key: 'family-orders',
    path: '/family/orders',
    roles: ['family'],
    title: '服务管理',
    description: '',
    showInNavigation: true,
    navigationOrder: 30,
    isHomeAction: true,
    navigation: { label: '服务管理', description: '', iconKey: 'service' },
    element: FamilyOrdersPage,
  },
  {
    key: 'family-new-request',
    path: '/family/new-request',
    roles: ['family'],
    title: '代长辈下单',
    description: '家属为绑定长辈发布服务需求',
    showInNavigation: true,
    navigationOrder: 31,
    isHomeAction: true,
    navigation: { label: '代长辈下单', description: '', iconKey: 'service' },
    element: NewServiceRequestPage,
  },
  {
    key: 'family-alerts',
    path: '/family/alerts',
    roles: ['family'],
    title: '异常告警',
    description: '',
    showInNavigation: true,
    navigationOrder: 35,
    navigation: { label: '异常告警', description: '', iconKey: 'alert' },
    element: FamilyAlertsPage,
  },
  {
    key: 'family-live-tracking',
    path: '/family/live-tracking',
    roles: ['family'],
    title: '实时守护',
    description: '仅在服务期间查看绑定老人和志愿者的实时状态',
    showInNavigation: true,
    navigationOrder: 33,
    isHomeAction: true,
    navigation: { label: '实时守护', description: '', iconKey: 'dashboard' },
    element: FamilyLiveTrackingPage,
  },
  // ── Elder ──
  {
    key: 'elder-dashboard',
    path: '/elder/dashboard',
    roles: ['elder'],
    title: '我的首页',
    description: '',
    showInNavigation: true,
    navigationOrder: 10,
    navigation: { label: '我的首页', description: '', iconKey: 'home' },
    element: ElderDashboardPage,
  },
  {
    key: 'elder-checkin',
    path: '/elder/checkin',
    roles: ['elder'],
    title: '健康打卡',
    description: '',
    showInNavigation: true,
    navigationOrder: 20,
    isHomeAction: true,
    navigation: { label: '健康打卡', description: '', iconKey: 'heart' },
    element: ElderCheckinPage,
  },
  {
    key: 'elder-sos',
    path: '/elder/sos',
    roles: ['elder'],
    title: '紧急求助',
    description: '',
    showInNavigation: true,
    navigationOrder: 15,
    isHomeAction: true,
    navigation: { label: '紧急求助', description: '', iconKey: 'emergency' },
    element: ElderSosPage,
  },
  {
    key: 'elder-services',
    path: '/elder/services',
    roles: ['elder'],
    title: '谁在帮我',
    description: '',
    showInNavigation: true,
    navigationOrder: 30,
    isHomeAction: true,
    navigation: { label: '谁在帮我', description: '', iconKey: 'service' },
    element: ElderServicesPage,
  },
  {
    key: 'elder-dispatch',
    path: '/elder/dispatch',
    roles: ['elder'],
    title: '请人帮忙',
    description: '告诉系统需要什么帮助，安排志愿者',
    showInNavigation: true,
    navigationOrder: 35,
    isHomeAction: true,
    navigation: { label: '请人帮忙', description: '', iconKey: 'service' },
    element: ElderDispatchPage,
  },
  {
    key: 'elder-companion',
    path: '/elder/companion',
    roles: ['elder'],
    title: '智能陪聊',
    description: '智能助手陪您聊天，语音转文字、朗读回复',
    showInNavigation: true,
    navigationOrder: 27,
    navigation: { label: '智能陪聊', description: '', iconKey: 'chat' },
    element: ElderCompanionPage,
  },
  {
    key: 'elder-weekly-report',
    path: '/elder/weekly-report',
    roles: ['elder'],
    title: '智能周报',
    description: 'AI 根据近7天健康和服务数据自动生成周报',
    showInNavigation: true,
    navigationOrder: 25,
    isHomeAction: true,
    navigation: { label: '智能周报', description: '', iconKey: 'document' },
    element: ElderWeeklyReportPage,
  },
  // ── Volunteer ──
  {
    key: 'volunteer-home',
    path: '/volunteer/home',
    roles: ['volunteer'],
    title: '志愿者首页',
    description: '',
    showInNavigation: true,
    navigationOrder: 5,
    navigation: { label: '志愿者首页', description: '', iconKey: 'home' },
    element: VolunteerDashboardPage,
  },
  {
    key: 'volunteer-dispatch',
    path: '/volunteer/dispatch',
    roles: ['volunteer'],
    title: '智能推荐接单',
    description: '查看技能匹配的实时推荐订单',
    showInNavigation: true,
    navigationOrder: 8,
    navigation: { label: '智能推荐接单', description: '', iconKey: 'service' },
    element: VolunteerDispatchPage,
  },
  {
    key: 'volunteer-tasks',
    path: '/volunteer/tasks',
    roles: ['volunteer'],
    title: '我的任务',
    description: '',
    showInNavigation: true,
    navigationOrder: 10,
    navigation: { label: '我的任务', description: '', iconKey: 'dashboard' },
    element: VolunteerTasksPage,
  },
  {
    key: 'volunteer-task-detail',
    path: '/volunteer/tasks/:taskId',
    roles: ['volunteer'],
    title: '任务详情',
    description: '',
    showInNavigation: false,
    element: VolunteerTaskDetailPage,
  },
  {
    key: 'volunteer-profile',
    path: '/volunteer/profile',
    roles: ['volunteer'],
    title: '我的成就',
    description: '',
    showInNavigation: true,
    navigationOrder: 20,
    navigation: { label: '我的成就', description: '', iconKey: 'user' },
    element: VolunteerProfilePage,
  },
  {
    key: 'family-honor-wall',
    path: '/family/honor-wall',
    roles: ['family'],
    title: '荣誉墙',
    description: '',
    showInNavigation: true,
    navigationOrder: 40,
    isHomeAction: true,
    navigation: { label: '荣誉墙', description: '', iconKey: 'honor' },
    element: VolunteerLeaderboardPage,
  },
  {
    key: 'volunteer-leaderboard',
    path: '/volunteer/leaderboard',
    roles: ['volunteer'],
    title: '荣誉墙',
    description: '',
    showInNavigation: true,
    navigationOrder: 30,
    isHomeAction: true,
    navigation: { label: '荣誉墙', description: '', iconKey: 'honor' },
    element: VolunteerLeaderboardPage,
  },
  {
    key: 'admin-honor-wall',
    path: '/admin/honor-wall',
    roles: ['admin'],
    title: '荣誉墙',
    description: '',
    showInNavigation: true,
    navigationOrder: 40,
    isHomeAction: true,
    navigation: { label: '荣誉墙', description: '', iconKey: 'honor' },
    element: VolunteerLeaderboardPage,
  },
  // ── Admin ──
  {
    key: 'admin-home',
    path: '/admin/home',
    roles: ['admin'],
    title: '管理首页',
    description: '',
    showInNavigation: true,
    navigationOrder: 5,
    navigation: { label: '管理首页', description: '', iconKey: 'home' },
    element: AdminHomePage,
  },
  {
    key: 'admin-dispatch-board',
    path: '/admin/dispatch-board',
    roles: ['admin'],
    title: '实时调度指挥台',
    description: 'A*路线、候选评分和并发调度看板',
    showInNavigation: true,
    navigationOrder: 15,
    navigation: { label: '实时调度指挥台', description: '', iconKey: 'dashboard' },
    element: AdminDispatchBoardPage,
  },
  {
    key: 'admin-regions',
    path: '/admin/regions',
    roles: ['admin'],
    title: '区域管理',
    description: '总管理员按省市区添加官方多边形调度区域',
    showInNavigation: true,
    navigationOrder: 16,
    navigation: { label: '区域管理', description: '', iconKey: 'dashboard' },
    element: AdminRegionsPage,
  },
  {
    key: 'admin-ai-settings',
    path: '/admin/ai-settings',
    roles: ['admin'],
    title: 'AI模型配置',
    description: 'Groq、自定义模型与 Edge TTS 参数配置',
    showInNavigation: true,
    navigationOrder: 17,
    navigation: { label: 'AI模型配置', description: '', iconKey: 'chat' },
    element: AdminAiSettingsPage,
  },
  {
    key: 'admin-dashboard',
    path: '/admin/dashboard',
    roles: ['admin'],
    title: '总览看板',
    description: '',
    showInNavigation: true,
    navigationOrder: 10,
    navigation: { label: '总览看板', description: '', iconKey: 'dashboard' },
    element: AdminDashboardPage,
  },
  {
    key: 'admin-users',
    path: '/admin/users',
    roles: ['admin'],
    title: '用户管理',
    description: '',
    showInNavigation: true,
    navigationOrder: 20,
    navigation: { label: '用户管理', description: '', iconKey: 'team' },
    element: AdminUsersPage,
  },
  {
    key: 'admin-hour-reviews',
    path: '/admin/hour-reviews',
    roles: ['admin'],
    title: '时长审核',
    description: '',
    showInNavigation: true,
    navigationOrder: 25,
    navigation: { label: '时长审核', description: '', iconKey: 'alert' },
    element: AdminHourReviewsPage,
  },
  {
    key: 'admin-alerts',
    path: '/admin/alerts',
    roles: ['admin'],
    title: '告警中心',
    description: '',
    showInNavigation: true,
    navigationOrder: 30,
    navigation: { label: '告警中心', description: '', iconKey: 'alert' },
    element: AdminAlertsPage,
  },
  {
    key: 'admin-donations',
    path: '/admin/donations',
    roles: ['admin'],
    title: '爱心捐赠',
    description: '查看爱心捐款沙盘生成的演示支付信息',
    showInNavigation: true,
    navigationOrder: 31,
    navigation: { label: '爱心捐赠', description: '', iconKey: 'heart' },
    element: AdminDonationsPage,
  },
]

export function getNavigationForRole(role: Role, options?: { isRoot?: boolean }) {
  const navigationItems = appRoutes
    .filter((route) => {
      if (route.isPublic || !route.showInNavigation || !route.roles.includes(role)) {
        return false
      }
      // District admins must not manage official region polygons.
      if (route.key === 'admin-regions' && !options?.isRoot) {
        return false
      }
      if (route.key === 'admin-ai-settings' && !options?.isRoot) {
        return false
      }
      if (route.key === 'admin-donations' && !options?.isRoot) {
        return false
      }
      // Hour reviews are operational work for district admins; root uses看板抽查.
      if (route.key === 'admin-hour-reviews' && options?.isRoot) {
        return false
      }
      // Admin SOS lives in 告警中心; hide duplicate 我的消息 inbox for admins.
      if (route.key === 'conversations' && role === 'admin') {
        return false
      }
      return true
    })
    .sort(
      (left, right) =>
        (left.navigationOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.navigationOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .map((route) => ({
      key: route.key,
      label: route.navigation?.label ?? route.title,
      path: route.path,
      icon: iconMap[route.navigation?.iconKey ?? 'home'],
      description: route.description,
      order:
        route.path === '/task-hall'
          ? 98
          : route.path === '/profile'
            ? 99
            : route.navigationOrder ?? Number.MAX_SAFE_INTEGER,
    }))

  if (taskHallNavigationRoles.includes(role)) {
    navigationItems.push({
      key: 'public-task-hall-nav',
      label: '任务大厅',
      path: '/task-hall',
      icon: iconMap.service,
      description: '查看公益服务任务',
      order: 98,
    })
  }

  return navigationItems
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...item }) => item)
}

export function getRouteDefinition(pathname: string) {
  return appRoutes.find((route) =>
    matchPath({ path: route.path, end: true }, pathname),
  )
}

export function getHomeActions(role: Role) {
  return appRoutes
    .filter(
      (route) =>
        !route.isPublic &&
        route.roles.includes(role) &&
        route.isHomeAction &&
        route.path !== getDefaultRoute(role),
    )
    .sort(
      (left, right) =>
        (left.navigationOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.navigationOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 3)
    .map((route) => ({
      key: route.key,
      label: route.navigation?.label ?? route.title,
      path: route.path,
      icon: iconMap[route.navigation?.iconKey ?? 'home'],
      description: route.description,
    }))
}
