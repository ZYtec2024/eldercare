import type { Role } from '@/types/domain'

export interface OnboardingStep {
  key: string
  title: string
  description: string
  icon: string
  ctaPath?: string
}

export const onboardingContent: Record<Role, OnboardingStep[]> = {
  family: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '作为家属，您可以绑定长辈、查看健康数据、发布服务需求，并实时追踪志愿者服务进度。',
      icon: '🏠',
    },
    {
      key: 'bind-elder',
      title: '绑定长辈',
      description: '通过长辈的手机号建立关联。绑定时可以填写老人性格简介，帮助志愿者更好地服务。',
      icon: '🔗',
      ctaPath: '/family/bind-elder',
    },
    {
      key: 'health',
      title: '健康趋势与告警',
      description: '在长辈详情页查看近 7 天的健康打卡数据和趋势图。长辈血压/体温异常时会自动向您推送告警。',
      icon: '📊',
      ctaPath: '/family/dashboard',
    },
    {
      key: 'orders',
      title: '发布服务需求',
      description: '为长辈发布陪诊、代购、上门陪伴等服务需求，系统会智能匹配附近的志愿者。',
      icon: '📝',
      ctaPath: '/family/new-request',
    },
    {
      key: 'tracking',
      title: '实时追踪志愿者',
      description: '服务进行中可在地图上实时查看志愿者位置和预计到达时间，服务结束后位置自动锁定。',
      icon: '📍',
      ctaPath: '/family/live-tracking',
    },
  ],

  elder: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '作为长辈，您可以每日健康打卡、一键 SOS 求助、查看服务记录。页面已为您自动开启大字模式。',
      icon: '🏠',
    },
    {
      key: 'checkin',
      title: '每日健康打卡',
      description: '每天记录血压、心率、体温等指标。异常数据会自动通知家属，请按时打卡。',
      icon: '💪',
      ctaPath: '/elder/checkin',
    },
    {
      key: 'sos',
      title: '一键 SOS 求助',
      description: '遇到紧急情况点击 SOS 按钮，系统会立即通知家属和管理员，并派附近的志愿者前来帮助。',
      icon: '🚨',
      ctaPath: '/elder/sos',
    },
    {
      key: 'services',
      title: '查看服务记录',
      description: '查看志愿者为您提供的陪诊、代购等服务记录，服务完成后可以对志愿者进行评价。',
      icon: '📋',
      ctaPath: '/elder/services',
    },
  ],

  volunteer: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '作为志愿者，您可以领取服务任务、查看老人简介、实时导航至服务地点，并积累志愿时长和荣誉。',
      icon: '🏠',
    },
    {
      key: 'dispatch',
      title: '智能派单',
      description: '系统会根据距离、路况、技能匹配度为您推荐任务。Top1 专属确认 → Top3 → Top10 逐步扩散，越早响应机会越大。',
      icon: '🎯',
      ctaPath: '/volunteer/dispatch',
    },
    {
      key: 'tasks',
      title: '任务列表',
      description: '查看待接单和进行中的任务。接单后可以在任务卡片上看到老人性格简介，便于提供贴心服务。',
      icon: '📋',
      ctaPath: '/volunteer/tasks',
    },
    {
      key: 'navigation',
      title: '实时导航',
      description: '接单后地图会显示前往老人住址的路线和预计到达时间，支持一键打开高德导航。',
      icon: '🗺️',
    },
    {
      key: 'leaderboard',
      title: '荣誉排行榜',
      description: '完成服务积累志愿时长，每周结算时 TOP3 志愿者自动获得荣誉奖章。',
      icon: '🏆',
      ctaPath: '/volunteer/leaderboard',
    },
  ],

  admin: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '作为管理员，您可以管理用户、审核志愿者、处理告警、审计志愿时长、执行每周结算，并查看数据看板。',
      icon: '🏠',
    },
    {
      key: 'users',
      title: '用户管理',
      description: '查看全部用户、审核志愿者注册、管理用户状态和区域权限。',
      icon: '👥',
      ctaPath: '/admin/users',
    },
    {
      key: 'dispatch-board',
      title: '调度看板',
      description: '实时监控全区域服务调度状态，查看 Top1/Top3/Top10 派单池和兜底分配情况。',
      icon: '🎛️',
      ctaPath: '/admin/dispatch-board',
    },
    {
      key: 'alerts',
      title: '告警中心',
      description: '处理老人 SOS 和健康异常告警，可对话沟通、派单或关闭告警。',
      icon: '🔔',
      ctaPath: '/admin/alerts',
    },
    {
      key: 'settlement',
      title: '时长审计与结算',
      description: '审核超预估时长的服务记录，执行每周结算清零并颁发荣誉奖章。',
      icon: '⏱️',
      ctaPath: '/admin/hour-reviews',
    },
    {
      key: 'dashboard',
      title: '数据看板',
      description: '查看全平台运营数据统计，包括用户增长、服务量、志愿时长等关键指标。',
      icon: '📊',
      ctaPath: '/admin/dashboard',
    },
  ],
}
