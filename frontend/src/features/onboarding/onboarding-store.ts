import type { Role } from '@/types/domain'

const ONBOARDING_SEEN_PREFIX = 'eldercare.onboarding.seen'

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function getSeenKey(userId: number, role: Role): string {
  return `${ONBOARDING_SEEN_PREFIX}:${userId}:${role}`
}

/**
 * Check whether the onboarding guide has been permanently dismissed
 * for the given user + role combination.
 */
export function hasSeenOnboarding(userId: number, role: Role): boolean {
  if (!canUseStorage()) return false
  try {
    return window.localStorage.getItem(getSeenKey(userId, role)) === '1'
  } catch {
    return false
  }
}

/**
 * Mark the onboarding guide as permanently dismissed so it won't
 * auto-popup on next login. Manual access via the help icon still works.
 */
export function markOnboardingSeen(userId: number, role: Role): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(getSeenKey(userId, role), '1')
  } catch {
    // localStorage might be full or disabled — silently degrade
  }
}
