/**
 * 静态补货（2026-10-24 确认口径）
 *
 *   月销量 M  = 指数平滑周销 × 30/7（从首次出单那周起算，周销扣掉 Vine）
 *   库存位置 = FBA总量 + 本地仓 + 已下单
 *   库存位置 < M × 3 + 补货用时(周) × 周销 → 发 1 个 M（有箱规按整箱，没有取 5 的倍数）
 *
 * - 会员日这类大促周用前后两周均值代替；大促周就是最新一周时先跳过
 * - 下滑（近 4 周均 < 前 4 周均 × 0.7）时 M 不超过近 4 周均
 * - 断货周不剔除，只提示；爆量不削峰，只提示
 * 静态补货只做预警和校验，实际发货以「建议补货」（补货批次计划）为准。
 */
export const DEFAULT_RESTOCK_CONFIG = {
  coverMonths: 3, // 库存位置不够几个月就补
  shipMonths: 1, // 每次补几个月
  daysPerMonth: 30,
  smoothingAlpha: 0.3, // 本周销量在平滑值里的权重
  eventWeeks: ['41周'], // 大促周
  declineRatio: 0.7,
  declineMinWeekly: 10, // 前 4 周均低于这个件数不判下滑
  surgeRatio: 2, // 上周 ≥ 前 4 周均 × 2 提示爆量
  newProductWeeks: 8, // 出单不超过几周提示新品
  cartonRoundUp: 0.3, // 箱数小数部分 ≥ 0.3 进一箱
  mixedMultiple: 5, // 没有箱规时取几的倍数
  stockoutSalesRatio: 0.4, // 周销 < 前后 4 周中位数 × 0.4
  stockoutStockWeeks: 0.5, // 且周初或周末可售 < 半周销量 → 提示断货周
  stockoutLookbackWeeks: 8, // 只提示最近几周里的断货周
}

export function resolveRestockConfig(config) {
  return { ...DEFAULT_RESTOCK_CONFIG, ...(config || {}) }
}

function finite(v) {
  if (v == null || v === '') return NaN
  const n = Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

function orZero(v) {
  const n = finite(v)
  return Number.isFinite(n) ? n : 0
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}

function median(xs) {
  if (!xs.length) return NaN
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Listing 30 天销量已扣 Vine，Vine赠品销量单列：Vine 占比 = Vine / (销量 + Vine) */
export function vineShareOf(monthSales, vineGiftSales) {
  const sales = orZero(monthSales)
  const vine = orZero(vineGiftSales)
  return sales + vine > 0 && vine > 0 ? vine / (sales + vine) : 0
}

/**
 * 把各周快照 + 各周 Listing 拼成每个「店铺 + ASIN」的周序列。
 * weeks：周元信息（任意顺序，按 startDate 升序处理）；snapshots：weekId → 周快照；
 * listings：weekId → Listing 记录数组（buildListingRowRecord 的结果，带 asin）；
 * shopIdOf(店铺名) → shopId。
 * 返回 { 'shopId::ASIN': [{ week, sales, vineShare, sellable }] }，sales 为 null 表示该周报表里没有这个 ASIN。
 * 缺「销量」或「店铺」列的周整周不用，免得所有 ASIN 这周都按 0 销量算。
 */
export function collectRestockHistories({ weeks, snapshots, listings, shopIdOf }) {
  const ordered = (Array.isArray(weeks) ? weeks : [])
    .filter((w) => w?.id && hasRestockColumns(snapshots?.[w.id]))
    .slice()
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
  const byKey = new Map()
  const slot = (key) => {
    if (!byKey.has(key)) byKey.set(key, ordered.map((w) => ({ week: w.id, sales: null, vineShare: 0, sellable: null })))
    return byKey.get(key)
  }

  ordered.forEach((w, i) => {
    const snap = snapshots[w.id]
    const cols = Array.isArray(snap.columns) ? snap.columns : []
    const shopIdx = cols.indexOf('店铺')
    const asinIdx = cols.indexOf('ASIN')
    const salesIdx = cols.indexOf('销量')
    for (const row of snap.rows || []) {
      const values = row?.values || []
      const asin = String(row?.asin || values[asinIdx] || '').trim()
      const shopId = shopIdOf(String(values[shopIdx] ?? '').trim())
      if (!asin || !shopId) continue
      const cell = slot(`${shopId}::${asin}`)[i]
      cell.sales = (cell.sales ?? 0) + orZero(values[salesIdx])
    }
    for (const rec of listings?.[w.id] || []) {
      const asin = String(rec?.asin || '').trim()
      const shopId = shopIdOf(String(rec?.shopName || '').trim())
      if (!asin || !shopId || !byKey.has(`${shopId}::${asin}`)) continue
      const cell = byKey.get(`${shopId}::${asin}`)[i]
      cell.vineShare = vineShareOf(rec.monthSales, rec.vineGiftSales)
      const sellable = finite(rec.sellable)
      cell.sellable = Number.isFinite(sellable) ? sellable : null
    }
  })
  return Object.fromEntries(byKey)
}

/** 周快照能不能拿来算月销：要有「店铺」「销量」列 */
export function hasRestockColumns(snapshot) {
  const cols = Array.isArray(snapshot?.columns) ? snapshot.columns : []
  return cols.includes('店铺') && cols.includes('销量')
}

/** 扣掉 Vine 后的周销 */
function netSales(h) {
  const share = finite(h?.vineShare)
  return orZero(h?.sales) * (share > 0 ? 1 - Math.min(share, 1) : 1)
}

/**
 * 由周序列算月销量和提示标记；从没出过单（扣 Vine 后）、或出单后只有还不能用的大促周时返回 null。
 * history：[{ week, sales, vineShare, sellable }]，按时间升序。
 */
export function buildRestockBasis(history, config) {
  const cfg = resolveRestockConfig(config)
  const list = Array.isArray(history) ? history : []
  // 纯 Vine 赠品的周不算开卖
  const first = list.findIndex((h) => netSales(h) > 0)
  if (first < 0) return null
  const weeks = list.slice(first)
  const gross = weeks.map((h) => orZero(h.sales))
  const net = weeks.map(netSales)

  // 大促周用前后最近的非大促周均值代替（黑五、网一两周相连）；后面还没有非大促周时先跳过
  const events = new Set(cfg.eventWeeks || [])
  const isEvent = (i) => events.has(weeks[i].week)
  const clean = []
  net.forEach((x, i) => {
    if (!isEvent(i)) return clean.push(x)
    let before = i - 1
    while (before >= 0 && isEvent(before)) before--
    let after = i + 1
    while (after < net.length && isEvent(after)) after++
    if (before >= 0 && after < net.length) clean.push((net[before] + net[after]) / 2)
  })
  if (!clean.length) return null

  const alpha = cfg.smoothingAlpha
  let smoothed = null
  for (const x of clean) smoothed = smoothed == null ? x : alpha * x + (1 - alpha) * smoothed

  // 停滞（近 4 周 0 销，按实际或按大促替换后的值看都算）不走下滑保护，否则 M 归零、长期断货的也会显示「无需补货」
  const stalled = [net, clean].some((xs) => xs.slice(-4).every((x) => x === 0))
  const recent = clean.slice(-4)
  const before = clean.slice(-8, -4)
  const recentWeekly = mean(recent)
  const declining =
    !stalled &&
    before.length === 4 &&
    mean(before) >= cfg.declineMinWeekly &&
    recentWeekly < cfg.declineRatio * mean(before)
  const weekly = declining ? Math.min(smoothed, recentWeekly) : smoothed

  const prior = clean.slice(-5, -1)
  const surge = prior.length >= 2 && mean(prior) > 0 && clean[clean.length - 1] >= cfg.surgeRatio * mean(prior)

  // 断货周：只看最近几周（更早的周在平滑值里权重已很小），销量用扣 Vine 后的、缺行按 0
  const stockoutWeeks = []
  const lookFrom = Math.max(0, weeks.length - cfg.stockoutLookbackWeeks)
  for (let i = lookFrom; i < weeks.length; i++) {
    const around = []
    for (let j = Math.max(0, i - 4); j <= Math.min(weeks.length - 1, i + 4); j++) {
      if (j !== i) around.push(net[j])
    }
    const ref = median(around)
    if (!(ref > 0) || net[i] >= cfg.stockoutSalesRatio * ref) continue
    const stock = [list[first + i - 1]?.sellable, weeks[i].sellable].map(finite).filter(Number.isFinite)
    if (stock.length && Math.min(...stock) < cfg.stockoutStockWeeks * ref) stockoutWeeks.push(weeks[i].week)
  }

  return {
    weekly,
    monthly: (weekly * cfg.daysPerMonth) / 7,
    smoothedMonthly: (smoothed * cfg.daysPerMonth) / 7,
    recentMonthly: (recentWeekly * cfg.daysPerMonth) / 7,
    declining,
    surge,
    stalled,
    weeksOnSale: weeks.length,
    isNew: weeks.length <= cfg.newProductWeeks,
    vineAdjusted: net.some((x, i) => x !== gross[i]),
    stockoutWeeks,
  }
}

/** 发货量取整：有箱规按整箱（小数部分 ≥ 0.3 进一箱，至少 1 箱），没有箱规取 5 的倍数（至少 5） */
export function roundShipQty(qty, cartonQty, config) {
  const cfg = resolveRestockConfig(config)
  if (!(qty > 0)) return 0
  const carton = finite(cartonQty)
  if (carton > 0) {
    const boxes = qty / carton
    let n = Math.floor(boxes)
    if (boxes - n >= cfg.cartonRoundUp - 1e-9) n += 1
    return Math.max(n, 1) * carton
  }
  const m = cfg.mixedMultiple > 0 ? cfg.mixedMultiple : 1
  return Math.max(m, Math.ceil(qty / m - 1e-9) * m)
}

/**
 * 静态补货结论。text：件数字符串 / '无需补货' / '停滞-人工' / ''（算不出）。
 * flags：需要人工看的提示（下滑 / 爆量 / 停滞 / 新品 / 断货周）。
 */
export function decideRestock({ basis, category, fbaTotal, localWarehouse, orderedQty, cycle, cartonQty, config }) {
  const cfg = resolveRestockConfig(config)
  const empty = { text: '', qty: null, monthly: null, position: null, threshold: null, coverMonths: null, flags: [] }
  const fba = finite(fbaTotal)
  if (category === '放弃' || !basis || !Number.isFinite(fba)) return empty

  const flags = []
  if (basis.declining) flags.push('下滑')
  if (basis.surge) flags.push('爆量')
  if (basis.stalled) flags.push('停滞')
  if (basis.isNew) flags.push('新品')
  if (basis.stockoutWeeks?.length) flags.push('断货周')

  const position = fba + orZero(localWarehouse) + orZero(orderedQty)
  const cycleWeeks = Math.max(0, orZero(cycle))
  const monthly = basis.monthly
  const threshold = monthly * cfg.coverMonths + basis.weekly * cycleWeeks
  const result = {
    ...empty,
    monthly,
    position,
    threshold,
    coverMonths: monthly > 0 ? position / monthly : null,
    flags,
    basis,
    parts: { fbaTotal: fba, localWarehouse: orZero(localWarehouse), orderedQty: orZero(orderedQty), cycleWeeks },
  }
  if (!(monthly > 0) || position >= threshold) return { ...result, text: '无需补货' }
  if (basis.stalled) return { ...result, text: '停滞-人工' }
  const qty = roundShipQty(monthly * cfg.shipMonths, cartonQty, cfg)
  return { ...result, text: String(qty), qty }
}
