import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useReplenishment } from '../src/composables/useReplenishment.js'
import { useTrendWeeks } from '../src/composables/useTrendWeeks.js'

function jsonResponse(data, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => data })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useTrendWeeks', () => {
  const weekMeta = (n) => ({ id: `${n}周`, startDate: `2026-01-${String(n).padStart(2, '0')}` })
  // weeks.json 按时间倒序：12周 … 1周
  const weeks = ref(Array.from({ length: 12 }, (_, i) => weekMeta(12 - i)))

  it('loads only the last 8 weeks once, reusing the seeded latest week', async () => {
    const fetchMock = vi.fn((url) => jsonResponse({ columns: [], rows: [], from: url }))
    vi.stubGlobal('fetch', fetchMock)
    const t = useTrendWeeks(weeks)
    t.seedTrendWeek('12周', { columns: ['ASIN'], rows: [] })
    expect(t.trendReady.value).toBe(false)

    const first = t.ensureTrendWeeks()
    const second = t.ensureTrendWeeks() // 并发调用复用同一次加载
    expect(t.trendLoading.value).toBe(true)
    await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(fetchMock.mock.calls.map(([url]) => decodeURIComponent(url))).not.toContain('/api/weeks/12周')
    expect(t.trendLoading.value).toBe(false)
    expect(t.trendReady.value).toBe(true)
    expect(t.trendWeeks.value.map((w) => w.id)).toEqual(['5周', '6周', '7周', '8周', '9周', '10周', '11周', '12周'])
    expect(t.trendWeeks.value[7].columns).toEqual(['ASIN'])

    await t.ensureTrendWeeks()
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('skips weeks that fail to load and reloads everything after a reset', async () => {
    const fetchMock = vi.fn((url) => (url.includes('7') ? jsonResponse(null, false, 500) : jsonResponse({ rows: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const t = useTrendWeeks(weeks)
    await t.ensureTrendWeeks()
    expect(t.trendWeeks.value.map((w) => w.id)).not.toContain('7周')
    expect(t.trendReady.value).toBe(false)

    t.resetTrendWeeks()
    expect(t.trendWeeks.value).toEqual([])
    t.seedTrendWeek('', { rows: [] }) // 没有周次 ID 时忽略
    expect(t.trendWeeks.value).toEqual([])
  })
})

describe('useReplenishment', () => {
  const shops = ref([
    { id: 'shop-1', name: 'CZH-主店一号' },
    { id: 'shop-2', name: 'TZH-主店二号' },
    { id: 'shop-3', name: 'LPH-主店三号' },
  ])
  const plan = (shop, items) => ({
    shop,
    file: `${shop}.csv`,
    batches: [
      { key: '10/17', date: '2026-10-17' },
      { key: '10/24', date: '2026-10-24' },
    ],
    items,
  })
  const PLANS = [
    plan('LPH', [{ sku: 'L1', asin: 'B0L1', qtyByBatch: { '10/24': 5 } }]),
    plan('XXX', [{ sku: 'X1', asin: 'B0X1', qtyByBatch: { '10/17': 1 } }]),
    plan('TZH', [
      { sku: 'T1', asin: 'B0T1', qtyByBatch: { '10/17': 10, '10/24': 20 } },
      { sku: 'T2', asin: 'B0T2', qtyByBatch: {} },
    ]),
  ]

  function setup(overrides = {}) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 14, 9, 0))
    const routes = {
      'GET /api/replenishment': () =>
        jsonResponse({ plans: PLANS, warnings: ['旧文件已忽略'], shipped: { TZH: { B0T1: { '2026-10-17': 't0' } } } }),
      ...overrides,
    }
    const fetchMock = vi.fn((url, init = {}) => routes[`${init.method || 'GET'} ${url}`](JSON.parse(init.body || 'null')))
    vi.stubGlobal('fetch', fetchMock)
    const onError = vi.fn()
    return { r: useReplenishment(shops, { onError }), fetchMock, onError }
  }

  it('loads plans, orders them like shops.json and indexes rows by shop + ASIN', async () => {
    const { r } = setup()
    await r.loadReplenishment()
    expect(r.today.value).toBe('2026-10-14')
    expect(r.orderedPlans.value.map((p) => p.shop)).toEqual(['TZH', 'LPH', 'XXX'])
    expect(r.warnings.value).toEqual(['旧文件已忽略', '补货清单店铺 XXX 在店铺列表里找不到，已忽略'])

    const entry = r.planEntry('shop-2', 'B0T1')
    expect(entry.item.sku).toBe('T1')
    expect(entry.summary).toMatchObject({ plannedQty: 30, shippedQty: 10, dueBatch: '10/24' })
    expect(r.planEntry('shop-3', 'B0T1')).toBeNull()
    expect(r.summaries.value.TZH.shippedQty).toBe(10)

    expect(r.cellShipped('TZH', 'B0T1', '2026-10-17')).toBe(true)
    expect(r.cellShipped('TZH', 'B0T1', '2026-10-24')).toBe(false)
    expect(r.shippedAt('TZH', 'B0T1', '2026-10-17')).toBe('t0')
    expect(r.shippedAt('LPH', 'B0L1', '2026-10-24')).toBe('')
  })

  it('treats a failed load as an empty plan list', async () => {
    const { r } = setup({ 'GET /api/replenishment': () => jsonResponse(null, false, 500) })
    await r.loadReplenishment()
    expect(r.orderedPlans.value).toEqual([])
    expect(r.warnings.value).toEqual([])
  })

  it('saves shipped marks and refreshes the summary', async () => {
    const { r, fetchMock } = setup({
      'PUT /api/replenishment/shipped': (body) =>
        jsonResponse({ shop: body.shop, shipped: { B0T1: { '2026-10-17': 't0', '2026-10-24': 't1' } } }),
    })
    await r.loadReplenishment()
    const pending = r.saveShipped('TZH', [{ asin: 'B0T1', date: '2026-10-24' }], true)
    expect(r.saving.value).toBe(true)
    // 保存中再点一次会被忽略
    expect(await r.saveShipped('TZH', [{ asin: 'B0T1', date: '2026-10-24' }], true)).toBe(false)
    expect(await pending).toBe(true)
    expect(r.saving.value).toBe(false)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      shop: 'TZH',
      entries: [{ asin: 'B0T1', date: '2026-10-24' }],
      shipped: true,
    })
    expect(r.planEntry('shop-2', 'B0T1').summary).toMatchObject({ shippedQty: 30, dueBatch: '' })
    expect(await r.saveShipped('TZH', [], true)).toBe(false)
  })

  it('reports save errors without changing the state', async () => {
    const { r, onError } = setup({
      'PUT /api/replenishment/shipped': () => jsonResponse({ error: '计划中不存在的 ASIN / 批次日期' }, false, 400),
    })
    await r.loadReplenishment()
    expect(await r.saveShipped('TZH', [{ asin: 'B0T1', date: '2027-10-24' }], true)).toBe(false)
    expect(onError).toHaveBeenCalledWith('保存失败：计划中不存在的 ASIN / 批次日期')
    expect(r.summaries.value.TZH.shippedQty).toBe(10)

    const broken = setup({ 'PUT /api/replenishment/shipped': () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) }) })
    await broken.r.loadReplenishment()
    await broken.r.saveShipped('TZH', [{ asin: 'B0T1', date: '2026-10-24' }], true)
    expect(broken.onError).toHaveBeenCalledWith('保存失败：HTTP 502')
  })
})
