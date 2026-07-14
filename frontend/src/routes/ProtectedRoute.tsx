import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Spin, Result, Button } from 'antd'

import { useSession } from '@/features/auth/useSession'
import type { Role } from '@/types/domain'

interface ProtectedRouteProps {
  allowedRoles: Role[]
}

export function ProtectedRoute({ allowedRoles }: ProtectedRouteProps) {
  const location = useLocation()
  const { session, isHydrated, rememberRedirectPath } = useSession()

  useEffect(() => {
    if (!session || session.tokenState !== 'active') {
      rememberRedirectPath(location.pathname)
    }
  }, [location.pathname, rememberRedirectPath, session])

  if (!isHydrated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spin size="large" tip="正在恢复会话..." />
      </div>
    )
  }

  if (!session || session.tokenState !== 'active') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (!allowedRoles.includes(session.role)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Result
          status="403"
          title="无权访问"
          subTitle="您没有权限访问此页面"
          extra={
            <Button type="primary" href="/">
              返回首页
            </Button>
          }
        />
      </div>
    )
  }

  return <Outlet />
}
