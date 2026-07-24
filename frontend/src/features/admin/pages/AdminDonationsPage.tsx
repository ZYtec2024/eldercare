import { useEffect, useState } from 'react'
import { App, Button, Card, Result, Space, Statistic, Table, Tag, Typography } from 'antd'
import { HeartFilled, ReloadOutlined, TransactionOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import { fetchDonations, type DonationRecord } from '@/services/adapters/donation-adapter'

export default function AdminDonationsPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [records, setRecords] = useState<DonationRecord[]>([])
  const [total, setTotal] = useState(0)
  const [totalAmount, setTotalAmount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  const load = () => {
    if (!session?.isRoot) return
    setLoading(true)
    fetchDonations(session.userId, page, 20)
      .then((data) => {
        setRecords(data.items)
        setTotal(data.total)
        setTotalAmount(data.total_amount)
      })
      .catch((error: any) => message.error(error?.message || '加载捐赠记录失败'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [session?.userId, session?.isRoot, page])

  if (!session?.isRoot) {
    return <Result status="403" title="仅总管理员可查看爱心捐赠记录" />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Typography.Title level={3} className="!mb-1">爱心捐赠</Typography.Title>
          <Typography.Text type="secondary">接收登录页爱心捐款沙盘生成的演示支付信息</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="!rounded-2xl"><Statistic title="沙盘捐赠笔数" value={total} prefix={<TransactionOutlined />} /></Card>
        <Card className="!rounded-2xl"><Statistic title="沙盘捐赠总额" value={totalAmount} precision={2} prefix="¥" valueStyle={{ color: '#e11d48' }} /></Card>
      </div>
      <Card className="!rounded-2xl">
        <Table
          rowKey="donation_id"
          loading={loading}
          dataSource={records}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage }}
          scroll={{ x: 900 }}
          columns={[
            { title: '爱心姓名', dataIndex: 'donor_name', key: 'donor_name', render: (value) => <Space><HeartFilled className="text-rose-500" />{value}</Space> },
            { title: '金额', dataIndex: 'amount', key: 'amount', render: (value) => <strong className="text-rose-600">¥{Number(value).toFixed(2)}</strong> },
            { title: '渠道', dataIndex: 'payment_method', key: 'payment_method', render: (value) => <Tag color={value === 'wechat' ? 'green' : 'blue'}>{value === 'wechat' ? '微信沙盘' : '支付宝沙盘'}</Tag> },
            { title: '联系方式', dataIndex: 'contact', key: 'contact', render: (value) => value || '—' },
            { title: '爱心寄语', dataIndex: 'message', key: 'message', render: (value) => value || '—' },
            { title: '沙盘流水号', dataIndex: 'transaction_no', key: 'transaction_no', width: 250 },
            { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 180 },
          ]}
        />
      </Card>
    </div>
  )
}
