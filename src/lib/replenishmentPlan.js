/**
 * 补货批次计划（周批次版补货清单 CSV）
 *
 * 一个 CSV 对应一个店铺：每行一个 SKU，“MM/DD” 形式的列是每周批次的发货件数；
 * SKU 以“每周”开头的行是每周合计（件数 / 采购金额 / 净重 / SKU 数）。
 * 已发货状态单独保存：{ [shop]: { [sku]: { [batchKey]: ISO 时间 } } }
 */

/** 最小 CSV 解析：支持 BOM、引号字段、"" 转义、CRLF；丢弃全空行 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch !== '"') field += ch
      else if (src[i + 1] === '"') {
        field += '"'
        i++
      } else inQuotes = false
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function toNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

const BATCH_HEADER_RE = /^(\d{1,2})\/(\d{1,2})(?:\s*\((.*)\))?$/

/** “10/10” “09/26(仅现货)” → { key: '10/10', note: '仅现货' }；其它表头返回 null */
export function parseBatchHeader(header) {
  const m = String(header ?? '').trim().match(BATCH_HEADER_RE)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const key = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
  return { key, month, day, note: (m[3] || '').trim() }
}

/**
 * 批次表头只有月/日：以文件时间所在年份为起点，月份回退时跨年。
 * 文件时间在年底、首批在次年初（相差超过半年）时，起始年份 +1。
 */
export function inferBatchDates(batches, refDate) {
  const ref = new Date(refDate)
  let year = ref.getFullYear()
  if (batches.length && batches[0].month < ref.getMonth() + 1 - 6) year += 1
  let prevMonth = 0
  return batches.map((b) => {
    if (b.month < prevMonth) year += 1
    prevMonth = b.month
    return `${year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`
  })
}

const FIELD_MATCHERS = [
  ['shop', (h) => h === '店铺'],
  ['sku', (h) => h === 'SKU'],
  ['name', (h) => h === '品名'],
  ['asin', (h) => h === 'ASIN'],
  ['available', (h) => h === '当前可用'],
  ['inbound', (h) => h === '在途'],
  ['dailyDemand', (h) => h.startsWith('日均需求')],
  ['emergency', (h) => h.includes('应急')],
  ['reason', (h) => h === '判断说明'],
  ['lateGap', (h) => h.includes('残余缺口')],
  ['preHolidayTotal', (h) => h === '春节前合计'],
  ['postHolidayRef', (h) => h.includes('节后首班')],
  ['amount', (h) => h.includes('采购金额')],
  ['weight', (h) => h.includes('净重')],
  ['remark', (h) => h.startsWith('备注')],
]

const SUMMARY_MATCHERS = [
  ['qty', (s) => s.includes('件数')],
  ['amount', (s) => s.includes('采购金额')],
  ['weight', (s) => s.includes('净重')],
  ['skuCount', (s) => s.includes('SKU数')],
]

/**
 * 把 parseCsv 的结果解析为补货计划。
 * @param rows 二维数组，第一行为表头
 * @param options.refDate 用于推断批次年份的参考时间（通常是文件修改时间）
 */
export function parseReplenishmentPlan(rows, { refDate = new Date() } = {}) {
  const header = (rows[0] || []).map((h) => String(h ?? '').replace(/^﻿/, '').trim())
  const col = {}
  for (const [key, match] of FIELD_MATCHERS) {
    const idx = header.findIndex(match)
    if (idx >= 0) col[key] = idx
  }
  if (col.sku == null) throw new Error('补货清单缺少 SKU 列')

  const batchCols = []
  header.forEach((h, idx) => {
    const parsed = parseBatchHeader(h)
    if (parsed) batchCols.push({ ...parsed, label: h, idx })
  })
  if (!batchCols.length) throw new Error('补货清单没有 MM/DD 形式的批次列')
  const dates = inferBatchDates(batchCols, refDate)
  const batches = batchCols.map((b, i) => ({ key: b.key, label: b.label, note: b.note, date: dates[i] }))

  const text = (row, key) => (col[key] == null ? '' : String(row[col[key]] ?? '').trim())
  const num = (row, key) => (col[key] == null ? null : toNumber(row[col[key]]))

  const items = []
  const weekly = { qty: {}, amount: {}, weight: {}, skuCount: {} }
  const weeklyNotes = {}
  let shop = ''
  for (const row of rows.slice(1)) {
    const sku = text(row, 'sku')
    if (!sku) continue
    shop = shop || text(row, 'shop')
    if (sku.startsWith('每周')) {
      const hit = SUMMARY_MATCHERS.find(([, match]) => match(sku))
      if (!hit) continue
      const [kind] = hit
      for (const b of batchCols) {
        const n = toNumber(row[b.idx])
        if (n != null) weekly[kind][b.key] = n
      }
      const note = text(row, 'remark')
      if (note) weeklyNotes[kind] = note
      continue
    }
    const qtyByBatch = {}
    for (const b of batchCols) {
      const n = toNumber(row[b.idx])
      if (n != null && n > 0) qtyByBatch[b.key] = n
    }
    items.push({
      sku,
      name: text(row, 'name'),
      asin: text(row, 'asin'),
      available: num(row, 'available'),
      inbound: num(row, 'inbound'),
      dailyDemand: text(row, 'dailyDemand'),
      emergency: text(row, 'emergency'),
      reason: text(row, 'reason'),
      lateGap: text(row, 'lateGap'),
      qtyByBatch,
      preHolidayTotal: num(row, 'preHolidayTotal'),
      postHolidayRef: num(row, 'postHolidayRef'),
      amount: num(row, 'amount'),
      weight: num(row, 'weight'),
      remark: text(row, 'remark'),
    })
  }
  if (!shop) throw new Error('补货清单缺少店铺')
  return { shop, batches, items, weekly, weeklyNotes }
}

export function isShipped(shopShipped, sku, batchKey) {
  return !!shopShipped?.[sku]?.[batchKey]
}

/**
 * 汇总发货进度。
 * 批次状态：empty 无计划 / done 已发完 / partial 部分已发 / pending 待发；
 * overdue 表示批次日期已过（早于 today）但还没发完。
 */
export function buildShippingSummary(plan, shopShipped = {}, today = '') {
  const batches = plan.batches.map((b) => {
    let plannedQty = 0
    let plannedSkus = 0
    let shippedQty = 0
    let shippedSkus = 0
    for (const item of plan.items) {
      const qty = item.qtyByBatch[b.key]
      if (!qty) continue
      plannedQty += qty
      plannedSkus += 1
      if (isShipped(shopShipped, item.sku, b.key)) {
        shippedQty += qty
        shippedSkus += 1
      }
    }
    let status = 'pending'
    if (!plannedSkus) status = 'empty'
    else if (shippedSkus === plannedSkus) status = 'done'
    else if (shippedSkus) status = 'partial'
    const overdue = !!today && b.date < today && (status === 'pending' || status === 'partial')
    return { ...b, plannedQty, plannedSkus, shippedQty, shippedSkus, status, overdue }
  })

  const items = {}
  for (const item of plan.items) {
    let plannedQty = 0
    let shippedQty = 0
    for (const [key, qty] of Object.entries(item.qtyByBatch)) {
      plannedQty += qty
      if (isShipped(shopShipped, item.sku, key)) shippedQty += qty
    }
    items[item.sku] = { plannedQty, shippedQty }
  }

  const plannedQty = batches.reduce((acc, b) => acc + b.plannedQty, 0)
  const shippedQty = batches.reduce((acc, b) => acc + b.shippedQty, 0)
  const nextBatch = batches.find((b) => b.status === 'pending' || b.status === 'partial') || null
  return { batches, items, plannedQty, shippedQty, nextBatch }
}

/** 过滤出计划里真实存在（该 SKU 在该批次件数 > 0）的条目，返回无效条目 */
export function findInvalidShippedEntries(plan, entries) {
  const bySku = new Map(plan.items.map((item) => [item.sku, item]))
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const item = bySku.get(String(entry?.sku ?? ''))
    return !item || !item.qtyByBatch[String(entry?.batch ?? '')]
  })
}

/** 返回新的已发货状态（不修改入参）；撤销后清理空对象 */
export function applyShippedChange(state, shop, entries, shipped, timestamp) {
  const next = { ...(state || {}) }
  const shopState = { ...(next[shop] || {}) }
  for (const { sku, batch } of entries) {
    const skuState = { ...(shopState[sku] || {}) }
    if (shipped) skuState[batch] = skuState[batch] || timestamp
    else delete skuState[batch]
    if (Object.keys(skuState).length) shopState[sku] = skuState
    else delete shopState[sku]
  }
  if (Object.keys(shopState).length) next[shop] = shopState
  else delete next[shop]
  return next
}
