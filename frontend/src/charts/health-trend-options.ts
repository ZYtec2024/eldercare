import type { HealthTrendSnapshot } from '@/types/domain'

export function buildHealthTrendOptions(snapshot: HealthTrendSnapshot) {
  const warningLine = 140
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        label: { backgroundColor: '#1f2937' },
      },
    },
    legend: {
      data: ['收缩压', '舒张压', '心率'],
      top: 8,
      textStyle: { color: '#475569' },
    },
    grid: {
      left: 20,
      right: 24,
      top: 52,
      bottom: 34,
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: snapshot.dateRange,
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748b' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b' },
      axisLine: { show: false },
      splitLine: {
        lineStyle: { color: 'rgba(148, 163, 184, 0.25)', type: 'dashed' },
      },
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      {
        type: 'slider',
        height: 18,
        bottom: 6,
        start: 0,
        end: 100,
        backgroundColor: 'rgba(148, 163, 184, 0.15)',
        fillerColor: 'rgba(59, 130, 246, 0.25)',
        borderColor: 'transparent',
        handleStyle: { color: '#3b82f6', borderColor: '#3b82f6' },
      },
    ],
    series: [
      {
        name: '收缩压',
        type: 'line',
        smooth: true,
        data: snapshot.systolicSeries,
        showSymbol: false,
        lineStyle: { width: 3, color: '#ef4444' },
        itemStyle: { color: '#ef4444' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(239, 68, 68, 0.35)' },
              { offset: 1, color: 'rgba(239, 68, 68, 0.06)' },
            ],
          },
        },
        markLine: {
          symbol: 'none',
          label: { formatter: `收缩压警戒线 ${warningLine}`, color: '#ef4444' },
          lineStyle: { color: '#ef4444', type: 'dashed', width: 1 },
          data: [{ yAxis: warningLine }],
        },
        emphasis: { focus: 'series' },
      },
      {
        name: '舒张压',
        type: 'line',
        smooth: true,
        data: snapshot.diastolicSeries,
        showSymbol: false,
        lineStyle: { width: 2.5, color: '#f59e0b' },
        itemStyle: { color: '#f59e0b' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.3)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0.05)' },
            ],
          },
        },
        emphasis: { focus: 'series' },
      },
      {
        name: '心率',
        type: 'line',
        smooth: true,
        data: snapshot.heartRateSeries,
        showSymbol: false,
        lineStyle: { width: 2.5, color: '#059669' },
        itemStyle: { color: '#059669' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(5, 150, 105, 0.3)' },
              { offset: 1, color: 'rgba(5, 150, 105, 0.05)' },
            ],
          },
        },
        emphasis: { focus: 'series' },
      },
    ],
  }
}
