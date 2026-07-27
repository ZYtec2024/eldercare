import type { ReactNode } from 'react'

import { getNavigationForRole } from '@/routes/route-config'
import { getDefaultRoute } from '@/routes/role-defaults'
import type { Role } from '@/types/domain'

export type HomeFeatureItem = {
  icon: ReactNode
  title: string
  desc: string
  path: string
  color: string
}

const fallbackStyles = [
  { card: 'border-blue-200 bg-blue-50/50', icon: 'text-blue-600' },
  { card: 'border-indigo-200 bg-indigo-50/50', icon: 'text-indigo-600' },
  { card: 'border-cyan-200 bg-cyan-50/50', icon: 'text-cyan-600' },
  { card: 'border-emerald-200 bg-emerald-50/50', icon: 'text-emerald-600' },
  { card: 'border-amber-200 bg-amber-50/50', icon: 'text-amber-500' },
  { card: 'border-violet-200 bg-violet-50/50', icon: 'text-violet-600' },
]

/**
 * Use the sidebar as the source of truth for role-home shortcuts.
 * Existing cards keep their richer copy and styling, while newly added sidebar
 * entries automatically receive a usable fallback card in exactly the same order.
 */
export function orderHomeFeatures(
  role: Role,
  customFeatures: HomeFeatureItem[],
  options?: { isRoot?: boolean },
) {
  const customByPath = new Map(customFeatures.map((item) => [item.path, item]))

  return getNavigationForRole(role, options)
    .filter((item) => item.path !== getDefaultRoute(role))
    .map((item, index): HomeFeatureItem => {
      const custom = customByPath.get(item.path)
      if (custom) {
        return {
          ...custom,
          // Keep the visible label identical to the sidebar label.
          title: item.label,
        }
      }

      const style = fallbackStyles[index % fallbackStyles.length]
      return {
        path: item.path,
        title: item.label,
        desc: item.description || `进入“${item.label}”，查看并处理相关信息。`,
        color: style.card,
        icon: <span className={`text-5xl ${style.icon}`}>{item.icon}</span>,
      }
    })
}
