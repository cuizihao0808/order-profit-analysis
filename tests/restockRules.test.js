import { describe, expect, it } from 'vitest'
import { restockConfig } from '../src/data/restockConfig.js'
import {
  DEFAULT_RESTOCK_CONFIG,
  buildRestockBasis,
  collectRestockHistories,
  decideRestock,
  hasRestockColumns,
  roundShipQty,
  vineShareOf,
} from '../src/lib/restockRules.js'

const MONTH = 30 / 7
const hist = (sales, extra = {}) =>
  sales.map((s, i) => ({ week: extra.weeks?.[i] ?? `${i + 1}周`, sales: s, vineShare: extra.vine?.[i] ?? 0, sellable: extra.sellable?.[i] ?? null }))

describe('restockRules: config', () => {
  it('keeps the confirmed 3-month / 1-month rule and the 41周 event week', () => {
    expect({ ...DEFAULT_RESTOCK_CONFIG, ...restockConfig }).toMatchObject({ coverMonths: 3, shipMonths: 1, eventWeeks: ['41周'] })
  })
})

describe('restockRules: vineShareOf', () => {
  it('derives the Vine share from Listing 30-day sales (already net of Vine) plus Vine units', () => {
    expect(vineShareOf(30, 10)).toBe(0.25)
    expect(vineShareOf(0, 0)).toBe(0)
    expect(vineShareOf('', 5)).toBe(1)
    expect(vineShareOf(20, '')).toBe(0)
  })
})

describe('restockRules: collectRestockHistories', () => {
  const weeks = [
    { id: '2周', startDate: '2026-10-04' },
    { id: '1周', startDate: '2026-09-27' },
    { id: '9周', startDate: '2026-12-01' }, // 没有快照的周跳过
  ]
  const columns = ['ASIN', '店铺', '销量']
  const snapshots = {
    '1周': { columns, rows: [{ asin: 'B0A', values: ['B0A', 'TZH', '4'] }] },
    '2周': {
      columns,
      rows: [
        { asin: 'B0A', values: ['B0A', 'TZH', '6'] },
        { asin: 'B0A', values: ['B0A', 'TZH', '1'] }, // 同周重复行累加
        { asin: 'B0B', values: ['B0B', 'LPH', '3'] },
        { asin: 'B0X', values: ['B0X', '未知店', '9'] },
      ],
    },
  }
  const listings = {
    '2周': [
      { asin: 'B0B', shopName: 'LPH-US', monthSales: 30, vineGiftSales: 10, sellable: 0 },
      { asin: 'B0ONLYLISTING', shopName: 'TZH', monthSales: 5, sellable: 9 },
    ],
  }
  const shopIdOf = (name) => ({ TZH: 'shop-2', LPH: 'shop-3', 'LPH-US': 'shop-3' })[name] || ''

  it('orders weeks by start date, sums duplicate rows and leaves missing weeks as null', () => {
    const out = collectRestockHistories({ weeks, snapshots, listings, shopIdOf })
    expect(Object.keys(out).sort()).toEqual(['shop-2::B0A', 'shop-3::B0B'])
    expect(out['shop-2::B0A'].map((h) => [h.week, h.sales])).toEqual([['1周', 4], ['2周', 7]])
    expect(out['shop-3::B0B'][0]).toEqual({ week: '1周', sales: null, vineShare: 0, sellable: null })
  })

  it('drops weeks whose snapshot lacks the shop or sales column instead of counting them as zero', () => {
    const broken = { ...snapshots, '2周': { columns: ['ASIN', '店铺', '销量(新)'], rows: snapshots['2周'].rows } }
    const out = collectRestockHistories({ weeks, snapshots: broken, listings, shopIdOf })
    expect(out['shop-2::B0A'].map((h) => h.week)).toEqual(['1周'])
    expect(hasRestockColumns(snapshots['1周'])).toBe(true)
    expect(hasRestockColumns({ columns: ['ASIN', '销量'] })).toBe(false)
    expect(hasRestockColumns(null)).toBe(false)
  })

  it('attaches Vine share and sellable from that week’s Listing, matching shops through aliases', () => {
    const out = collectRestockHistories({ weeks, snapshots, listings, shopIdOf })
    expect(out['shop-3::B0B'][1]).toEqual({ week: '2周', sales: 3, vineShare: 0.25, sellable: 0 })
  })
})

describe('restockRules: buildRestockBasis', () => {
  it('returns null for an ASIN that never sold', () => {
    expect(buildRestockBasis(hist([null, 0, 0]))).toBeNull()
    expect(buildRestockBasis(undefined)).toBeNull()
  })

  it('smooths weekly sales from the first selling week (0.3 × this week + 0.7 × last value)', () => {
    const b = buildRestockBasis(hist([null, 0, 10, 20, 30]))
    expect(b.weekly).toBeCloseTo(18.1)
    expect(b.monthly).toBeCloseTo(18.1 * MONTH)
    expect(b.weeksOnSale).toBe(3)
    expect(b.isNew).toBe(true)
    expect(b.declining).toBe(false)
  })

  it('counts weeks missing from the report after the first sale as zero', () => {
    expect(buildRestockBasis(hist([10, null, 10])).weekly).toBeCloseTo(0.3 * 10 + 0.7 * 7)
  })

  it('takes Vine units out of weekly sales', () => {
    const b = buildRestockBasis(hist([40, 40, 40], { vine: [0, 0, 0.25] }))
    expect(b.weekly).toBeCloseTo(37)
    expect(b.vineAdjusted).toBe(true)
  })

  it('counts an all-Vine week as zero and does not start selling on it', () => {
    // 第 2 周 Vine 占 100%：按 0 算，也不是开卖周
    const b = buildRestockBasis(hist([0, 10, 4, 10], { vine: [0, 1, 0, 0] }))
    expect(b.weeksOnSale).toBe(2)
    expect(b.weekly).toBeCloseTo(0.3 * 10 + 0.7 * 4)
    expect(buildRestockBasis(hist([4, 10], { vine: [0, 1] })).weekly).toBeCloseTo(0.7 * 4)
    expect(buildRestockBasis(hist([6, 6], { vine: [1, 1] }))).toBeNull()
  })

  it('replaces an event week with the average of the weeks around it', () => {
    const weeks = ['40周', '41周', '42周']
    const b = buildRestockBasis(hist([10, 100, 20], { weeks }))
    // 41 周按 (10+20)/2=15 算：10 → 11.5 → 14.05
    expect(b.weekly).toBeCloseTo(14.05)
  })

  it('skips the event week while it is still the latest week', () => {
    const b = buildRestockBasis(hist([10, 20, 100], { weeks: ['39周', '40周', '41周'] }))
    expect(b.weekly).toBeCloseTo(13)
  })

  it('bridges back-to-back event weeks with the nearest normal weeks on both sides', () => {
    const weeks = ['46周', '47周', '48周', '49周', '50周']
    const cfg = { eventWeeks: ['48周', '49周'] }
    expect(buildRestockBasis(hist([100, 100, 300, 250, 100], { weeks }), cfg).weekly).toBeCloseTo(100)
    expect(buildRestockBasis(hist([100, 100, 300, 250], { weeks: weeks.slice(0, 4) }), cfg).weekly).toBeCloseTo(100)
  })

  it('returns null when the only weeks since the first sale are events not usable yet', () => {
    expect(buildRestockBasis(hist([0, 80], { weeks: ['40周', '41周'] }))).toBeNull()
  })

  it('caps a declining SKU at its recent 4-week average', () => {
    const b = buildRestockBasis(hist([500, 500, 500, 500, 200, 150, 120, 90]))
    expect(b.declining).toBe(true)
    expect(b.weekly).toBeCloseTo(140)
    expect(b.smoothedMonthly).toBeGreaterThan(b.monthly)
    expect(b.recentMonthly).toBeCloseTo(140 * MONTH)
  })

  it('does not call low sellers declining', () => {
    expect(buildRestockBasis(hist([9, 9, 9, 9, 1, 1, 1, 1])).declining).toBe(false)
  })

  it('marks stalled SKUs without letting the decline cap zero them out', () => {
    const b = buildRestockBasis(hist([30, 30, 30, 30, 0, 0, 0, 0]))
    expect(b.stalled).toBe(true)
    expect(b.declining).toBe(false)
    expect(b.monthly).toBeGreaterThan(0)
  })

  it('treats a few event-week sales between zero weeks as stalled, not as a decline to zero', () => {
    const weeks = ['35周', '36周', '37周', '38周', '39周', '40周', '41周', '42周']
    const b = buildRestockBasis(hist([20, 20, 20, 20, 0, 0, 5, 0], { weeks }))
    expect(b.stalled).toBe(true)
    expect(b.declining).toBe(false)
    expect(decideRestock({ basis: b, fbaTotal: 0 }).text).toBe('停滞-人工')
    // 大促周替换值把窗口外的销量带进来时，按实际销量也算停滞
    // 41 周在近 4 周第一格，替换值 (40周+42周)/2 = 15 不为 0，但 41~44 周实际全是 0
    const later = buildRestockBasis(
      hist([30, 30, 30, 0, 0, 0, 0], { weeks: ['38周', '39周', '40周', '41周', '42周', '43周', '44周'] }),
    )
    expect(later.stalled).toBe(true)
    expect(later.declining).toBe(false)
  })

  it('flags a surge when last week is at least twice the four weeks before', () => {
    expect(buildRestockBasis(hist([10, 10, 10, 10, 25])).surge).toBe(true)
    expect(buildRestockBasis(hist([10, 10, 10, 10, 15])).surge).toBe(false)
  })

  it('lists stockout weeks (sales collapsed and little sellable stock) without excluding them', () => {
    const b = buildRestockBasis(hist([50, 50, 50, 5, 50, 50], { sellable: [80, 80, 10, 0, 90, 90] }))
    expect(b.stockoutWeeks).toEqual(['4周'])
    // 销量塌了但库存充足的不算断货
    expect(buildRestockBasis(hist([50, 50, 50, 5, 50, 50], { sellable: [80, 80, 80, 80, 90, 90] })).stockoutWeeks).toEqual([])
    // 报表里缺行的周按 0 算，也能判出断货
    expect(buildRestockBasis(hist([50, 50, 50, null, 50, 50], { sellable: [80, 80, 10, 0, 90, 90] })).stockoutWeeks).toEqual(['4周'])
  })
})

describe('restockRules: roundShipQty', () => {
  it('rounds to whole cartons, adding a carton from 0.3 upward, at least one', () => {
    expect(roundShipQty(354.5, 84)).toBe(336) // 4.22 箱 → 4 箱
    expect(roundShipQty(360, 84)).toBe(336) // 4.29 箱 → 4 箱
    expect(roundShipQty(365, 84)).toBe(420) // 4.35 箱 → 5 箱
    expect(roundShipQty(10, 84)).toBe(84) // 不到一箱也发一箱
  })

  it('ships at least 5 cartons for full-carton products', () => {
    expect(roundShipQty(144, 16, undefined, 'full')).toBe(144) // 9 箱
    expect(roundShipQty(30, 16, undefined, 'full')).toBe(80) // 不到 5 箱补到 5 箱
    expect(roundShipQty(30, 16, undefined, 'mixed')).toBe(32)
    expect(roundShipQty(30, '', undefined, 'full')).toBe(30) // 没有箱规时照常取 5 的倍数
  })

  it('uses multiples of 5 without a carton size, at least 5', () => {
    expect(roundShipQty(1.2, '')).toBe(5)
    expect(roundShipQty(256, null)).toBe(260)
    expect(roundShipQty(255, undefined)).toBe(255)
    expect(roundShipQty(0, 84)).toBe(0)
  })
})

describe('restockRules: decideRestock', () => {
  const basis = buildRestockBasis(hist([70, 70, 70, 70])) // 周销 70 → 月销 300
  const base = { basis, category: '正常', fbaTotal: 500, localWarehouse: 0, orderedQty: 0, cycle: 0, cartonQty: '' }

  it('ships one month when the stock position is below three months', () => {
    const d = decideRestock(base)
    expect(d.monthly).toBeCloseTo(300)
    expect(d.text).toBe('300')
    expect(d.qty).toBe(300)
    expect(d.coverMonths).toBeCloseTo(500 / 300)
  })

  it('counts local warehouse and ordered quantities in the stock position', () => {
    expect(decideRestock({ ...base, localWarehouse: 300, orderedQty: 100 }).text).toBe('无需补货')
    expect(decideRestock({ ...base, localWarehouse: '399' }).position).toBe(899)
  })

  it('does not ship at exactly the threshold', () => {
    expect(decideRestock({ ...base, fbaTotal: 900 }).text).toBe('无需补货')
  })

  it('adds the restock cycle (weeks × weekly sales) on top of three months', () => {
    const d = decideRestock({ ...base, fbaTotal: 1000, cycle: 2 })
    expect(d.threshold).toBeCloseTo(900 + 140)
    expect(d.text).toBe('300')
    expect(decideRestock({ ...base, fbaTotal: 1000, cycle: '' }).text).toBe('无需补货')
  })

  it('rounds the shipment by carton', () => {
    expect(decideRestock({ ...base, cartonQty: 84 }).text).toBe('336')
    expect(decideRestock({ ...base, cartonQty: 84, packingMode: 'full' })).toMatchObject({ text: '420', boxes: 5 })
    expect(decideRestock({ ...base, cartonQty: 84 }).boxes).toBeNull()
  })

  it('returns empty for abandoned SKUs, missing basis or missing FBA stock', () => {
    expect(decideRestock({ ...base, category: '放弃' }).text).toBe('')
    expect(decideRestock({ ...base, basis: null }).text).toBe('')
    expect(decideRestock({ ...base, fbaTotal: '' }).text).toBe('')
  })

  it('asks for a manual check instead of shipping a stalled SKU', () => {
    const stalled = buildRestockBasis(hist([30, 30, 30, 30, 0, 0, 0, 0]))
    const d = decideRestock({ ...base, basis: stalled, fbaTotal: 0 })
    expect(d.text).toBe('停滞-人工')
    expect(d.qty).toBeNull()
    expect(d.flags).toContain('停滞')
  })

  it('collects review flags and honours config overrides', () => {
    const surge = buildRestockBasis(hist([10, 10, 10, 10, 40]))
    expect(decideRestock({ ...base, basis: surge }).flags).toEqual(['爆量', '新品'])
    expect(decideRestock({ ...base, config: { coverMonths: 1 } }).text).toBe('无需补货')
  })
})
