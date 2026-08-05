import { useEffect, useRef, useState } from 'react'
import { App, Button, Card, Empty, Input, Space, Switch, Tag, Typography } from 'antd'
import {
  AudioOutlined,
  BulbOutlined,
  EditOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  SendOutlined,
  SoundOutlined,
  StopOutlined,
} from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  sendCompanionChat,
  synthesizeCompanionSpeech,
  transcribeCompanionAudio,
  fetchCompanionHistory,
  saveCompanionMessage,
  clearCompanionHistory,
  deleteLastCompanionMessages,
  type CompanionHistoryItem,
} from '@/services/adapters/ai-adapter'

type CompanionMessage = CompanionHistoryItem & { id: number }

const introMessage = '您好，我是智能陪聊助手。您可以直接打字，也可以按下录音按钮说话，我会帮您转成文字并读出回复。'

function recordingPermissionMessage(error: unknown) {
  const candidate = error as { name?: string; message?: string } | null
  const name = String(candidate?.name || '')
  const detail = String(candidate?.message || '')
  if (name === 'NotAllowedError' || /permission|dismissed|denied/i.test(detail)) {
    return '麦克风权限未允许。请在浏览器地址栏左侧的站点设置中允许麦克风，然后刷新页面重试。'
  }
  if (name === 'NotFoundError' || /device not found/i.test(detail)) {
    return '没有检测到可用麦克风，请检查设备连接和系统录音设置。'
  }
  if (name === 'NotReadableError' || /could not start|track start/i.test(detail)) {
    return '麦克风正被其他程序占用，请关闭其他录音程序后重试。'
  }
  return detail || '无法开启录音权限'
}

export default function ElderCompanionPage() {
  const { session } = useSession()
  const { message: toast } = App.useApp()
  const [messages, setMessages] = useState<CompanionMessage[]>([{ id: 1, role: 'assistant', content: introMessage }])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [autoSpeak, setAutoSpeak] = useState(true)
  const [busyAudio, setBusyAudio] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef<number>(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const maxVolumeRef = useRef<number>(0)
  const nextIdRef = useRef(2)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const historyLoadedRef = useRef<number | null>(null)

  const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(() => () => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    audioCtxRef.current?.close().catch(() => {})
  }, [])

  useEffect(() => {
    if (!session) return
    if (historyLoadedRef.current === session.userId) return
    historyLoadedRef.current = session.userId
    setMessages([{ id: 1, role: 'assistant', content: introMessage }])
    nextIdRef.current = 2
    fetchCompanionHistory(session.userId)
      .then((history) => {
        if (history.length > 0) {
          const restored: CompanionMessage[] = history.map((item, index) => ({
            id: index + 2,
            role: item.role,
            content: item.content,
          }))
          setMessages([{ id: 1, role: 'assistant', content: introMessage }, ...restored])
          nextIdRef.current = restored.length + 2
        }
      })
      .catch(() => {})
  }, [session?.userId])

  const appendMessage = (role: CompanionMessage['role'], content: string) => {
    const nextMessage: CompanionMessage = {
      id: nextIdRef.current,
      role,
      content,
    }
    nextIdRef.current += 1
    setMessages((current) => [...current, nextMessage])
    return nextMessage
  }

  const stopAudio = () => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    setPlaying(false)
  }

  const playBlob = async (blob: Blob) => {
    // 如果正在播放，再次点击则中止播放
    if (playing) {
      stopAudio()
      return
    }
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
    }
    const url = URL.createObjectURL(blob)
    currentUrlRef.current = url
    const audio = audioRef.current || new Audio()
    audioRef.current = audio
    audio.src = url
    audio.onended = () => setPlaying(false)
    audio.onpause = () => setPlaying(false)
    audio.onerror = () => setPlaying(false)
    try {
      setPlaying(true)
      await audio.play()
    } catch {
      setPlaying(false)
      toast.warning('语音已生成，可以点击消息右侧的朗读按钮重试')
    }
  }

  const speakText = async (text: string) => {
    if (!text.trim()) return
    setBusyAudio(true)
    try {
      const blob = await synthesizeCompanionSpeech(text, session?.userId)
      await playBlob(blob)
    } catch (error: any) {
      toast.error(error?.message || '语音生成失败')
    } finally {
      setBusyAudio(false)
    }
  }

  const submitMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!session || !trimmed) return
    const previousMessages = messages.slice(-12).map((item) => ({ role: item.role, content: item.content }))
    const userMessage = appendMessage('user', trimmed)
    setDraft('')
    setSending(true)
    // 用户消息立即落库，不怕切页丢失
    saveCompanionMessage(session.userId, 'user', trimmed).catch(() => {})
    try {
      const reply = await sendCompanionChat({
        userId: session.userId,
        message: trimmed,
        history: previousMessages,
      })
      saveCompanionMessage(session.userId, 'assistant', reply.reply).catch(() => {})
      const assistant = appendMessage('assistant', reply.reply)
      if (autoSpeak) {
        void speakText(assistant.content)
      }
    } catch (error: any) {
      setMessages((current) => current.filter((item) => item.id !== userMessage.id))
      toast.error(error?.message || '发送失败')
    } finally {
      setSending(false)
    }
  }

  const retractExchange = (userMsgId: number) => {
    setMessages((current) => {
      const idx = current.findIndex((m) => m.id === userMsgId)
      if (idx === -1 || current[idx].role !== 'user') return current
      // Remove the user message and the assistant reply that immediately follows
      const next = current[idx + 1]
      const toRemove = new Set([userMsgId])
      if (next && next.role === 'assistant') toRemove.add(next.id)
      return current.filter((m) => !toRemove.has(m.id))
    })
  }

  const handleEditConfirm = (msgId: number) => {
    const text = editDraft.trim()
    if (!text || !session) return
    setEditingId(null)
    setEditDraft('')
    retractExchange(msgId)
    deleteLastCompanionMessages(session.userId, 2).catch(() => {})
    void submitMessage(text)
  }

  const handleRegenerate = (assistantMsgId: number) => {
    if (!session) return
    setMessages((current) => {
      const idx = current.findIndex((m) => m.id === assistantMsgId)
      if (idx === -1 || current[idx].role !== 'assistant') return current
      const prev = current[idx - 1]
      if (!prev || prev.role !== 'user') return current
      deleteLastCompanionMessages(session.userId, 2).catch(() => {})
      const removed = current.filter((m) => m.id !== assistantMsgId)
      setTimeout(() => { void submitMessage(prev.content) }, 0)
      return removed
    })
  }

  const startRecording = async () => {
    if (!canRecord) {
      toast.error('当前浏览器不支持录音')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      recordStartRef.current = Date.now()
      maxVolumeRef.current = 0

      // 用 AnalyserNode 实时监测时域音量，判断录音是否包含实际语音
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      analyserRef.current = analyser
      source.connect(analyser)
      const timeData = new Float32Array(analyser.fftSize)
      let volumeTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (!analyserRef.current) return
        analyserRef.current.getFloatTimeDomainData(timeData)
        // 时域 RMS：128 是零线，偏离越大音量越高
        let sum = 0
        for (let i = 0; i < timeData.length; i++) {
          sum += timeData[i] * timeData[i]
        }
        const rms = Math.sqrt(sum / timeData.length) * 100
        if (rms > maxVolumeRef.current) {
          maxVolumeRef.current = rms
        }
      }, 100)

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.onstop = async () => {
        setRecording(false)
        streamRef.current?.getTracks().forEach((track) => track.stop())
        if (volumeTimer) { clearInterval(volumeTimer); volumeTimer = null }
        audioCtxRef.current?.close().catch(() => {})
        audioCtxRef.current = null
        analyserRef.current = null

        const duration = Date.now() - recordStartRef.current
        const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (duration < 1500 || audioBlob.size < 4096) {
          toast.warning('录音时长太短，请说话后再结束录音')
          return
        }
        // 时域 RMS（0-100 尺度）：<1.0 为几乎静音，环境噪音通常在 0.5-2.0，语音在 3.0+
        if (maxVolumeRef.current < 1.8) {
          toast.warning('未检测到有效语音，请说话后再结束录音')
          return
        }
        try {
          const text = await transcribeCompanionAudio(session!.userId, audioBlob)
          const trimmed = text.trim()
          if (!trimmed || !/[^\x00-\xff]/.test(trimmed) || trimmed.length < 2) {
            toast.warning('没有识别到有效语音内容')
            return
          }
          // 转写 < 5 字 → 可能为噪音幻觉，先放入输入框让用户确认
          if (trimmed.length < 5) {
            setDraft(trimmed)
            toast.warning('识别内容较短，请确认后手动发送')
            return
          }
          // ≥ 5 字 → 自动发送（老人友好）
          await submitMessage(trimmed)
        } catch (error: any) {
          toast.error(error?.message || '语音转写失败')
        }
      }
      recorder.start()
      setRecording(true)
    } catch (error: any) {
      toast.error(recordingPermissionMessage(error))
    }
  }

  const stopRecording = () => {
    recorderRef.current?.stop()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Card className="!overflow-hidden !rounded-3xl !border-0 !shadow-[0_18px_60px_rgba(37,99,235,.14)]" bodyStyle={{ padding: 0 }}>
        <div className="compact-companion-hero relative overflow-hidden bg-gradient-to-r from-sky-700 via-cyan-600 to-blue-500 px-5 py-5 text-white md:px-6 md:py-6">
          <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,.45) 0, rgba(255,255,255,0) 35%), radial-gradient(circle at 80% 0%, rgba(255,255,255,.35) 0, rgba(255,255,255,0) 28%)' }} />
          <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <Tag color="cyan" className="!border-0 !px-3 !py-1 !text-xs !font-medium">老人端智能陪聊</Tag>
              <Typography.Title level={2} className="!mb-0 !text-white !text-2xl md:!text-3xl">
                想说什么，就直接说出来
              </Typography.Title>
              <Typography.Paragraph className="!mb-0 !max-w-2xl !text-white/90 !text-sm md:!text-base leading-relaxed">
                说话或打字都可以，助手会回复，也可以朗读给您听。
              </Typography.Paragraph>
            </div>
            <div className="rounded-2xl bg-white/15 px-4 py-2.5 backdrop-blur-sm">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-white/80">自动朗读</span>
                <Switch checked={autoSpeak} onChange={setAutoSpeak} />
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-white/85">
                <SoundOutlined />
                <span>录音后会自动识别并发送</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="!rounded-3xl !border-slate-200 !shadow-[0_12px_40px_rgba(15,23,42,.08)]" styles={{ body: { padding: 18 } }}>
        <Space wrap className="w-full justify-between gap-3">
          <Space wrap>
            <Button
              type={recording ? 'default' : 'primary'}
              danger={recording}
              icon={recording ? <StopOutlined /> : <AudioOutlined />}
              loading={busyAudio}
              disabled={!session}
              onClick={() => (recording ? stopRecording() : void startRecording())}
            >
              {recording ? '停止录音' : '开始说话'}
            </Button>
            <Button
              icon={<AudioOutlined />}
              disabled={!draft.trim() || sending}
              onClick={() => void submitMessage(draft)}
            >
              发送文字
            </Button>
            <Button
              icon={<PauseCircleOutlined />}
              onClick={() => {
                setMessages([{ id: 1, role: 'assistant', content: introMessage }])
                nextIdRef.current = 2
                if (session) clearCompanionHistory(session.userId).catch(() => {})
              }}
            >
              清空聊天
            </Button>
          </Space>
          <div className="text-sm text-slate-500">
            {recording ? '正在聆听，请说话...' : canRecord ? '支持录音与语音播放' : '当前浏览器不支持录音'}
          </div>
        </Space>
      </Card>

      <Card className="!rounded-3xl !border-slate-200 !shadow-[0_12px_40px_rgba(15,23,42,.08)]" styles={{ body: { padding: 0 } }}>
        <div className="max-h-[58vh] space-y-4 overflow-y-auto bg-[#eef4f8] px-4 py-5 md:px-6">
          {messages.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center">
              <Empty description="还没有开始聊天" />
            </div>
          ) : (
            messages.map((item) => (
              <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[82%] rounded-2xl px-4 py-3 shadow-sm ${item.role === 'user' ? 'bg-emerald-500 text-white rounded-br-md' : 'bg-white text-slate-800 rounded-bl-md'}`}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs opacity-70">
                    <span>{item.role === 'user' ? '我' : '智能助手'}</span>
                    <Space size={2}>
                      {item.role === 'user' && !sending && (
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          className="!h-6 !px-1 !text-xs !text-inherit hover:!opacity-100"
                          onClick={() => { setEditingId(item.id); setEditDraft(item.content) }}
                        />
                      )}
                      {item.role === 'assistant' && !sending && (
                        <Button
                          type="text"
                          size="small"
                          icon={<ReloadOutlined />}
                          className="!h-6 !px-1 !text-xs !text-inherit hover:!opacity-100"
                          onClick={() => handleRegenerate(item.id)}
                        />
                      )}
                      {item.role === 'assistant' && (
                        <Button
                          type="text"
                          size="small"
                          icon={playing ? <StopOutlined /> : <SoundOutlined />}
                          className="!h-6 !px-2 !text-xs"
                          loading={busyAudio && !playing}
                          onClick={() => {
                            if (playing) {
                              stopAudio()
                            } else {
                              void speakText(item.content)
                            }
                          }}
                        >
                          {playing ? '停止' : '朗读'}
                        </Button>
                      )}
                    </Space>
                  </div>
                  {editingId === item.id ? (
                    <div className="flex gap-2">
                      <Input.TextArea
                        size="small"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        maxLength={1000}
                        className="!text-slate-800 !rounded-lg"
                        onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); handleEditConfirm(item.id) } }}
                      />
                      <Button size="small" type="primary" onClick={() => handleEditConfirm(item.id)}>确认</Button>
                      <Button size="small" onClick={() => setEditingId(null)}>取消</Button>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{item.content}</div>
                  )}
                </div>
              </div>
            ))
          )}
          {sending ? (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md bg-white px-4 py-3 text-slate-500 shadow-sm">
                <LoadingOutlined className="mr-2" />
                正在思考...
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="!rounded-3xl !border-slate-200 !shadow-[0_12px_40px_rgba(15,23,42,.08)]" styles={{ body: { padding: 16 } }}>
        <div className="flex items-end gap-3">
          <Input.TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="您可以直接输入，也可以先按录音再说话"
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={1000}
            className="!rounded-2xl !border-slate-200 !bg-slate-50 !px-4 !py-3"
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault()
                void submitMessage(draft)
              }
            }}
          />
          <Button
            type="primary"
            size="large"
            shape="round"
            icon={<SendOutlined />}
            loading={sending}
            disabled={!draft.trim()}
            className="!h-12 !px-6 !bg-sky-600 hover:!bg-sky-500"
            onClick={() => void submitMessage(draft)}
          >
            发送
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <BulbOutlined />
          <span>如果识别有误，可以先修改文字再发送。</span>
        </div>
      </Card>
    </div>
  )
}
