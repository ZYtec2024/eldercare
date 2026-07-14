import type { Role } from '@/types/domain'

export const roleDefaultRoutes: Record<Role, string> = {
  family: '/family/dashboard',
  elder: '/elder/dashboard',
  volunteer: '/volunteer/home',
  admin: '/admin/home',
}

export function getDefaultRoute(role: Role) {
  return roleDefaultRoutes[role]
}

const roleAllowedPrefixes: Record<Role, string[]> = {
  family: ['/family', '/profile', '/family/honor-wall'],
  elder: ['/elder', '/profile'],
  volunteer: ['/volunteer', '/profile'],
  admin: ['/admin', '/profile', '/admin/honor-wall'],
}

export function isRoleAllowedPath(role: Role, pathname: string) {
  return roleAllowedPrefixes[role].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function resolvePostLoginRoute(role: Role, pathname?: string | null) {
  if (pathname && isRoleAllowedPath(role, pathname)) {
    return pathname
  }

  return getDefaultRoute(role)
}
