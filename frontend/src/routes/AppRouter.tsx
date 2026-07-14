import { Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { Spin } from 'antd'

import { useSession } from '@/features/auth/useSession'
import { AppShell } from '@/layouts/AppShell'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import { allRoles, appRoutes } from '@/routes/route-config'
import { getDefaultRoute } from '@/routes/role-defaults'

function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Spin size="large" tip="页面加载中..." />
    </div>
  )
}

function UnknownRouteRedirect() {
  const location = useLocation()
  const { session, isHydrated } = useSession()

  if (!isHydrated) {
    return <RouteFallback />
  }

  if (!session || session.tokenState !== 'active') {
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }

  return <Navigate to={getDefaultRoute(session.role)} replace />
}

function RouteElement({
  Component,
}: {
  Component: LazyExoticComponent<ComponentType>
}) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Component />
    </Suspense>
  )
}

export function AppRouter() {
  const publicRoutes = appRoutes.filter((route) => route.isPublic)
  const sharedProtectedRoutes = appRoutes.filter(
    (route) => !route.isPublic && route.roles.length === allRoles.length,
  )
  const roleProtectedRoutes = appRoutes.filter(
    (route) => !route.isPublic && route.roles.length !== allRoles.length,
  )

  return (
    <BrowserRouter>
      <Routes>
        {publicRoutes.map((route) => (
          <Route
            key={route.key}
            path={route.path}
            element={<RouteElement Component={route.element} />}
          />
        ))}
        <Route element={<ProtectedRoute allowedRoles={allRoles} />}>
          <Route element={<AppShell />}>
            {sharedProtectedRoutes.map((route) => (
              <Route
                key={route.key}
                path={route.path}
                element={<RouteElement Component={route.element} />}
              />
            ))}
          </Route>
        </Route>
        {allRoles.map((role) => (
          <Route key={role} element={<ProtectedRoute allowedRoles={[role]} />}>
            <Route element={<AppShell />}>
              {roleProtectedRoutes
                .filter((route) => route.roles.includes(role))
                .map((route) => (
                  <Route
                    key={route.key}
                    path={route.path}
                    element={<RouteElement Component={route.element} />}
                  />
                ))}
            </Route>
          </Route>
        ))}
        <Route path="*" element={<UnknownRouteRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}
