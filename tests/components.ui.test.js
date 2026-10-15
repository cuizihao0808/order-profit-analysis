import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import FilterChip from '../src/components/FilterChip.vue'
import PlanDetail from '../src/components/PlanDetail.vue'
import PlanOverview from '../src/components/PlanOverview.vue'
import TrendPanel from '../src/components/TrendPanel.vue'
import { buildShippingSummary } from '../src/lib/replenishmentPlan.js'
import { buildSeries } from '../src/lib/trendMetrics.js'

const global = { plugins: [ElementPlus] }

const PLAN = {
  shop: 'TZH',
  file: 'TZH补货清单.csv',
  updatedAt: '2026-10-10T04:00:00.000Z',
  labels: { emergency: '10/24海运是否带应急量', lateGap: '', postHolidayRef: '' },
  batches: [
    { key: '10/10', date: '2026-10-10', note: '仅现货' },
    { key: '10/17', date: '2026-10-17', note: '' },
    { key: '10/24', date: '2026-10-24', note: '' },
  ],
  weekly: { amount: { '10/10': 100, '10/17': 200 }, weight: { '10/10': 1.5 } },
  weeklyNotes: { amount: '无采购成本的SKU未计入' },
  items: [
    {
      sku: 'T1',
      asin: 'B0T1',
      qtyByBatch: { '10/10': 10, '10/17': 20 },
      preHolidayTotal: 30,
      postHolidayRef: 5,
      amount: 1200,
      weight: 3.5,
      available: 2,
      inbound: 975,
      dailyDemand: '基线 12.9',
      lateGap: '',
      emergency: '有必要（缺口 40）',
      reason: '说明',
      remark: '',
    },
    { sku: 'T2', asin: 'B0T2', qtyByBatch: { '10/17': 8 }, amount: null, weight: null, emergency: '建议带 10 件' },
  ],
}

describe('FilterChip', () => {
  const options = [
    { value: '__all__', label: '全部' },
    { value: '新品', label: '新品' },
  ]

  it('shows the current value, highlights a non-default pick and clears it', async () => {
    const wrapper = mount(FilterChip, { global, props: { label: '分类', options, modelValue: '__all__' } })
    expect(wrapper.text()).toContain('分类全部')
    expect(wrapper.find('.filter-chip').classes()).not.toContain('on')

    wrapper.findComponent({ name: 'ElDropdown' }).vm.$emit('command', '新品')
    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['新品'])

    await wrapper.setProps({ modelValue: '新品' })
    expect(wrapper.find('.filter-chip').classes()).toContain('on')
    await wrapper.find('.filter-chip-clear').trigger('click')
    expect(wrapper.emitted('update:modelValue')[1]).toEqual(['__all__'])

    await wrapper.setProps({ modelValue: '已删除的值' })
    expect(wrapper.text()).toContain('分类全部')
  })
})

describe('PlanDetail', () => {
  const summary = buildShippingSummary(PLAN, { B0T1: { '2026-10-10': 't' } }, '2026-10-14')

  function mountDetail(item = PLAN.items[0], extra = {}) {
    return mount(PlanDetail, {
      global,
      props: {
        plan: PLAN,
        item,
        summary: summary.items[item.sku],
        batches: summary.batches,
        isShipped: (date) => date === '2026-10-10' && item.sku === 'T1',
        shippedAt: (date) => (date === '2026-10-10' ? '2026-10-10T08:00:00.000Z' : ''),
        ...extra,
      },
    })
  }

  it('lists the planned batches with shipped / overdue state and emits toggles', async () => {
    const wrapper = mountDetail()
    const chips = wrapper.findAll('.pd-batch')
    expect(chips.map((c) => c.find('.pd-batch-key').text())).toEqual(['10/10', '10/17'])
    expect(chips[0].classes()).toContain('shipped')
    expect(chips[0].attributes('title')).toContain('已于 2026-10-10')
    expect(chips[1].classes()).not.toContain('overdue')
    expect(chips[1].attributes('title')).toContain('点击标记已发货')
    await chips[1].trigger('click')
    expect(wrapper.emitted('toggle')[0][0].key).toBe('10/17')
  })

  it('labels the inventory as of the plan file date and shows the CSV details', () => {
    const text = mountDetail().text()
    expect(text).toContain('生成时可用 / 在途（截至 2026-10-10）')
    expect(text).toContain('2 / 975')
    expect(text).toContain('¥1,200')
    expect(text).toContain('已发 10 / 30 件')
    expect(mountDetail().find('.pd-tag-red').exists()).toBe(true)
  })

  it('handles items without amounts, overdue batches and plans without a date', () => {
    const late = buildShippingSummary(PLAN, {}, '2026-10-20')
    const wrapper = mount(PlanDetail, {
      global,
      props: {
        plan: { ...PLAN, updatedAt: '' },
        item: PLAN.items[1],
        summary: late.items.T2,
        batches: late.batches,
        isShipped: () => false,
        shippedAt: () => '',
      },
    })
    expect(wrapper.find('.pd-batch').classes()).toContain('overdue')
    expect(wrapper.text()).toContain('截至 —')
    expect(wrapper.find('.pd-tag-amber').exists()).toBe(true)
    expect(wrapper.text()).toContain('采购金额参考—')

    const empty = mount(PlanDetail, {
      global,
      props: { plan: PLAN, item: { ...PLAN.items[1], qtyByBatch: {}, emergency: '' }, isShipped: () => false, shippedAt: () => '' },
    })
    expect(empty.text()).toContain('没有批次')
  })
})

describe('PlanOverview', () => {
  function mountOverview(today, shipped = {}, extra = {}) {
    return mount(PlanOverview, {
      global,
      props: {
        plans: [PLAN, { ...PLAN, shop: 'LPH' }],
        plan: PLAN,
        summary: buildShippingSummary(PLAN, shipped, today),
        warnings: ['旧文件已忽略'],
        today,
        shop: 'TZH',
        batch: '',
        rowFilter: 'all',
        shopLabel: (code) => `${code}-店`,
        ...extra,
      },
    })
  }

  it('summarises the plan and describes the next batch', () => {
    const wrapper = mountOverview('2026-10-14', { B0T1: { '2026-10-10': 't' } })
    const text = wrapper.text()
    expect(text).toContain('TZH-店')
    expect(text).toContain('旧文件已忽略')
    expect(text).toContain('生成于 2026-10-10')
    expect(text).toContain('完成 26%')
    expect(text).toContain('还有 3 天 · 28 件待发')
    expect(text).toContain('¥1,200')
    expect(wrapper.findAll('.po-batch').map((b) => b.find('.po-batch-status').text())).toEqual(['已发货', '待发货', '无计划'])

    const firstShipped = { B0T1: { '2026-10-10': 't' } }
    expect(mountOverview('2026-10-17', firstShipped).text()).toContain('今天发货')
    expect(mountOverview('2026-10-20', firstShipped).text()).toContain('已逾期 3 天')
    const all = { B0T1: { '2026-10-10': 't', '2026-10-17': 't' }, B0T2: { '2026-10-17': 't' } }
    expect(mountOverview('2026-10-20', all).text()).toContain('全部已发完')
    const partial = mountOverview('2026-10-20', { B0T1: { '2026-10-10': 't', '2026-10-17': 't' } })
    expect(partial.findAll('.po-batch-status').map((s) => s.text())).toContain('逾期 1/2')
    expect(mountOverview('2026-10-12', { B0T1: { '2026-10-17': 't' } }).findAll('.po-batch-status')[1].text()).toBe('已发 1/2')
  })

  it('selects a batch, emits batch actions and switches shops', async () => {
    const wrapper = mountOverview('2026-10-14')
    await wrapper.findAll('.po-batch')[1].trigger('click')
    expect(wrapper.emitted('update:batch')[0]).toEqual(['10/17'])

    await wrapper.setProps({ batch: '10/17', rowFilter: 'batch' })
    const buttons = () => wrapper.findAll('.po-batch-bar button')
    expect(wrapper.find('.po-batch-bar').text()).toContain('10/17 批次')
    await buttons().find((b) => b.text() === '复制本批清单').trigger('click')
    expect(wrapper.emitted('copy')[0][0].key).toBe('10/17')
    await buttons().find((b) => b.text() === '整批标记已发货').trigger('click')
    expect(wrapper.emitted('mark')[0].slice(1)).toEqual([true])

    // 取消选择时一并退出“仅所选批次”
    await buttons().find((b) => b.text() === '取消选择').trigger('click')
    expect(wrapper.emitted('update:batch').at(-1)).toEqual([''])
    expect(wrapper.emitted('update:rowFilter').at(-1)).toEqual(['all'])

    await wrapper.findAll('.po-shop-btn')[1].trigger('click')
    expect(wrapper.emitted('update:shop')[0]).toEqual(['LPH'])
  })

  it('offers undo when part of the batch is shipped, and collapses the summary', async () => {
    const wrapper = mountOverview('2026-10-14', { B0T1: { '2026-10-17': 't' } }, { batch: '10/17' })
    const undo = wrapper.findAll('.po-batch-bar button').find((b) => b.text() === '撤销本批已发货')
    await undo.trigger('click')
    expect(wrapper.emitted('mark')[0].slice(1)).toEqual([false])

    await wrapper.findAll('.po-bar button').find((b) => b.text() === '收起汇总').trigger('click')
    expect(wrapper.emitted('update:collapsed')[0]).toEqual([true])
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.find('.po-kpis').exists()).toBe(false)

    const noPlan = mount(PlanOverview, { global, props: { plans: [], plan: null, summary: null } })
    expect(noPlan.text()).toContain('还没有补货清单')
  })
})

describe('TrendPanel', () => {
  const COLUMNS = ['ASIN', '店铺', '销量', '销售额', '毛利润', '广告费率', '采购成本', '退款率']
  const week = (id, values, note) => ({
    id,
    startDate: '2026-09-01',
    endDate: '2026-09-07',
    columns: COLUMNS,
    rows: values ? [{ asin: 'B0A', values: ['B0A', 'TZH', ...values] }] : [],
    notes: note ? { B0A: note } : {},
  })
  const series = buildSeries(
    [week('39周', ['10', '100', '20', '5%', '-50', '1%'], '10整箱'), week('40周', null), week('41周', ['12', '120', '-5', '18%', '-50', '0%'])],
    'TZH',
    'B0A',
  )

  it('shows KPIs with alerts, the chart, notes and the weekly table', () => {
    const wrapper = mount(TrendPanel, { global, props: { series } })
    const kpis = wrapper.findAll('.trend-kpi')
    expect(kpis[0].text()).toContain('12')
    expect(kpis[0].text()).toContain('+20.0%')
    expect(kpis[2].find('.trend-kpi-value').classes()).toContain('trend-bad')
    expect(wrapper.findAll('rect.chart-bar')).toHaveLength(3)
    expect(wrapper.find('.chart-zero').exists()).toBe(true)
    expect(wrapper.find('.trend-notes').text()).toContain('39周10整箱')
    expect(wrapper.findAll('.trend-table thead th')).toHaveLength(4)
    expect(wrapper.find('.trend-table tbody').text()).toContain('—')
  })

  it('shows loading, no-data and no-notes states', () => {
    expect(mount(TrendPanel, { global, props: { series: [], loading: true } }).text()).toContain('正在加载')
    const none = buildSeries([week('41周', null)], 'TZH', 'B0A')
    expect(mount(TrendPanel, { global, props: { series: none } }).text()).toContain('都没有这个 ASIN')
    const quiet = buildSeries([week('41周', ['1', '1', '1', '0%', '-1', '0%'])], 'TZH', 'B0A')
    const wrapper = mount(TrendPanel, { global, props: { series: quiet } })
    expect(wrapper.text()).toContain('最近几周没有备注')
    expect(wrapper.findAll('.trend-kpi-delta.muted').length).toBeGreaterThan(0)
  })
})

describe('writeClipboard', () => {
  it('falls back to a hidden textarea when the Clipboard API is unavailable', async () => {
    const { writeClipboard } = await import('../src/utils/clipboard.js')
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    let copied = ''
    document.execCommand = (cmd) => {
      copied = cmd === 'copy' ? document.activeElement?.value ?? document.querySelector('textarea')?.value : ''
      return true
    }
    await writeClipboard('B0A1\nB0B1')
    expect(copied).toBe('B0A1\nB0B1')
    expect(document.querySelector('textarea')).toBeNull()

    const writeText = async (text) => {
      copied = `api:${text}`
    }
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await writeClipboard('B0C1')
    expect(copied).toBe('api:B0C1')
    if (original) Object.defineProperty(navigator, 'clipboard', original)
  })
})
