import type { AdminUserRow, AlertItem, DashboardMetric } from '@/types/domain'

export const adminUsersFixture: AdminUserRow[] = [
  {
    userId: 101,
    username: 'family01',
    role: 'family',
    name: '陈晓琳',
    phone: '13800001111',
    email: 'family01@example.com',
    status: 'active',
  },
  {
    userId: 201,
    username: 'elder01',
    role: 'elder',
    name: '张桂芳',
    phone: '13900002222',
    email: 'elder01@example.com',
    status: 'active',
  },
  {
    userId: 301,
    username: 'volunteer01',
    role: 'volunteer',
    name: '李志强',
    phone: '13700003333',
    email: 'volunteer01@example.com',
    status: 'pending_review',
  },
  {
    userId: 302,
    username: 'volunteer02',
    role: 'volunteer',
    name: '王佳明',
    phone: '13600004444',
    email: 'volunteer02@example.com',
    status: 'active',
  },
]

export const alertsFixture: AlertItem[] = [
  {
    alertId: 801,
    category: 'sos',
    priority: 'high',
    createdAt: '2026-03-23 09:20',
    status: 'new',
    sourceLabel: '张桂芳紧急求助',
    linkedEntityId: 201,
  },
  {
    alertId: 802,
    category: 'health_abnormal',
    priority: 'medium',
    createdAt: '2026-03-23 10:45',
    status: 'new',
    sourceLabel: '张桂芳血压连续偏高',
    linkedEntityId: 201,
  },
]

export const dashboardMetricsFixture: DashboardMetric[] = [
  {
    metricId: 'users',
    label: '平台用户',
    value: 350,
    comparisonText: '较上周新增 12 人',
    visualType: 'stat',
    datasetPreview: [],
  },
  {
    metricId: 'orders',
    label: '活跃订单',
    value: 12,
    comparisonText: '今日待处理 4 单',
    visualType: 'stat',
    datasetPreview: [],
  },
  {
    metricId: 'services',
    label: '服务类型分布',
    value: 0,
    comparisonText: '本月社区最常见服务',
    visualType: 'pie',
    datasetPreview: [
      { label: '陪同就医', value: 12 },
      { label: '上门陪聊', value: 8 },
      { label: '代买药品', value: 5 },
    ],
  },
  {
    metricId: 'volunteers',
    label: '志愿者贡献排行',
    value: 0,
    comparisonText: '本月总服务时长前列',
    visualType: 'bar',
    datasetPreview: [
      { label: '王佳明', value: 42 },
      { label: '李志强', value: 18 },
      { label: '陈小宇', value: 15 },
    ],
  },
]
