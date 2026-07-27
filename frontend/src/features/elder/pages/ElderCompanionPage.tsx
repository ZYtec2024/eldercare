import { useEffect, useRef, useState } from 'react'
import { App, Button, Card, Empty, Input, Space, Switch, Tag, Typography } from 'antd'
import {
  AudioOutlined,
  BulbOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
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
  type CompanionHistoryItem,
} from '@/services/adapters/ai-adapter'

type CompanionMessage = CompanionHistoryItem & { id: number }

const introMessage = '您好，我是智能陪聊助手。您可以直接打字，也可以按下录音按钮说话，我会帮您转成文字并读出回复。'

export default function ElderCompanionPage() {
  const { session } = useSession()
  const { message: toast } = App.useApp()
  const [messages, setMessages] = useState<CompanionMessage[]>([{ id: 1, role: 'assistant', content: introMessage }])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [autoSpeak, setAutoSpeak] = useState(true)
  const [busyAudio, setBusyAudio] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const nextIdRef = useRef(2)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const historyLoadedRef = useRef<number | null>(null)

  const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(() => () => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
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

  const playBlob = async (blob: Blob) => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
    }
    const url = URL.createObjectURL(blob)
    currentUrlRef.current = url
    const audio = audioRef.current || new Audio()
    audioRef.current = audio
    audio.src = url
    await audio.play().catch(() => {
      toast.warning('语音已生成，可以点击消息右侧的朗读按钮重试')
    })
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

  const startRecording = async () => {
    if (!canRecord) {
      toast.error('当前浏览器不支持录音')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
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
        const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (!audioBlob.size) {
          return
        }
        try {
          const text = await transcribeCompanionAudio(session!.userId, audioBlob)
          if (!text.trim()) {
            toast.warning('没有识别到有效语音内容')
            return
          }
          setDraft(text)
          await submitMessage(text)
        } catch (error: any) {
          toast.error(error?.message || '语音转写失败')
        }
      }
      recorder.start()
      setRecording(true)
    } catch (error: any) {
      toast.error(error?.message || '无法开启录音权限')
    }
  }

  const stopRecording = () => {
    recorderRef.current?.stop()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Card className="!overflow-hidden !rounded-3xl !border-0 !shadow-[0_18px_60px_rgba(37,99,235,.14)]" bodyStyle={{ padding: 0 }}>
        <div className="relative overflow-hidden bg-gradient-to-r from-sky-700 via-cyan-600 to-emerald-500 px-6 py-7 text-white md:px-8 md:py-8">
          <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,.45) 0, rgba(255,255,255,0) 35%), radial-gradient(circle at 80% 0%, rgba(255,255,255,.35) 0, rgba(255,255,255,0) 28%)' }} />
          <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <Tag color="cyan" className="!border-0 !px-3 !py-1 !text-xs !font-medium">老人端智能陪聊</Tag>
              <Typography.Title level={2} className="!mb-0 !text-white">
                想说什么，就直接说出来
              </Typography.Title>
              <Typography.Paragraph className="!mb-0 !max-w-2xl !text-white/90 !text-base leading-relaxed">
                语音会先转成文字，再发送给智能助手回复。回复可以自动朗读，也可以手动点播。
              </Typography.Paragraph>
            </div>
            <div className="rounded-2xl bg-white/15 px-4 py-3 backdrop-blur-sm">
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
                    {item.role === 'assistant' ? (
                      <Button
                        type="text"
                        size="small"
                        icon={<SoundOutlined />}
                        className="!h-6 !px-2 !text-xs"
                        loading={busyAudio}
                        onClick={() => void speakText(item.content)}
                      >
                        朗读
                      </Button>
                    ) : null}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{item.content}</div>
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