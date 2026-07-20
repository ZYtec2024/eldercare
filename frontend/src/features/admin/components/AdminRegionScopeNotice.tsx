import { useEffect, useState } from 'react'
import { EnvironmentOutlined } from '@ant-design/icons'
import { Tag } from 'antd'

import { useSession } from '@/features/auth/useSession'
import { fetchAdminDispatchRegions } from '@/services/adapters/dispatch-adapter'

export function AdminRegionScopeNotice() {
  const { session } = useSession()
  const [regions, setRegions] = useState<Array<{ adcode: string; name: string }>>([])

  useEffect(() => {
    if (!session) return
    fetchAdminDispatchRegions(session.userId).then(setRegions).catch(() => setRegions([]))
  }, [session?.userId])

  if (!session || regions.length === 0) return null
  const isNational = regions.length >= 3

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-sm text-sky-900">
      <EnvironmentOutlined />
      <span>{isNational ? '全国总管理员：可查看全国汇总，并在用户管理 / 调度台按区县切换。' : '区县管理员：本页面仅显示你的授权区县数据。'}</span>
      {regions.map((region) => <Tag color={isNational ? 'blue' : 'green'} key={region.adcode}>{region.name}</Tag>)}
    </div>
  )
}
