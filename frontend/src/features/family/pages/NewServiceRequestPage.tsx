import { Button, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'

import FamilyProxyOrderForm from '@/features/family/components/FamilyProxyOrderForm'

export default function NewServiceRequestPage() {
  const navigate = useNavigate()

  return (
    <div className="mobile-compact-page space-y-6">
      <div className="section-page-hero">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="role-home-kicker">家属协助服务申请</div>
            <Typography.Title level={2} className="!mb-2 !text-slate-900">代长辈下单</Typography.Title>
            <Typography.Text className="!text-base !text-slate-600">
              选择长辈，确认本次订单服务点，再发布服务需求。SOS 仍由长辈本人发起。
            </Typography.Text>
          </div>
          <Button size="large" onClick={() => navigate('/family/orders')}>查看服务管理</Button>
        </div>
      </div>
      <FamilyProxyOrderForm onPublished={() => navigate('/family/orders')} />
    </div>
  )
}
