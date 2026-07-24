import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Empty, Input, Popconfirm } from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  MoreOutlined,
  SendOutlined,
  SyncOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import {
  fetchConversations,
  fetchConversationThread,
  hideConversation,
  markAllConversationsRead,
  sendConversationMessage,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationThread,
} from '@/services/adapters/conversation-adapter'

const quickMessages = ['我已看到', '我已出发', '我已到达', '请保持电话畅通']

function shortTime(value?: string | null) {
  if (!value) return ''
  const text = String(value)
  const match = text.match(/(\d{1,2}:\d{2})(?::\d{2})?/)
  if (match) return match[1]
  if (text.includes(' ')) return text.split(' ').slice(-1)[0]?.slice(0, 5) || text
  return text.slice(0, 16)
}

function avatarTone(type?: string, upgraded?: boolean) {
  if (upgraded || type === 'sos') return 'from-rose-500 to-orange-500'
  return 'from-sky-500 to-teal-500'
}

function avatarLabel(item: ConversationSummary) {
  if (item.upgraded_to_sos || item.conversation_type === 'sos') return '急'
  const title = item.title || item.service_type || '服'
  return title.slice(0, 1)
}

export default function ConversationPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const raw = searchParams.get('id') || searchParams.get('conversationId')
    const parsed = Number(raw || 0)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  })
  const [thread, setThread] = useState<ConversationThread | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [hiding, setHiding] = useState(false)
  const [markingAllRead, setMarkingAllRead] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const raw = searchParams.get('id') || searchParams.get('conversationId')
    const parsed = Number(raw || 0)
    if (Number.isFinite(parsed) && parsed > 0) {
      setSelectedId(parsed)
    } else {
      // Leaving detail (back / clear query) must drop selection in one step.
      setSelectedId(null)
    }
  }, [searchParams])

  const openConversation = (conversationId: number | null) => {
    setShowMembers(false)
    if (conversationId) {
      setSelectedId(conversationId)
      setSearchParams({ id: String(conversationId) }, { replace: true })
    } else {
      setSelectedId(null)
      setThread(null)
      setSearchParams({}, { replace: true })
    }
  }

  const loadConversations = async () => {
    if (!session) return
    try {
      const rows = await fetchConversations(session.userId)
      setConversations(rows)
      setSelectedId(() => {
        // Read live URL so an in-flight refresh after「返回」cannot reopen the chat
        // from a stale React searchParams closure.
        const params = new URLSearchParams(window.location.search)
        const preferred = Number(params.get('id') || params.get('conversationId') || 0)
        if (preferred > 0) {
          return rows.some((item) => item.conversation_id === preferred) ? preferred : null
        }
        return null
      })
    } catch (error: any) {
      message.error(error?.message || '会话列表加载失败')
    }
  }

  const loadThread = async (conversationId = selectedId) => {
    if (!session || !conversationId) {
      setThread(null)
      return
    }
    try {
      setThread(await fetchConversationThread(conversationId, session.userId))
    } catch (error: any) {
      message.error(error?.message || '会话消息加载失败')
      setThread(null)
    }
  }

  useEffect(() => { void loadConversations().catch(() => {}) }, [session?.userId])
  useEffect(() => { void loadThread().catch(() => {}) }, [selectedId, session?.userId])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadConversations().catch(() => {})
      if (selectedId) void loadThread(selectedId).catch(() => {})
    }, 4000)
    return () => window.clearInterval(timer)
  }, [selectedId, session?.userId])

  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [thread?.messages?.length, selectedId])

  const send = async (content = draft, type: 'text' | 'quick_status' = 'text') => {
    if (!session || !selectedId || !content.trim()) return
    setLoading(true)
    try {
      await sendConversationMessage(selectedId, { userId: session.userId, content: content.trim(), type })
      setDraft('')
      await Promise.all([loadThread(selectedId), loadConversations()])
    } catch (error: any) {
      message.error(error?.message || '消息发送失败')
    } finally {
      setLoading(false)
    }
  }

  const removeChat = async () => {
    if (!session || !selectedId) return
    setHiding(true)
    try {
      message.success((await hideConversation(selectedId, session.userId)).message || '已删除')
      openConversation(null)
      setThread(null)
      await loadConversations()
    } catch (error: any) {
      message.error(error?.message || '删除失败')
    } finally {
      setHiding(false)
    }
  }

  const clearUnread = async () => {
    if (!session || unreadCount <= 0) return
    setMarkingAllRead(true)
    try {
      message.success((await markAllConversationsRead(session.userId)).message || '已全部标为已读')
      await loadConversations()
    } catch (error: any) {
      message.error(error?.message || '清除未读失败')
    } finally {
      setMarkingAllRead(false)
    }
  }

  const selected = conversations.find((item) => item.conversation_id === selectedId)
  const subtitle = thread?.member_guide || thread?.participant_subtitle || selected?.member_guide || selected?.participant_subtitle || ''
  const threadCode = thread?.thread_code || selected?.thread_code || ''
  const canSpeak = thread?.my_can_speak !== false && selected?.status === 'active'
  const canHide = Boolean(thread?.can_hide || selected?.can_hide)
  const messages: ConversationMessage[] = thread?.messages || []
  const participants = thread?.participants || selected?.participants || []
  const unreadCount = useMemo(
    () => conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0),
    [conversations],
  )

  if (selected) {
    const title = thread?.title || selected.title || (selected.conversation_type === 'sos' ? '紧急求助' : selected.service_type || '服务沟通')
    const upgraded = Boolean(thread?.upgraded_to_sos || selected.upgraded_to_sos)
    const urgent = upgraded || selected.conversation_type === 'sos'

    return (
      <div className="mx-auto flex h-[min(78vh,720px)] max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,.08)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white/95 px-3 py-2.5 backdrop-blur">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-100"
            onClick={() => openConversation(null)}
            aria-label="返回"
          >
            <ArrowLeftOutlined />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[16px] font-semibold text-slate-900">{title}</h1>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${urgent && selected.status === 'active' ? 'bg-rose-50 text-rose-600' : selected.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {selected.status === 'closed'
                  ? '已关闭'
                  : selected.status !== 'active'
                    ? '已结束'
                    : upgraded
                      ? '升级SOS'
                      : selected.conversation_type === 'sos'
                        ? 'SOS'
                        : '进行中'}
              </span>
            </div>
            <div className="truncate text-[11px] text-slate-400">
              {threadCode ? `单号 ${threadCode} · ` : ''}
              {participants.length ? `${participants.length} 人` : '群聊'}
            </div>
          </div>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
            onClick={() => setShowMembers((open) => !open)}
            aria-label="成员"
          >
            <TeamOutlined />
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
            onClick={() => void loadThread(selected.conversation_id)}
            aria-label="刷新"
          >
            <SyncOutlined />
          </button>
          {canHide ? (
            <Popconfirm title="从你的列表删除此会话？管理员仍会留档。" onConfirm={() => void removeChat()} okText="删除" cancelText="取消">
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full text-rose-500 transition hover:bg-rose-50"
                aria-label="删除"
                disabled={hiding}
              >
                <DeleteOutlined />
              </button>
            </Popconfirm>
          ) : (
            <span className="flex h-9 w-9 items-center justify-center text-slate-300"><MoreOutlined /></span>
          )}
        </header>

        {showMembers ? (
          <div className="shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="mb-2 text-xs font-medium text-slate-500">本群人物（{participants.length} 人）</div>
            <div className="flex flex-wrap gap-1.5">
              {participants.map((person) => (
                <span
                  key={person.user_id}
                  className={`rounded-full px-2.5 py-1 text-[11px] ${person.can_speak === false ? 'bg-slate-200 text-slate-400 line-through' : 'bg-white text-slate-700 shadow-sm'}`}
                >
                  {person.display_label}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div
          ref={scrollerRef}
          className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4"
          style={{
            backgroundColor: '#e9eef3',
            backgroundImage:
              'radial-gradient(circle at 1px 1px, rgba(148,163,184,.18) 1px, transparent 0)',
            backgroundSize: '18px 18px',
          }}
        >
          {!showMembers && subtitle ? (
            <div className="mx-auto max-w-[90%] rounded-xl bg-white/70 px-3 py-2 text-center text-[11px] leading-relaxed text-slate-500 shadow-sm backdrop-blur">
              {subtitle}
            </div>
          ) : null}

          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-16">
              <Empty description="还没有消息，打个招呼吧" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            messages.map((item) => {
              const mine = item.sender_user_id === session?.userId
              const system = item.message_type === 'system'
              if (system) {
                return (
                  <div key={item.message_id} className="flex justify-center px-6">
                    <span className="rounded-full bg-black/10 px-3 py-1 text-[11px] leading-relaxed text-slate-600">
                      {item.content}
                    </span>
                  </div>
                )
              }
              return (
                <div key={item.message_id} className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : 'flex-row'}`}>
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-xs font-semibold text-white shadow-sm ${mine ? 'from-emerald-500 to-teal-600' : 'from-sky-500 to-blue-600'}`}>
                    {(item.sender_name || (mine ? '我' : '成')).slice(0, 1)}
                  </div>
                  <div className={`max-w-[72%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                    <div className={`mb-0.5 px-1 text-[11px] text-slate-500 ${mine ? 'text-right' : 'text-left'}`}>
                      {item.sender_name || (mine ? '我' : '成员')}
                    </div>
                    <div
                      className={`relative rounded-2xl px-3 py-2 text-[14px] leading-relaxed shadow-sm ${
                        mine
                          ? 'rounded-br-md bg-[#95ec69] text-slate-900'
                          : 'rounded-bl-md bg-white text-slate-800'
                      }`}
                    >
                      <div className="whitespace-pre-wrap break-words">{item.content}</div>
                    </div>
                    {item.created_at ? (
                      <div className={`mt-1 px-1 text-[10px] text-slate-400 ${mine ? 'text-right' : 'text-left'}`}>
                        {shortTime(item.created_at)}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {canSpeak ? (
          <footer className="shrink-0 border-t border-slate-100 bg-white px-3 pb-3 pt-2">
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {quickMessages.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[12px] text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                  onClick={() => void send(item, 'quick_status')}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <Input.TextArea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={1000}
                placeholder="输入消息，Enter 发送"
                className="!rounded-2xl !border-slate-200 !bg-slate-50 !px-3 !py-2"
                onPressEnter={(event) => {
                  if (!event.shiftKey) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <Button
                type="primary"
                shape="round"
                icon={<SendOutlined />}
                loading={loading}
                disabled={!draft.trim()}
                className="!h-10 !bg-[#07c160] !shadow-none hover:!bg-[#06ad56]"
                onClick={() => void send()}
              >
                发送
              </Button>
            </div>
          </footer>
        ) : (
          <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-4 py-3 text-center text-sm text-slate-500">
            {selected.status === 'closed'
              ? '本单已对您关闭，仅可查看记录'
              : selected.status !== 'active'
                ? '会话已结束，仅可查看记录'
                : '您已离开本群，无法继续发言'}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,.06)]">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-900">消息</h1>
          <p className="text-xs text-slate-400">服务沟通与 SOS 协同，结束后可删除</p>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 ? <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-medium text-white">{unreadCount} 未读</span> : null}
          <Button
            type="text"
            size="small"
            icon={<CheckCircleOutlined />}
            loading={markingAllRead}
            disabled={unreadCount <= 0}
            onClick={() => void clearUnread()}
          >
            一键已读
          </Button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
            onClick={() => void loadConversations()}
            aria-label="刷新"
          >
            <SyncOutlined />
          </button>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="py-20"><Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>
      ) : (
        <div
          className="conversation-list-scroll divide-y divide-slate-100 overflow-y-auto"
          style={{ maxHeight: 'min(70vh, 680px)', scrollbarGutter: 'stable' }}
        >
          {conversations.map((item) => {
            const unread = Number(item.unread_count || 0)
            const upgraded = Boolean(item.upgraded_to_sos)
            return (
              <button
                key={item.conversation_id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-slate-50 active:bg-slate-100"
                onClick={() => openConversation(item.conversation_id)}
              >
                <div className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-[15px] font-semibold text-white shadow-sm ${avatarTone(item.conversation_type, upgraded)}`}>
                  {avatarLabel(item)}
                  {unread > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="truncate text-[15px] font-medium text-slate-900">
                      {item.title || (item.conversation_type === 'sos' ? '紧急求助' : item.service_type || '服务沟通')}
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-400">{shortTime(item.last_message_at)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-slate-400">
                    {item.thread_code ? `${item.thread_code} · ` : ''}
                    {item.participant_subtitle || item.elder_name || '群聊'}
                  </div>
                  <div className="mt-1 truncate text-[13px] text-slate-500">
                    {item.last_message || '暂无消息'}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
