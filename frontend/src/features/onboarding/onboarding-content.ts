import type { Role } from '@/types/domain'

export interface OnboardingStep {
  key: string
  title: string
  description: string
  icon: string
  ctaPath?: string
  image?: string
}

export const onboardingContent: Record<Role, OnboardingStep[]> = {
  family: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '欢迎使用社区智慧伴老平台！作为家属，您可以通过本平台随时关注长辈的日常健康打卡数据、一键代为发布养老服务需求、实时查看志愿服务轨迹与接单进度，全方位保障长辈的晚年生活安全与生活照护。',
      icon: '🏠',
    },
    {
      key: 'bind-elder',
      title: '绑定长辈',
      description: '【绑定指引】输入长辈注册时的手机号码建立亲属关联。建议在绑定表单中详细填写入长辈的性格习惯、日常喜好、慢性病病史与特殊照护提示，这些信息将同步分享给抢单的志愿者，帮助他们提供更加贴心、个性化的关怀服务。',
      icon: '🔗',
      ctaPath: '/family/bind-elder',
      image: '/guide-images/family-bind-elder.png',
    },
    {
      key: 'health',
      title: '健康趋势与告警',
      description: '【健康监控】在长辈详情与健康看板中，您可以查看长辈近 7 天、30 天的血压、心率、血糖、体温走势图。当系统检测到长辈连续未打卡或血压/血糖指标超过安全红线时，系统将通过微信/短信及系统消息即时向您推送异常告警信息。',
      icon: '📊',
      ctaPath: '/family/dashboard',
    },
    {
      key: 'orders',
      title: '发布服务需求',
      description: '【代下单指引】进入代长辈下单页面，选择绑定的长辈、服务类型（如陪同就医、代买代办、康复训练等）、服务预约时间与预估时长。系统会自动提取长辈当前的居住服务点地址，并基于高德地图引擎将订单智能推荐给附近的优质志愿者。',
      icon: '📝',
      ctaPath: '/family/new-request',
      image: '/guide-images/family-orders.png',
    },
    {
      key: 'tracking',
      title: '实时追踪志愿者',
      description: '【服务追踪】志愿者接单并开启前往行程后，您可以在实时追踪地图上查看志愿者的实时地理位置、移动路线及预计到达时间。服务圆满完成后，您还可以对志愿者的服务质量进行评价与点赞。',
      icon: '📍',
      ctaPath: '/family/live-tracking',
    },
  ],

  elder: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '欢迎来到智慧伴老平台！为了方便您的使用，系统已为您自动开启专属大字号与高对比度关怀模式。在这里您可以轻松完成每天的健康打卡、在遇到困难时随时发起一键紧急求助，以及查看志愿者对您的照料服务记录。',
      icon: '🏠',
    },
    {
      key: 'companion',
      title: 'AI 智能伴聊',
      description: '【AI 语音与文字伴聊】在这里您可以随时与专属 AI 陪伴助手语音或文字对话交流。智能助手能陪伴您聊天解闷、解答健康常识、提醒用药与天气，让您的日常生活更加丰富温馨、不再孤单。',
      icon: '💬',
      ctaPath: '/elder/companion',
      image: '/guide-images/elder-companion.png',
    },
    {
      key: 'checkin',
      title: '每日健康打卡',
      description: '【健康打卡指引】请您每天按时在打卡页面输入收缩压、舒张压、心率、血糖等健康数值。系统会自动帮您记录并生成健康趋势折线图，若数值有异常还会第一时间提醒您的家属和社区管理员，陪伴您的每一天健康。',
      icon: '💪',
      ctaPath: '/elder/checkin',
      image: '/guide-images/elder-checkin.png',
    },
    {
      key: 'sos',
      title: '一键 SOS 求助',
      description: '【紧急求助指引】如果您在家中或出行时遇到突发身体不适、摔倒或其他紧急情况，请点击底部的红框 SOS 紧急求助按钮。系统会立刻触发高音响铃与紧急告警，同步将您的定位发送给家属、社区管理员以及附近的志愿者前来救援。',
      icon: '🚨',
      ctaPath: '/elder/sos',
      image: '/guide-images/elder-sos.png',
    },
    {
      key: 'services',
      title: '查看服务记录',
      description: '【服务记录与评价】您可以在此查看志愿者为您提供的陪同就医、代买物品、上门关怀等历史服务明细。服务完成后，您可以为贴心的志愿者点击【👍 点赞】予以鼓励，或者提交您的切身服务评价。',
      icon: '📋',
      ctaPath: '/elder/services',
    },
    {
      key: 'weekly-report',
      title: '智能健康周报',
      description: '【AI 智能健康分析周报】每周系统会自动汇总分析您的血压、心率、血糖打卡记录与志愿关怀陪伴情况，由智能算法为您生成专属的每周健康分析报告与生活建议，助您轻松掌握身体健康动态。',
      icon: '📈',
      ctaPath: '/elder/weekly-report',
    },
  ],

  volunteer: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '欢迎加入社区智慧伴老志愿者团队！在这里您可以通过智能推荐接单匹配、帮助身边的社区老人解决就医与生活困难。每一次志愿服务都将精准记录入您的个人志愿时长档案，并可参与每周荣誉榜评比。',
      icon: '🏠',
    },
    {
      key: 'dispatch',
      title: '智能派单',
      description: '【智能派单规则】系统结合高德地图路线算法与技能匹配度为您推送订单。系统采用 Top1 专属确认（35秒确认期） → Top3 扩圈 → Top10 全网抢单机制。遇到紧急 SOS 求助时，优先派发给开启了「自动接单」且距离最近的志愿者。',
      icon: '🎯',
      ctaPath: '/volunteer/dispatch',
      image: '/guide-images/volunteer-dispatch.png',
    },
    {
      key: 'tasks',
      title: '任务列表',
      description: '【任务管理】在任务大厅与进行中列表中，您可以查看已接订单的详细地址、老人性格喜好与特殊照护提示。点击「开始前往」后即可开启路线追踪，服务完成后点击「完成服务」提交拍照打卡。',
      icon: '📋',
      ctaPath: '/volunteer/tasks',
    },
    {
      key: 'navigation',
      title: '实时导航',
      description: '【地图导航】接单后系统自动规划前往老人住址的最优道路路线（支持步导、骑导与驾车导航），显示实时路况与预计抵达分钟数，也可一键调起外部高德地图App进行语音导航。',
      icon: '🗺️',
      ctaPath: '/volunteer/tasks',
    },
    {
      key: 'leaderboard',
      title: '荣誉排行榜',
      description: '【时长与荣誉】您完成的所有有效关怀服务时长都将实时计入时长库。每周日深夜系统会自动执行每周结算，排名前三名的优秀志愿者将获得社区专属荣誉勋章与志愿积分奖励。',
      icon: '🏆',
      ctaPath: '/volunteer/leaderboard',
    },
  ],

  admin: [
    {
      key: 'welcome',
      title: '欢迎使用智慧伴老平台',
      description: '欢迎登录智慧伴老社区管理后台！作为管理员，您拥有全区老人家属与志愿者数据管理、高德调度沙盘监控、SOS 告警快速处置分流、志愿者服务时长审核及全站数据大屏监控等核心权限。',
      icon: '🏠',
    },
    {
      key: 'users',
      title: '用户管理',
      description: '【用户管理与审核】您可以在此查看并管理管辖区县内的老人、家属及志愿者账号。支持按区域与角色筛选、快速审核志愿者资质注册申请、分配志愿者专业服务技能标签及启用/禁用账号状态。',
      icon: '👥',
      ctaPath: '/admin/users',
      image: '/guide-images/admin-users.png',
    },
    {
      key: 'dispatch-board',
      title: '调度看板',
      description: '【全区高德调度沙盘】实时显示辖区内的高德沙盘地图，动态监控所有待调度订单、服务中行程、SOS 紧急求助点位及空闲志愿者分布情况。支持一键点击【刷新真实订单数据】更新沙盘推演。',
      icon: '🎛️',
      ctaPath: '/admin/dispatch-board',
      image: '/guide-images/admin-dispatch-board.png',
    },
    {
      key: 'alerts',
      title: '告警中心',
      description: '【告警监控与处置】集中监控老人发起的 SOS 紧急求助告警及连续未打卡/血压异常告警。管理员可在此进行人工干预、联系家属、指派专属志愿者或联动社区救援力量，确保每一起告警均得到妥善处置。',
      icon: '🔔',
      ctaPath: '/admin/alerts',
    },
    {
      key: 'settlement',
      title: '时长审计与结算',
      description: '【时长审计与每周结算】针对服务时长显著超过预估或存在争议的关怀订单进行人工审计核扣；支持手动或系统定时执行每周志愿时长结算、排行榜更新与勋章自动发放。',
      icon: '⏱️',
      ctaPath: '/admin/hour-reviews',
    },
    {
      key: 'dashboard',
      title: '数据看板',
      description: '【运营数据大屏】全方位展示社区养老运营指标，包括老人建档数、服务完成率、告警处置率、志愿者活跃度及各区县服务贡献排名走势，为社区照护决策提供数据支撑。',
      icon: '📊',
      ctaPath: '/admin/dashboard',
    },
  ],
}
