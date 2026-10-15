/**
 * 主表的纯展示逻辑：列配置、筛选、父 ASIN 分组排序、表头分组、单元格展示、剪贴板表格。
 * 这里不碰 Vue 状态，App.vue 把“怎么取值”作为参数传进来。
 */
import { sortFullCartonFirst } from './productUpdates.js'
import { toNum } from './weekSnapshot.js'

/* ================= 列配置 ================= */

/**
 * 固定几组列的相对位置：月度指标跟在周销量后面；退货率、退款率跟在广告费率后面
 * （没有广告费率时跟在 ROI 后面）；备注固定在最后。
 */
export function ensureColumnsOrder(cols) {
  const arr = Array.isArray(cols) ? cols.slice() : []

  const salesIdx = arr.findIndex((c) => c?.name === '销量')
  if (salesIdx >= 0) {
    const picked = []
    for (const name of ['月销量', '月销售额', '月订单数', '日均销量', 'Vine赠品销量']) {
      const idx = arr.findIndex((c) => c?.name === name)
      if (idx >= 0) picked.push(arr.splice(idx, 1)[0])
    }
    arr.splice(arr.findIndex((c) => c?.name === '销量') + 1, 0, ...picked)
  }

  const picked = []
  for (const name of ['退货率', '退款率']) {
    const idx = arr.findIndex((c) => c?.name === name)
    if (idx >= 0) picked.push(arr.splice(idx, 1)[0])
  }
  if (picked.length) {
    let anchor = arr.findIndex((c) => c?.name === '广告费率')
    if (anchor < 0) anchor = arr.findIndex((c) => c?.name === 'ROI')
    arr.splice(anchor < 0 ? arr.length : anchor + 1, 0, ...picked)
  }

  const noteIdx = arr.findIndex((c) => c?.name === '备注')
  if (noteIdx >= 0) arr.push(...arr.splice(noteIdx, 1))

  return arr
}

/**
 * 合并列配置：保留浏览器里存过的顺序和显隐（只认当前可用的列），
 * 没存过时按默认顺序放默认可见列；剩下的新列追加在后面，默认列可见、其余隐藏。
 * stored 为空即“重置为默认”。
 */
export function mergeColumnConfig(available, stored, defaultOrder) {
  const availableSet = new Set(available)
  const defaultSet = new Set(defaultOrder)
  const merged = []
  const seen = new Set()
  const push = (name, visible) => {
    merged.push({ name, visible })
    seen.add(name)
  }
  for (const item of Array.isArray(stored) ? stored : []) {
    if (item && typeof item.name === 'string' && availableSet.has(item.name) && !seen.has(item.name)) {
      push(item.name, item.visible !== false)
    }
  }
  if (!merged.length) {
    for (const name of defaultOrder) if (availableSet.has(name) && !seen.has(name)) push(name, true)
  }
  for (const name of available) if (!seen.has(name)) push(name, defaultSet.has(name))
  return ensureColumnsOrder(merged)
}

/** 把 list[idx] 往前 / 往后挪一位，越界返回原数组 */
export function moveItem(list, idx, delta) {
  const next = idx + delta
  if (idx < 0 || idx >= list.length || next < 0 || next >= list.length) return list
  const arr = list.slice()
  const [item] = arr.splice(idx, 1)
  arr.splice(next, 0, item)
  return arr
}

/* ================= 筛选 ================= */

/** 静态补货的值是不是一个具体件数（不是空、不是“无需补货”） */
export function isRestockQty(value) {
  return value !== '' && value != null && value !== '无需补货' && Number.isFinite(toNum(value))
}

/**
 * 补货筛选：
 * need-restock 需要补货 / no-restock 不需要 / ordered 已下单 / local-warehouse 本地仓有货 /
 * need-restock-no-local-no-ordered 需补货且本地仓、已下单都为 0
 */
export function matchesSupplyFilter(filter, { localWarehouse, orderedQty, needRestock }) {
  const local = toNum(localWarehouse)
  const ordered = toNum(orderedQty)
  const hasLocal = Number.isFinite(local) && local > 0
  const hasOrdered = Number.isFinite(ordered) && ordered > 0
  switch (filter) {
    case 'need-restock':
      return needRestock
    case 'no-restock':
      return !needRestock
    case 'ordered':
      return hasOrdered
    case 'local-warehouse':
      return hasLocal
    case 'need-restock-no-local-no-ordered':
      return needRestock && !hasLocal && !hasOrdered
    default:
      return true
  }
}

/* ================= 分组排序 ================= */

export function normalizeAsinKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
}

/**
 * 按父 ASIN 分组。
 * - 组内按毛利润降序，再把整箱产品提前；组头优先取 ASIN 等于父 ASIN 的那一行
 * - 组间按组头毛利润降序，再把含整箱产品的组提前
 * get: { parentKey(row), profit(row), packingMode(row) }
 */
export function groupByParent(rows, get) {
  const map = new Map()
  for (const row of rows) {
    const parent = get.parentKey(row)
    if (!parent) continue
    if (!map.has(parent)) map.set(parent, [])
    map.get(parent).push(row)
  }
  const profit = (row) => {
    const n = get.profit(row)
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY
  }
  const result = []
  for (const [key, members] of map) {
    const sorted = sortFullCartonFirst(
      members.slice().sort((a, b) => profit(b) - profit(a)),
      get.packingMode,
    )
    const header = sorted.find((r) => normalizeAsinKey(r.asin) === key) || sorted[0]
    result.push({ key, header, children: sorted.filter((r) => r !== header) })
  }
  return sortFullCartonFirst(
    result.sort((a, b) => profit(b.header) - profit(a.header)),
    (group) => ([group.header, ...group.children].some((r) => get.packingMode(r) === 'full') ? 'full' : 'mixed'),
  )
}

/** 稳定排序：按组内成员 key 的最小值升序，key 相同保持原顺序 */
export function sortGroupsBy(list, keyOf) {
  const minKey = (g) => [g.header, ...g.children].map(keyOf).sort()[0]
  return list
    .map((g, index) => ({ g, index, key: minKey(g) }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1))
    .map((x) => x.g)
}

/**
 * 表格里一组一行：多成员的组不显示父 ASIN 自己那一行（它只是组名），
 * 只剩父体一行时照常显示。
 */
export function flattenGroups(groups) {
  const rows = []
  for (const g of groups) {
    let members = [g.header, ...g.children]
    if (members.length > 1) {
      const withoutParent = members.filter((r) => normalizeAsinKey(r.asin) !== g.key)
      if (withoutParent.length) members = withoutParent
    }
    members.forEach((row, idx) => rows.push({ row, isGroupHead: idx === 0, groupSize: members.length }))
  }
  return rows
}

/* ================= 表头 / 单元格 ================= */

/** 表头分组：跳过固定列，相邻同组列合并；没有组名的列各占一格 */
export function buildHeaderGroups(displayCols, groupOf) {
  const out = []
  for (const col of displayCols) {
    if (col.fixed) continue
    const name = groupOf[col.name] || ''
    const last = out[out.length - 1]
    if (last && name && last.name === name) last.span += 1
    else out.push({ name, span: 1, first: col.name })
  }
  return out
}

/** 建议补货单元格：第一行件数，第二行「N 天后 · 批次」；7 天内 soon、逾期 bad */
export function suggestedView(suggested, hasPlan) {
  const s = suggested || { state: 'none' }
  if (s.state === 'pending') {
    let when = ''
    let tone = ''
    if (s.inDays != null && s.inDays < 0) {
      when = `逾期 ${-s.inDays} 天 · `
      tone = 'bad'
    } else if (s.inDays != null && s.inDays <= 7) {
      when = s.inDays === 0 ? '今天 · ' : `${s.inDays} 天后 · `
      tone = 'soon'
    }
    return { qty: `${s.qty} 件`, sub: `${when}${s.batch}`, tone }
  }
  if (s.state === 'done') return { qty: '', sub: '已发完', tone: 'done' }
  return { qty: '', sub: hasPlan ? '计划不补' : '', tone: '' }
}

/** 批次进度：已发 / 计划件数 + 百分比；没有计划件数返回 null */
export function progressView(summary) {
  if (!summary?.plannedQty) return null
  return {
    text: `${summary.shippedQty} / ${summary.plannedQty.toLocaleString('en-US')}`,
    pct: (summary.shippedQty / summary.plannedQty) * 100,
  }
}

/* ================= 剪贴板表格 ================= */

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 带边框的 HTML 表格：粘贴进 Word / Excel 保留表格 */
export function buildClipboardTableHtml(header, rows) {
  const cellStyle = 'border:1px solid #999;padding:4px 8px;'
  const headHtml = header
    .map((h) => `<th style="${cellStyle}background:#f0f0f0;font-weight:bold;">${escapeHtml(h)}</th>`)
    .join('')
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((v) => `<td style="${cellStyle}">${escapeHtml(v)}</td>`).join('')}</tr>`)
    .join('')
  return `<table style="border-collapse:collapse;"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
}

/** 转为全角字符：聊天框多为非等宽字体，只有全角字符宽度一致，才能保证各列对齐 */
export function toFullWidth(text) {
  return String(text)
    .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '　')
    .replace(/×/g, 'ｘ')
    .replace(/—/g, '－')
}

/** 纯文本表格：所有字符全角，每列用全角空格补齐到同一长度 */
export function buildClipboardTableText(header, rows) {
  const cells = [header, ...rows].map((row) => row.map(toFullWidth))
  const widths = header.map((_, i) => Math.max(...cells.map((row) => [...row[i]].length)))
  const pad = (v, i) => v + '　'.repeat(widths[i] - [...v].length)
  const line = (row) => row.map(pad).join('｜')
  const divider = widths.map((w) => '－'.repeat(w)).join('＋')
  return [line(cells[0]), divider, ...cells.slice(1).map(line)].join('\n')
}
