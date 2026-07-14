import { useState } from 'react'
import { Typography, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftOutlined, CheckCircleOutlined } from '@ant-design/icons'

import { healthKnowledgeFixture } from '@/mocks/fixtures/shared'
import type { HealthKnowledgeEntry } from '@/types/domain'

const metricIcons: Record<string, string> = {
  blood_pressure: '💓',
  blood_oxygen: '🫁',
  blood_sugar: '🩸',
  temperature: '🌡️',
  weight: '⚖️',
  heart_rate: '❤️',
}

const metricColors: Record<string, { bg: string; border: string; badge: string; badgeText: string; sidebar: string; sidebarActive: string }> = {
  blood_pressure: { bg: 'bg-red-50', border: 'border-red-200', badge: 'bg-red-100', badgeText: 'text-red-700', sidebar: 'hover:bg-red-50', sidebarActive: 'bg-red-50 border-red-400 text-red-700' },
  blood_oxygen: { bg: 'bg-sky-50', border: 'border-sky-200', badge: 'bg-sky-100', badgeText: 'text-sky-700', sidebar: 'hover:bg-sky-50', sidebarActive: 'bg-sky-50 border-sky-400 text-sky-700' },
  blood_sugar: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-100', badgeText: 'text-amber-700', sidebar: 'hover:bg-amber-50', sidebarActive: 'bg-amber-50 border-amber-400 text-amber-700' },
  temperature: { bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-100', badgeText: 'text-orange-700', sidebar: 'hover:bg-orange-50', sidebarActive: 'bg-orange-50 border-orange-400 text-orange-700' },
  weight: { bg: 'bg-green-50', border: 'border-green-200', badge: 'bg-green-100', badgeText: 'text-green-700', sidebar: 'hover:bg-green-50', sidebarActive: 'bg-green-50 border-green-400 text-green-700' },
  heart_rate: { bg: 'bg-pink-50', border: 'border-pink-200', badge: 'bg-pink-100', badgeText: 'text-pink-700', sidebar: 'hover:bg-pink-50', sidebarActive: 'bg-pink-50 border-pink-400 text-pink-700' },
}

/** Extended detail content for each metric */
const detailContent: Record<string, { whatIs: string; whyMatters: string; howToMeasure: string; warningSignals: string[]; dailyAdvice: string[] }> = {
  blood_pressure: {
    whatIs: '血压是血液在血管中流动时对血管壁产生的压力。通常用收缩压（高压）和舒张压（低压）两个数值表示，单位为毫米汞柱（mmHg）。',
    whyMatters: '长期高血压会增加心脏病、中风、肾病等风险；低血压则可能导致头晕、乏力甚至晕厥。老年人血压波动较大，需要定期监测。',
    howToMeasure: '建议使用上臂式电子血压计，测量前静坐休息5分钟，避免饮酒、咖啡或剧烈运动后立即测量。每天固定时间测量2-3次，记录数值变化趋势。',
    warningSignals: ['收缩压持续 ≥ 140 或舒张压 ≥ 90', '突然出现剧烈头痛、视物模糊', '血压短时间内大幅波动（>30mmHg）', '伴随胸闷、气短等不适'],
    dailyAdvice: ['低盐饮食，每日食盐不超过5克', '适量运动，如散步、太极拳', '保持情绪稳定，避免过度紧张', '遵医嘱按时服用降压药物', '戒烟限酒，保证充足睡眠'],
  },
  blood_oxygen: {
    whatIs: '血氧饱和度（SpO2）是指血液中氧合血红蛋白占全部血红蛋白的百分比，反映身体的供氧状况。',
    whyMatters: '血氧过低意味着身体组织和器官可能得不到足够的氧气供应，严重时可导致器官功能障碍。老年人肺功能下降，更需关注血氧水平。',
    howToMeasure: '使用指夹式脉搏血氧仪，将传感器夹在手指上，保持手指温暖、干净，静止不动等待数值稳定。避免涂指甲油影响读数。',
    warningSignals: ['血氧持续低于 95%', '低于 90% 需立即就医', '伴随呼吸急促、口唇发紫', '活动后血氧明显下降且恢复缓慢'],
    dailyAdvice: ['保持室内空气流通', '适当进行呼吸训练（如腹式呼吸）', '避免长时间处于密闭空间', '有慢性肺病者遵医嘱使用氧疗设备', '戒烟，远离二手烟环境'],
  },
  blood_sugar: {
    whatIs: '血糖是指血液中的葡萄糖浓度，是人体重要的能量来源指标。空腹血糖和餐后血糖是两个关键监测时点。',
    whyMatters: '血糖过高可能导致糖尿病及其并发症（视网膜病变、肾病、神经病变等）；血糖过低则可能引起头晕、出汗、甚至昏迷。',
    howToMeasure: '使用家用血糖仪，采指尖血测量。空腹血糖需在早晨未进食前测量；餐后血糖在进食后2小时测量。注意试纸保质期和仪器校准。',
    warningSignals: ['空腹血糖 > 7.0 mmol/L', '餐后2小时血糖 > 11.1 mmol/L', '出现多饮、多尿、体重下降', '低血糖症状：出冷汗、手抖、心慌'],
    dailyAdvice: ['规律饮食，控制碳水化合物摄入', '少食多餐，避免暴饮暴食', '适量运动，餐后散步30分钟', '按医嘱使用降糖药物或胰岛素', '定期检查糖化血红蛋白（HbA1c）'],
  },
  temperature: {
    whatIs: '体温是人体内部的温度，反映身体的代谢状态和免疫反应。正常体温因测量部位不同略有差异（腋温、口温、耳温）。',
    whyMatters: '发热通常是身体对感染的免疫反应；持续低温可能提示甲状腺功能减退等问题。老年人体温调节能力下降，感染时发热反应可能不明显。',
    howToMeasure: '推荐使用电子体温计。腋下测量需夹紧5分钟；耳温枪测量更快速。每天固定时间测量，注意运动、进食、洗澡后30分钟内测量可能偏高。',
    warningSignals: ['体温 ≥ 38.5°C 持续不退', '体温 < 35°C（低体温症）', '发热伴随寒战、意识模糊', '反复低热超过一周'],
    dailyAdvice: ['发热时多饮水，注意休息', '物理降温：温水擦浴、冰敷额头', '注意保暖，避免受凉', '高热不退及时就医', '季节交替注意增减衣物'],
  },
  weight: {
    whatIs: '体重是衡量身体总质量的指标，结合身高可计算BMI（体质指数）来评估体重是否在健康范围内。老年人BMI建议在 20-26.9 之间。',
    whyMatters: '体重过重增加心血管疾病、糖尿病风险；体重过轻可能提示营养不良或潜在疾病。短期内体重大幅波动（一周内变化超过2kg）需要警惕。',
    howToMeasure: '每天固定时间（建议晨起排便后、进食前）穿轻薄衣物称量。使用同一台体重秤，放在硬质平面上，记录数值观察趋势。',
    warningSignals: ['一个月内体重下降超过5%', '不明原因的持续体重增加', '伴随食欲明显变化', '下肢水肿导致的体重增加'],
    dailyAdvice: ['均衡饮食，保证蛋白质摄入', '每日适量运动，维持肌肉量', '避免过度节食或暴饮暴食', '关注体重变化趋势而非单次数值', '定期体检，排除代谢性疾病'],
  },
  heart_rate: {
    whatIs: '心率是指心脏每分钟跳动的次数，静息心率是在安静状态下测量的心率。它反映心脏的工作效率和自主神经系统的状态。',
    whyMatters: '心率过快（心动过速）或过慢（心动过缓）都可能提示心脏问题。心律不齐（心跳节奏不规则）也需要关注，可能与房颤等疾病相关。',
    howToMeasure: '可通过脉搏血氧仪、智能手环或手动触摸桡动脉（手腕内侧）计数。测量前静坐休息5分钟，计数60秒内的脉搏次数。注意感受节律是否规整。',
    warningSignals: ['静息心率持续 > 100 次/分钟', '静息心率 < 50 次/分钟（非运动员）', '心跳明显不规则、有停顿感', '伴随胸闷、气短、头晕'],
    dailyAdvice: ['保持规律作息，避免熬夜', '适度有氧运动，增强心肺功能', '减少咖啡因和酒精摄入', '学会放松，管理压力和情绪', '有心脏病史者遵医嘱定期复查'],
  },
}

export default function HealthKnowledgePage() {
  const navigate = useNavigate()
  const [activeId, setActiveId] = useState(healthKnowledgeFixture[0].entryId)

  const activeEntry = healthKnowledgeFixture.find((e) => e.entryId === activeId) as HealthKnowledgeEntry
  const colors = metricColors[activeEntry.metricType] || metricColors.heart_rate
  const detail = detailContent[activeEntry.metricType]

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
          <div className="flex items-center gap-4">
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              className="!text-blue-200 hover:!text-white"
              onClick={() => navigate('/')}
            >
              返回首页
            </Button>
            <div>
              <Typography.Title level={3} className="!text-white !mb-0">
                健康知识手册
              </Typography.Title>
              <Typography.Text className="!text-blue-200 text-sm">
                六大健康指标详解
              </Typography.Text>
            </div>
          </div>
        </div>
      </div>

      {/* Main: Sidebar + Content */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-4 md:px-6 py-6">
        <div className="flex gap-6 min-h-[calc(100vh-180px)]">
          {/* Sidebar */}
          <div className="w-56 flex-shrink-0 hidden md:block">
            <div className="sticky top-6">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <Typography.Text className="!font-semibold !text-gray-600 !text-xs uppercase tracking-wider">
                    健康指标
                  </Typography.Text>
                </div>
                <nav className="py-1">
                  {healthKnowledgeFixture.map((entry) => {
                    const c = metricColors[entry.metricType] || metricColors.heart_rate
                    const isActive = entry.entryId === activeId
                    return (
                      <button
                        key={entry.entryId}
                        onClick={() => setActiveId(entry.entryId)}
                        className={`w-full text-left px-4 py-3 flex items-center gap-3 border-l-4 transition-all ${
                          isActive
                            ? `${c.sidebarActive} font-semibold`
                            : `border-transparent text-gray-600 ${c.sidebar}`
                        }`}
                      >
                        <span className="text-xl">{metricIcons[entry.metricType]}</span>
                        <span className="text-sm">{entry.title}</span>
                      </button>
                    )
                  })}
                </nav>
              </div>
            </div>
          </div>

          {/* Mobile selector */}
          <div className="md:hidden mb-4 w-full">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {healthKnowledgeFixture.map((entry) => {
                const c = metricColors[entry.metricType] || metricColors.heart_rate
                const isActive = entry.entryId === activeId
                return (
                  <button
                    key={entry.entryId}
                    onClick={() => setActiveId(entry.entryId)}
                    className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      isActive
                        ? `${c.badge} ${c.badgeText}`
                        : 'bg-white text-gray-600 border border-gray-200'
                    }`}
                  >
                    {metricIcons[entry.metricType]} {entry.title}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Title Section */}
              <div className={`${colors.bg} ${colors.border} border-b p-6 md:p-8`}>
                <div className="flex items-center gap-4 mb-4">
                  <span className="text-5xl">{metricIcons[activeEntry.metricType]}</span>
                  <div>
                    <Typography.Title level={2} className="!mb-1 !text-gray-800">
                      {activeEntry.title}
                    </Typography.Title>
                    <span className={`inline-block px-4 py-1.5 rounded-full text-sm font-bold ${colors.badge} ${colors.badgeText}`}>
                      正常范围：{activeEntry.normalRangeText}
                    </span>
                  </div>
                </div>
                <Typography.Paragraph className="!text-gray-600 !text-base !mb-0">
                  {activeEntry.summary}
                </Typography.Paragraph>
              </div>

              {/* Detail Content */}
              <div className="p-6 md:p-8 space-y-8">
                {/* What is it */}
                <section>
                  <Typography.Title level={4} className="!text-gray-800 !mb-3">
                    什么是{activeEntry.title}？
                  </Typography.Title>
                  <Typography.Paragraph className="!text-gray-600 !text-base leading-relaxed !mb-0">
                    {detail.whatIs}
                  </Typography.Paragraph>
                </section>

                {/* Why it matters */}
                <section>
                  <Typography.Title level={4} className="!text-gray-800 !mb-3">
                    为什么要关注{activeEntry.title}？
                  </Typography.Title>
                  <Typography.Paragraph className="!text-gray-600 !text-base leading-relaxed !mb-0">
                    {detail.whyMatters}
                  </Typography.Paragraph>
                </section>

                {/* How to measure */}
                <section>
                  <Typography.Title level={4} className="!text-gray-800 !mb-3">
                    如何正确测量？
                  </Typography.Title>
                  <Typography.Paragraph className="!text-gray-600 !text-base leading-relaxed !mb-0">
                    {detail.howToMeasure}
                  </Typography.Paragraph>
                </section>

                {/* Warning signals */}
                <section>
                  <Typography.Title level={4} className="!text-red-600 !mb-3">
                    需要警惕的信号
                  </Typography.Title>
                  <div className="bg-red-50 rounded-xl p-5 border border-red-100">
                    <ul className="space-y-2">
                      {detail.warningSignals.map((signal, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-red-500 mt-0.5 flex-shrink-0">⚠️</span>
                          <Typography.Text className="text-red-700">{signal}</Typography.Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                {/* Daily care tips */}
                <section>
                  <Typography.Title level={4} className="!text-gray-800 !mb-3">
                    日常护理建议
                  </Typography.Title>
                  <div className={`${colors.bg} rounded-xl p-5 ${colors.border} border`}>
                    <ul className="space-y-3">
                      {detail.dailyAdvice.map((advice, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <CheckCircleOutlined className="text-blue-500 mt-1 flex-shrink-0 text-base" />
                          <Typography.Text className="text-gray-700 text-base">{advice}</Typography.Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                {/* Original care tips from fixture */}
                <section>
                  <Typography.Title level={4} className="!text-gray-800 !mb-3">
                    快速要点
                  </Typography.Title>
                  <div className="flex flex-wrap gap-2">
                    {activeEntry.careTips.map((tip, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium ${colors.badge} ${colors.badgeText}`}
                      >
                        <CheckCircleOutlined />
                        {tip}
                      </span>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
