/**
 * 单个 ASIN 的逐周趋势：指标定义、环比、趋势图坐标。
 * 周快照形如 { id, startDate, endDate, columns, rows: [{ asin, values }], notes }。
 */
import { buildColIndex, toNum, weekCell, weekRoi } from './weekSnapshot.js'

/** 趋势只看最近几周 */
export const TREND_WEEKS = 8

export function fmtNum(n, digits = 0) {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * 指标定义
 * - pick: 从周快照行中取值（g 读一格，roi 为该行 ROI）
 * - kind: 'num' | 'money' | 'pct' | 'ratio'
 * - better: 'up' 越高越好 / 'down' 越低越好（用于环比着色）
 */
export const METRICS = [
  { key: 'sales', label: '周销量', kind: 'num', better: 'up', pick: (g) => toNum(g('销量')) },
  { key: 'revenue', label: '销售额', kind: 'money', better: 'up', pick: (g) => toNum(g('销售额')) },
  { key: 'profit', label: '毛利润', kind: 'money', better: 'up', alertCol: '毛利润', pick: (g) => toNum(g('毛利润')) },
  { key: 'margin', label: '毛利率', kind: 'pct', better: 'up', pick: (g) => toNum(g('毛利率')) },
  { key: 'price', label: '平均售价', kind: 'money', better: 'up', pick: (g) => toNum(g('平均售价')) },
  { key: 'adSpend', label: '广告花费', kind: 'money', better: 'down', pick: (g) => Math.abs(toNum(g('广告花费'))) },
  { key: 'adRate', label: '广告费率', kind: 'pct', better: 'down', alertCol: '广告费率', pick: (g) => toNum(g('广告费率')) },
  {
    key: 'adShare',
    label: '广告单占比',
    kind: 'pct',
    better: 'down',
    pick: (g) => {
      const ad = toNum(g('广告销量'))
      const total = toNum(g('销量'))
      return Number.isFinite(ad) && total > 0 ? (ad / total) * 100 : NaN
    },
  },
  { key: 'roi', label: 'ROI', kind: 'ratio', better: 'up', alertCol: 'ROI', pick: (g, roi) => roi },
  { key: 'refundRate', label: '退款率', kind: 'pct', better: 'down', alertCol: '退款率', pick: (g) => toNum(g('退款率')) },
]
export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]))
export const KPI_KEYS = ['sales', 'revenue', 'profit', 'margin', 'adRate', 'roi', 'refundRate']

export function fmtMetric(metric, n) {
  if (!Number.isFinite(n)) return '—'
  if (metric.kind === 'pct') return `${n.toFixed(2)}%`
  if (metric.kind === 'money') return `${n < 0 ? '-' : ''}$${fmtNum(Math.abs(n), 2)}`
  if (metric.kind === 'ratio') return n.toFixed(2)
  return fmtNum(n)
}

/** 环比：百分比类指标用 pp 差值，ROI 用差值，其它用变化率 */
export function deltaOf(metric, cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null
  const diff = cur - prev
  let text
  if (metric.kind === 'pct') {
    text = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp`
  } else if (metric.kind === 'ratio') {
    text = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`
  } else if (prev === 0) {
    text = diff === 0 ? '0%' : '新增'
  } else {
    const rate = (diff / Math.abs(prev)) * 100
    text = `${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%`
  }
  let tone = 'flat'
  if (Math.abs(diff) > 1e-9) {
    const good = metric.better === 'up' ? diff > 0 : diff < 0
    tone = good ? 'good' : 'bad'
  }
  return { text, tone, arrow: diff > 0 ? '▲' : diff < 0 ? '▼' : '' }
}

/** 某周某店某 ASIN 的行；周表没有店铺列时只按 ASIN 找 */
export function findWeekRow(week, shopName, asin) {
  const shopIdx = (week?.columns || []).indexOf('店铺')
  for (const row of week?.rows || []) {
    if (String(row.asin || '').trim() !== asin) continue
    if (shopIdx < 0 || String(row.values?.[shopIdx] ?? '').trim() === shopName) return row
  }
  return null
}

/** weeks 按时间升序；返回每周一个点，没有数据的周 hasData=false */
export function buildSeries(weeks, shopName, asin) {
  return (weeks || []).map((week) => {
    const row = findWeekRow(week, shopName, asin)
    const idx = buildColIndex(week.columns)
    const g = (col) => (row ? weekCell(row, idx, col) : '')
    const roi = row ? weekRoi(row, idx) : NaN
    const metrics = {}
    for (const m of METRICS) metrics[m.key] = row ? m.pick(g, roi) : NaN
    return {
      weekId: week.id,
      range: `${String(week.startDate || '').slice(5)}~${String(week.endDate || '').slice(5)}`,
      hasData: !!row,
      note: String(week.notes?.[asin] || '').trim(),
      metrics,
    }
  })
}

/** 最新一个有数据的周 vs 上一个有数据的周 */
export function latestKpis(series, keys = KPI_KEYS) {
  const withData = (series || []).filter((s) => s.hasData)
  const latest = withData[withData.length - 1] || null
  const previous = withData[withData.length - 2] || null
  return keys.map((key) => {
    const metric = METRIC_BY_KEY[key]
    const cur = latest ? latest.metrics[key] : NaN
    return {
      key,
      label: metric.label,
      raw: cur,
      value: fmtMetric(metric, cur),
      alertCol: metric.alertCol || '',
      delta: previous ? deltaOf(metric, cur, previous.metrics[key]) : null,
    }
  })
}

/** 多个 ASIN 同一周某指标的合计；全部没有数据返回 NaN */
export function sumMetric(seriesList, index, key) {
  let total = 0
  let hit = false
  for (const series of seriesList) {
    const n = series[index]?.metrics?.[key]
    if (Number.isFinite(n)) {
      total += n
      hit = true
    }
  }
  return hit ? total : NaN
}

/** 逐周表格某格相对上一周的好坏 */
export function trendTone(metric, series, i) {
  if (i === 0) return ''
  const d = deltaOf(metric, series[i].metrics[metric.key], series[i - 1].metrics[metric.key])
  return d ? d.tone : ''
}

export const CHART = { width: 520, height: 150, pad: { top: 16, right: 12, bottom: 24, left: 12 } }

/** 柱 = 周销量，折线 = 毛利润；毛利润有负数时画 0 线 */
export function chartOf(series, { width, height, pad } = CHART) {
  const n = series.length
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const x = (i) => pad.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1))

  const maxSales = Math.max(1, ...series.map((s) => s.metrics.sales).filter(Number.isFinite))
  const profitFinite = series.map((s) => s.metrics.profit).filter(Number.isFinite)
  const pMin = Math.min(0, ...profitFinite)
  const pMax = Math.max(1, ...profitFinite)

  const barW = Math.min(28, (innerW / Math.max(n, 1)) * 0.5)
  const bars = series.map((s, i) => {
    const v = Number.isFinite(s.metrics.sales) ? s.metrics.sales : 0
    const h = (v / maxSales) * innerH
    return { x: x(i) - barW / 2, y: pad.top + innerH - h, w: barW, h, label: s.weekId, value: v }
  })

  const py = (v) => pad.top + innerH - ((v - pMin) / (pMax - pMin)) * innerH
  const points = series
    .map((s, i) => (Number.isFinite(s.metrics.profit) ? { x: x(i), y: py(s.metrics.profit), v: s.metrics.profit } : null))
    .filter(Boolean)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const zeroY = pMin < 0 ? py(0) : null
  const labels = series.map((s, i) => ({ x: x(i), text: s.weekId }))
  return { bars, points, path, zeroY, labels }
}
