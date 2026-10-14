import { describe, expect, it } from 'vitest'
import {
  METRIC_BY_KEY,
  buildSeries,
  chartOf,
  deltaOf,
  findWeekRow,
  fmtMetric,
  fmtNum,
  latestKpis,
  sumMetric,
  trendTone,
} from '../src/lib/trendMetrics.js'

const COLUMNS = ['ASIN', '店铺', '销量', '销售额', '毛利润', '毛利率', '平均售价', '广告花费', '广告费率', '广告销量', '采购成本', '退款率']

function week(id, rows, notes = {}) {
  return { id, startDate: `2026-09-${id}`, endDate: `2026-10-${id}`, columns: COLUMNS, rows, notes }
}
function row(asin, shop, [sales, revenue, profit, cost]) {
  return { asin, values: [asin, shop, sales, revenue, profit, '20%', '25', '-12', '8%', '2', cost, '1%'] }
}

const W1 = week('01', [row('B0A', 'TZH-主店二号', ['10', '250', '50', '-100'])], { B0A: '首周' })
const W2 = week('02', [row('B0B', 'TZH-主店二号', ['1', '1', '1', '-1'])])
const W3 = week('03', [
  row('B0A', 'LPH-主店三号', ['99', '99', '99', '-99']),
  row('B0A', 'TZH-主店二号', ['20', '500', '-30', '-120']),
])

describe('formatting', () => {
  it('formats numbers, money, percents and ratios', () => {
    expect(fmtNum(1234.5, 1)).toBe('1,234.5')
    expect(fmtNum(NaN)).toBe('—')
    expect(fmtMetric(METRIC_BY_KEY.revenue, -12.5)).toBe('-$12.50')
    expect(fmtMetric(METRIC_BY_KEY.margin, 20)).toBe('20.00%')
    expect(fmtMetric(METRIC_BY_KEY.roi, 0.123456)).toBe('0.12')
    expect(fmtMetric(METRIC_BY_KEY.sales, 1500)).toBe('1,500')
    expect(fmtMetric(METRIC_BY_KEY.sales, NaN)).toBe('—')
  })

  it('describes week-on-week change by metric kind', () => {
    expect(deltaOf(METRIC_BY_KEY.sales, 20, 10)).toEqual({ text: '+100.0%', tone: 'good', arrow: '▲' })
    expect(deltaOf(METRIC_BY_KEY.adSpend, 20, 10).tone).toBe('bad')
    expect(deltaOf(METRIC_BY_KEY.margin, 18, 20).text).toBe('-2.00pp')
    expect(deltaOf(METRIC_BY_KEY.roi, 1.5, 1).text).toBe('+0.50')
    expect(deltaOf(METRIC_BY_KEY.sales, 5, 0).text).toBe('新增')
    expect(deltaOf(METRIC_BY_KEY.sales, 0, 0)).toEqual({ text: '0%', tone: 'flat', arrow: '' })
    expect(deltaOf(METRIC_BY_KEY.sales, NaN, 1)).toBeNull()
  })
})

describe('series', () => {
  it('matches rows by shop and ASIN only', () => {
    expect(findWeekRow(W3, 'TZH-主店二号', 'B0A').values[2]).toBe('20')
    expect(findWeekRow(W3, 'CZH-主店一号', 'B0A')).toBeNull()
    expect(findWeekRow({ columns: ['ASIN'], rows: [{ asin: 'B0A', values: ['B0A'] }] }, 'x', 'B0A')).not.toBeNull()
    expect(findWeekRow(null, 'x', 'B0A')).toBeNull()
  })

  it('builds one point per week with metrics, gaps and notes', () => {
    const series = buildSeries([W1, W2, W3], 'TZH-主店二号', 'B0A')
    expect(series.map((s) => s.hasData)).toEqual([true, false, true])
    expect(series[0]).toMatchObject({ weekId: '01', range: '09-01~10-01', note: '首周' })
    expect(series[0].metrics).toMatchObject({ sales: 10, revenue: 250, profit: 50, adSpend: 12, adShare: 20, roi: 0.5 })
    expect(series[1].metrics.sales).toBeNaN()
    expect(series[2].metrics.roi).toBeCloseTo(-0.25)
  })

  it('compares the latest week with data to the previous one', () => {
    const series = buildSeries([W1, W2, W3], 'TZH-主店二号', 'B0A')
    const [sales, , profit] = latestKpis(series)
    expect(sales).toMatchObject({ key: 'sales', value: '20', delta: { text: '+100.0%' } })
    expect(profit).toMatchObject({ raw: -30, alertCol: '毛利润' })
    expect(latestKpis([], ['sales'])[0]).toMatchObject({ value: '—', delta: null })
  })

  it('sums a metric across ASINs and colours trend cells', () => {
    const a = buildSeries([W1, W3], 'TZH-主店二号', 'B0A')
    const b = buildSeries([W1, W3], 'LPH-主店三号', 'B0A')
    expect(sumMetric([a, b], 1, 'sales')).toBe(119)
    expect(sumMetric([b], 0, 'sales')).toBeNaN()
    expect(trendTone(METRIC_BY_KEY.sales, a, 0)).toBe('')
    expect(trendTone(METRIC_BY_KEY.sales, a, 1)).toBe('good')
    expect(trendTone(METRIC_BY_KEY.sales, b, 1)).toBe('')
  })
})

describe('chartOf', () => {
  it('scales bars to sales and draws a zero line for losses', () => {
    const chart = chartOf(buildSeries([W1, W2, W3], 'TZH-主店二号', 'B0A'))
    expect(chart.bars).toHaveLength(3)
    expect(chart.bars[2].h).toBeGreaterThan(chart.bars[0].h)
    expect(chart.bars[1].h).toBe(0)
    expect(chart.points).toHaveLength(2)
    expect(chart.path.startsWith('M')).toBe(true)
    expect(chart.zeroY).not.toBeNull()
    expect(chart.labels.map((l) => l.text)).toEqual(['01', '02', '03'])
  })

  it('centres a single point and skips the zero line without losses', () => {
    const chart = chartOf(buildSeries([W1], 'TZH-主店二号', 'B0A'))
    expect(chart.points[0].x).toBe(chart.labels[0].x)
    expect(chart.zeroY).toBeNull()
  })
})
