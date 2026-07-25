import { Button, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'

import FamilyProxyOrderForm from '@/features/family/components/FamilyProxyOrderForm'

export default function NewServiceRequestPage() {
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Typography.Title level={3} className="!mb-1">代长辈下单</Typography.Title>
          <Typography.Text className="text-gray-500">
            先选长辈，再确认当前服务点或其他地址后发布（SOS 请由长辈本人发起）
          </Typography.Text>
        </div>
        <Button onClick={() => navigate('/family/orders')}>查看服务管理</Button>
      </div>
      <FamilyProxyOrderForm onPublished={() => navigate('/family/orders')} />
    </div>
  )
}
