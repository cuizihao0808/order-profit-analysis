import { describe, expect, it } from 'vitest'
import {
  buildClipboardTableHtml,
  buildClipboardTableText,
  buildHeaderGroups,
  ensureColumnsOrder,
  flattenGroups,
  groupByParent,
  isRestockQty,
  matchesSupplyFilter,
  mergeColumnConfig,
  moveItem,
  normalizeAsinKey,
  progressView,
  restockTitle,
  restockView,
  sortGroupsBy,
  suggestedView,
  toFullWidth,
} from '../src/lib/tableView.js'

const names = (cols) => cols.map((c) => c.name)
const cols = (...list) => list.map((name) => ({ name, visible: true }))

describe('column config', () => {
  it('keeps monthly metrics after 周销量, rates after 广告费率 and 备注 last', () => {
    const ordered = ensureColumnsOrder(cols('月销量', '备注', '采购成本', '销量', '退款率', 'ROI', '广告费率', '退货率', '日均销量'))
    expect(names(ordered)).toEqual(['采购成本', '销量', '月销量', '日均销量', 'ROI', '广告费率', '退货率', '退款率', '备注'])
  })

  it('falls back to ROI, then to the end, when 广告费率 is hidden from the config', () => {
    expect(names(ensureColumnsOrder(cols('退款率', 'ROI', '毛利润')))).toEqual(['ROI', '退款率', '毛利润'])
    expect(names(ensureColumnsOrder(cols('退货率', '毛利润')))).toEqual(['毛利润', '退货率'])
    expect(ensureColumnsOrder(null)).toEqual([])
  })

  it('uses defaults on first load and appends new columns hidden', () => {
    const merged = mergeColumnConfig(['销量', '毛利润', '标题', '备注'], [], ['毛利润', '销量', '不存在'])
    expect(merged).toEqual([
      { name: '毛利润', visible: true },
      { name: '销量', visible: true },
      { name: '标题', visible: false },
      { name: '备注', visible: false },
    ])
  })

  it('keeps stored order and visibility, drops unknown and duplicate entries', () => {
    const stored = [
      { name: '标题', visible: true },
      { name: '旧列', visible: true },
      { name: '销量', visible: false },
      { name: '标题', visible: false },
      null,
      { visible: true },
    ]
    const merged = mergeColumnConfig(['销量', '毛利润', '标题'], stored, ['毛利润'])
    expect(merged).toEqual([
      { name: '标题', visible: true },
      { name: '销量', visible: false },
      { name: '毛利润', visible: true },
    ])
    expect(mergeColumnConfig(['销量'], 'bad', [])).toEqual([{ name: '销量', visible: false }])
  })

  it('moves an item one step and ignores moves past either end', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    const list = ['a', 'b']
    expect(moveItem(list, 0, -1)).toBe(list)
    expect(moveItem(list, 1, 1)).toBe(list)
    expect(moveItem(list, 5, -1)).toBe(list)
  })
})

describe('supply filter', () => {
  it('recognises a real restock quantity', () => {
    expect(isRestockQty('320')).toBe(true)
    expect(['', null, undefined, '无需补货', '停滞-人工', 'abc'].some(isRestockQty)).toBe(false)
  })

  it('matches each supply option', () => {
    const urgent = { localWarehouse: 0, orderedQty: '', needRestock: true }
    const handled = { localWarehouse: '12', orderedQty: 30, needRestock: true }
    const fine = { localWarehouse: null, orderedQty: 0, needRestock: false }
    const pick = (filter) => [urgent, handled, fine].map((r) => matchesSupplyFilter(filter, r))
    expect(pick('need-restock')).toEqual([true, true, false])
    expect(pick('no-restock')).toEqual([false, false, true])
    expect(pick('ordered')).toEqual([false, true, false])
    expect(pick('local-warehouse')).toEqual([false, true, false])
    expect(pick('need-restock-no-local-no-ordered')).toEqual([true, false, false])
    expect(pick('__all__')).toEqual([true, true, true])
  })
})

describe('grouping', () => {
  const row = (asin, parent, profit, packing = 'mixed') => ({ asin, parent, profit, packing })
  const get = {
    parentKey: (r) => normalizeAsinKey(r.parent || r.asin),
    profit: (r) => r.profit,
    packingMode: (r) => r.packing,
  }

  it('groups children under the parent row and sorts by profit, full cartons first', () => {
    const groups = groupByParent(
      [
        row('c1', 'P', 5),
        row('P', 'P', 1),
        row('c2', 'p', 50),
        row('solo', '', 100),
        row('box', 'B', -10, 'full'),
        row('nan', 'N', NaN),
        row('', '', 0),
      ],
      get,
    )
    expect(groups.map((g) => g.key)).toEqual(['B', 'SOLO', 'P', 'N'])
    const p = groups.find((g) => g.key === 'P')
    expect(p.header.asin).toBe('P')
    expect(p.children.map((r) => r.asin)).toEqual(['c2', 'c1'])
  })

  it('falls back to the best row as header when the parent itself is missing', () => {
    const [g] = groupByParent([row('a', 'X', 1), row('b', 'X', 9)], get)
    expect(g.header.asin).toBe('b')
    expect(g.children.map((r) => r.asin)).toEqual(['a'])
  })

  it('hides the parent row of multi-member groups when flattening', () => {
    const groups = groupByParent([row('P', 'P', 1), row('c1', 'P', 2), row('solo', '', 3)], get)
    expect(flattenGroups(groups).map((x) => [x.row.asin, x.isGroupHead, x.groupSize])).toEqual([
      ['solo', true, 1],
      ['c1', true, 1],
    ])
    // 只有父体一行时照常显示
    expect(flattenGroups([{ key: 'P', header: row('P', 'P', 1), children: [row('p', 'P', 0)] }]).map((x) => x.row.asin)).toEqual(['P', 'p'])
  })

  it('re-sorts groups by the smallest member key, keeping ties stable', () => {
    const g = (key, ...members) => ({ key, header: { k: members[0] }, children: members.slice(1).map((k) => ({ k })) })
    const list = [g('A', 'z'), g('B', '2', 'y'), g('C', 'z'), g('D', '1')]
    expect(sortGroupsBy(list, (r) => r.k).map((x) => x.key)).toEqual(['D', 'B', 'A', 'C'])
  })
})

describe('header and cells', () => {
  it('merges adjacent columns of the same group and skips fixed columns', () => {
    const groupOf = { 销量: '销售', 月销量: '销售', 毛利润: '利润', ROI: '利润' }
    const display = [
      { name: '品名', fixed: true },
      { name: '销量' },
      { name: '月销量' },
      { name: '标题' },
      { name: '备注' },
      { name: '毛利润' },
      { name: 'ROI' },
    ]
    expect(buildHeaderGroups(display, groupOf)).toEqual([
      { name: '销售', span: 2, first: '销量' },
      { name: '', span: 1, first: '标题' },
      { name: '', span: 1, first: '备注' },
      { name: '利润', span: 2, first: '毛利润' },
    ])
  })

  it('describes the suggested restock by urgency', () => {
    const pending = (inDays) => ({ state: 'pending', qty: 200, batch: '10/17', inDays })
    expect(suggestedView(pending(3), true)).toEqual({ qty: '200 件', sub: '3 天后 · 10/17', tone: 'soon' })
    expect(suggestedView(pending(0), true).sub).toBe('今天 · 10/17')
    expect(suggestedView(pending(-2), true)).toEqual({ qty: '200 件', sub: '逾期 2 天 · 10/17', tone: 'bad' })
    expect(suggestedView(pending(20), true)).toEqual({ qty: '200 件', sub: '10/17', tone: '' })
    expect(suggestedView(pending(null), true).tone).toBe('')
    expect(suggestedView({ state: 'done' }, true)).toEqual({ qty: '', sub: '已发完', tone: 'done' })
    expect(suggestedView({ state: 'none' }, true).sub).toBe('计划不补')
    expect(suggestedView(null, false).sub).toBe('')
  })

  it('reports batch progress', () => {
    expect(progressView({ shippedQty: 200, plannedQty: 1600 })).toEqual({ text: '200 / 1,600', pct: 12.5 })
    expect(progressView({ shippedQty: 0, plannedQty: 0 })).toBeNull()
    expect(progressView(null)).toBeNull()
  })

  const decision = (over = {}) => ({
    text: '480',
    qty: 480,
    monthly: 478.5,
    position: 731,
    threshold: 1659.5,
    coverMonths: 731 / 478.5,
    flags: ['爆量', '断货周', '新品'],
    basis: {
      vineAdjusted: true,
      surge: true,
      isNew: true,
      weeksOnSale: 4,
      stockoutWeeks: ['36周', '37周'],
      smoothedMonthly: 478.5,
      recentMonthly: 400,
    },
    parts: { fbaTotal: 731, localWarehouse: 0, orderedQty: 0, cycleWeeks: 1 },
    ...over,
  })

  it('shows the static restock quantity with monthly sales, coverage and review flags only', () => {
    expect(restockView(decision())).toEqual({
      qty: '480',
      boxes: '',
      status: '',
      sub: '月销 479 · 覆盖 1.5 月',
      subParts: ['月销 479', '覆盖 1.5 月'],
      flags: ['爆量'],
    })
    expect(restockView(decision({ text: '无需补货', qty: null })).status).toBe('')
    expect(restockView(decision({ text: '360', qty: 360, boxes: 9 })).boxes).toBe('（9箱）')
    expect(restockView(decision({ text: '停滞-人工', qty: null, monthly: 0 }))).toMatchObject({ status: '停滞-人工', sub: '近 4 周没有销量' })
    expect(restockView({ text: '' })).toBeNull()
    expect(restockView(null)).toBeNull()
  })

  it('explains how the static restock was worked out', () => {
    const title = restockTitle(decision(), { coverMonths: 3 })
    expect(title).toContain('月销 479 件（指数平滑周销 × 30/7，已扣 Vine）')
    expect(title).toContain('库存位置 731 = FBA 731 + 本地仓 0 + 已下单 0')
    expect(title).toContain('阈值 1,660 = 3 个月 + 补货用时 1 周')
    expect(title).toContain('爆量')
    expect(title).toContain('近 8 周断货周：36周、37周（没有剔除）')
    expect(title).toContain('新品：出单 4 周')
    expect(title).not.toContain('下滑')
    expect(title.split('\n').at(-1)).toBe('只做预警，实际发货以「建议补货」为准')
    const declining = restockTitle(decision({ basis: { declining: true, recentMonthly: 740, smoothedMonthly: 892 } }))
    expect(declining).toContain('下滑：近 4 周均折月 740，比平滑值 892 低，按低的算')
    expect(restockTitle({ text: '' })).toContain('算不出静态补货')
  })
})

describe('clipboard tables', () => {
  it('converts to full-width characters so plain-text columns line up', () => {
    expect(toFullWidth('20×15 cm—1')).toBe('２０ｘ１５　ｃｍ－１')
  })

  it('pads every column to the same width', () => {
    const text = buildClipboardTableText(['尺寸', '数量'], [['20×15', 3], ['8', 120]])
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1)
    expect(lines[1]).toBe('－－－－－＋－－－')
  })

  it('escapes HTML in the rich-text table', () => {
    const html = buildClipboardTableHtml(['a<b'], [['x & "y"']])
    expect(html).toContain('<th style="border:1px solid #999;padding:4px 8px;background:#f0f0f0;font-weight:bold;">a&lt;b</th>')
    expect(html).toContain('x &amp; &quot;y&quot;')
  })
})
