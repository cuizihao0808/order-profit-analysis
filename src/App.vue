<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { computeRestockQty } from './lib/restockRules.js'

const ImportDialog = defineAsyncComponent(() => import('./components/ImportDialog.vue'))

/* ================= 常量 ================= */
const FIXED_COLS = ['亚马逊主图', '品名', 'ASIN']
const COL_CONFIG_KEY = 'opa:column-config:v4'
const SHOP_FILTER_KEY = 'opa:shop-filter:v1'
const SUPPLY_FILTER_KEY = 'opa:supply-filter:v1'
const WEEK_KEY = 'opa:current-week:v1'
const DEV_SESSION_KEY = 'opa:dev-session:v1'
const FIXED_WIDTHS = { 亚马逊主图: 92, 品名: 320, ASIN: 180 }
const EXPAND_COL_WIDTH = 40
const SELECT_COL_WIDTH = 44

/**
 * ASIN 主数据字段（存于 src/data/products/{shopId}.json）
 * 仅保留下列主属性，其余属性从 xlsx 快照取：
 *   asin / parentAsin / name / category / restockCycle / inventory fields
 */
const MASTER_COL_TO_KEY = {
  ASIN: 'asin',
  '父ASIN': 'parentAsin',
  '品名': 'name',
}

/** 产品分类选项 */
const CATEGORY_OPTIONS = ['正常', '新品', '观望', '断货', '放弃']

/**
 * 扩展列定义：
 * - type='edit-select' 可编辑下拉；存于 products.json
 * - type='edit-num'    可编辑数字；存于 products.json
 * - type='calc'        公式计算，不可编辑
 */
const EXTRA_COLS = [
  { name: '备注', key: 'note', type: 'edit-week-text' },
  { name: '产品分类', key: 'category', type: 'edit-select', options: CATEGORY_OPTIONS },
  { name: '月销量', key: 'monthSales', type: 'display-num' },
  { name: '月销售额', key: 'monthRevenue', type: 'display-num' },
  { name: '月订单数', key: 'monthOrders', type: 'display-num' },
  { name: '日均销量', key: 'dailySales', type: 'display-num' },
  { name: 'Vine赠品销量', key: 'vineGiftSales', type: 'display-num' },
  { name: '可售', key: 'sellable', type: 'display-num' },
  { name: '入库中', key: 'inbound', type: 'display-num' },
  { name: '不可售', key: 'unsellable', type: 'display-num' },
  { name: '预留', key: 'reserved', type: 'display-num' },
  { name: 'FBA总量', key: 'fbaTotal', type: 'display-num' },
  { name: '本地仓库', key: 'localWarehouse', type: 'edit-num' },
  { name: '已下单', key: 'orderedQty', type: 'edit-num' },
  { name: '补货用时', key: 'restockCycle', type: 'edit-num' },
  { name: 'ROI', key: 'roi', type: 'calc' },
  { name: '补货数量', key: 'restockQty', type: 'calc' },
]
const EXTRA_COL_NAMES = EXTRA_COLS.map((c) => c.name)
const EXTRA_COL_BY_NAME = Object.fromEntries(EXTRA_COLS.map((c) => [c.name, c]))

/** \u5217\u540d \u2192 \u53ef\u7f16\u8f91\u5b57\u6bb5\u7684 key\uff08\u975e\u53ef\u7f16\u8f91\u8fd4\u56de ''\uff09 */
function editColKey(name) {
  if (name === '品名') return 'name'
  const c = EXTRA_COL_BY_NAME[name]
  if (!c) return ''
  if (c.type === 'edit-select' || c.type === 'edit-num' || c.type === 'edit-week-text') return c.key
  return ''
}
function isEditableCol(name) {
  return !!editColKey(name)
}
function isCalcCol(name) {
  return EXTRA_COL_BY_NAME[name]?.type === 'calc'
}

function displayColName(name) {
  return name === '销量' ? '周销量' : name
}

/** 默认可见列（不含固定列），遵守需求顺序 */
const DEFAULT_VISIBLE_ORDER = [
  '产品分类',
  '销量',
  '月销量',
  '月销售额',
  '月订单数',
  '日均销量',
  'Vine赠品销量',
  '采购成本',
  '毛利润',
  '广告费率',
  'ROI',
  '退货率',
  '退款率',
  '备注',
]
const DEFAULT_VISIBLE_SET = new Set(DEFAULT_VISIBLE_ORDER)

function ensureColumnsOrder(cols) {
  const arr = Array.isArray(cols) ? cols.slice() : []

  const salesIdx = arr.findIndex((c) => c?.name === '销量')
  if (salesIdx >= 0) {
    const tailNames = ['月销量', '月销售额', '月订单数', '日均销量', 'Vine赠品销量']
    const picked = []
    for (const name of tailNames) {
      const idx = arr.findIndex((c) => c?.name === name)
      if (idx >= 0) picked.push(arr.splice(idx, 1)[0])
    }
    arr.splice(salesIdx + 1, 0, ...picked)
  }

  const roiIdx = arr.findIndex((c) => c?.name === 'ROI')
  if (roiIdx >= 0) {
    const targetNames = ['退货率', '退款率']
    const picked = []
    for (const name of targetNames) {
      const idx = arr.findIndex((c) => c?.name === name)
      if (idx >= 0) picked.push(arr.splice(idx, 1)[0])
    }
    arr.splice(roiIdx + 1, 0, ...picked)
  }

  const noteIdx = arr.findIndex((c) => c?.name === '备注')
  if (noteIdx >= 0) {
    const [noteCol] = arr.splice(noteIdx, 1)
    arr.push(noteCol)
  }

  return arr
}

/** 将字符串/数字安全转为数字（去除 $ 逗号 百分号） */
function toNum(v) {
  if (v == null || v === '') return NaN
  const s = String(v).replace(/[$,\s]/g, '').replace(/%$/, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/* ================= 状态 ================= */
const shops = ref([])
const products = ref([])
const weeks = ref([]) // [{ id, filename, startDate, endDate, rowCount, importedAt }]
const currentWeekId = ref('')
const currentWeek = ref(null) // { columns, rows: [{ asin, values }] }
const restockConfig = ref({}) // { monthlyMultiplier, quantityMultiplier, quantityDiscount }

const customCols = ref([]) // [{ name, visible }]
const shopFilter = ref('__all__')
const supplyFilter = ref('__all__')
const asinSearch = ref('')
const status = ref('正在加载...')

const showFieldPanel = ref(false)
const showShopPanel = ref(false)
const showProductPanel = ref(false)
const showImportPanel = ref(false)
const importScan = ref({ unimported: [], imported: [] })
const importResult = ref(null) // 导入完成后的汇总
const importLoading = ref(false)
const importBusy = ref(false)
const exportPdfBusy = ref(false)
const importMessage = ref('')
const resolvePanel = ref({
  show: false,
  weekId: '',
  resultIndex: -1,
  items: [],
  busy: false,
  message: '',
})
const imagePreview = ref({ show: false, urls: [], index: 0, title: '' })
const toast = ref({ show: false, text: '', type: 'success' })
const copiedAsinMap = ref({})
const noteOverflowMap = ref({})
const expandedInventoryRows = ref(new Set())
const selectedAsins = ref(new Set())
const batchCategoryValue = ref('')
const batchCategoryBusy = ref(false)
const filtersCollapsed = ref(false)
const compact13Mode = ref(false)
let toastTimer = null
const copyResetTimers = new Map()

function updateCompact13Mode() {
  if (typeof window === 'undefined') return
  compact13Mode.value = window.innerWidth <= 1512 && window.innerHeight <= 982
}

/* ================= 派生数据 ================= */
const productMap = computed(() => new Map(products.value.map((p) => [p.asin, p])))
const shopIdByName = computed(() => new Map(shops.value.map((s) => [s.name, s.id])))
const productByShopAsin = computed(() => {
  const map = new Map()
  for (const p of products.value) {
    const asin = String(p?.asin || '').trim()
    const shopId = String(p?.shopId || '').trim()
    if (!asin || !shopId) continue
    map.set(`${shopId}::${asin}`, p)
  }
  return map
})

const colIndex = computed(() => {
  const idx = {}
  const cols = currentWeek.value?.columns ?? []
  cols.forEach((name, i) => (idx[name] = i))
  return idx
})

function rowShopName(row) {
  const idx = colIndex.value['店铺']
  if (idx == null) return ''
  return String(row?.values?.[idx] ?? '').trim()
}

function rowShopId(row) {
  const name = rowShopName(row)
  return name ? String(shopIdByName.value.get(name) || '').trim() : ''
}

function rowProduct(row) {
  const asin = String(row?.asin || '').trim()
  if (!asin) return null
  const shopId = rowShopId(row)
  if (shopId) {
    const exact = productByShopAsin.value.get(`${shopId}::${asin}`)
    return exact || null
  }
  return productMap.value.get(asin) || null
}

const allRows = computed(() => currentWeek.value?.rows ?? [])

function rowMatchesSupplyFilter(row) {
  const product = rowProduct(row)
  const localWarehouse = toNum(product?.localWarehouse)
  const orderedQty = toNum(product?.orderedQty)
  const hasLocalWarehouse = Number.isFinite(localWarehouse) && localWarehouse > 0
  const hasOrderedQty = Number.isFinite(orderedQty) && orderedQty > 0
  const needRestock = hasRestockNeed(row)

  switch (supplyFilter.value) {
    case 'need-restock':
      return needRestock
    case 'no-restock':
      return !needRestock
    case 'ordered':
      return hasOrderedQty
    case 'local-warehouse':
      return hasLocalWarehouse
    case 'need-restock-no-local-no-ordered':
      return needRestock && !hasLocalWarehouse && !hasOrderedQty
    default:
      return true
  }
}

const filteredRows = computed(() => {
  let rows = allRows.value
  if (shopFilter.value !== '__all__') {
    rows = rows.filter((r) => getCell(r, '店铺') === shopFilter.value)
  }
  rows = rows.filter(rowMatchesSupplyFilter)

  const q = asinSearch.value.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => {
    const asin = String(getCell(r, 'ASIN') || '').toLowerCase()
    const fnsku = String(getCell(r, 'FNSKU') || '').toLowerCase()
    return asin.includes(q) || fnsku.includes(q)
  })
})

function getWeekNote(asin) {
  if (!asin) return ''
  const notes = currentWeek.value?.notes
  if (!notes || typeof notes !== 'object') return ''
  const v = notes[asin]
  return v == null ? '' : String(v)
}

async function patchWeekNote(asin, note) {
  if (!currentWeekId.value || !asin) return
  const text = (note || '').trim()
  if (!currentWeek.value || typeof currentWeek.value !== 'object') return

  const beforeNotes = { ...(currentWeek.value.notes || {}) }
  const nextNotes = { ...beforeNotes }
  if (text) nextNotes[asin] = text
  else delete nextNotes[asin]
  currentWeek.value = { ...currentWeek.value, notes: nextNotes }

  try {
    const r = await fetch(
      `/api/weeks/${encodeURIComponent(currentWeekId.value)}/notes/${encodeURIComponent(asin)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: text }),
      },
    )
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || '保存失败')
    }
  } catch (e) {
    currentWeek.value = { ...currentWeek.value, notes: beforeNotes }
    showToast('备注保存失败：' + (e.message || e), 'error')
  }
}

/** 单元格取值：
 *  1. 主字段（品名/ASIN/父ASIN）优先取 products.json，其次 xlsx
 *  2. 扩展字段（产品分类/库存明细/补货用时）取 products.json
 *  3. ROI = ROUND(毛利润 / 采购成本, 2)
 *  4. 补货数量 = IF(FBA总量 < 销量*(12+补货用时), 销量*4*0.8, '无需补货')
 *  5. 其余取 xlsx 快照
 */
function getCell(row, colName) {
  if (!row) return ''
  const product = rowProduct(row)

  if (colName === 'FNSKU') {
    const fromProduct = String(product?.fnsku || '').trim()
    if (fromProduct) return fromProduct
    const i = colIndex.value[colName]
    return i != null ? row.values[i] ?? '' : ''
  }

  const masterKey = MASTER_COL_TO_KEY[colName]
  if (masterKey) {
    const v = product?.[masterKey]
    if (v != null && v !== '') return String(v)
    const i = colIndex.value[colName]
    return i != null ? row.values[i] ?? '' : ''
  }

  const extra = EXTRA_COL_BY_NAME[colName]
  if (extra) {
    if (extra.type === 'edit-week-text') {
      return getWeekNote(row.asin)
    }
    if (extra.type === 'calc') {
      if (extra.key === 'roi') {
        const profit = toNum(row.values[colIndex.value['毛利润']])
        const cost = Math.abs(toNum(row.values[colIndex.value['采购成本']]))
        if (!Number.isFinite(profit) || !Number.isFinite(cost) || cost === 0) return ''
        return (Math.round((profit / cost) * 100) / 100).toFixed(2)
      }
      if (extra.key === 'restockQty') {
        return computeRestockQty({
          fbaTotal: toNum(product?.fbaTotal),
          sales: toNum(row.values[colIndex.value['销量']]),
          cycle: toNum(product?.restockCycle),
          config: restockConfig.value,
        })
      }
      return ''
    }
    // edit-*: 从 products.json 读
    const v = product?.[extra.key]
    return v == null ? '' : String(v)
  }

  const i = colIndex.value[colName]
  if (i == null) return ''
  const raw = row.values[i] ?? ''
  // 采购成本在 xlsx 里是负数，按正数展示
  if (colName === '采购成本') {
    const n = toNum(raw)
    if (Number.isFinite(n)) return String(Math.abs(n))
  }
  return raw
}

function asinValue(row) {
  return String(getCell(row, 'ASIN') || '').trim()
}

function asinUrl(row) {
  const asin = asinValue(row)
  return asin ? `https://www.amazon.com/dp/${encodeURIComponent(asin)}` : ''
}

function productImageUrl(row) {
  const first = productImageUrls(row)[0] || ''
  return String(first).trim()
}

function amazonMainImageUrl(row) {
  const product = rowProduct(row) || {}
  const fromMain = String(product.amazonMainImage || '').trim()
  if (fromMain) return fromMain
  return ''
}

function displayProductName(row) {
  return String(getCell(row, '品名') || '').trim()
}

function displayProductTitle(row) {
  const title = String(getCell(row, '商品标题') || getCell(row, '标题') || '').trim()
  return title
}

function productImageUrls(row) {
  const product = rowProduct(row) || {}
  const urls = []

  const main = String(product.amazonMainImage || '').trim()
  if (main) urls.push(main)

  if (Array.isArray(product.productImages)) {
    for (const u of product.productImages) {
      const s = String(u || '').trim()
      if (s) urls.push(s)
    }
  }

  const fromProduct = String(product.productImage || '').trim()
  if (fromProduct) urls.push(fromProduct)

  const fromCell = String(getCell(row, '产品图片') || '').trim()
  if (fromCell) urls.push(fromCell)

  return Array.from(new Set(urls))
}

function inventoryDetailImageUrls(row) {
  const product = rowProduct(row) || {}
  const urls = []

  if (Array.isArray(product.listingDetailImages)) {
    for (const u of product.listingDetailImages) {
      const s = String(u || '').trim()
      if (s) urls.push(s)
    }
  }

  if (!urls.length && Array.isArray(product.productImages)) {
    const main = String(product.amazonMainImage || '').trim()
    for (const u of product.productImages) {
      const s = String(u || '').trim()
      if (!s || s === main) continue
      urls.push(s)
    }
  }

  return Array.from(new Set(urls))
}

function openImagePreview(row, index = 0) {
  const urls = productImageUrls(row)
  if (!urls.length) return
  const safeIndex = Math.min(Math.max(Number(index) || 0, 0), urls.length - 1)
  imagePreview.value = {
    show: true,
    urls,
    index: safeIndex,
    title: `${asinValue(row)} 产品图片`,
  }
}

function openInventoryDetailImagePreview(row, index = 0) {
  const urls = inventoryDetailImageUrls(row)
  if (!urls.length) return
  const safeIndex = Math.min(Math.max(Number(index) || 0, 0), urls.length - 1)
  imagePreview.value = {
    show: true,
    urls,
    index: safeIndex,
    title: `${asinValue(row)} 库存详情图片`,
  }
}

function closeImagePreview() {
  imagePreview.value = { show: false, urls: [], index: 0, title: '' }
}

const currentPreviewImageUrl = computed(() => {
  if (!imagePreview.value.urls.length) return ''
  return imagePreview.value.urls[imagePreview.value.index] || ''
})

function prevPreviewImage() {
  if (imagePreview.value.urls.length <= 1) return
  imagePreview.value = {
    ...imagePreview.value,
    index:
      (imagePreview.value.index - 1 + imagePreview.value.urls.length) %
      imagePreview.value.urls.length,
  }
}

function nextPreviewImage() {
  if (imagePreview.value.urls.length <= 1) return
  imagePreview.value = {
    ...imagePreview.value,
    index: (imagePreview.value.index + 1) % imagePreview.value.urls.length,
  }
}

async function copyAsin(row) {
  const asin = asinValue(row)
  if (!asin) return
  try {
    await writeClipboard(asin)
    copiedAsinMap.value = { ...copiedAsinMap.value, [asin]: true }
    if (copyResetTimers.has(asin)) clearTimeout(copyResetTimers.get(asin))
    const timer = setTimeout(() => {
      const next = { ...copiedAsinMap.value }
      delete next[asin]
      copiedAsinMap.value = next
      copyResetTimers.delete(asin)
    }, 1300)
    copyResetTimers.set(asin, timer)
    showToast(`已复制 ASIN: ${asin}`)
  } catch {
    showToast('复制失败，请手动复制', 'error')
  }
}

function isAsinCopied(row) {
  const asin = asinValue(row)
  return !!(asin && copiedAsinMap.value[asin])
}

function updateNoteOverflow(asin, event) {
  if (!asin) return
  const target = event?.target
  const current = event?.currentTarget
  const input = target instanceof HTMLInputElement
    ? target
    : current instanceof HTMLElement
      ? current.querySelector('input')
      : null
  if (!(input instanceof HTMLInputElement)) return
  const text = String(input.value || '').trim()
  const overflow = !!text && input.scrollWidth > input.clientWidth + 1
  noteOverflowMap.value = { ...noteOverflowMap.value, [asin]: overflow }
}

function shouldShowNoteTooltip(asin) {
  if (!asin) return false
  const note = getWeekNote(asin)
  return !!note && !!noteOverflowMap.value[asin]
}

function toggleInventoryRow(asin) {
  if (!asin) return
  const current = expandedInventoryRows.value
  if (current.has(asin)) {
    expandedInventoryRows.value = new Set()
    return
  }
  expandedInventoryRows.value = new Set([asin])
}

function isInventoryRowExpanded(asin) {
  return !!(asin && expandedInventoryRows.value.has(asin))
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'absolute'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

/** 判断某行是否被标记为「放弃」 */
function isAbandoned(row) {
  if (!row) return false
  return rowProduct(row)?.category === '放弃'
}

/** 单元格告警高亮：
 *  - 广告费率 > 15%       → 红
 *  - 毛利润 / ROI 为负数  → 红
 *  - 补货数量 是数字      → 黄
 */
function cellAlertClass(row, colName) {
  if (!row) return ''
  if (colName === '广告费率' || colName === '退款率' || colName === '退货率') {
    const n = toNum(getCell(row, '广告费率'))
    if (colName === '广告费率' && Number.isFinite(n) && n > 15) return 'alert-red'
    const rate = toNum(getCell(row, colName))
    if ((colName === '退款率' || colName === '退货率') && Number.isFinite(rate) && rate > 10) {
      return 'alert-red'
    }
    return ''
  }
  if (colName === '毛利润') {
    const n = toNum(row.values[colIndex.value['毛利润']])
    if (Number.isFinite(n) && n < 0) return 'alert-red'
    return ''
  }
  if (colName === 'ROI') {
    const v = getCell(row, 'ROI')
    const n = toNum(v)
    if (Number.isFinite(n) && n < 0) return 'alert-red'
    return ''
  }
  if (colName === '补货数量') {
    const v = getCell(row, '补货数量')
    if (v !== '' && v !== '无需补货' && Number.isFinite(toNum(v))) return 'alert-yellow'
    return ''
  }
  return ''
}

function hasRestockNeed(row) {
  if (!row) return false
  const v = getCell(row, '补货数量')
  return v !== '' && v !== '无需补货' && Number.isFinite(toNum(v))
}

function profitValue(row) {
  if (!row) return Number.NEGATIVE_INFINITY
  const n = toNum(getCell(row, '毛利润'))
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY
}

function normalizeAsinKey(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
}

function groupParentKey(row) {
  if (!row) return ''
  const rawParent = colIndex.value['父ASIN'] != null ? row.values[colIndex.value['父ASIN']] : ''
  const parent = normalizeAsinKey(rawParent)
  if (parent) return parent
  const fromProduct = normalizeAsinKey(rowProduct(row)?.parentAsin)
  if (fromProduct) return fromProduct
  return normalizeAsinKey(row.asin) || normalizeAsinKey(getCell(row, 'ASIN'))
}

function rowAsinKey(row) {
  return normalizeAsinKey(row?.asin)
}

/**
 * 按 父ASIN 分组
 * - 同父 ASIN 的记录强制聚合为同一组
 * - 主表不展示「放弃」分类的 ASIN
 */
const groups = computed(() => {
  const list = filteredRows.value.filter((row) => !isAbandoned(row))
  if (!list.length) return []

  const map = new Map()
  for (const row of list) {
    const parent = groupParentKey(row)
    if (!parent) continue
    if (!map.has(parent)) map.set(parent, [])
    map.get(parent).push(row)
  }

  const result = []
  for (const [key, rows] of map) {
    const sorted = rows.slice().sort((a, b) => profitValue(b) - profitValue(a))
    let headerRow = sorted.find((r) => rowAsinKey(r) === key)
    if (!headerRow) headerRow = sorted[0]
    let children
    children = sorted.filter((r) => r !== headerRow)
    result.push({ key, header: headerRow, children })
  }
  return result.sort((a, b) => profitValue(b.header) - profitValue(a.header))
})

const visibleRows = computed(() => {
  const rows = []
  for (const g of groups.value) {
    rows.push(g.header)
    rows.push(...g.children)
  }
  return rows
})

const tableRows = computed(() => {
  const rows = []
  for (const g of groups.value) {
    let members = [g.header, ...g.children]
    if (members.length > 1) {
      members = members.filter((r) => rowAsinKey(r) !== g.key)
      if (!members.length) members = [g.header, ...g.children]
    }
    members.forEach((row, idx) => {
      rows.push({ row, isGroupHead: idx === 0, groupSize: members.length })
    })
  }
  return rows
})

const visibleAsinList = computed(() => {
  const list = []
  const seen = new Set()
  for (const item of tableRows.value) {
    const asin = String(item?.row?.asin || '').trim()
    if (!asin || seen.has(asin)) continue
    seen.add(asin)
    list.push(asin)
  }
  return list
})

const selectedAsinCount = computed(() => selectedAsins.value.size)

const selectedPackageAndOrderedRows = computed(() => {
  const rows = []
  for (const asin of selectedAsins.value) {
    const product = productMap.value.get(asin)
    if (!product) continue
    const packageSize = String(
      product.packageSize || product.packageSize1 || product.packageSize2 || '',
    ).trim()
    const orderedQtyRaw = product.orderedQty
    const orderedQty = orderedQtyRaw == null || orderedQtyRaw === '' ? 0 : Number(orderedQtyRaw)
    rows.push({
      asin,
      packageSize: packageSize || '—',
      orderedQty: Number.isFinite(orderedQty) ? orderedQty : 0,
    })
  }
  return rows.sort((a, b) => a.asin.localeCompare(b.asin))
})

const isAllVisibleAsinsSelected = computed(() => {
  const list = visibleAsinList.value
  if (!list.length) return false
  for (const asin of list) {
    if (!selectedAsins.value.has(asin)) return false
  }
  return true
})

function isAsinSelected(asin) {
  return selectedAsins.value.has(String(asin || '').trim())
}

function toggleAsinSelected(asin, checked) {
  const key = String(asin || '').trim()
  if (!key) return
  const next = new Set(selectedAsins.value)
  if (checked) next.add(key)
  else next.delete(key)
  selectedAsins.value = next
}

function toggleSelectAllVisible(checked) {
  const next = new Set(selectedAsins.value)
  for (const asin of visibleAsinList.value) {
    if (checked) next.add(asin)
    else next.delete(asin)
  }
  selectedAsins.value = next
}

function clearSelectedAsins() {
  selectedAsins.value = new Set()
}

const nonAbandonedVisibleAsins = computed(() => {
  const set = new Set()
  for (const row of visibleRows.value) {
    const category = rowProduct(row)?.category || '正常'
    if (category === '放弃') continue
    const asin = asinValue(row)
    if (asin) set.add(asin)
  }
  return Array.from(set)
})

const canExportLocalWarehousePdf = computed(
  () => shopFilter.value !== '__all__' && supplyFilter.value === 'local-warehouse' && visibleRows.value.length > 0,
)

const exportLocalWarehouseDisabledReason = computed(() => {
  if (canExportLocalWarehousePdf.value) return ''
  if (shopFilter.value === '__all__') return '请先选择单个店铺'
  if (supplyFilter.value !== 'local-warehouse') return '请切换到“本地仓库有的”筛选'
  if (!visibleRows.value.length) return '当前筛选结果为空，无法导出'
  return '当前条件不满足导出'
})

function productField(row, key, fallback = '') {
  const value = rowProduct(row)?.[key]
  return value == null || value === '' ? fallback : value
}

function buildLocalWarehousePdfPayload() {
  const rows = visibleRows.value.slice()
  const exportShopName = shopMdNameByName.value.get(shopFilter.value) || shopFilter.value
  const payloadRows = rows.map((row) => ({
    asin: asinValue(row),
    fnsku: String(getCell(row, 'FNSKU') || '').trim(),
    name: String(getCell(row, '品名') || '').trim(),
    localWarehouse: Number(productField(row, 'localWarehouse', 0) || 0),
    packageSize: String(productField(row, 'packageSize') || productField(row, 'packageSize1') || productField(row, 'packageSize2') || '').trim(),
    packageType: String(productField(row, 'packageType') || productField(row, 'packageType1') || productField(row, 'packageType2') || '').trim(),
    itemWeight: String(productField(row, 'itemWeight') || '').trim(),
    images: productImageUrls(row),
  }))
  return {
    weekId: String(currentWeekId.value || '').trim(),
    shopName: exportShopName,
    rows: payloadRows,
  }
}

function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

async function exportLocalWarehousePdf() {
  if (!canExportLocalWarehousePdf.value) {
    showToast('请先选择单个店铺，并切换到“本地仓库有的”筛选', 'warn')
    return
  }
  if (exportPdfBusy.value) return

  exportPdfBusy.value = true
  const exportShopName = shopMdNameByName.value.get(shopFilter.value) || shopFilter.value
  const safeShopName = exportShopName.replace(/[\\/:*?"<>|]/g, '-').trim() || '店铺'
  const safeWeek = (currentWeekId.value || '周次').replace(/[\\/:*?"<>|]/g, '-')
  const filename = `${safeWeek}-${safeShopName}-本地仓库.pdf`

  try {
    const response = await fetch('/api/export/local-warehouse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalWarehousePdfPayload()),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || '导出失败')
    }
    const blob = await response.blob()
    downloadBlobFile(filename, blob)
    showToast(`已导出 ${visibleRows.value.length} 行本地仓库 PDF`, 'success')
  } catch (e) {
    showToast(`导出 PDF 失败：${String(e?.message || e)}`, 'error')
  } finally {
    exportPdfBusy.value = false
  }
}

async function copyNonAbandonedAsins() {
  const asins = nonAbandonedVisibleAsins.value
  if (!asins.length) {
    showToast('当前没有可复制的 ASIN（放弃除外）', 'warn')
    return
  }
  try {
    await writeClipboard(asins.join('\n'))
    showToast(`已复制 ${asins.length} 个 ASIN（放弃除外）`)
  } catch {
    showToast('批量复制失败，请手动复制', 'error')
  }
}

async function copySelectedPackageAndOrdered() {
  const rows = selectedPackageAndOrderedRows.value
  if (!rows.length) {
    showToast('请先勾选产品', 'warn')
    return
  }
  const content = rows.map((x) => `${x.packageSize}\t${x.orderedQty}`).join('\n')
  try {
    await writeClipboard(content)
    showToast(`已复制 ${rows.length} 条包装尺寸和已下单数量`, 'success')
  } catch {
    showToast('复制失败，请重试', 'error')
  }
}

const displayCols = computed(() => {
  const cols = currentWeek.value?.columns ?? []
  const list = []
  for (const name of FIXED_COLS) list.push({ name, fixed: true })
  for (const col of customCols.value) {
    if (!col.visible) continue
    // 只渲染 xlsx 有的列 或 EXTRA_COL_NAMES 中的列
    if (cols.includes(col.name) || EXTRA_COL_NAMES.includes(col.name)) {
      list.push({ name: col.name, fixed: false })
    }
  }
  return list
})

const numericColumns = computed(() => {
  const result = {}
  for (const col of displayCols.value) {
    if (FIXED_COLS.includes(col.name)) {
      result[col.name] = false
      continue
    }
    let hasNumber = false
    let allNumeric = true
    outer: for (const g of groups.value) {
      for (const row of [g.header, ...g.children]) {
        const v = String(getCell(row, col.name) ?? '').trim()
        if (v === '') continue
        const normalized = v.replace(/,/g, '').replace(/%$/, '')
        if (Number.isFinite(Number(normalized))) hasNumber = true
        else {
          allNumeric = false
          break outer
        }
      }
    }
    result[col.name] = hasNumber && allNumeric
  }
  return result
})

const groupCount = computed(() => groups.value.length)
const asinCount = computed(() => tableRows.value.length)
const shopNames = computed(() => shops.value.map((s) => s.name))
const shopMdNameByName = computed(() => {
  const map = new Map()
  for (const shop of shops.value) {
    const mdName = String(shop?.mdExportName || '').trim()
    map.set(shop.name, mdName || shop.name)
  }
  return map
})

function fixedLeft(displayIndex) {
  let left = compact13Mode.value ? 38 : SELECT_COL_WIDTH
  const widthMap = compact13Mode.value
    ? { 亚马逊主图: 76, 品名: 260, ASIN: 150 }
    : FIXED_WIDTHS
  for (let i = 0; i < displayIndex; i++) {
    const name = FIXED_COLS[i]
    left += widthMap[name] ?? 120
  }
  return left + 'px'
}

function fixedColStyle(displayIndex, colName) {
  const widthMap = compact13Mode.value
    ? { 亚马逊主图: 76, 品名: 260, ASIN: 150 }
    : FIXED_WIDTHS
  const width = widthMap[colName] ?? 120
  return {
    left: fixedLeft(displayIndex),
    width: width + 'px',
    minWidth: width + 'px',
    maxWidth: width + 'px',
  }
}

/* ================= 加载 ================= */
async function loadShops() {
  const r = await fetch('/api/shops', { cache: 'no-store' })
  shops.value = r.ok ? await r.json() : []
}

async function loadProducts() {
  const r = await fetch('/api/products', { cache: 'no-store' })
  products.value = r.ok ? await r.json() : []
}

async function loadWeeks() {
  const r = await fetch('/api/weeks', { cache: 'no-store' })
  weeks.value = r.ok ? await r.json() : []
}

async function loadRestockConfig() {
  const r = await fetch('/api/restock-config', { cache: 'no-store' })
  restockConfig.value = r.ok ? await r.json() : {}
}


async function loadCurrentWeek() {
  if (!currentWeekId.value) {
    currentWeek.value = null
    return
  }
  const r = await fetch(`/api/weeks/${encodeURIComponent(currentWeekId.value)}`, {
    cache: 'no-store',
  })
  if (r.ok) {
    currentWeek.value = await r.json()
    if (!currentWeek.value.notes || typeof currentWeek.value.notes !== 'object') {
      currentWeek.value.notes = {}
    }
    mergeCustomCols(currentWeek.value.columns)
  } else {
    currentWeek.value = null
  }
}

async function bootstrap() {
  try {
    status.value = '正在加载...'
    await Promise.all([loadShops(), loadProducts(), loadWeeks(), loadRestockConfig()])

    // 选择当前周：localStorage > 最新
    const stored = localStorage.getItem(WEEK_KEY)
    const preferred = weeks.value.find((w) => w.id === stored)
    currentWeekId.value = preferred?.id || weeks.value[0]?.id || ''
    await loadCurrentWeek()

    updateStatus()
  } catch (e) {
    status.value = e.message || '加载失败'
  }
}

function updateStatus() {
  if (!weeks.value.length) {
    status.value = '尚未导入任何周数据，请点击「扫描并导入」'
  } else {
    const supplyFilterText = {
      '__all__': '全部',
      'need-restock': '需要补货',
      'no-restock': '不需要补货',
      ordered: '已经下单的',
      'local-warehouse': '本地仓库有的',
      'need-restock-no-local-no-ordered': '需要补货且本地没有和没有下单的',
    }[supplyFilter.value]
    status.value = `订单 ${allRows.value.length} 行 · 当前 ${filteredRows.value.length} 行 · 店铺 ${shops.value.length} · ASIN ${products.value.length} · 补货筛选 ${supplyFilterText}`
  }
}

function showToast(text, type = 'success') {
  toast.value = { show: true, text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value.show = false
  }, 2400)
}

async function clearCacheOnDevServerRestart() {
  if (!import.meta.env.DEV) return
  try {
    const r = await fetch('/api/dev-session', { cache: 'no-store' })
    if (!r.ok) return
    const data = await r.json()
    const sessionId = String(data?.sessionId || '')
    if (!sessionId) return
    const prev = localStorage.getItem(DEV_SESSION_KEY) || ''
    if (prev === sessionId) return

    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('opa:')) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
    localStorage.setItem(DEV_SESSION_KEY, sessionId)
  } catch {
    // ignore cache clear failures in dev
  }
}

/* ================= 列配置持久化 ================= */
function loadStoredConfig() {
  try {
    const raw = localStorage.getItem(COL_CONFIG_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => x && typeof x.name === 'string')
  } catch {
    return []
  }
}

function saveCustomCols() {
  try {
    localStorage.setItem(COL_CONFIG_KEY, JSON.stringify(customCols.value))
  } catch {
    /* ignore */
  }
}

function mergeCustomCols(xlsxCols) {
  const available = [
    ...(xlsxCols || []).filter((h) => h && !FIXED_COLS.includes(h)),
    ...EXTRA_COL_NAMES,
  ]
  const availableSet = new Set(available)
  const stored = loadStoredConfig()

  const merged = []
  const seen = new Set()
  for (const item of stored) {
    if (availableSet.has(item.name) && !seen.has(item.name)) {
      merged.push({ name: item.name, visible: item.visible !== false })
      seen.add(item.name)
    }
  }
  // 首次加载：按默认顺序先插入默认可见列，其余默认隐藏
  if (!stored.length) {
    for (const name of DEFAULT_VISIBLE_ORDER) {
      if (availableSet.has(name) && !seen.has(name)) {
        merged.push({ name, visible: true })
        seen.add(name)
      }
    }
  }
  for (const name of available) {
    if (!seen.has(name)) {
      merged.push({ name, visible: DEFAULT_VISIBLE_SET.has(name) })
    }
  }
  customCols.value = ensureColumnsOrder(merged)
}

/* ================= 交互 ================= */

function moveCol(idx, delta) {
  const next = idx + delta
  if (next < 0 || next >= customCols.value.length) return
  const arr = customCols.value.slice()
  const [item] = arr.splice(idx, 1)
  arr.splice(next, 0, item)
  customCols.value = arr
}
function toggleColVisible(idx) {
  const arr = customCols.value.slice()
  arr[idx] = { ...arr[idx], visible: !arr[idx].visible }
  customCols.value = arr
}
function setAllColsVisible(visible) {
  customCols.value = customCols.value.map((c) => ({ ...c, visible }))
}
function resetColConfig() {
  const xlsxCols = currentWeek.value?.columns ?? []
  const available = [
    ...xlsxCols.filter((h) => h && !FIXED_COLS.includes(h)),
    ...EXTRA_COL_NAMES,
  ]
  const availableSet = new Set(available)
  const list = []
  const seen = new Set()
  for (const name of DEFAULT_VISIBLE_ORDER) {
    if (availableSet.has(name) && !seen.has(name)) {
      list.push({ name, visible: true })
      seen.add(name)
    }
  }
  for (const name of available) {
    if (!seen.has(name)) list.push({ name, visible: false })
  }
  customCols.value = ensureColumnsOrder(list)
}

/* ================= 店铺 CRUD ================= */
const shopForm = ref({ id: '', name: '', country: '', note: '' })
const shopEditingId = ref('')
const shopMessage = ref('')
function resetShopForm() {
  shopForm.value = { id: '', name: '', country: '', note: '' }
  shopEditingId.value = ''
}
function pickShop(shop) {
  shopEditingId.value = shop.id
  shopForm.value = {
    id: shop.id,
    name: shop.name ?? '',
    country: shop.country ?? '',
    note: shop.note ?? '',
  }
}
async function saveShop() {
  const name = shopForm.value.name.trim()
  if (!name) return (shopMessage.value = '店铺名称不能为空')
  const body = {
    name,
    country: shopForm.value.country.trim(),
    note: shopForm.value.note.trim(),
  }
  try {
    const url = shopEditingId.value
      ? `/api/shops/${encodeURIComponent(shopEditingId.value)}`
      : '/api/shops'
    const r = await fetch(url, {
      method: shopEditingId.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || '保存失败')
    }
    await loadShops()
    resetShopForm()
    shopMessage.value = '已保存'
  } catch (e) {
    shopMessage.value = e.message
  }
}
async function deleteShop(shop) {
  if (!confirm(`确定删除店铺「${shop.name}」？`)) return
  const r = await fetch(`/api/shops/${encodeURIComponent(shop.id)}`, { method: 'DELETE' })
  if (r.ok) {
    await loadShops()
    if (shopFilter.value === shop.name) shopFilter.value = '__all__'
  }
}

/* ================= 产品(ASIN) CRUD ================= */
const productSearch = ref('')
const productForm = ref({
  asin: '',
  parentAsin: '',
  name: '',
  shopId: '',
})
const productEditing = ref(false)
const productMessage = ref('')

const shopNameById = computed(() => new Map(shops.value.map((s) => [s.id, s.name])))

const filteredProducts = computed(() => {
  const q = productSearch.value.trim().toLowerCase()
  if (!q) return products.value
  return products.value.filter((p) =>
    [p.asin, p.name, p.parentAsin, shopNameById.value.get(p.shopId)].some((v) =>
      (v || '').toString().toLowerCase().includes(q),
    ),
  )
})

function resetProductForm() {
  productForm.value = {
    asin: '',
    parentAsin: '',
    name: '',
    shopId: shops.value[0]?.id || '',
  }
  productEditing.value = false
}
function pickProduct(p) {
  productForm.value = {
    asin: p.asin,
    parentAsin: p.parentAsin || '',
    name: p.name || '',
    shopId: p.shopId || '',
  }
  productEditing.value = true
}
async function saveProduct() {
  const asin = productForm.value.asin.trim()
  if (!asin) return (productMessage.value = 'ASIN 不能为空')
  if (!productForm.value.shopId) return (productMessage.value = '请选择店铺')
  try {
    const url = productEditing.value
      ? `/api/products/${encodeURIComponent(asin)}`
      : '/api/products'
    const r = await fetch(url, {
      method: productEditing.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asin,
        parentAsin: productForm.value.parentAsin.trim(),
        name: productForm.value.name.trim(),
        shopId: productForm.value.shopId,
      }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || '保存失败')
    }
    await loadProducts()
    productMessage.value = '已保存'
  } catch (e) {
    productMessage.value = e.message
  }
}
async function deleteProduct(p) {
  if (!confirm(`确定删除 ASIN「${p.asin}」的主数据？`)) return
  const r = await fetch(`/api/products/${encodeURIComponent(p.asin)}`, { method: 'DELETE' })
  if (r.ok) {
    await loadProducts()
    if (productForm.value.asin === p.asin) resetProductForm()
  }
}

/** 内联编辑：直接改 products.json 的指定 ASIN 的某个字段 */
async function patchProduct(asin, patch, options = {}) {
  if (!asin) return
  const preferredShopId = String(options?.shopId || '').trim()
  const targets = [{ asin, patch, shopId: preferredShopId }]

  // 联动：父体改为「放弃」时，所有子体同步「放弃」
  if (patch.category === '放弃') {
    for (const p of products.value) {
      if (p.parentAsin === asin && p.asin !== asin && p.category !== '放弃') {
        targets.push({ asin: p.asin, patch: { category: '放弃' }, shopId: String(p.shopId || '').trim() })
      }
    }
  }

  // 乐观更新：先改本地
  const backups = []
  for (const t of targets) {
    const idx = products.value.findIndex(
      (p) => p.asin === t.asin && (!t.shopId || String(p.shopId || '').trim() === t.shopId),
    )
    if (idx < 0) continue
    backups.push({ idx, before: { ...products.value[idx] } })
    products.value[idx] = { ...products.value[idx], ...t.patch }
  }
  if (!backups.length) return

  try {
    await Promise.all(
      targets.map((t) =>
        fetch(`/api/products/${encodeURIComponent(t.asin)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t.shopId ? { ...t.patch, shopId: t.shopId } : t.patch),
        }).then((r) => {
          if (!r.ok) throw new Error(`save failed: ${t.asin}`)
        }),
      ),
    )
  } catch (e) {
    // 回滚
    for (const b of backups) products.value[b.idx] = b.before
    alert('保存失败：' + (e.message || e))
  }
}

async function applyBatchCategoryChange() {
  const targetCategory = String(batchCategoryValue.value || '').trim()
  if (!targetCategory) {
    showToast('请先选择目标分类', 'warn')
    return
  }
  const selected = Array.from(selectedAsins.value)
  if (!selected.length) {
    showToast('请先勾选要批量修改的 ASIN', 'warn')
    return
  }

  const targets = selected.filter((asin) => {
    const current = String(productMap.value.get(asin)?.category || '正常').trim()
    return current !== targetCategory
  })
  if (!targets.length) {
    showToast('勾选项分类已是目标值，无需修改', 'warn')
    return
  }

  batchCategoryBusy.value = true
  try {
    for (const asin of targets) {
      await patchProduct(asin, { category: targetCategory })
    }
    showToast(`已批量修改 ${targets.length} 个 ASIN 的分类`, 'success')
    selectedAsins.value = new Set()
  } finally {
    batchCategoryBusy.value = false
  }
}

async function markOrderedArrived(row) {
  const asin = String(row?.asin || '').trim()
  if (!asin) return
  const product = rowProduct(row)
  const localWarehouse = toNum(product?.localWarehouse)
  const orderedQty = toNum(product?.orderedQty)
  if (!Number.isFinite(orderedQty) || orderedQty <= 0) return

  await patchProduct(asin, {
    localWarehouse: (Number.isFinite(localWarehouse) ? localWarehouse : 0) + orderedQty,
    orderedQty: 0,
  }, { shopId: rowShopId(row) })
}

async function markLocalShipped(row) {
  const asin = String(row?.asin || '').trim()
  if (!asin) return
  const product = rowProduct(row)
  const localWarehouse = toNum(product?.localWarehouse)
  if (!Number.isFinite(localWarehouse) || localWarehouse <= 0) return

  await patchProduct(asin, {
    localWarehouse: 0,
  }, { shopId: rowShopId(row) })
}

/* ================= 导入 ================= */
async function openImport() {
  showImportPanel.value = true
  importResult.value = null
  importMessage.value = '正在扫描周目录...'
  importLoading.value = true
  try {
    const r = await fetch('/api/scan', { cache: 'no-store' })
    importScan.value = r.ok ? await r.json() : { unimported: [], imported: [] }
    if (!Array.isArray(importScan.value.imported) || !importScan.value.imported.length) {
      const wk = await fetch('/api/weeks', { cache: 'no-store' })
      const weekList = wk.ok ? await wk.json() : []
      importScan.value = {
        ...importScan.value,
        imported: Array.isArray(weekList) ? weekList : [],
      }
    }
    importMessage.value = importScan.value.unimported.length
      ? `扫描完成，发现 ${importScan.value.unimported.length} 个待导入文件`
      : '扫描完成，没有待导入文件'
  } catch (e) {
    importScan.value = { unimported: [], imported: [] }
    importMessage.value = e.message || '扫描失败'
  } finally {
    importLoading.value = false
  }
}

function closeImportPanel() {
  showImportPanel.value = false
}

async function doImport(weekIds) {
  importBusy.value = true
  importMessage.value = `正在导入 ${weekIds.length} 个周次...`
  try {
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds }),
    })
    const data = await r.json()
    importResult.value = data.results
    await Promise.all([loadShops(), loadProducts(), loadWeeks(), loadRestockConfig()])
    // 自动切到最新导入的一周
    if (weeks.value.length) {
      currentWeekId.value = weeks.value[0].id
      await loadCurrentWeek()
    }
    // 刷新扫描列表
    const r2 = await fetch('/api/scan', { cache: 'no-store' })
    importScan.value = r2.ok ? await r2.json() : { unimported: [], imported: [] }
    if (!Array.isArray(importScan.value.imported) || !importScan.value.imported.length) {
      const wk = await fetch('/api/weeks', { cache: 'no-store' })
      const weekList = wk.ok ? await wk.json() : []
      importScan.value = {
        ...importScan.value,
        imported: Array.isArray(weekList) ? weekList : [],
      }
    }
    const okCount = (data.results || []).filter((x) => !x.error).length
    const failCount = (data.results || []).filter((x) => x.error).length
    importMessage.value = failCount
      ? `导入完成：成功 ${okCount}，失败 ${failCount}`
      : `导入完成：成功 ${okCount}`
    if (okCount) {
      showToast(
        failCount
          ? `导入完成：成功 ${okCount}，失败 ${failCount}`
          : `已成功导入 ${okCount} 个文件`,
        failCount ? 'warn' : 'success',
      )
    }
    const firstNeedResolveIndex = (importResult.value || []).findIndex(
      (x) => !x?.error && x?.listingOnlyUnresolvedTotal > 0,
    )
    if (firstNeedResolveIndex >= 0) {
      openResolvePanel(importResult.value[firstNeedResolveIndex], firstNeedResolveIndex)
    }
    updateStatus()
  } catch (e) {
    importMessage.value = e.message || '导入失败'
    showToast(importMessage.value, 'error')
  } finally {
    importBusy.value = false
  }
}

function openResolvePanel(result, resultIndex) {
  if (!result || result.error) return
  const groups = Array.isArray(result.listingOnlyUnresolvedByFile)
    ? result.listingOnlyUnresolvedByFile
    : []
  const items = []
  for (const g of groups) {
    const listingFile = String(g?.listingFile || '')
    const asins = Array.isArray(g?.asins) ? g.asins : []
    for (const asin of asins) {
      items.push({ asin: String(asin), listingFile, shopId: '' })
    }
  }
  if (!items.length) return
  resolvePanel.value = {
    show: true,
    weekId: String(result.weekId || ''),
    resultIndex,
    items,
    busy: false,
    message: `请为 ${items.length} 个 ASIN 选择店铺，然后写入主数据。`,
  }
}

function closeResolvePanel() {
  resolvePanel.value = {
    show: false,
    weekId: '',
    resultIndex: -1,
    items: [],
    busy: false,
    message: '',
  }
}

const resolveReady = computed(() =>
  resolvePanel.value.items.length > 0 &&
  resolvePanel.value.items.every((x) => String(x.shopId || '').trim()),
)

async function submitResolvePanel() {
  if (!resolveReady.value || resolvePanel.value.busy) return
  resolvePanel.value = {
    ...resolvePanel.value,
    busy: true,
    message: `正在写入 ${resolvePanel.value.items.length} 个 ASIN...`,
  }
  try {
    const payload = {
      weekId: resolvePanel.value.weekId,
      assignments: resolvePanel.value.items.map((x) => ({
        asin: x.asin,
        shopId: x.shopId,
      })),
    }
    const r = await fetch('/api/import/resolve-listing-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || '写入失败')

    await loadProducts()

    const idx = resolvePanel.value.resultIndex
    if (idx >= 0 && Array.isArray(importResult.value) && importResult.value[idx]) {
      const target = { ...importResult.value[idx] }
      target.listingOnlyUnresolvedByFile = []
      target.listingOnlyUnresolvedTotal = 0
      const existing = Array.isArray(target.listingOnlyAddedByShop) ? target.listingOnlyAddedByShop : []
      const mergedByShop = new Map(existing.map((x) => [x.shopName, { ...x, asins: [...(x.asins || [])] }]))
      for (const x of data.addedByShop || []) {
        const curr = mergedByShop.get(x.shopName)
        if (!curr) {
          mergedByShop.set(x.shopName, {
            shopName: x.shopName,
            count: x.count,
            asins: [...(x.asins || [])],
          })
        } else {
          const nextSet = new Set([...(curr.asins || []), ...(x.asins || [])])
          curr.asins = Array.from(nextSet).sort((a, b) => a.localeCompare(b))
          curr.count = curr.asins.length
          mergedByShop.set(x.shopName, curr)
        }
      }
      target.listingOnlyAddedByShop = Array.from(mergedByShop.values()).sort(
        (a, b) => b.count - a.count || a.shopName.localeCompare(b.shopName),
      )
      target.listingOnlyAddedTotal = (target.listingOnlyAddedByShop || []).reduce(
        (sum, x) => sum + Number(x.count || 0),
        0,
      )
      importResult.value.splice(idx, 1, target)
    }

    showToast(`已写入 ${data.addedCount || 0} 个 ASIN`, 'success')
    closeResolvePanel()
  } catch (e) {
    resolvePanel.value = {
      ...resolvePanel.value,
      busy: false,
      message: e.message || '写入失败',
    }
    showToast(resolvePanel.value.message, 'error')
  }
}

async function deleteWeek(week) {
  if (!confirm(`确定删除周次「${week.filename}」的快照？（public/data 周目录文件不受影响，可再次导入）`)) return
  const r = await fetch(`/api/weeks/${encodeURIComponent(week.id)}`, { method: 'DELETE' })
  if (r.ok) {
    await loadWeeks()
    if (currentWeekId.value === week.id) {
      currentWeekId.value = weeks.value[0]?.id || ''
      await loadCurrentWeek()
    }
    const r2 = await fetch('/api/scan', { cache: 'no-store' })
    importScan.value = r2.ok ? await r2.json() : { unimported: [], imported: [] }
    updateStatus()
  }
}

/* ================= 副作用 ================= */
watch(customCols, saveCustomCols, { deep: true })
watch(shopFilter, (v) => {
  try {
    localStorage.setItem(SHOP_FILTER_KEY, v)
  } catch {
    /* ignore */
  }
  updateStatus()
})
watch(supplyFilter, (v) => {
  try {
    localStorage.setItem(SUPPLY_FILTER_KEY, v)
  } catch {
    /* ignore */
  }
  updateStatus()
})
watch(currentWeekId, async (v) => {
  if (!v) return
  try {
    localStorage.setItem(WEEK_KEY, v)
  } catch {
    /* ignore */
  }
  await loadCurrentWeek()
  updateStatus()
})

watch(visibleAsinList, (list) => {
  const allowed = new Set(list)
  const next = new Set()
  for (const asin of selectedAsins.value) {
    if (allowed.has(asin)) next.add(asin)
  }
  if (next.size !== selectedAsins.value.size) {
    selectedAsins.value = next
  }
})

onMounted(async () => {
  updateCompact13Mode()
  window.addEventListener('resize', updateCompact13Mode)
  await clearCacheOnDevServerRestart()
  try {
    const v = localStorage.getItem(SHOP_FILTER_KEY)
    if (v) shopFilter.value = v
    const supply = localStorage.getItem(SUPPLY_FILTER_KEY)
    if (supply) supplyFilter.value = supply
  } catch {
    /* ignore */
  }
  bootstrap()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateCompact13Mode)
  for (const t of copyResetTimers.values()) clearTimeout(t)
  copyResetTimers.clear()
})
</script>

<template>
  <div class="app" :class="{ 'compact-13': compact13Mode }">
    <div v-if="toast.show" class="toast" :class="`toast-${toast.type}`">
      <span class="loading-dot toast-icon">✓</span>
      <span>{{ toast.text }}</span>
    </div>
    <header class="topbar">
      <div class="topbar-left">
        <span class="crumb">订单利润分析</span>
        <span class="crumb-sep">/</span>
        <span class="title">
          <span class="title-badge">OPA</span>
          周订单利润
        </span>
      </div>
    </header>

    <div class="toolbar toolbar-modern">
      <el-button class="filter-toggle-btn" plain @click="filtersCollapsed = !filtersCollapsed">
        {{ filtersCollapsed ? '展开筛选' : '收起筛选' }}
      </el-button>

      <div v-show="!filtersCollapsed" class="toolbar-filter-group">
        <div class="filter-item filter-item-week">
          <span class="tool-label">周次</span>
          <el-select v-model="currentWeekId" class="tool-ep-select" placeholder="选择周次" :disabled="!weeks.length" filterable>
            <el-option v-if="!weeks.length" label="暂无" value="" />
            <el-option
              v-for="w in weeks"
              :key="w.id"
              :label="`${w.id} · ${w.startDate} ~ ${w.endDate}（${w.rowCount} 行）`"
              :value="w.id"
            />
          </el-select>
        </div>

        <div class="filter-item filter-item-shop">
          <span class="tool-label">店铺</span>
          <el-select v-model="shopFilter" class="tool-ep-select" :disabled="!shopNames.length" filterable>
            <el-option :label="`全部店铺（${shopNames.length}）`" value="__all__" />
            <el-option v-for="s in shopNames" :key="s" :label="s" :value="s" />
          </el-select>
        </div>

        <div class="filter-item filter-item-supply">
          <span class="tool-label">补货筛选</span>
          <el-select v-model="supplyFilter" class="tool-ep-select" filterable>
            <el-option label="全部" value="__all__" />
            <el-option label="需要补货" value="need-restock" />
            <el-option label="不需要补货" value="no-restock" />
            <el-option label="已经下单的" value="ordered" />
            <el-option label="本地仓库有的" value="local-warehouse" />
            <el-option label="需要补货且本地没有和没有下单的" value="need-restock-no-local-no-ordered" />
          </el-select>
        </div>

        <div class="filter-item filter-item-search">
          <span class="tool-label">ASIN/FNSKU搜索</span>
          <el-input
            v-model="asinSearch"
            class="tool-ep-input"
            placeholder="ASIN / FNSKU"
            clearable
          />
        </div>
      </div>

      <el-button type="primary" :loading="importLoading || importBusy" :disabled="importLoading || importBusy" @click="openImport">
        {{ importLoading ? '扫描中...' : importBusy ? '导入中...' : '扫描并导入' }}
      </el-button>
      <el-button @click="showShopPanel = true">店铺</el-button>
      <el-button @click="showProductPanel = true">ASIN</el-button>
      <el-button :disabled="!nonAbandonedVisibleAsins.length" @click="copyNonAbandonedAsins">
        复制非放弃ASIN（{{ nonAbandonedVisibleAsins.length }}）
      </el-button>
      <el-button :disabled="!selectedAsinCount" @click="copySelectedPackageAndOrdered">
        复制包装尺寸+已下单（{{ selectedAsinCount }}）
      </el-button>
      <span class="tool-label">批量分类</span>
      <el-select v-model="batchCategoryValue" class="tool-ep-select" style="width: 122px" placeholder="选择分类">
        <el-option value="" label="选择分类" />
        <el-option v-for="opt in CATEGORY_OPTIONS" :key="`batch-${opt}`" :value="opt" :label="opt" />
      </el-select>
      <el-button :disabled="!selectedAsinCount || !batchCategoryValue || batchCategoryBusy" @click="applyBatchCategoryChange">
        {{ batchCategoryBusy ? '批量修改中...' : `批量改分类（${selectedAsinCount}）` }}
      </el-button>
      <el-button :disabled="!selectedAsinCount" @click="clearSelectedAsins">清空勾选</el-button>
      <div class="export-tip-wrap">
        <el-button :disabled="!canExportLocalWarehousePdf || exportPdfBusy" @click="exportLocalWarehousePdf">
          {{ exportPdfBusy ? '导出PDF中...' : '导出本地仓库PDF' }}
        </el-button>
        <span v-if="!canExportLocalWarehousePdf" class="export-tip-bubble">{{ exportLocalWarehouseDisabledReason }}</span>
      </div>

      <span class="tool-divider"></span>

      <el-button type="primary" plain @click="showFieldPanel = true">字段设置</el-button>
    </div>

    <div class="metabar">
      <el-tag effect="light" round>父ASIN组 {{ groupCount }}</el-tag>
      <el-tag effect="light" round>ASIN {{ asinCount }}</el-tag>
      <el-tag v-if="shopFilter !== '__all__'" type="success" effect="light" round>当前店铺：{{ shopFilter }}</el-tag>
      <div class="status">{{ status }}</div>
    </div>

    <div class="table-wrap">
      <div v-if="!currentWeek || !tableRows.length" class="empty">
        {{
          !weeks.length
            ? '尚未导入任何周数据，点击右上「扫描并导入」开始'
            : '当前筛选条件下没有数据'
        }}
      </div>
      <table v-else>
        <thead>
          <tr>
            <th class="select-col">
              <input
                type="checkbox"
                :checked="isAllVisibleAsinsSelected"
                :disabled="!visibleAsinList.length"
                @change="toggleSelectAllVisible($event.target.checked)"
              />
            </th>
            <th
              v-for="(col, i) in displayCols"
              :key="col.name"
              :class="{ 'fix-left': col.fixed, 'fix-last': col.fixed && col.name === 'ASIN' }"
              :style="col.fixed ? fixedColStyle(i, col.name) : null"
            >
              {{ displayColName(col.name) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in tableRows" :key="item.row.asin || item.row._rowIndex">
            <tr
              :class="[
                item.isGroupHead ? 'parent-row' : 'child-row',
                isInventoryRowExpanded(item.row.asin) ? 'row-inventory-open' : '',
                isAbandoned(item.row) ? 'row-abandoned' : '',
                hasRestockNeed(item.row) ? 'row-need-restock' : '',
              ]"
            >
              <td class="select-col">
                <input
                  type="checkbox"
                  :checked="isAsinSelected(item.row.asin)"
                  @change="toggleAsinSelected(item.row.asin, $event.target.checked)"
                />
              </td>
              <td
                v-for="(col, i) in displayCols"
                :key="col.name + '-' + (item.row.asin || item.row._rowIndex)"
                :class="[cellAlertClass(item.row, col.name), {
                  'fix-left': col.fixed,
                  'fix-last': col.fixed && col.name === 'ASIN',
                  num: numericColumns[col.name],
                  'cell-name': col.name === '品名',
                  'cell-edit': isEditableCol(col.name),
                }]"
                :style="col.fixed ? fixedColStyle(i, col.name) : null"
              >
                <template v-if="editColKey(col.name) === 'category'">
                  <el-select
                    :class="['cell-ep-select', 'cat-' + (rowProduct(item.row)?.category || '正常')]"
                    size="small"
                    :model-value="rowProduct(item.row)?.category || '正常'"
                    @change="patchProduct(item.row.asin, { category: $event }, { shopId: rowShopId(item.row) })"
                  >
                    <el-option v-for="opt in CATEGORY_OPTIONS" :key="opt" :value="opt" :label="opt" />
                  </el-select>
                </template>
                <template v-else-if="col.name === '亚马逊主图'">
                  <div class="amazon-main-cell">
                    <button
                      v-if="amazonMainImageUrl(item.row)"
                      class="name-image-btn"
                      type="button"
                      @click="openImagePreview(item.row, 0)"
                    >
                      <img
                        :src="amazonMainImageUrl(item.row)"
                        :alt="displayProductName(item.row) || displayProductTitle(item.row) || asinValue(item.row)"
                        class="name-image-thumb"
                        loading="lazy"
                      />
                    </button>
                    <div v-else class="name-image-placeholder">—</div>
                  </div>
                </template>
                <template v-else-if="col.name === '品名'">
                  <div class="name-cell-stack">
                    <el-input
                      class="cell-ep-input"
                      size="small"
                      :model-value="rowProduct(item.row)?.name ?? ''"
                      @change="patchProduct(item.row.asin, { name: ($event || '').trim() }, { shopId: rowShopId(item.row) })"
                    />
                    <div class="title-tooltip-wrap name-title-subrow">
                      <span class="name-title-ellipsis">标题：{{ displayProductTitle(item.row) || '—' }}</span>
                      <span class="title-tooltip-bubble">{{ displayProductTitle(item.row) || '—' }}</span>
                    </div>
                  </div>
                </template>
                <template
                  v-else-if="editColKey(col.name) === 'restockCycle' || editColKey(col.name) === 'localWarehouse' || editColKey(col.name) === 'orderedQty'"
                >
                  <el-input
                    class="cell-ep-input cell-ep-input-num"
                    type="number"
                    size="small"
                    :model-value="rowProduct(item.row)?.[editColKey(col.name)] ?? ''"
                    @change="patchProduct(item.row.asin, { [editColKey(col.name)]: $event === '' ? '' : Number($event) }, { shopId: rowShopId(item.row) })"
                  />
                </template>
                <template v-else-if="editColKey(col.name) === 'note'">
                  <div class="note-tooltip-wrap">
                    <el-input
                      class="cell-ep-input"
                      size="small"
                      :model-value="getWeekNote(item.row.asin)"
                      placeholder="本周备注"
                      @mouseenter="updateNoteOverflow(item.row.asin, $event)"
                      @focusin="updateNoteOverflow(item.row.asin, $event)"
                      @change="patchWeekNote(item.row.asin, $event)"
                    />
                    <span v-if="shouldShowNoteTooltip(item.row.asin)" class="note-tooltip-bubble">{{ getWeekNote(item.row.asin) }}</span>
                  </div>
                </template>
                <template v-else-if="col.name === 'ASIN'">
                  <div v-if="asinValue(item.row)" class="asin-cell">
                    <a
                      v-if="asinUrl(item.row)"
                      class="asin-link"
                      :href="asinUrl(item.row)"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {{ asinValue(item.row) }}
                    </a>
                    <button
                      class="asin-copy-btn"
                      :class="{ copied: isAsinCopied(item.row) }"
                      type="button"
                      @click="copyAsin(item.row)"
                    >
                      {{ isAsinCopied(item.row) ? '已复制' : '复制' }}
                    </button>
                    <button
                      class="asin-copy-btn"
                      :class="{
                        copied: isInventoryRowExpanded(item.row.asin),
                        'restock-alert': hasRestockNeed(item.row),
                      }"
                      type="button"
                      @click="toggleInventoryRow(item.row.asin)"
                    >
                      {{ isInventoryRowExpanded(item.row.asin) ? '收起库存' : '库存详情' }}
                    </button>
                  </div>
                </template>
                <template v-else-if="col.name === '产品图片'">
                  <div v-if="productImageUrls(item.row).length" class="product-image-list">
                    <button
                      v-for="(imgUrl, imgIndex) in productImageUrls(item.row)"
                      :key="`${item.row.asin}-${imgIndex}-${imgUrl}`"
                      class="product-image-link"
                      type="button"
                      @click="openImagePreview(item.row, imgIndex)"
                    >
                      <img :src="imgUrl" :alt="`${asinValue(item.row)} 产品图片 ${imgIndex + 1}`" class="product-image-thumb" loading="lazy" />
                    </button>
                  </div>
                  <span v-else>—</span>
                </template>
                <template v-else>{{ getCell(item.row, col.name) }}</template>
              </td>
            </tr>
            <tr v-if="isInventoryRowExpanded(item.row.asin)" class="inventory-row">
              <td :colspan="displayCols.length + 1" class="inventory-detail-cell">
                <div class="inventory-detail-grid">
                  <div class="inventory-item"><span>FNSKU</span><strong>{{ getCell(item.row, 'FNSKU') || '—' }}</strong></div>
                  <div class="inventory-item"><span>可售</span><strong>{{ getCell(item.row, '可售') || '—' }}</strong></div>
                  <div class="inventory-item"><span>入库中</span><strong>{{ getCell(item.row, '入库中') || '—' }}</strong></div>
                  <div class="inventory-item"><span>不可售</span><strong>{{ getCell(item.row, '不可售') || '—' }}</strong></div>
                  <div class="inventory-item"><span>预留</span><strong>{{ getCell(item.row, '预留') || '—' }}</strong></div>
                  <div class="inventory-item"><span>FBA总量</span><strong>{{ getCell(item.row, 'FBA总量') || '—' }}</strong></div>
                  <div class="inventory-item"><span>包装尺寸/cm</span><strong>{{ rowProduct(item.row)?.packageSize || rowProduct(item.row)?.packageSize1 || rowProduct(item.row)?.packageSize2 || '—' }}</strong></div>
                  <div class="inventory-item"><span>包装类型</span><strong>{{ rowProduct(item.row)?.packageType || rowProduct(item.row)?.packageType1 || rowProduct(item.row)?.packageType2 || '—' }}</strong></div>
                  <div class="inventory-item"><span>单品重量/g</span><strong>{{ rowProduct(item.row)?.itemWeight || '—' }}</strong></div>
                  <label class="inventory-item inventory-input-item">
                    <span>本地仓库</span>
                    <el-input
                      class="cell-ep-input cell-ep-input-num"
                      type="number"
                      size="small"
                      :model-value="rowProduct(item.row)?.localWarehouse ?? 0"
                      @change="patchProduct(item.row.asin, { localWarehouse: $event === '' ? 0 : Number($event) }, { shopId: rowShopId(item.row) })"
                    />
                  </label>
                  <label class="inventory-item inventory-input-item">
                    <span>已下单</span>
                    <el-input
                      class="cell-ep-input cell-ep-input-num"
                      type="number"
                      size="small"
                      :model-value="rowProduct(item.row)?.orderedQty ?? 0"
                      @change="patchProduct(item.row.asin, { orderedQty: $event === '' ? 0 : Number($event) }, { shopId: rowShopId(item.row) })"
                    />
                  </label>
                  <label class="inventory-item inventory-input-item">
                    <span>补货用时</span>
                    <el-input
                      class="cell-ep-input cell-ep-input-num"
                      type="number"
                      size="small"
                      :model-value="rowProduct(item.row)?.restockCycle ?? ''"
                      @change="patchProduct(item.row.asin, { restockCycle: $event === '' ? '' : Number($event) }, { shopId: rowShopId(item.row) })"
                    />
                  </label>
                  <div class="inventory-item"><span>补货数量</span><strong>{{ getCell(item.row, '补货数量') || '—' }}</strong></div>
                </div>
                <div class="inventory-footer-bar">
                  <div class="inventory-item inventory-item-image inventory-item-image-footer">
                    <span>产品图片</span>
                    <div v-if="inventoryDetailImageUrls(item.row).length" class="product-image-list">
                      <button
                        v-for="(imgUrl, imgIndex) in inventoryDetailImageUrls(item.row)"
                        :key="`${item.row.asin}-detail-${imgIndex}-${imgUrl}`"
                        class="product-image-link"
                        type="button"
                        @click="openInventoryDetailImagePreview(item.row, imgIndex)"
                      >
                        <img :src="imgUrl" :alt="`${asinValue(item.row)} 产品图片 ${imgIndex + 1}`" class="product-image-thumb" loading="lazy" />
                      </button>
                    </div>
                    <strong v-else>—</strong>
                  </div>
                  <div class="inventory-btn-group">
                    <button
                      class="inventory-arrived-btn"
                      type="button"
                      :disabled="!(Number(rowProduct(item.row)?.orderedQty) > 0)"
                      @click="markOrderedArrived(item.row)"
                    >
                      已到库
                    </button>
                    <button
                      class="inventory-shipped-btn"
                      type="button"
                      :disabled="!(Number(rowProduct(item.row)?.localWarehouse) > 0)"
                      @click="markLocalShipped(item.row)"
                    >
                      已发出
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <el-dialog
      :model-value="imagePreview.show"
      class="opa-dialog image-preview-ep"
      width="min(92vw, 1120px)"
      align-center
      :show-close="false"
      @update:model-value="(v) => { if (!v) closeImagePreview() }"
    >
      <template #header>
        <div class="image-preview-head">
          <span>{{ imagePreview.title || '图片预览' }}</span>
          <el-button circle size="small" @click="closeImagePreview">✕</el-button>
        </div>
      </template>
      <div class="image-preview-stage">
        <el-button
          v-if="imagePreview.urls.length > 1"
          class="image-preview-nav image-preview-nav-prev"
          circle
          @click="prevPreviewImage"
        >
          ‹
        </el-button>
        <img :src="currentPreviewImageUrl" :alt="imagePreview.title" class="image-preview-large" />
        <el-button
          v-if="imagePreview.urls.length > 1"
          class="image-preview-nav image-preview-nav-next"
          circle
          @click="nextPreviewImage"
        >
          ›
        </el-button>
      </div>
      <div v-if="imagePreview.urls.length > 1" class="image-preview-indicator">
        {{ imagePreview.index + 1 }} / {{ imagePreview.urls.length }}
      </div>
    </el-dialog>

    <el-dialog v-model="showFieldPanel" class="opa-dialog" title="字段配置" width="920px" top="6vh">
      <div class="drawer-tip">
        固定列：亚马逊主图、品名、ASIN（不可调整）。其它字段可自定义显隐与顺序，配置保存在浏览器。
      </div>
      <div class="drawer-actions">
        <el-button @click="setAllColsVisible(true)">全选</el-button>
        <el-button @click="setAllColsVisible(false)">全不选</el-button>
        <el-button @click="resetColConfig">重置</el-button>
      </div>
      <el-table :data="customCols" border class="opa-table" max-height="460">
        <el-table-column label="显示" width="80" align="center">
          <template #default="scope">
            <el-switch :model-value="scope.row.visible" @change="toggleColVisible(scope.$index)" />
          </template>
        </el-table-column>
        <el-table-column label="字段">
          <template #default="scope">
            <span>{{ displayColName(scope.row.name) }}</span>
            <el-tag v-if="isCalcCol(scope.row.name)" size="small" type="warning" effect="plain" style="margin-left: 8px">公式</el-tag>
            <el-tag v-else-if="EXTRA_COL_NAMES.includes(scope.row.name)" size="small" effect="plain" style="margin-left: 8px">可编辑</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="顺序" width="140" align="center">
          <template #default="scope">
            <el-button size="small" :disabled="scope.$index === 0" @click="moveCol(scope.$index, -1)">上移</el-button>
            <el-button size="small" :disabled="scope.$index === customCols.length - 1" @click="moveCol(scope.$index, 1)">下移</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="showShopPanel" class="opa-dialog" title="店铺管理" width="860px" top="6vh">
      <div class="drawer-tip">
        数据存于 <code>src/data/shops.json</code>。导入周数据时新店铺会自动追加。
      </div>
      <div class="shop-form">
        <el-form label-width="88px" label-position="left" class="opa-form-inline">
          <div class="form-grid shop-grid">
            <el-form-item label="店铺名称 *">
              <el-input v-model="shopForm.name" placeholder="例如 LPH-主店三号" />
            </el-form-item>
            <el-form-item label="国家">
              <el-input v-model="shopForm.country" placeholder="美国 / 日本..." />
            </el-form-item>
            <el-form-item label="备注" class="form-row-wide">
              <el-input v-model="shopForm.note" placeholder="选填" />
            </el-form-item>
          </div>
        </el-form>
        <div class="form-actions">
          <el-button type="primary" @click="saveShop">{{ shopEditingId ? '保存修改' : '新增店铺' }}</el-button>
          <el-button v-if="shopEditingId" @click="resetShopForm">取消</el-button>
          <span v-if="shopMessage" class="form-msg">{{ shopMessage }}</span>
        </div>
      </div>
      <div class="shop-list-head">已有店铺（{{ shops.length }}）</div>
      <el-table :data="shops" border class="opa-table" max-height="380" empty-text="还没有店铺">
        <el-table-column prop="name" label="店铺名称" min-width="220" />
        <el-table-column label="国家" min-width="110">
          <template #default="scope">{{ scope.row.country || '—' }}</template>
        </el-table-column>
        <el-table-column label="备注" min-width="160">
          <template #default="scope">{{ scope.row.note || '—' }}</template>
        </el-table-column>
        <el-table-column prop="id" label="ID" width="120" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button size="small" @click="pickShop(scope.row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="deleteShop(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="showProductPanel" class="opa-dialog" :title="`ASIN 主数据（${products.length}）`" width="1080px" top="4vh">
      <div class="drawer-tip">
        数据存于 <code>src/data/products/{shopId}.json</code>（每个店铺一个文件）。导入周数据时新 ASIN 会根据店铺自动归属。
      </div>

      <div class="shop-form">
        <el-form label-width="88px" label-position="left" class="opa-form-inline">
          <div class="form-grid">
            <el-form-item label="ASIN *">
              <el-input v-model="productForm.asin" :disabled="productEditing" />
            </el-form-item>
            <el-form-item label="父 ASIN">
              <el-input v-model="productForm.parentAsin" />
            </el-form-item>
            <el-form-item label="品名" class="form-row-wide">
              <el-input v-model="productForm.name" />
            </el-form-item>
            <el-form-item label="店铺 *">
              <el-select v-model="productForm.shopId" placeholder="请选择店铺" style="width: 100%" filterable>
                <el-option v-for="s in shops" :key="s.id" :value="s.id" :label="s.name" />
              </el-select>
            </el-form-item>
          </div>
        </el-form>
        <div class="form-actions">
          <el-button type="primary" @click="saveProduct">{{ productEditing ? '保存修改' : '新增 ASIN' }}</el-button>
          <el-button v-if="productEditing" @click="resetProductForm">取消编辑</el-button>
          <span v-if="productMessage" class="form-msg">{{ productMessage }}</span>
        </div>
      </div>

      <div class="shop-list-head search-head">
        <span>已有 ASIN ({{ filteredProducts.length }} / {{ products.length }})</span>
        <el-input v-model="productSearch" clearable placeholder="搜索 ASIN / 品名 / 店铺" style="max-width: 360px" />
      </div>
      <el-table :data="filteredProducts" border class="opa-table" max-height="400" empty-text="还没有 ASIN，请先导入周数据">
        <el-table-column label="ASIN" width="150">
          <template #default="scope"><span class="shop-id">{{ scope.row.asin }}</span></template>
        </el-table-column>
        <el-table-column label="品名" min-width="220">
          <template #default="scope">{{ scope.row.name || '(未命名)' }}</template>
        </el-table-column>
        <el-table-column label="店铺" min-width="170">
          <template #default="scope">{{ shopNameById.get(scope.row.shopId) || '—' }}</template>
        </el-table-column>
        <el-table-column label="父 ASIN" width="150">
          <template #default="scope">{{ scope.row.parentAsin || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button size="small" @click="pickProduct(scope.row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="deleteProduct(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <ImportDialog
      :show-import-panel="showImportPanel"
      :import-loading="importLoading"
      :import-busy="importBusy"
      :import-message="importMessage"
      :import-scan="importScan"
      :import-result="importResult"
      :resolve-panel="resolvePanel"
      :resolve-ready="resolveReady"
      :shops="shops"
      @close="closeImportPanel"
      @scan="openImport"
      @import-weeks="doImport"
      @open-resolve="({ row, index }) => openResolvePanel(row, index)"
      @submit-resolve="submitResolvePanel"
      @close-resolve="closeResolvePanel"
      @delete-week="deleteWeek"
    />
  </div>
</template>
