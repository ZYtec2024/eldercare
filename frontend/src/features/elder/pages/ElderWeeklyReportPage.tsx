import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Collapse, Empty, Popconfirm, Spin, Tag, Typography } from 'antd'
import {
  FileTextOutlined,
  ReloadOutlined,
  HistoryOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  DeleteOutlined,
  SaveOutlined,
} from '@ant-design/icons'

import { useSession } from '@/features/auth/useSession'
import {
  generateWeeklyReport,
  fetchWeeklyReportEligibility,
  fetchWeeklyReportHistory,
  deleteWeeklyReport,
  saveWeeklyReport,
} from '@/services/adapters/elder-adapter'
import type { WeeklyReport, WeeklyReportEligibility } from '@/services/adapters/elder-adapter'

function renderMarkdown(content: string): string {
  return content
    .replace(/^### (.+)$/gm, '<h3 class="text-xl font-semibold mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-2xl font-bold mt-5 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-3xl font-bold mt-6 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">$1</strong>')
    .replace(/^\- (.+)$/gm, '<li class="ml-4">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4">$1</li>')
    .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="list-disc pl-6 my-2">$1</ul>')
    .replace(/^(\|.+)$/gm, (match) =>
      match.replace(/^\|/, '<tr class="border-b border-gray-200"><td class="px-3 py-1.5">')
        .replace(/\|$/, '</td></tr>')
        .replace(/\|/g, '</td><td class="px-3 py-1.5">'),
    )
    .replace(/((?:<tr[^>]*>.*<\/tr>\n?)+)/g, (match) => {
      const headerEnd = match.indexOf('</tr>')
      if (headerEnd === -1) return `<table class="w-full my-4 border-collapse">${match}</table>`
      const headerRow = match.slice(0, headerEnd + '</tr>'.length)
      const bodyRows = match.slice(headerEnd + '</tr>'.length)
      const sepIdx = bodyRows.indexOf('<tr')
      if (sepIdx === -1) return `<table class="w-full my-4 border-collapse"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`
      const sepEnd = bodyRows.indexOf('</tr>', sepIdx)
      if (sepEnd === -1) return `<table class="w-full my-4 border-collapse"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`
      const actualBody = bodyRows.slice(sepEnd + '</tr>'.length)
      return `<table class="w-full my-4 border-collapse"><thead>${headerRow}</thead><tbody>${actualBody}</tbody></table>`
    })
    .replace(/^---$/gm, '<hr class="my-6 border-gray-300" />')
    .replace(/\n\n+/g, '<br/>')
}

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return (
    <div
      className="text-base text-gray-800 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function ElderWeeklyReportPage() {
  const { session } = useSession()
  const userId = session?.userId ?? 0

  const [eligibility, setEligibility] = useState<WeeklyReportEligibility | null>(null)
  const [eligibilityLoading, setEligibilityLoading] = useState(true)

  const [currentReport, setCurrentReport] = useState<WeeklyReport | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useState<WeeklyReport[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const currentReportRef = useRef<WeeklyReport | null>(null)
  const generatingRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    currentReportRef.current = currentReport
  }, [currentReport])

  useEffect(() => {
    generatingRef.current = generating
  }, [generating])

  useEffect(() => {
    return () => {
      if (currentReportRef.current && !saved) {
        const id = currentReportRef.current.reportId
        if (id) {
          navigator.sendBeacon(`/api/elder/weekly-report/${id}/save`, '{}')
        }
      }
    }
  }, [saved])

  const loadEligibility = useCallback(() => {
    if (!userId) return
    setEligibilityLoading(true)
    fetchWeeklyReportEligibility(userId)
      .then((res) => {
        setEligibility(res.data)
        if (res.data.draft) {
          setCurrentReport(res.data.draft)
          setSaved(false)
          setGenerating(false)
          sessionStorage.removeItem('weeklyReportGenerating')
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }
        } else if (sessionStorage.getItem('weeklyReportGenerating') === '1') {
          setGenerating(true)
        }
      })
      .catch(() => setEligibility(null))
      .finally(() => setEligibilityLoading(false))
  }, [userId])

  const loadHistory = useCallback(() => {
    if (!userId) return
    setHistoryLoading(true)
    fetchWeeklyReportHistory(userId)
      .then((res) => setHistory(res.data?.items ?? []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false))
  }, [userId])

  useEffect(() => {
    loadEligibility()
    loadHistory()

    if (sessionStorage.getItem('weeklyReportGenerating') === '1') {
      setGenerating(true)
      pollTimerRef.current = setInterval(() => {
        loadEligibility()
      }, 3000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
    }
  }, [loadEligibility, loadHistory])

  const handleGenerate = async () => {
    if (!userId || generating) return
    setError(null)
    setGenerating(true)
    setSaved(false)
    sessionStorage.setItem('weeklyReportGenerating', '1')
    try {
      const res = await generateWeeklyReport(userId)
      setCurrentReport(res.data)
      loadHistory()
      loadEligibility()
    } catch (err: any) {
      setError(err?.message ?? '生成失败，请稍后重试')
    } finally {
      setGenerating(false)
      sessionStorage.removeItem('weeklyReportGenerating')
    }
  }

  const handleRegenerate = async () => {
    if (!userId || !currentReport || generating) return
    setError(null)
    setGenerating(true)
    setSaved(false)
    sessionStorage.setItem('weeklyReportGenerating', '1')
    try {
      if (currentReport.reportId) {
        await deleteWeeklyReport(currentReport.reportId, userId)
      }
      const res = await generateWeeklyReport(userId)
      setCurrentReport(res.data)
      loadHistory()
      loadEligibility()
    } catch (err: any) {
      setError(err?.message ?? '重新生成失败，请稍后重试')
    } finally {
      setGenerating(false)
      sessionStorage.removeItem('weeklyReportGenerating')
    }
  }

  const handleSave = async () => {
    if (!currentReport?.reportId || saved) return
    try {
      await saveWeeklyReport(currentReport.reportId)
      setSaved(true)
      setCurrentReport(null)
      loadHistory()
    } catch (err: any) {
      setError(err?.message ?? '保存失败')
    }
  }

  const handleDelete = async (reportId: number) => {
    if (!userId) return
    try {
      await deleteWeeklyReport(reportId, userId)
      setHistory((prev) => prev.filter((item) => item.reportId !== reportId))
      if (currentReport?.reportId === reportId) {
        setCurrentReport(null)
      }
    } catch (err: any) {
      setError(err?.message ?? '删除失败')
    }
  }

  const eligible = eligibility?.eligible ?? false
  const weekLabel = eligibility
    ? `${eligibility.weekStart} — ${eligibility.weekEnd}`
    : ''

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-700 p-8 md:p-10 text-white shadow-lg">
        <Typography.Title level={1} className="!text-white !mb-2 !text-3xl md:!text-4xl">
          智能周报
        </Typography.Title>
        <Typography.Paragraph className="!text-purple-100 !text-lg !mb-1 max-w-2xl">
          AI 根据您近7天的健康数据和服务记录，自动生成一份专属周报。
        </Typography.Paragraph>
        {weekLabel && (
          <Tag color="purple" className="!text-base !px-3 !py-1 !mt-2">
            {weekLabel}
          </Tag>
        )}
      </div>

      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      <Card className="!rounded-2xl">
        {eligibilityLoading && !generating ? (
          <div className="text-center py-8">
            <Spin size="large" />
            <Typography.Paragraph className="!mt-4 !text-gray-500">
              正在检查健康数据...
            </Typography.Paragraph>
          </div>
        ) : generating ? (
          <div className="text-center py-6">
            <Spin size="large" className="mb-4" />
            <Typography.Title level={3} className="!mb-2">
              周报生成中，请耐心等待
            </Typography.Title>
            <Typography.Paragraph className="!text-gray-500 !mb-6">
              AI 正在分析您的健康数据和服务记录...
            </Typography.Paragraph>
            <Button
              type="primary"
              size="large"
              icon={<FileTextOutlined />}
              loading
              disabled
              className="!h-12 !px-8 !text-lg !font-semibold !rounded-xl"
            >
              正在生成...
            </Button>
          </div>
        ) : eligible ? (
          <div className="text-center py-6">
            <CheckCircleOutlined className="!text-5xl !text-green-500 mb-4" />
            <Typography.Title level={3} className="!mb-2">
              条件满足，可以生成周报
            </Typography.Title>
            <Typography.Paragraph className="!text-gray-500 !mb-6">
              您已有 {eligibility?.daysWithData} 天健康打卡记录
            </Typography.Paragraph>
            <Button
              type="primary"
              size="large"
              icon={<FileTextOutlined />}
              loading={generating}
              disabled={!!currentReport}
              onClick={handleGenerate}
              className="!h-12 !px-8 !text-lg !font-semibold !rounded-xl"
            >
              {generating ? 'AI 正在生成周报...' : '生成本周周报'}
            </Button>
          </div>
        ) : (
          <div className="text-center py-6">
            <ExclamationCircleOutlined className="!text-5xl !text-amber-500 mb-4" />
            <Typography.Title level={3} className="!mb-2">
              暂不满足生成条件
            </Typography.Title>
            <Typography.Paragraph className="!text-gray-500 !mb-2">
              近7天仅有 {eligibility?.daysWithData ?? 0} 天健康打卡记录
            </Typography.Paragraph>
            <Typography.Paragraph className="!text-gray-400">
              请坚持每日健康打卡，满 7 天后即可生成周报！
            </Typography.Paragraph>
          </div>
        )}
      </Card>

      {generating && (
        <Card className="!rounded-2xl text-center py-12">
          <Spin size="large" />
          <Typography.Paragraph className="!mt-4 !text-gray-500 !text-lg">
            AI 正在为您撰写周报，请稍候...
          </Typography.Paragraph>
        </Card>
      )}

      {currentReport && !generating && (
        <Card
          className="!rounded-2xl"
          title={
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-lg">本次周报</span>
              <div className="flex items-center gap-3">
                <Tag color="purple">{currentReport.templateName}</Tag>
                {!saved && (
                  <Button
                    icon={<SaveOutlined />}
                    onClick={handleSave}
                    type="primary"
                    ghost
                    size="small"
                  >
                    保存到历史
                  </Button>
                )}
                <Button
                  icon={<ReloadOutlined />}
                  onClick={handleRegenerate}
                  loading={generating}
                >
                  换一种风格重新生成
                </Button>
              </div>
            </div>
          }
        >
          <MarkdownPreview content={currentReport.content} />
        </Card>
      )}

      <Card
        className="!rounded-2xl"
        title={
          <div className="flex items-center gap-2">
            <HistoryOutlined />
            <span>历史周报</span>
          </div>
        }
      >
        {historyLoading ? (
          <div className="text-center py-4">
            <Spin />
          </div>
        ) : history.length === 0 ? (
          <Empty description="暂无历史周报，快去生成第一份吧！" />
        ) : (
          <Collapse
            accordion
            items={history.map((item) => ({
              key: String(item.reportId),
              label: (
                <div className="flex items-center gap-3 w-full">
                  <span className="font-medium">
                    {item.weekStart} — {item.weekEnd}
                  </span>
                  <Tag className="!text-xs">{item.templateName}</Tag>
                  <span className="text-gray-400 text-sm flex-1">{item.generatedAt}</span>
                  <Popconfirm
                    title="确定删除这份周报吗？"
                    onConfirm={() => handleDelete(item.reportId)}
                    okText="确定"
                    cancelText="取消"
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </div>
              ),
              children: <MarkdownPreview content={item.content} />,
            }))}
          />
        )}
      </Card>
    </div>
  )
}
