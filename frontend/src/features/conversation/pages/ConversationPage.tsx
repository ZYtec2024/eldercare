import { useEffect, useState } from 'react'
import { App, Badge, Button, Card, Empty, Input, List, Space, Tag, Typography } from 'antd'
import { SendOutlined, SyncOutlined } from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  fetchConversationMessages,
  fetchConversations,
  sendConversationMessage,
  type ConversationMessage,
  type ConversationSummary,
} from '@/services/adapters/conversation-adapter'

const quickMessages = ['我已看到', '我已出发', '我已到达', '请保持电话畅通']

export default function ConversationPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)

  const loadConversations = async () => {
    if (!session) return
    const rows = await fetchConversations(session.userId)
    setConversations(rows)
    setSelectedId((current) => current && rows.some((item) => item.conversation_id === current) ? current : rows[0]?.conversation_id ?? null)
  }
  const loadMessages = async (conversationId = selectedId) => {
    if (!session || !conversationId) return
    setMessages(await fetchConversationMessages(conversationId, session.userId))
  }

  useEffect(() => { void loadConversations().catch(() => {}) }, [session?.userId])
  useEffect(() => { void loadMessages().catch(() => {}) }, [selectedId, session?.userId])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadConversations().catch(() => {})
      void loadMessages().catch(() => {})
    }, 4000)
    return () => window.clearInterval(timer)
  }, [selectedId, session?.userId])

  const send = async (content = draft, type: 'text' | 'quick_status' = 'text') => {
    if (!session || !selectedId || !content.trim()) return
    setLoading(true)
    try {
      await sendConversationMessage(selectedId, { userId: session.userId, content: content.trim(), type })
      setDraft('')
      await Promise.all([loadMessages(selectedId), loadConversations()])
    } catch (error: any) {
      message.error(error?.message || '消息发送失败')
    } finally {
      setLoading(false)
    }
  }
  const selected = conversations.find((item) => item.conversation_id === selectedId)
  const activeCount = conversations.filter((item) => item.status === 'active').length
  const unreadCount = conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0)

  return <div className="space-y-5">
    <div className="rounded-3xl bg-gradient-to-r from-cyan-700 via-blue-700 to-indigo-800 p-6 text-white shadow-xl">
      <Typography.Title level={2} className="!mb-1 !text-white">服务沟通工作台</Typography.Title>
      <Typography.Text className="!text-blue-100">每笔服务和 SOS 都是独立会话；左侧会话池持续刷新，切换一笔不会中断其他会话的消息接收。</Typography.Text>
      <div className="mt-3"><Space><Tag color="blue">进行中 {activeCount}</Tag><Badge count={unreadCount} overflowCount={99}><Tag color="gold">待处理消息</Tag></Badge></Space></div>
    </div>
    <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
      <Card className="!rounded-2xl" title="我的会话池" extra={<Button size="small" icon={<SyncOutlined />} onClick={() => void loadConversations()}>刷新</Button>}>
        <List
          dataSource={conversations}
          locale={{ emptyText: '当前没有可沟通的服务会话' }}
          renderItem={(item) => {
            const unread = Number(item.unread_count || 0)
            return <List.Item className={`cursor-pointer rounded-lg px-2 ${item.conversation_id === selectedId ? 'bg-blue-50' : ''}`} onClick={() => setSelectedId(item.conversation_id)}>
              <Badge count={unread} offset={[-2, 2]}>
                <List.Item.Meta
                  title={<Space><span>{item.conversation_type === 'sos' ? 'SOS 协同' : item.service_type || '服务沟通'}</span><Tag color={item.conversation_type === 'sos' ? 'red' : 'blue'}>{item.status === 'active' ? '进行中' : '已归档'}</Tag></Space>}
                  description={<div><div>{item.elder_name || '关联服务'}</div><div className="truncate text-xs">{item.last_message || '暂无消息'}</div></div>}
                />
              </Badge>
            </List.Item>
          }}
        />
      </Card>
      <Card className="!rounded-2xl" title={selected ? `${selected.conversation_type === 'sos' ? 'SOS 协同' : '服务沟通'} · ${selected.elder_name || ''}` : '请选择会话'}>
        {!selected ? <Empty description="请从左侧选择会话" /> : <div className="space-y-4">
          <div className="max-h-[420px] min-h-[260px] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-4">
            {messages.map((item) => <div key={item.message_id} className={item.sender_user_id === session?.userId ? 'text-right' : 'text-left'}>
              <div className={`inline-block max-w-[80%] rounded-2xl px-3 py-2 text-left ${item.message_type === 'system' ? 'bg-amber-50 text-amber-800' : item.sender_user_id === session?.userId ? 'bg-blue-600 text-white' : 'bg-white shadow-sm'}`}>
                <div className="text-xs opacity-75">{item.message_type === 'system' ? '系统' : item.sender_name || '成员'}</div><div>{item.content}</div>
              </div>
            </div>)}
          </div>
          {selected.status === 'active' ? <>
            <Space wrap>{quickMessages.map((item) => <Button key={item} size="small" onClick={() => void send(item, 'quick_status')}>{item}</Button>)}</Space>
            <Input.TextArea value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1000} placeholder="请输入消息…" onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void send() } }} />
            <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={() => void send()}>发送消息</Button>
          </> : <Typography.Text type="secondary">该会话已归档，仅保留沟通记录。</Typography.Text>}
        </div>}
      </Card>
    </div>
  </div>
}
