/**
 * 周订单利润快照的共用读数逻辑。
 * 周数据形如 { id, columns: string[], rows: [{ asin, values }], notes: { [asin]: string } }，
 * 产品主数据来自 src/data/products/{shopId}.json。
 */

/** 将字符串/数字安全转为数字（去除 $ 逗号 百分号） */
export function toNum(v) {
  if (v == null || v === '') return NaN
  const s = String(v).replace(/[$,\s]/g, '').replace(/%$/, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** “20×15×10cm” → [20, 15, 10]；解析不出三边返回 null */
export function parsePackageDimsCm(sizeText) {
  const raw = String(sizeText || '').trim()
  if (!raw) return null
  const nums = raw.match(/\d+(?:\.\d+)?/g) || []
  if (nums.length < 3) return null
  const dims = nums.slice(0, 3).map((v) => Number(v))
  if (dims.some((n) => !Number.isFinite(n) || n <= 0)) return null
  return dims
}

/** 单品重量与体积重（长×宽×高/6000）比较：实重 / 抛重 */
export function weightTypeText(product) {
  const itemWeightG = toNum(product?.itemWeight)
  if (!Number.isFinite(itemWeightG) || itemWeightG <= 0) return '—'

  const packageSize = product?.packageSize || product?.packageSize1 || product?.packageSize2 || ''
  const dims = parsePackageDimsCm(packageSize)
  if (!dims) return '—'

  const [lengthCm, widthCm, heightCm] = dims
  const volumetricWeightG = (lengthCm * widthCm * heightCm * 1000) / 6000
  return itemWeightG > volumetricWeightG ? '实重' : '抛重'
}

/** 成对字段（包装成本1/2 等）合成 “a / b”，都为空返回 — */
export function pairedText(product, firstKey, secondKey) {
  const values = [product?.[firstKey], product?.[secondKey]].filter((v) => v != null && v !== '')
  return values.join(' / ') || '—'
}

/** 可售+预留 > 月销量×1.5 视为健康 */
export function inventoryHealthText(product) {
  const sellable = toNum(product?.sellable)
  const reserved = toNum(product?.reserved)
  const monthSales = toNum(product?.monthSales)
  const stock = (Number.isFinite(sellable) ? sellable : 0) + (Number.isFinite(reserved) ? reserved : 0)
  const monthly = Number.isFinite(monthSales) ? monthSales : 0
  return stock > monthly * 1.5 ? '健康' : '不足'
}

/** 列名 → 下标 */
export function buildColIndex(columns) {
  const idx = {}
  ;(columns || []).forEach((name, i) => {
    idx[name] = i
  })
  return idx
}

/** 读一格；采购成本在 xlsx 里是负数，按正数展示（与周订单利润页一致） */
export function weekCell(row, colIndex, name) {
  const i = colIndex?.[name]
  if (i == null) return ''
  const raw = row?.values?.[i] ?? ''
  if (name === '采购成本') {
    const n = toNum(raw)
    if (Number.isFinite(n)) return String(Math.abs(n))
  }
  return raw
}

/** 毛利润 / 采购成本，不取整；算不出返回 NaN */
export function weekRoi(row, colIndex) {
  const profit = toNum(weekCell(row, colIndex, '毛利润'))
  const cost = Math.abs(toNum(weekCell(row, colIndex, '采购成本')))
  if (!Number.isFinite(profit) || !Number.isFinite(cost) || cost === 0) return NaN
  return profit / cost
}

/** ROI 展示两位小数；算不出返回 '' */
export function formatRoi(roi) {
  return Number.isFinite(roi) ? roi.toFixed(2) : ''
}

/** 需要标红的值：广告费率>15、退货/退款率>10、毛利润/ROI 为负 */
export function isWeekFieldAlert(name, value) {
  const n = typeof value === 'number' ? value : toNum(value)
  if (!Number.isFinite(n)) return false
  if (name === '广告费率') return n > 15
  if (name === '退货率' || name === '退款率') return n > 10
  if (name === '毛利润' || name === 'ROI') return n < 0
  return false
}

/** 店铺全称 “TZH-主店二号” → 简码 “TZH”（补货清单 CSV 用简码） */
export function shopCodeOf(name) {
  return String(name || '').split('-')[0].trim()
}
