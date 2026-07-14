import type { VolunteerProfile, VolunteerTaskCard } from '@/types/domain'

export const volunteerTasksFixture: VolunteerTaskCard[] = [
  {
    orderId: 501,
    serviceType: '陪同就医',
    scheduledTime: '2026-03-25 09:30',
    addressPreview: '幸福里 3 栋 201',
    serviceHours: 2,
    urgencyLevel: 'high',
    elderName: '张桂芳',
    status: 'pending',
    availableActions: ['accept'],
  },
  {
    orderId: 502,
    serviceType: '上门陪聊',
    scheduledTime: '2026-03-24 15:00',
    addressPreview: '幸福里 3 栋 201',
    serviceHours: 1.5,
    urgencyLevel: 'medium',
    elderName: '张桂芳',
    status: 'accepted',
    availableActions: ['complete'],
  },
  {
    orderId: 503,
    serviceType: '陪同复诊',
    scheduledTime: '2026-03-26 11:00',
    addressPreview: '康宁苑 8 栋 602',
    serviceHours: 2.5,
    urgencyLevel: 'medium',
    elderName: '李建国',
    status: 'pending',
    availableActions: ['accept'],
  },
]

export const volunteerProfileFixture: VolunteerProfile = {
  rank: 2,
  leaderboardRank: 2,
  userId: 302,
  realName: '王佳明',
  completedCount: 18,
  totalHours: 42,
  weeklyHours: 6,
  likesCount: 13,
  awards: ['社区暖心服务奖'],
  badges: ['社区暖心服务奖'],
}

export const volunteerLeaderboardFixture: VolunteerProfile[] = [
  {
    rank: 1,
    leaderboardRank: 1,
    userId: 301,
    realName: '李志强',
    completedCount: 26,
    totalHours: 58,
    weeklyHours: 9,
    likesCount: 20,
    awards: ['本周公益之星', '社区暖心服务奖'],
    badges: ['本周公益之星', '社区暖心服务奖'],
  },
  volunteerProfileFixture,
  {
    rank: 3,
    leaderboardRank: 3,
    userId: 303,
    realName: '赵海涛',
    completedCount: 14,
    totalHours: 30,
    weeklyHours: 4,
    likesCount: 8,
    awards: ['守时服务奖'],
    badges: ['守时服务奖'],
  },
]
