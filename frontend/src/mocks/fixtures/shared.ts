import { getDefaultRoute } from '@/routes/role-defaults'
import type {
  AccountStatus,
  HealthKnowledgeEntry,
  ProfileSnapshot,
  ReviewState,
  Role,
  SessionUser,
} from '@/types/domain'

export interface MockAccount {
  userId: number
  username: string
  password: string
  role: Role
  realName: string
  phone: string
  email: string
  status: AccountStatus
  reviewState: ReviewState
  age?: number
  gender?: string
  address?: string
  idCard?: string
  skills?: string
}

export const accountsFixture: MockAccount[] = [
  {
    userId: 101,
    username: 'family01',
    password: '123456',
    role: 'family',
    realName: '陈晓琳',
    phone: '13800001111',
    email: 'family01@example.com',
    status: 'active',
    reviewState: 'none',
  },
  {
    userId: 201,
    username: 'elder01',
    password: '123456',
    role: 'elder',
    realName: '张桂芳',
    phone: '13900002222',
    email: 'elder01@example.com',
    status: 'active',
    reviewState: 'none',
    age: 72,
    gender: '女',
    address: '幸福里 3 栋 201',
  },
  {
    userId: 202,
    username: 'elder02',
    password: '123456',
    role: 'elder',
    realName: '李建国',
    phone: '13900002223',
    email: 'elder02@example.com',
    status: 'active',
    reviewState: 'none',
    age: 78,
    gender: '男',
    address: '康宁苑 8 栋 602',
  },
  {
    userId: 301,
    username: 'volunteer01',
    password: '123456',
    role: 'volunteer',
    realName: '李志强',
    phone: '13700003333',
    email: 'volunteer01@example.com',
    status: 'pending_review',
    reviewState: 'pending_review',
    idCard: '110105194912310021',
    skills: '会理发、懂急救',
  },
  {
    userId: 302,
    username: 'volunteer02',
    password: '123456',
    role: 'volunteer',
    realName: '王佳明',
    phone: '13600004444',
    email: 'volunteer02@example.com',
    status: 'active',
    reviewState: 'approved',
    idCard: '110105194912310022',
    skills: '陪诊、沟通协调',
  },
  {
    userId: 401,
    username: 'admin01',
    password: '123456',
    role: 'admin',
    realName: '社区管理员',
    phone: '13500005555',
    email: 'admin01@example.com',
    status: 'active',
    reviewState: 'none',
  },
]

export const profilesFixture: Record<number, ProfileSnapshot> = {
  101: {
    accountId: 101,
    role: 'family',
    realName: '陈晓琳',
    phone: '13800001111',
    email: 'family01@example.com',
  },
  201: {
    accountId: 201,
    role: 'elder',
    realName: '张桂芳',
    phone: '13900002222',
    email: 'elder01@example.com',
    medicalHistory: '高血压',
    alertSysThreshold: 140,
  },
  202: {
    accountId: 202,
    role: 'elder',
    realName: '李建国',
    phone: '13900002223',
    email: 'elder02@example.com',
    medicalHistory: '血糖偏高',
    alertSysThreshold: 145,
  },
  301: {
    accountId: 301,
    role: 'volunteer',
    realName: '李志强',
    phone: '13700003333',
    email: 'volunteer01@example.com',
    skills: '会理发、懂急救',
    totalHours: 18,
    weeklyHours: 0,
    awards: [],
    likesCount: 2,
  },
  302: {
    accountId: 302,
    role: 'volunteer',
    realName: '王佳明',
    phone: '13600004444',
    email: 'volunteer02@example.com',
    skills: '陪诊、沟通协调',
    totalHours: 42,
    weeklyHours: 6,
    awards: ['社区暖心服务奖'],
    likesCount: 13,
  },
  401: {
    accountId: 401,
    role: 'admin',
    realName: '社区管理员',
    phone: '13500005555',
    email: 'admin01@example.com',
  },
}

export const healthKnowledgeFixture: HealthKnowledgeEntry[] = [
  {
    entryId: 'blood-pressure',
    metricType: 'blood_pressure',
    title: '血压',
    normalRangeText: '90/60 ~ 140/90 mmHg',
    summary: '持续偏高或偏低都值得关注，测量时尽量保持平静。',
    careTips: ['固定时间测量', '发现持续波动及时就医'],
  },
  {
    entryId: 'blood-oxygen',
    metricType: 'blood_oxygen',
    title: '血氧',
    normalRangeText: '95% ~ 100%',
    summary: '如果明显偏低，说明身体供氧可能不足。',
    careTips: ['保持通风', '反复偏低及时求助'],
  },
  {
    entryId: 'blood-sugar',
    metricType: 'blood_sugar',
    title: '血糖',
    normalRangeText: '空腹 3.9 ~ 6.1 mmol/L',
    summary: '餐前、餐后波动都需要结合医生建议判断。',
    careTips: ['规律饮食', '按医嘱监测'],
  },
  {
    entryId: 'temperature',
    metricType: 'temperature',
    title: '体温',
    normalRangeText: '36.1°C ~ 37.2°C',
    summary: '过高或过低都可能提示身体正在经历异常状态。',
    careTips: ['发热时补水', '持续异常及时就诊'],
  },
  {
    entryId: 'weight',
    metricType: 'weight',
    title: '体重',
    normalRangeText: '短期内大幅波动需关注',
    summary: '体重变化往往和饮食、活动量、慢病管理有关。',
    careTips: ['固定时间记录', '结合饮食和运动看趋势'],
  },
  {
    entryId: 'heart-rate',
    metricType: 'heart_rate',
    title: '心率',
    normalRangeText: '60 ~ 100 次/分钟',
    summary: '剧烈活动、情绪波动和不适都会影响心率。',
    careTips: ['安静休息后测量', '持续异常及时咨询医生'],
  },
]

export function buildSessionUser(role: Role, displayName?: string): SessionUser {
  const account =
    role === 'volunteer'
      ? accountsFixture.find((item) => item.userId === 302)
      : accountsFixture.find((item) => item.role === role)

  if (!account) {
    throw new Error('缺少演示账号')
  }

  return {
    userId: account.userId,
    username: account.username,
    role: account.role,
    displayName: displayName ?? account.realName,
    email: account.email,
    tokenState: 'active',
    reviewState: account.reviewState,
    lastVisitedRoute: getDefaultRoute(account.role),
  }
}

export function buildSessionUserFromAccount(account: MockAccount): SessionUser {
  return {
    userId: account.userId,
    username: account.username,
    role: account.role,
    displayName: account.realName,
    email: account.email,
    tokenState: 'active',
    reviewState: account.reviewState,
    lastVisitedRoute: getDefaultRoute(account.role),
  }
}
