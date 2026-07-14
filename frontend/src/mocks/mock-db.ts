import {
  alertsFixture,
  adminUsersFixture,
  dashboardMetricsFixture,
} from '@/mocks/fixtures/admin'
import { elderPendingServicesFixture } from '@/mocks/fixtures/elder'
import {
  familyEldersFixture,
  familyHealthFixture,
  serviceRequestsFixture,
} from '@/mocks/fixtures/family'
import {
  accountsFixture,
  healthKnowledgeFixture,
  profilesFixture,
  type MockAccount,
} from '@/mocks/fixtures/shared'
import {
  volunteerLeaderboardFixture,
  volunteerProfileFixture,
  volunteerTasksFixture,
} from '@/mocks/fixtures/volunteer'
import type {
  AlertItem,
  DashboardMetric,
  HealthKnowledgeEntry,
  PendingService,
  ProfileSnapshot,
  ServiceRequestCard,
  VolunteerProfile,
  VolunteerTaskCard,
} from '@/types/domain'

export interface MockDatabase {
  accounts: MockAccount[]
  profiles: Record<number, ProfileSnapshot>
  healthKnowledge: HealthKnowledgeEntry[]
  elders: typeof familyEldersFixture
  health: typeof familyHealthFixture
  serviceRequests: ServiceRequestCard[]
  pendingServices: PendingService[]
  volunteerTasks: VolunteerTaskCard[]
  volunteerProfiles: VolunteerProfile[]
  adminUsers: typeof adminUsersFixture
  alerts: AlertItem[]
  dashboardMetrics: DashboardMetric[]
  likePairs: string[]
  nextRequestId: number
  nextAlertId: number
  nextUserId: number
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createMockDatabase(): MockDatabase {
  return {
    accounts: clone(accountsFixture),
    profiles: clone(profilesFixture),
    healthKnowledge: clone(healthKnowledgeFixture),
    elders: clone(familyEldersFixture),
    health: clone(familyHealthFixture),
    serviceRequests: clone(serviceRequestsFixture),
    pendingServices: clone(elderPendingServicesFixture),
    volunteerTasks: clone(volunteerTasksFixture),
    volunteerProfiles: clone(volunteerLeaderboardFixture),
    adminUsers: clone(adminUsersFixture),
    alerts: clone(alertsFixture),
    dashboardMetrics: clone(dashboardMetricsFixture),
    likePairs: ['101:302', '201:302'],
    nextRequestId: 900,
    nextAlertId: 900,
    nextUserId: 500,
  }
}

let database = createMockDatabase()

export function getMockDatabase() {
  return database
}

export function getPrimaryVolunteerProfile() {
  return (
    database.volunteerProfiles.find((item) => item.leaderboardRank === 2) ??
    clone(volunteerProfileFixture)
  )
}

export function resetMockDatabase() {
  database = createMockDatabase()
}
