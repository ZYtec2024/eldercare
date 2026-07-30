export function proxyRoleLabel(role?: string | null) {
  if (role === 'admin') return '管理员'
  if (role === 'family') return '家属'
  return '代下人'
}

export function proxyActorName(name?: string | null, role?: string | null) {
  return name || proxyRoleLabel(role)
}

export function proxyOrderTag(role?: string | null) {
  return `${proxyRoleLabel(role)}代下`
}

export function proxyOrderAlertTitle(roles: Array<string | null | undefined>) {
  const uniqueRoles = new Set(roles.filter(Boolean))
  if (uniqueRoles.size === 1) {
    return `${proxyRoleLabel([...uniqueRoles][0])}已为您代下服务单`
  }
  return '您有新的代下服务单'
}
