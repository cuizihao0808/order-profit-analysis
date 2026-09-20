import { describe, expect, it } from 'vitest'
import {
  applyShippedChange,
  buildShippingSummary,
  findInvalidShippedEntries,
  inferBatchDates,
  isShipped,
  parseBatchHeader,
  parseCsv,
  parseReplenishmentPlan,
  sortByUrgency,
} from '../src/lib/replenishmentPlan.js'

const HEADER = [
  '店铺', 'SKU', '品名', 'ASIN', '当前可用', '在途', '日均需求参考(件/天)', '9/26下周海运是否带应急量',
  '判断说明', '在途晚到7天时残余缺口', '12/26(仅现货)', '01/02', '01/16(春节前末班)', '春节前合计',
  '2/27节后首班参考(须节前备好)', '春节前采购金额参考(元)', '春节前净重参考(kg)', '备注(利润红旗按正常量算)',
]

const CSV = [
  HEADER.join(','),
  'TZH,SKU-A,品名A,B0AAAA,33,160,9月6.0,有必要,说明A,无,220,,80,300,50,"1,200",43.5,16件/箱',
  'TZH,SKU-B,品名B,B0BBBB,5,0,9月1.0,无必要,说明B,,,30,,30,,,,【利润红旗，本次按正常量算】',
  'TZH,每周合计件数,,,,,,,,,220,30,80,330,50,1200,43.5,单周件数=该周六交凯琦的总件数',
  'TZH,每周采购金额(元),,,,,,,,,800,100,300,,,,,无采购成本的SKU未计入',
  'TZH,每周净重(kg),,,,,,,,,30.5,2,11,,,,,净重参考',
  'TZH,每周SKU数,,,,,,,,,1,1,1,,,,,',
  'TZH,每周其它,,,,,,,,,9,9,9,,,,,',
].join('\r\n')

describe('parseCsv', () => {
  it('handles BOM, quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsv('﻿a,"b,1","say ""hi"""\r\n\r\nc,,d\n,,\ne')).toEqual([
      ['a', 'b,1', 'say "hi"'],
      ['c', '', 'd'],
      ['e'],
    ])
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']])
    expect(parseCsv(null)).toEqual([])
  })
})

describe('parseBatchHeader / inferBatchDates', () => {
  it('recognises MM/DD headers with an optional note', () => {
    expect(parseBatchHeader('09/26(仅现货)')).toEqual({ key: '09/26', month: 9, day: 26, note: '仅现货' })
    expect(parseBatchHeader('1/9')).toEqual({ key: '01/09', month: 1, day: 9, note: '' })
    expect(parseBatchHeader('2/27节后首班参考(须节前备好)')).toBeNull()
    expect(parseBatchHeader('9/26下周海运是否带应急量')).toBeNull()
    expect(parseBatchHeader('13/01')).toBeNull()
    expect(parseBatchHeader(undefined)).toBeNull()
  })

  it('rolls the year over when the month goes backwards', () => {
    const batches = ['09/26', '12/26', '01/02'].map(parseBatchHeader)
    expect(inferBatchDates(batches, new Date(2026, 8, 19))).toEqual(['2026-09-26', '2026-12-26', '2027-01-02'])
  })

  it('starts next year when a year-end file plans batches for early next year', () => {
    const batches = ['01/09', '01/16'].map(parseBatchHeader)
    expect(inferBatchDates(batches, new Date(2026, 11, 28))).toEqual(['2027-01-09', '2027-01-16'])
    expect(inferBatchDates([], new Date(2026, 11, 28))).toEqual([])
  })
})

describe('parseReplenishmentPlan', () => {
  const plan = parseReplenishmentPlan(parseCsv(CSV), { refDate: new Date(2026, 8, 19) })

  it('reads shop, batches and SKU rows', () => {
    expect(plan.shop).toBe('TZH')
    expect(plan.batches).toEqual([
      { key: '12/26', label: '12/26(仅现货)', note: '仅现货', date: '2026-12-26' },
      { key: '01/02', label: '01/02', note: '', date: '2027-01-02' },
      { key: '01/16', label: '01/16(春节前末班)', note: '春节前末班', date: '2027-01-16' },
    ])
    expect(plan.items).toHaveLength(2)
    expect(plan.items[0]).toMatchObject({
      sku: 'SKU-A',
      name: '品名A',
      asin: 'B0AAAA',
      available: 33,
      inbound: 160,
      emergency: '有必要',
      lateGap: '无',
      qtyByBatch: { '12/26': 220, '01/16': 80 },
      preHolidayTotal: 300,
      postHolidayRef: 50,
      amount: 1200,
      weight: 43.5,
    })
    expect(plan.items[1]).toMatchObject({ qtyByBatch: { '01/02': 30 }, amount: null, remark: '【利润红旗，本次按正常量算】' })
  })

  it('collects the weekly summary rows and ignores unknown ones', () => {
    expect(plan.weekly).toEqual({
      qty: { '12/26': 220, '01/02': 30, '01/16': 80 },
      amount: { '12/26': 800, '01/02': 100, '01/16': 300 },
      weight: { '12/26': 30.5, '01/02': 2, '01/16': 11 },
      skuCount: { '12/26': 1, '01/02': 1, '01/16': 1 },
    })
    expect(plan.weeklyNotes).toEqual({
      qty: '单周件数=该周六交凯琦的总件数',
      amount: '无采购成本的SKU未计入',
      weight: '净重参考',
    })
  })

  it('tolerates missing optional columns', () => {
    const minimal = parseReplenishmentPlan([['店铺', 'SKU', '10/10'], ['LPH', 'X', '5']], { refDate: '2026-09-19' })
    expect(minimal.items[0]).toMatchObject({ sku: 'X', name: '', available: null, qtyByBatch: { '10/10': 5 } })
    expect(parseReplenishmentPlan([['店铺', 'SKU', '10/10'], ['LPH', 'X', '5']]).shop).toBe('LPH')
  })

  it('rejects files without SKU, batch columns or shop', () => {
    expect(() => parseReplenishmentPlan([['店铺', '10/10']])).toThrow('缺少 SKU 列')
    expect(() => parseReplenishmentPlan([['店铺', 'SKU']])).toThrow('没有 MM/DD')
    expect(() => parseReplenishmentPlan([['SKU', '10/10'], ['X', '1']])).toThrow('缺少店铺')
    expect(() => parseReplenishmentPlan([])).toThrow('缺少 SKU 列')
  })
})

describe('shipping state', () => {
  const plan = parseReplenishmentPlan(parseCsv(CSV), { refDate: new Date(2026, 8, 19) })

  it('summarises batch and SKU progress, including overdue batches', () => {
    const shipped = { 'SKU-A': { '12/26': 't' } }
    const s = buildShippingSummary(plan, shipped, '2027-01-10')
    expect(s.batches.map((b) => [b.key, b.status, b.overdue, b.shippedQty, b.plannedQty])).toEqual([
      ['12/26', 'done', false, 220, 220],
      ['01/02', 'pending', true, 0, 30],
      ['01/16', 'pending', false, 0, 80],
    ])
    expect(s.items).toEqual({
      'SKU-A': {
        plannedQty: 300,
        shippedQty: 220,
        firstBatch: '12/26',
        firstDate: '2026-12-26',
        firstInDays: -15,
        urgent: true,
        dueBatch: '01/16',
        dueDate: '2027-01-16',
        dueInDays: 6,
        nearTermDone: false,
      },
      'SKU-B': {
        plannedQty: 30,
        shippedQty: 0,
        firstBatch: '01/02',
        firstDate: '2027-01-02',
        firstInDays: -8,
        urgent: true,
        dueBatch: '01/02',
        dueDate: '2027-01-02',
        dueInDays: -8,
        nearTermDone: false,
      },
    })
    expect([s.plannedQty, s.shippedQty, s.nextBatch.key]).toEqual([330, 220, '01/02'])
  })

  it('reports partial, empty and fully shipped plans', () => {
    const twoSkuPlan = { ...plan, batches: [...plan.batches, { key: '02/06', date: '2027-02-06' }] }
    twoSkuPlan.items = plan.items.map((i) => ({ ...i, qtyByBatch: { ...i.qtyByBatch, '12/26': 10 } }))
    const partial = buildShippingSummary(twoSkuPlan, { 'SKU-A': { '12/26': 't' } }, '2027-01-01')
    expect(partial.batches[0]).toMatchObject({ status: 'partial', overdue: true, shippedSkus: 1, plannedSkus: 2 })
    expect(partial.batches[3]).toMatchObject({ status: 'empty', overdue: false })

    const all = {}
    for (const item of plan.items) for (const key of Object.keys(item.qtyByBatch)) all[item.sku] = { ...all[item.sku], [key]: 't' }
    const done = buildShippingSummary(plan, all)
    expect(done.nextBatch).toBeNull()
    expect(done.batches.every((b) => b.status === 'done' && !b.overdue)).toBe(true)
    expect(buildShippingSummary(plan).shippedQty).toBe(0)
  })

  it('pins SKUs whose first planned batch falls inside the urgency window', () => {
    // 窗口按“计划里的第一个批次”判断：SKU-A 12/26、SKU-B 01/02 都已逾期
    const s = buildShippingSummary(plan, {}, '2027-01-10', 3)
    expect(s.items['SKU-A']).toMatchObject({ firstBatch: '12/26', firstInDays: -15, urgent: true, nearTermDone: false })
    expect(s.items['SKU-B']).toMatchObject({ firstBatch: '01/02', firstInDays: -8, urgent: true })
    expect(sortByUrgency(plan.items, s).map((i) => i.sku)).toEqual(['SKU-A', 'SKU-B'])

    // 计划外的窗口：两个 SKU 都不置顶，保持原顺序
    const future = buildShippingSummary(plan, {}, '2026-01-01', 3)
    expect(future.items['SKU-A'].urgent).toBe(false)
    expect(sortByUrgency(plan.items, future).map((i) => i.sku)).toEqual(['SKU-A', 'SKU-B'])

    // 没有 today 就不判断紧急，保持原顺序
    const noToday = buildShippingSummary(plan, {})
    expect(noToday.items['SKU-A']).toMatchObject({ firstInDays: null, urgent: false })
    expect(sortByUrgency(plan.items, noToday).map((i) => i.sku)).toEqual(['SKU-A', 'SKU-B'])
    expect(sortByUrgency(plan.items, null).map((i) => i.sku)).toEqual(['SKU-A', 'SKU-B'])
  })

  it('keeps the order stable when a batch is marked shipped', () => {
    const before = buildShippingSummary(plan, {}, '2027-01-10')
    const orderBefore = sortByUrgency(plan.items, before).map((i) => i.sku)
    // 把 SKU-A 最近的待发批次标记为已发货：dueBatch 往后走，但置顶依据（firstDate）不变
    const after = buildShippingSummary(plan, { 'SKU-A': { '12/26': 't' } }, '2027-01-10')
    expect(after.items['SKU-A']).toMatchObject({ firstBatch: '12/26', dueBatch: '01/16', urgent: true })
    expect(sortByUrgency(plan.items, after).map((i) => i.sku)).toEqual(orderBefore)

    // 窗口内的批次全部发完 → nearTermDone，但仍然置顶
    const done = buildShippingSummary(plan, { 'SKU-B': { '01/02': 't' } }, '2027-01-10', 3)
    expect(done.items['SKU-B']).toMatchObject({ urgent: true, nearTermDone: true, dueInDays: null })
    expect(sortByUrgency(plan.items, done).map((i) => i.sku)).toEqual(orderBefore)
  })

  it('checks and validates entries against the plan', () => {
    expect(isShipped({ A: { '12/26': 't' } }, 'A', '12/26')).toBe(true)
    expect(isShipped(undefined, 'A', '12/26')).toBe(false)
    expect(
      findInvalidShippedEntries(plan, [
        { sku: 'SKU-A', batch: '12/26' },
        { sku: 'SKU-A', batch: '01/02' },
        { sku: 'NOPE', batch: '12/26' },
        null,
      ]),
    ).toEqual([{ sku: 'SKU-A', batch: '01/02' }, { sku: 'NOPE', batch: '12/26' }, null])
    expect(findInvalidShippedEntries(plan, 'bad')).toEqual([])
  })

  it('applies and reverts marks immutably, keeping the first timestamp', () => {
    const before = { LPH: { X: { '10/10': 'old' } } }
    const marked = applyShippedChange(before, 'TZH', [{ sku: 'A', batch: '12/26' }, { sku: 'A', batch: '01/02' }], true, 't1')
    expect(marked).toEqual({ LPH: { X: { '10/10': 'old' } }, TZH: { A: { '12/26': 't1', '01/02': 't1' } } })
    expect(before).toEqual({ LPH: { X: { '10/10': 'old' } } })

    const again = applyShippedChange(marked, 'TZH', [{ sku: 'A', batch: '12/26' }], true, 't2')
    expect(again.TZH.A['12/26']).toBe('t1')

    const partlyUndone = applyShippedChange(again, 'TZH', [{ sku: 'A', batch: '12/26' }], false)
    expect(partlyUndone.TZH).toEqual({ A: { '01/02': 't1' } })
    const undone = applyShippedChange(partlyUndone, 'TZH', [{ sku: 'A', batch: '01/02' }], false)
    expect(undone).toEqual({ LPH: { X: { '10/10': 'old' } } })
    expect(applyShippedChange(null, 'TZH', [{ sku: 'A', batch: '01/02' }], false)).toEqual({})
  })
})
