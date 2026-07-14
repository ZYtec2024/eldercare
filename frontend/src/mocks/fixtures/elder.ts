import type { PendingService } from '@/types/domain'

export const elderPendingServicesFixture: PendingService[] = [
  {
    orderId: 502,
    serviceType: '上门陪聊',
    time: '2026-03-24 15:00',
    volunteerName: '王佳明',
    status: 'accepted',
  },
  {
    orderId: 501,
    serviceType: '陪同就医',
    time: '2026-03-25 09:30',
    status: 'pending',
  },
  {
    orderId: 504,
    serviceType: '代买药品',
    time: '2026-03-23 11:00',
    volunteerName: '王佳明',
    status: 'completed',
    canReview: true,
    reviewSubmitted: false,
  },
]
