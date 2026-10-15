import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asins, createApi, mountApp, rowOf, settle, stubBrowser } from './helpers/appHarness.js'

// 重点关注配置用测试数据，不读仓库里的真实清单
vi.mock('../src/data/focusProducts.json', () => ({ default: { 'shop-2': ['B0B1', 'B0A1'], 'shop-1': [] } }))

let api
let browser

beforeEach(() => {
  api = createApi()
  browser = stubBrowser(api)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ASIN 工作台', () => {
  it('shows only the latest week, grouped by parent, without abandoned ASINs', async () => {
    const wrapper = await mountApp()
    expect(wrapper.find('.latest-week-tag').text()).toBe('最新周 2周 · 10/04–10/10')
    // 父组按毛利润排序；放弃的 B0D1 不显示
    expect(asins(wrapper)).toEqual(['B0C1', 'B0A1', 'B0A2', 'B0B1'])
    expect(wrapper.find('.result-count').text()).toBe('3 个父组 · 4 个 ASIN')
    // 只请求了最新一周，趋势还没打开
    expect(api.requests.map((r) => r.path)).not.toContain('/api/weeks/1周')
    wrapper.unmount()
  })

  it('renders alerts, restock badges and the suggested batch', async () => {
    const wrapper = await mountApp()
    const a1 = rowOf(wrapper, 'B0A1')
    expect(a1.classes()).toContain('row-need-restock')
    expect(a1.find('.focus-star').exists()).toBe(true)
    expect(a1.find('.shop-code').text()).toBe('TZH')
    expect(a1.find('.v-amber').text()).toBe('80')
    expect(a1.findAll('.v-bad').map((c) => c.text())).toContain('20%')
    expect(a1.find('.suggest-cell').text()).toBe('30 件3 天后 · 10/17')
    expect(a1.find('.suggest-cell').attributes('title')).toContain('下一批 2026-10-17，3 天后')
    expect(a1.find('.progress-cell small').text()).toBe('0 / 50')

    const b1 = rowOf(wrapper, 'B0B1')
    expect(b1.findAll('.v-bad').map((c) => c.text())).toEqual(['-5', '-0.50'])
    expect(b1.find('.suggest-cell').text()).toBe('8 件10/24')
    expect(rowOf(wrapper, 'B0A2').find('.suggest-cell').text()).toBe('计划不补')
    expect(rowOf(wrapper, 'B0C1').find('.suggest-cell').exists()).toBe(false)
    wrapper.unmount()
  })

  it('switches between all, focus and plan views', async () => {
    const wrapper = await mountApp()
    const switchTo = async (value) => {
      await wrapper.findAll('.view-switch .el-radio-button__original-radio').find((r) => r.element.value === value).setValue(true)
      await settle()
    }

    await switchTo('focus')
    expect(asins(wrapper)).toEqual(['B0B1', 'B0A1'])
    expect(wrapper.find('.focus-bar').text()).toContain('周销量合计')
    expect(localStorage.getItem('opa:view:v1')).toBe('focus')
    await wrapper.findAll('.focus-bar button').find((b) => b.text() === '一键导出ASIN').trigger('click')
    await settle()
    expect(browser.writeText).toHaveBeenLastCalledWith('B0B1\nB0A1')

    await switchTo('plan')
    expect(asins(wrapper)).toEqual(['B0A1', 'B0A2', 'B0B1']) // B0A2 与 B0A1 同父组，跟着置顶
    expect(wrapper.find('.po').text()).toContain('TZH-主店二号')
    expect(wrapper.findAll('.filter-chip').map((c) => c.find('.filter-chip-label').text())).not.toContain('店铺')

    await switchTo('all')
    expect(asins(wrapper)).toHaveLength(4)
    wrapper.unmount()
  })

  it('filters by search text across ASIN and product name', async () => {
    const wrapper = await mountApp()
    await wrapper.find('.top-search input').setValue('垫高')
    expect(asins(wrapper)).toEqual(['B0A1', 'B0A2'])
    await wrapper.find('.filter-reset').trigger('click')
    expect(asins(wrapper)).toHaveLength(4)
    wrapper.unmount()
  })

  it('expands a row into inventory, trend and plan tabs and marks a batch shipped', async () => {
    const wrapper = await mountApp()
    // 点勾选框不展开，点行里的空白单元格才展开
    await rowOf(wrapper, 'B0A1').find('.select-col input').trigger('click')
    expect(wrapper.find('.inventory-detail-grid').exists()).toBe(false)
    await rowOf(wrapper, 'B0A1').find('td.num').trigger('click')
    const tabs = () => wrapper.findAll('.detail-tab')
    expect(tabs().map((t) => t.text())).toEqual(['库存详情', '8 周趋势', '补货批次'])
    expect(wrapper.find('.inventory-detail-grid').text()).toContain('静态补货80')

    await tabs()[1].trigger('click')
    await settle()
    expect(wrapper.find('.trend-panel').text()).toContain('+100.0%')
    expect(wrapper.find('.trend-notes').text()).toContain('2周10整箱')

    await tabs()[2].trigger('click')
    await wrapper.find('.pd-batch').trigger('click')
    await settle()
    expect(api.calls('PUT', '/api/replenishment/shipped')[0].entries).toEqual([{ asin: 'B0A1', date: '2026-10-17' }])
    expect(rowOf(wrapper, 'B0A1').find('.suggest-cell').text()).toBe('20 件10/24')

    // 没有补货计划的行，补货批次 Tab 不可用，自动退回库存详情
    await rowOf(wrapper, 'B0C1').find('td.num').trigger('click')
    expect(tabs()[2].attributes('disabled')).toBeDefined()
    expect(wrapper.find('.inventory-detail-grid').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows the batch bar only while rows are selected', async () => {
    const wrapper = await mountApp()
    expect(wrapper.find('.selbar').exists()).toBe(false)
    await rowOf(wrapper, 'B0A1').find('input[type=checkbox]').setValue(true)
    await rowOf(wrapper, 'B0B1').find('input[type=checkbox]').setValue(true)
    expect(wrapper.find('.selbar').text()).toContain('已选 2 个 ASIN')

    await wrapper.findAll('.selbar-btn').find((b) => b.text() === '复制 ASIN').trigger('click')
    await settle()
    expect(browser.writeText).toHaveBeenCalledWith('B0A1\nB0B1')

    await wrapper.find('.selbar-close').trigger('click')
    expect(wrapper.find('.selbar').exists()).toBe(false)
    wrapper.unmount()
  })
})
