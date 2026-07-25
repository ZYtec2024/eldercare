import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Divider, Form, Input, Select, Slider, Space, Spin, Switch, Tag, Typography } from 'antd'
import { RobotOutlined, SaveOutlined } from '@ant-design/icons'
import { Navigate } from 'react-router-dom'

import { useSession } from '@/features/auth/useSession'
import { fetchCompanionConfig, updateCompanionConfig } from '@/services/adapters/ai-adapter'

export default function AdminAiSettingsPage() {
  const { session } = useSession()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasGroqApiKey, setHasGroqApiKey] = useState(false)
  const [hasChatApiKey, setHasChatApiKey] = useState(false)

  useEffect(() => {
    if (!session) return
    if (!session.isRoot) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchCompanionConfig(session.userId)
      .then((config) => {
        setHasGroqApiKey(config.hasGroqApiKey)
        setHasChatApiKey(config.hasChatApiKey)
        form.setFieldsValue({
          groqApiKey: '',
          groqChatModel: config.groqChatModel,
          groqTranscribeModel: config.groqTranscribeModel,
          chatApiKey: '',
          chatApiBaseUrl: config.chatApiBaseUrl,
          chatModelName: config.chatModelName,
          ttsVoice: config.ttsVoice,
          ttsRate: config.ttsRate,
          ttsVolume: config.ttsVolume,
          companionSystemPrompt: config.companionSystemPrompt,
        })
      })
      .catch((error: any) => {
        message.error(error?.message || 'AI 配置加载失败')
      })
      .finally(() => setLoading(false))
  }, [form, message, session])

  const handleSave = async () => {
    if (!session) return
    setSaving(true)
    try {
      const values = await form.validateFields()
      const nextConfig = await updateCompanionConfig({
        adminUserId: session.userId,
        groqApiKey: values.groqApiKey,
        groqChatModel: values.groqChatModel,
        groqTranscribeModel: values.groqTranscribeModel,
        chatApiKey: values.chatApiKey,
        chatApiBaseUrl: values.chatApiBaseUrl,
        chatModelName: values.chatModelName,
        ttsVoice: values.ttsVoice,
        ttsRate: values.ttsRate,
        ttsVolume: values.ttsVolume,
        companionSystemPrompt: values.companionSystemPrompt,
      })
      setHasGroqApiKey(nextConfig.hasGroqApiKey)
      setHasChatApiKey(nextConfig.hasChatApiKey)
      message.success('AI 配置已保存')
      form.setFieldsValue({ groqApiKey: '', chatApiKey: '' })
    } catch (error: any) {
      if (error?.errorFields) return
      message.error(error?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (session && !session.isRoot) {
    return <Navigate to="/admin/dashboard" replace />
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Spin size="large" /></div>
  }

  const activeModel = hasChatApiKey && form.getFieldValue('chatModelName')
    ? `自定义: ${form.getFieldValue('chatModelName')}`
    : hasGroqApiKey
      ? `Groq: ${form.getFieldValue('groqChatModel')}`
      : '未配置'

  return (
    <div className="space-y-6">
      <div className="rounded-3xl bg-gradient-to-r from-slate-900 via-slate-800 to-sky-900 px-6 py-7 text-white shadow-xl">
        <Space align="start" className="w-full justify-between">
          <div>
            <Typography.Title level={2} className="!mb-2 !text-white">
              智能陪聊 API 配置
            </Typography.Title>
            <Typography.Paragraph className="!mb-0 !max-w-3xl !text-slate-200 leading-relaxed">
              管理 Groq 语音转写、对话模型（可替换为 DeepSeek / 豆包 / GPT 等）以及 Edge TTS 朗读参数。
            </Typography.Paragraph>
          </div>
          <div className="rounded-2xl bg-white/10 px-4 py-3 backdrop-blur-sm">
            <div className="text-sm text-slate-200">当前对话模型</div>
            <div className="mt-1 text-lg font-semibold">{activeModel}</div>
          </div>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message="使用说明"
        description="语音转写固定使用 Groq Whisper。若自定义模型的三项（API Key + Base URL + 模型名）均填写，对话将优先使用自定义模型而非 Groq。"
      />

      <Card className="!rounded-3xl !shadow-[0_10px_40px_rgba(15,23,42,.08)]" title={<Space><RobotOutlined />Groq 与自定义模型配置</Space>}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            groqApiKey: '',
            groqChatModel: 'llama-3.1-8b-instant',
            groqTranscribeModel: 'whisper-large-v3',
            chatApiKey: '',
            chatApiBaseUrl: 'https://api.deepseek.com',
            chatModelName: 'deepseek-chat',
            ttsVoice: 'zh-CN-XiaoxiaoNeural',
            ttsRate: '+0%',
            ttsVolume: '+0%',
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Form.Item label="Groq API Key" name="groqApiKey" extra="语音转写始终使用 Groq。留空不修改。">
              <Input.Password placeholder="gsk_xxx" autoComplete="off" />
            </Form.Item>
            <Form.Item label="Groq 对话模型（默认）" name="groqChatModel" rules={[{ required: true }]}>
              <Input placeholder="llama-3.1-8b-instant" />
            </Form.Item>
            <Form.Item label="Groq 转写模型" name="groqTranscribeModel" rules={[{ required: true }]}>
              <Input placeholder="whisper-large-v3" />
            </Form.Item>
          </div>

          <Divider plain>
            <Tag color="purple">自定义对话模型（可选，支持 OpenAI 兼容接口）</Tag>
          </Divider>
          <Typography.Paragraph type="secondary" className="!mb-4 !text-xs">
            填写以下三项后，对话将优先使用自定义模型。适用于 DeepSeek、豆包、GPT、通义千问等。
          </Typography.Paragraph>

          <div className="grid gap-4 md:grid-cols-3">
            <Form.Item label="自定义 API Key" name="chatApiKey" extra="留空则继续用 Groq">
              <Input.Password placeholder="sk-xxx" autoComplete="off" />
            </Form.Item>
            <Form.Item label="接口地址 (Base URL)" name="chatApiBaseUrl">
              <Input placeholder="https://api.deepseek.com" />
            </Form.Item>
            <Form.Item label="模型名称" name="chatModelName">
              <Input placeholder="deepseek-chat" />
            </Form.Item>
          </div>

          <Divider plain>
            <Tag color="blue">语音朗读 (Edge TTS)</Tag>
          </Divider>

          <div className="grid gap-4 md:grid-cols-3">
            <Form.Item label="Edge TTS 语音角色" name="ttsVoice" rules={[{ required: true }]}>
              <Select
                showSearch
                placeholder="选择朗读语音"
                options={[
                  { label: '晓晓（女·温柔）', value: 'zh-CN-XiaoxiaoNeural' },
                  { label: '云希（男·年轻）', value: 'zh-CN-YunxiNeural' },
                  { label: '云扬（男·新闻）', value: 'zh-CN-YunyangNeural' },
                  { label: '晓伊（女·可爱）', value: 'zh-CN-XiaoyiNeural' },
                  { label: '云健（男·运动）', value: 'zh-CN-YunjianNeural' },
                  { label: '晓辰（女·活泼）', value: 'zh-CN-XiaochenNeural' },
                  { label: '晓涵（女·沉稳）', value: 'zh-CN-XiaohanNeural' },
                  { label: '晓墨（女·知性）', value: 'zh-CN-XiaomoNeural' },
                  { label: '晓秋（女·温婉）', value: 'zh-CN-XiaoqiuNeural' },
                  { label: '晓睿（女·干练）', value: 'zh-CN-XiaoruiNeural' },
                  { label: '晓双（女·童声）', value: 'zh-CN-XiaoshuangNeural' },
                  { label: '晓颜（女·甜美）', value: 'zh-CN-XiaoyanNeural' },
                  { label: '晓悠（女·轻柔）', value: 'zh-CN-XiaoyouNeural' },
                  { label: '云夏（男·沉稳）', value: 'zh-CN-YunxiaNeural' },
                  { label: '云泽（男·成熟）', value: 'zh-CN-YunzeNeural' },
                ]}
              />
            </Form.Item>
            <Form.Item label="朗读语速" name="ttsRate" rules={[{ required: true }]}
              getValueFromEvent={(value) => (value >= 0 ? `+${value}%` : `${value}%`)}
              getValueProps={(value) => ({ value: value ? parseInt(String(value).replace('%', '').replace('+', '')) || 0 : 0 })}
            >
              <Slider min={-50} max={100} step={5}
                tooltip={{ formatter: (v) => (v && v >= 0 ? `+${v}%` : `${v}%`) }}
              />
            </Form.Item>
            <Form.Item label="朗读音量" name="ttsVolume" rules={[{ required: true }]}
              getValueFromEvent={(value) => (value >= 0 ? `+${value}%` : `${value}%`)}
              getValueProps={(value) => ({ value: value ? parseInt(String(value).replace('%', '').replace('+', '')) || 0 : 0 })}
            >
              <Slider min={-50} max={100} step={5}
                tooltip={{ formatter: (v) => (v && v >= 0 ? `+${v}%` : `${v}%`) }}
              />
            </Form.Item>
          </div>

          <Form.Item label="系统提示词" name="companionSystemPrompt" rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 5, maxRows: 10 }} placeholder="请输入老人端陪聊助手的系统提示词" />
          </Form.Item>

          <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-slate-700">服务状态</div>
              <div className="text-xs text-slate-500">
                Groq: {hasGroqApiKey ? '已配置' : '未配置'} · 自定义模型: {hasChatApiKey ? '已配置' : '未配置'} · 保存后立即生效
              </div>
            </div>
            <Switch checked={hasGroqApiKey || hasChatApiKey} disabled />
          </div>

          <div className="mt-5 flex justify-end">
            <Button type="primary" size="large" icon={<SaveOutlined />} loading={saving} onClick={() => void handleSave()}>
              保存配置
            </Button>
          </div>
        </Form>
      </Card>
    </div>
  )
}