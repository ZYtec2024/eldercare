import type { ComponentType, LazyExoticComponent } from 'react'
import type { Role } from '@/types/domain'

export interface RouteNavigationMeta {
  label: string
  description: string
  iconKey: string
}

export interface AppRouteDefinition {
  key: string
  path: string
  roles: Role[]
  title: string
  description: string
  showInNavigation: boolean
  isHomeAction?: boolean
  isPublic?: boolean
  navigationOrder?: number
  navigation?: RouteNavigationMeta
  element: LazyExoticComponent<ComponentType>
}
