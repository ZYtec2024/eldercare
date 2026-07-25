import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import {
  AlertOutlined,
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  SendOutlined,
  WarningOutlined,
} from '@ant-design/icons'

import { fetchAdminAlerts, handleAdminAlert } from '@/services/adapters/admin-adapter'
import { redispatchDispatchOrder, SOS_SKILL_OPTIONS, startAutoSosService } from '@/services/adapters/dispatch-adapter'
import {
  fetchConversationMessages,
  sendConversationMessage,
  type ConversationMessage,
} from '@/services/adapters/conversation-adapter'
import { AdminGeoScopeFilters, type AdminGeoScope } from '@/features/admin/components/AdminGeoScopeFilters'
import { AdminRegionScopeNotice } from '@/features/admin/components/AdminRegionScopeNotice'
import { useSession } from '@/features/auth/useSession'
import type { AlertItem } from '@/types/domain'

const statusPresentation: Record<string, { label: string; color: string; tier: string }> = {
  reported: { label: '待接警', color: 'red', tier: 'P0' },
  acknowledged: { label: '已接警处置中', color: 'blue', tier: '进行中' },
  dispatching: { label: '志愿服务调度中', color: 'orange', tier: '进行中' },
  awaiting_admin_close: { label: '待确认已处理', color: 'gold', tier: '待确认' },
  resolved: { label: '已处理', color: 'green', tier: '已归档' },
  health_open: { label: '待关注', color: 'orange', tier: '健康' },
  health_closed: { label: '已处理', color: 'green', tier: '健康' },
}

type StageFilter = 'actionable' | 'active' | 'closing' | 'health' | 'closed' | 'all'

const quickMessages = ['已确认接警', '正在联系家属', '志愿者已出发', '请保持电话畅通']

function isHealthAlert(item: AlertItem) {
  return item.category !== 'sos' || !item.incidentId
}

function displayStatus(item: AlertItem) {
  if (isHealthAlert(item)) {
    return item.status === 'handled' ? 'health_closed' : 'health_open'
  }
  return item.incidentStatus || (item.status === 'handled' ? 'resolved' : 'reported')
}

function matchesStage(item: AlertItem, stage: StageFilter) {
  const status = displayStatus(item)
  if (stage === 'all') return true
  if (stage === 'health') return status === 'health_open'
  if (stage === 'actionable') return status === 'reported'
  if (stage === 'active') return status === 'acknowledged' || status === 'dispatching'
  if (stage === 'closing') return status === 'awaiting_admin_close'
  if (stage === 'closed') return status === 'resolved' || status === 'health_closed'
  return true
}

export default function AdminAlertsPage() {
  const { message } = App.useApp()
  const { session } = useSession()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loading, setLoading] = useState(true)
  const [scopeTip, setScopeTip] = useState<string | null>(null)
  const [geoScope, setGeoScope] = useState<AdminGeoScope>({})
  const [stage, setStage] = useState<StageFilter>('actionable')
  const [activeAlertId, setActiveAlertId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [draft, setDraft] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [actionId, setActionId] = useState<number | null>(null)
  const [closeTarget, setCloseTarget] = useState<AlertItem | null>(null)
  const [closeForm] = Form.useForm<{ summary: string }>()
  const [skillTarget, setSkillTarget] = useState<AlertItem | null>(null)
  const [skillForm] = Form.useForm<{ skills: string[] }>()

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    try {
      setAlerts(await fetchAdminAlerts(session.userId, {
        regionAdcode: geoScope.regionAdcode,
        provinceName: !geoScope.regionAdcode ? geoScope.provinceName : undefined,
        cityName: !geoScope.regionAdcode ? geoScope.cityName : undefined,
      }))
      setScopeTip(null)
    } catch (error: any) {
      const tip = String(error?.message || '')
      const unbound = tip.includes('还未绑定区域') || tip.includes('未分配区县') || tip.includes('未绑定区域')
      setAlerts([])
      if (unbound) {
        setScopeTip(tip.includes('还未绑定') ? tip : '还未绑定区域，请联系总管理员在「区域管理」中为您分配区县后再查看')
      } else {
        setScopeTip(null)
        message.error(tip || '告警中心加载失败')
      }
    } finally {
      setLoading(false)
    }
  }, [session, geoScope.regionAdcode, geoScope.provinceName, geoScope.cityName, message])

  useEffect(() => { void load() }, [load])

  const activeAlert = useMemo(
    () => alerts.find((item) => item.alertId === activeAlertId) ?? null,
    [alerts, activeAlertId],
  )

  const loadMessages = useCallback(async (conversationId?: number | null) => {
    if (!session || !conversationId) {
      setMessages([])
      return
    }
    try {
      setMessages(await fetchConversationMessages(conversationId, session.userId))
    } catch {
      setMessages([])
    }
  }, [session])

  useEffect(() => {
    if (!activeAlert) return
    void loadMessages(activeAlert.conversationId)
    const timer = window.setInterval(() => {
      void loadMessages(activeAlert.conversationId)
      void load()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [activeAlert?.alertId, activeAlert?.conversationId, loadMessages, load])

  const filtered = useMemo(() => alerts.filter((item) => matchesStage(item, stage)), [alerts, stage])

  const stageCounts = useMemo(() => ({
    actionable: alerts.filter((item) => matchesStage(item, 'actionable')).length,
    active: alerts.filter((item) => matchesStage(item, 'active')).length,
    closing: alerts.filter((item) => matchesStage(item, 'closing')).length,
    health: alerts.filter((item) => matchesStage(item, 'health')).length,
    closed: alerts.filter((item) => matchesStage(item, 'closed')).length,
    all: alerts.length,
  }), [alerts])

  const acknowledge = async (item: AlertItem) => {
    if (!session) return
    setActionId(item.alertId)
    try {
      message.success((await handleAdminAlert(item.alertId, session.userId, 'acknowledge')).message)
      await load()
    } catch (error: any) {
      message.error(error?.message || '确认接警失败')
    } finally {
      setActionId(null)
    }
  }

  const markHealthHandled = async (item: AlertItem) => {
    if (!session) return
    setActionId(item.alertId)
    try {
      message.success((await handleAdminAlert(item.alertId, session.userId, 'acknowledge')).message)
      await load()
      if (activeAlertId === item.alertId) setActiveAlertId(null)
    } catch (error: any) {
      message.error(error?.message || '标记失败')
    } finally {
      setActionId(null)
    }
  }

  const openSkillPicker = (item: AlertItem) => {
    setSkillTarget(item)
    skillForm.setFieldsValue({ skills: ['emergency_response', 'medical_support'] })
  }

  const confirmAutoService = async () => {
    if (!session || !skillTarget?.incidentId) return
    const values = await skillForm.validateFields()
    const skills = values.skills || []
    setActionId(skillTarget.alertId)
    try {
      const result = await startAutoSosService(skillTarget.incidentId, session.userId, skills)
      message.success(result.message || '已按所选技能启动自动派单')
      skillForm.resetFields()
      setSkillTarget(null)
      await load()
      if (skillTarget.conversationId) await loadMessages(skillTarget.conversationId)
    } catch (error: any) {
      message.error(error?.message || '启动自动派单失败')
    } finally {
      setActionId(null)
    }
  }

  const confirmClose = async () => {
    if (!session || !closeTarget) return
    const values = await closeForm.validateFields()
    setActionId(closeTarget.alertId)
    try {
      message.success((await handleAdminAlert(closeTarget.alertId, session.userId, 'close', values.summary)).message)
      closeForm.resetFields()
      setCloseTarget(null)
      await load()
    } catch (error: any) {
      message.error(error?.message || '标记已处理失败')
    } finally {
      setActionId(null)
    }
  }

  const sendChat = async (content = draft, type: 'text' | 'quick_status' = 'text') => {
    if (!session || !activeAlert?.conversationId || !content.trim()) return
    setChatLoading(true)
    try {
      await sendConversationMessage(activeAlert.conversationId, {
        userId: session.userId,
        content: content.trim(),
        type,
      })
      setDraft('')
      await loadMessages(activeAlert.conversationId)
      await load()
    } catch (error: any) {
      message.error(error?.message || '消息发送失败')
    } finally {
      setChatLoading(false)
    }
  }

  const openThread = (item: AlertItem) => {
    setActiveAlertId(item.alertId)
    setDraft('')
  }

  const backToOverview = () => {
    setActiveAlertId(null)
    setMessages([])
    setDraft('')
    void load()
  }

  if (loading && !alerts.length) {
    return <div className="flex justify-center py-20"><Spin size="large" /></div>
  }

  if (activeAlert) {
    const status = displayStatus(activeAlert)
    const display = statusPresentation[status] || { label: status, color: 'default', tier: '' }
    const health = isHealthAlert(activeAlert)
    const isSos = !health
    const active = isSos && status !== 'resolved'
    const linkedStatus = String(activeAlert.linkedOrderStatus || '')
    const hasAssignee = Boolean(activeAlert.linkedVolunteerName) || ['accepted', 'in_progress', 'completed'].includes(linkedStatus)
    const waitingAuto = active && !hasAssignee
    const needsStartAuto = waitingAuto && !activeAlert.linkedOrderId

    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <Card className="!rounded-2xl !border-0 !shadow-sm" styles={{ body: { padding: '12px 16px' } }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Space wrap>
              <Button type="text" icon={<ArrowLeftOutlined />} onClick={backToOverview}>返回总览</Button>
              <Typography.Title level={4} className="!mb-0">
                {health ? '健康异常' : 'SOS'} · {activeAlert.sourceLabel}
              </Typography.Title>
              <Tag color={display.color}>{display.tier} · {display.label}</Tag>
            </Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadMessages(activeAlert.conversationId)}>刷新</Button>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {[activeAlert.provinceName, activeAlert.cityName, activeAlert.regionName].filter(Boolean).join(' / ') || '本区'}
            {activeAlert.linkedOrderId
              ? ` · 服务 #${activeAlert.linkedOrderId}${activeAlert.linkedVolunteerName ? ` · ${activeAlert.linkedVolunteerName}` : ' · 等待自动派单'}`
              : ''}
            {` · ${activeAlert.createdAt}`}
          </div>
          {health ? (
            <>
              <Alert
                className="!mt-3"
                type="warning"
                showIcon
                message="健康打卡异常提醒"
                description={activeAlert.resolutionSummary || '指标异常，请联系家属了解情况。健康异常不会创建 SOS 会话，也不进入待接警。'}
              />
              {status === 'health_open' ? (
                <Space wrap className="mt-3">
                  <Button type="primary" loading={actionId === activeAlert.alertId} onClick={() => void markHealthHandled(activeAlert)}>
                    标记已关注/已处理
                  </Button>
                </Space>
              ) : (
                <Tag icon={<CheckCircleOutlined />} color="green" className="mt-3">已处理</Tag>
              )}
            </>
          ) : (
            <>
              {waitingAuto ? (
                <Alert
                  className="!mt-3"
                  type="info"
                  showIcon
                  message={activeAlert.linkedOrderId ? '系统自动派单中' : '尚未启动志愿服务'}
                  description="请先选择需要的志愿者技能，再启动自动派单。系统只会匹配「已开自动接单 + 技能齐全 + 评分≥4 + 空闲/返程」的人；暂时没人会排队重试。"
                />
              ) : null}
              {active ? (
                <Space wrap className="mt-3">
                  {status === 'reported' ? (
                    <Button type="primary" loading={actionId === activeAlert.alertId} onClick={() => void acknowledge(activeAlert)}>确认接警</Button>
                  ) : null}
                  {needsStartAuto ? (
                    <Button type="primary" loading={actionId === activeAlert.alertId} onClick={() => openSkillPicker(activeAlert)}>
                      选择技能并自动派单
                    </Button>
                  ) : null}
                  {waitingAuto && activeAlert.linkedOrderId ? (
                    <Button loading={actionId === activeAlert.alertId} onClick={() => openSkillPicker(activeAlert)}>
                      调整技能并重新匹配
                    </Button>
                  ) : null}
                  {activeAlert.linkedOrderId && ['accepted', 'in_progress'].includes(linkedStatus) ? (
                    <Button
                      danger
                      loading={actionId === activeAlert.alertId}
                      onClick={() => void (async () => {
                        if (!session || !activeAlert.linkedOrderId) return
                        setActionId(activeAlert.alertId)
                        try {
                          const result = await redispatchDispatchOrder(
                            activeAlert.linkedOrderId,
                            session.userId,
                            '管理员介入：服务异常换人重派',
                          )
                          message.success(result.message)
                          await load()
                          if (activeAlert.conversationId) await loadMessages(activeAlert.conversationId)
                        } catch (error: any) {
                          message.error(error?.message || '重派失败')
                        } finally {
                          setActionId(null)
                        }
                      })()}
                    >
                      换人重派
                    </Button>
                  ) : null}
                  <Button
                    danger={status !== 'awaiting_admin_close'}
                    type={status === 'awaiting_admin_close' ? 'primary' : 'default'}
                    onClick={() => setCloseTarget(activeAlert)}
                  >
                    {status === 'awaiting_admin_close' ? '确认已处理' : '已处理'}
                  </Button>
                </Space>
              ) : (
                <Tag icon={<CheckCircleOutlined />} color="green" className="mt-3">已处理</Tag>
              )}
            </>
          )}
        </Card>

        {!health ? (
          <Card className="!rounded-2xl" styles={{ body: { padding: 0 } }}>
            <div className="max-h-[52vh] min-h-[320px] space-y-3 overflow-y-auto bg-[#ededed] px-4 py-4">
              {!activeAlert.conversationId ? (
                <Empty description="该告警尚未建立会话" />
              ) : messages.length === 0 ? (
                <Empty description="暂无消息，可在下方开始沟通" />
              ) : (
                messages.map((item) => {
                  const mine = item.sender_user_id === session?.userId
                  const system = item.message_type === 'system'
                  return (
                    <div key={item.message_id} className={system ? 'text-center' : mine ? 'text-right' : 'text-left'}>
                      {system ? (
                        <span className="inline-block rounded-full bg-black/5 px-3 py-1 text-xs text-slate-500">{item.content}</span>
                      ) : (
                        <div className={`inline-block max-w-[78%] rounded-2xl px-3 py-2 text-left shadow-sm ${mine ? 'bg-[#95ec69] text-slate-900' : 'bg-white'}`}>
                          <div className="mb-0.5 text-[11px] text-slate-500">{item.sender_name || (mine ? '我' : '成员')}</div>
                          <div className="whitespace-pre-wrap break-words text-sm">{item.content}</div>
                          {item.created_at ? <div className="mt-1 text-[10px] text-slate-400">{item.created_at}</div> : null}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            {activeAlert.conversationId && status !== 'resolved' ? (
              <div className="space-y-2 border-t border-slate-200 bg-white p-3">
                <Space wrap>
                  {quickMessages.map((item) => (
                    <Button key={item} size="small" onClick={() => void sendChat(item, 'quick_status')}>{item}</Button>
                  ))}
                </Space>
                <div className="flex gap-2">
                  <Input.TextArea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    maxLength={1000}
                    placeholder="输入消息…"
                    onPressEnter={(event) => {
                      if (!event.shiftKey) {
                        event.preventDefault()
                        void sendChat()
                      }
                    }}
                  />
                  <Button type="primary" icon={<SendOutlined />} loading={chatLoading} onClick={() => void sendChat()}>发送</Button>
                </div>
              </div>
            ) : (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm text-slate-500">
                会话已归档，仅可查看历史记录
              </div>
            )}
          </Card>
        ) : null}

        <Modal open={Boolean(closeTarget)} title="确认 SOS 已处理" okText="确认已处理" cancelText="取消" onCancel={() => { closeForm.resetFields(); setCloseTarget(null) }} onOk={() => void confirmClose()}>
          <Typography.Paragraph type="secondary">请确认老人风险已经解除，并填写处置结果。确认后该 SOS 将标记为已处理。</Typography.Paragraph>
          <Form form={closeForm} layout="vertical">
            <Form.Item name="summary" label="处置结果" rules={[{ required: true, message: '请填写处置结果' }]}>
              <Input.TextArea rows={4} maxLength={1000} placeholder="例如：志愿者已完成陪护，家属确认老人安全。" />
            </Form.Item>
          </Form>
        </Modal>
        <Modal
          open={Boolean(skillTarget)}
          title="选择所需志愿者技能"
          okText="按技能自动派单"
          cancelText="取消"
          confirmLoading={actionId === skillTarget?.alertId}
          onCancel={() => { skillForm.resetFields(); setSkillTarget(null) }}
          onOk={() => void confirmAutoService()}
        >
          <Typography.Paragraph type="secondary">
            系统只会找同时满足：已开自动接单、具备下列全部技能、评分≥4、空闲或返程的志愿者。急救响应会默认保留。
          </Typography.Paragraph>
          <Form form={skillForm} layout="vertical">
            <Form.Item
              name="skills"
              label="需要的技能"
              rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一项技能' }]}
            >
              <Select
                mode="multiple"
                placeholder="选择技能"
                options={SOS_SKILL_OPTIONS.map((item) => ({ value: item.code, label: item.label }))}
              />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <AdminRegionScopeNotice />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Typography.Title level={3} className="!mb-1">
            <AlertOutlined className="mr-2 text-red-500" />告警会话总览
          </Typography.Title>
          <Typography.Text type="secondary">
            「待接警」仅含 SOS。健康打卡异常单独放在「健康关注」，不会创建接警会话。
          </Typography.Text>
        </div>
        <Space wrap>
          {!scopeTip ? <AdminGeoScopeFilters value={geoScope} onChange={setGeoScope} /> : null}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </Space>
      </div>

      {scopeTip ? (
        <Alert
          type="info"
          showIcon={false}
          message="还未绑定区域"
          description={scopeTip}
        />
      ) : null}

      {!scopeTip ? (
      <Segmented
        value={stage}
        onChange={(value) => setStage(value as StageFilter)}
        options={[
          { label: `待接警 (${stageCounts.actionable})`, value: 'actionable' },
          { label: `处置中 (${stageCounts.active})`, value: 'active' },
          { label: `待确认 (${stageCounts.closing})`, value: 'closing' },
          { label: `健康关注 (${stageCounts.health})`, value: 'health' },
          { label: `已处理 (${stageCounts.closed})`, value: 'closed' },
          { label: `全部 (${stageCounts.all})`, value: 'all' },
        ]}
      />
      ) : null}
      <Card className="!rounded-2xl !overflow-hidden" styles={{ body: { padding: 0 } }}>
        {scopeTip ? (
          <div className="py-16">
            <Empty description="请先完成区县绑定后再查看告警" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16"><Empty description="当前分级下暂无告警" /></div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((item) => {
              const status = displayStatus(item)
              const display = statusPresentation[status] || { label: status, color: 'default', tier: '' }
              const health = isHealthAlert(item)
              const preview = health
                ? (item.resolutionSummary || item.lastMessage || '健康指标异常，点击查看并标记')
                : (item.lastMessage || item.resolutionSummary || '点击进入会话详情')
              const place = [item.cityName || item.provinceName, item.regionName].filter(Boolean).join(' · ')
              return (
                <button
                  key={item.alertId}
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                  onClick={() => openThread(item)}
                >
                  <div className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${health ? 'bg-amber-500 text-white' : 'bg-red-500 text-white'}`}>
                    {health ? <WarningOutlined /> : <AlertOutlined />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate font-medium text-slate-900">
                        {health ? '健康异常' : 'SOS'} · {item.sourceLabel}
                      </div>
                      <span className="shrink-0 text-xs text-slate-400">{item.lastMessageAt || item.createdAt}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Tag color={display.color}>{display.label}</Tag>
                      {place ? <span className="text-xs text-slate-400">{place}</span> : null}
                      {!health && item.linkedVolunteerName ? (
                        <span className="text-xs text-blue-600">{item.linkedVolunteerName}</span>
                      ) : !health && status !== 'resolved' ? (
                        <span className="text-xs text-rose-600">等待自动派单中</span>
                      ) : null}
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-500">{preview}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
