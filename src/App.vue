<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import focusConfig from './data/focusProducts.json'
import { decideRestock } from './lib/restockRules.js'
import { prepareImportScan } from './lib/importScan.js'
import { buildProductPatchTargets } from './lib/productUpdates.js'
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
  progressView as buildProgressView,
  restockTitle as buildRestockTitle,
  restockView as buildRestockView,
  sortGroupsBy,
  suggestedView as buildSuggestedView,
} from './lib/tableView.js'
import { findShopByCode, suggestedRestock } from './lib/replenishmentPlan.js'
import { METRIC_BY_KEY, buildSeries, deltaOf, fmtMetric, sumMetric } from './lib/trendMetrics.js'
import {
  formatRoi,
  inventoryHealthText as productInventoryHealthText,
  isWeekFieldAlert,
  pairedText,
  shopCodeOf,
  toNum,
  weekRoi,
  weightTypeText as productWeightTypeText,
} from './lib/weekSnapshot.js'
import { useReplenishment } from './composables/useReplenishment.js'
import { useTrendWeeks } from './composables/useTrendWeeks.js'
import { writeClipboard } from './utils/clipboard.js'
import FilterChip from './components/FilterChip.vue'
import PlanDetail from './components/PlanDetail.vue'
import PlanOverview from './components/PlanOverview.vue'
import TrendPanel from './components/TrendPanel.vue'

const ImportDialog = defineAsyncComponent(() => import('./components/ImportDialog.vue'))

/* ================= 常量 ================= */
const FIXED_COLS = ['品名', 'ASIN'] // 品名列里带主图
const COL_CONFIG_KEY = 'opa:column-config:v6'
const SHOP_FILTER_KEY = 'opa:shop-filter:v1'
const SUPPLY_FILTER_KEY = 'opa:supply-filter:v1'
const VIEW_KEY = 'opa:view:v1'
const PLAN_SHOP_KEY = 'opa:plan-shop:v1'
const DEV_SESSION_KEY = 'opa:dev-session:v1'
const FIXED_WIDTHS = { 品名: 300, ASIN: 150 }
const FIXED_WIDTHS_COMPACT = { 品名: 224, ASIN: 136 }
const SELECT_COL_WIDTH = 40 // 勾选框
const SELECT_COL_WIDTH_COMPACT = 36

/** 表头分组：列名 → 组名；相邻同组的列合并成一个组头，不在表里的列不显示组名 */
const COL_GROUPS = {
  销售: ['销量', '月销量', '月销售额', '月订单数', '日均销量', 'Vine赠品销量', '销售额', '平均日销', '含税销售额', '净销售额', '平均售价', '广告销售额', '广告销量', '多渠道销量'],
  利润: ['采购成本', '毛利润', '毛利率', 'ROI', '净毛利率', '平均毛利润', '合计成本', '头程成本', '采购均价', '头程均价'],
  运营: ['广告费率', '广告花费', '退货率', '退款率', '退货量', '退款量', '退款金额', '推广费', '平台费', 'FBA发货费'],
  库存: ['可售', '入库中', '不可售', '预留', 'FBA总量', '本地仓库', '已下单', '补货用时'],
  补货: ['静态补货', '建议补货', '批次进度'],
}
const GROUP_OF_COL = Object.fromEntries(Object.entries(COL_GROUPS).flatMap(([g, cols]) => cols.map((c) => [c, g])))

const SUPPLY_OPTIONS = [
  { value: '__all__', label: '全部' },
  { value: 'need-restock', label: '需要补货' },
  { value: 'need-restock-no-local-no-ordered', label: '需补货未下单' },
  { value: 'no-restock', label: '不需要补货' },
  { value: 'ordered', label: '已下单' },
  { value: 'local-warehouse', label: '本地仓有货' },
]
const HEALTH_OPTIONS = [
  { value: '__all__', label: '全部' },
  { value: '健康', label: '健康' },
  { value: '不足', label: '不足' },
]

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
  { name: '静态补货', key: 'restockQty', type: 'calc' },
  { name: '建议补货', key: 'suggestedQty', type: 'calc' },
  { name: '批次进度', key: 'batchProgress', type: 'calc' },
]

/** 顶部视图：全部 / 重点关注 / 有补货计划 */
const VIEWS = [
  { id: 'all', label: '全部' },
  { id: 'focus', label: '重点关注' },
  { id: 'plan', label: '有补货计划' },
]

/** 展开行的 Tab */
const DETAIL_TABS = [
  { id: 'inventory', label: '库存详情' },
  { id: 'trend', label: '8 周趋势' },
  { id: 'plan', label: '补货批次' },
]
const EXTRA_COL_NAMES = EXTRA_COLS.map((c) => c.name)
const EXTRA_COL_BY_NAME = Object.fromEntries(EXTRA_COLS.map((c) => [c.name, c]))

/** \u5217\u540d \u2192 \u53ef\u7f16\u8f91\u5b57\u6bb5\u7684 key\uff08\u975e\u53ef\u7f16\u8f91\u8fd4\u56de ''\uff09 */
function editColKey(name) {
  if (name === '品名') return 'name'
  if (name === '商品标题' || name === '标题') return 'productTitle'
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

/** 表头拆成两半，中间放 <wbr>：空间够时一行，屏幕窄时折成两行，不会逐字断开 */
/** 表头悬停说明：两列补货口径不同，要说清楚 */
const HEADER_TITLES = {
  静态补货: '库存位置（FBA总量+本地仓+已下单）不够 3 个月 + 补货用时 → 发 1 个月；只做预警，实际发货以「建议补货」为准',
  建议补货: '补货批次计划（CSV）：含季节系数、春节班期、人工例外，按它发货',
}

function headerParts(name) {
  const label = name === '品名' ? '产品' : displayColName(name)
  if (/^[\u4e00-\u9fa5]{3}$/.test(label)) return [label.slice(0, 1), label.slice(1)]
  if (label.length < 4) return [label, '']
  const mid = Math.ceil(label.length / 2)
  return [label.slice(0, mid), label.slice(mid)]
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
  'ROI',
  '广告费率',
  '退货率',
  '退款率',
  '静态补货',
  '建议补货',
  '批次进度',
  '备注',
]

function weightTypeText(row) {
  return productWeightTypeText(rowProduct(row))
}

function pairedInventoryText(row, firstKey, secondKey) {
  return pairedText(rowProduct(row), firstKey, secondKey)
}

/* ================= 状态 ================= */
const shops = ref([])
const products = ref([])
const weeks = ref([]) // [{ id, filename, startDate, endDate, rowCount, importedAt }]
const currentWeekId = ref('') // 始终是最新一周（weeks[0]）
const currentWeek = ref(null) // { columns, rows: [{ asin, values }] }
const currentWeekMeta = computed(() => weeks.value.find((w) => w.id === currentWeekId.value) || null)
const restockConfig = ref({}) // { coverMonths, shipMonths, eventWeeks, ... }，见 src/data/restockConfig.js
const restockBasis = ref({}) // 'shopId::ASIN' → 月销量和提示（中间件按全部周快照算好）

const customCols = ref([]) // [{ name, visible }]
const shopFilter = ref('__all__')
const supplyFilter = ref('__all__')
const categoryFilter = ref('__all__')
const inventoryHealthFilter = ref('__all__')
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
/** 正在播放收起动画的行：动画结束前详情行还留在 DOM 里 */
const closingInventoryRows = ref(new Set())
const selectedAsins = ref(new Set())
const batchCategoryValue = ref('')
const batchCategoryBusy = ref(false)
const compact13Mode = ref(false)

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
function writeStored(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

const storedView = readStored(VIEW_KEY, 'all')
const viewMode = ref(VIEWS.some((v) => v.id === storedView) ? storedView : 'all')
const planShop = ref(readStored(PLAN_SHOP_KEY, '')) // 补货视图当前店铺（CSV 简码）
const planBatch = ref('') // 补货视图选中的批次
const planRowFilter = ref('all') // all | pending | done | batch
const planOverviewCollapsed = ref(false)
const detailTab = ref('inventory')

const {
  orderedPlans,
  warnings: planWarnings,
  summaries: planSummaries,
  today,
  saving: planSaving,
  loadReplenishment,
  planEntry,
  cellShipped,
  shippedAt,
  saveShipped,
} = useReplenishment(shops, { onError: (text) => showToast(text, 'error') })

const { trendWeeks, trendLoading, ensureTrendWeeks, resetTrendWeeks, seedTrendWeek } = useTrendWeeks(weeks)

const hasActiveFilters = computed(
  () =>
    (viewMode.value !== 'plan' && shopFilter.value !== '__all__') ||
    supplyFilter.value !== '__all__' ||
    categoryFilter.value !== '__all__' ||
    inventoryHealthFilter.value !== '__all__' ||
    !!asinSearch.value.trim(),
)

function resetFilters() {
  shopFilter.value = '__all__'
  supplyFilter.value = '__all__'
  categoryFilter.value = '__all__'
  inventoryHealthFilter.value = '__all__'
  asinSearch.value = ''
}
let toastTimer = null
const copyResetTimers = new Map()

function updateCompact13Mode() {
  if (typeof window === 'undefined') return
  // 14 寸 MacBook 的各档缩放（≤1800 宽）都用紧凑表格，避免出现横向滚动条
  compact13Mode.value = window.innerWidth <= 1800
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

function inventoryHealthText(row) {
  return productInventoryHealthText(rowProduct(row))
}

/* ---------- 重点关注 / 补货计划：都按「店铺 + ASIN」关联 ---------- */
/** shopId → 重点关注 ASIN → 在配置里的顺序 */
const focusOrder = computed(() => {
  const out = new Map()
  for (const [shopId, list] of Object.entries(focusConfig)) {
    const order = new Map()
    ;(Array.isArray(list) ? list : []).forEach((a, i) => {
      const asin = String(a).trim()
      if (asin && !order.has(asin)) order.set(asin, i)
    })
    out.set(shopId, order)
  }
  return out
})

function isFocus(row) {
  return !!focusOrder.value.get(rowShopId(row))?.has(String(row?.asin || '').trim())
}

/** 该行在补货计划里的条目：{ plan, item, summary } 或 null */
function rowPlan(row) {
  const shopId = rowShopId(row)
  const asin = String(row?.asin || '').trim()
  return shopId && asin ? planEntry(shopId, asin) : null
}

function rowSuggested(row) {
  const entry = rowPlan(row)
  return entry ? suggestedRestock(entry.item, entry.summary) : { state: 'none' }
}

function rowMatchesPlanFilter(row) {
  const entry = rowPlan(row)
  if (!entry || entry.plan.shop !== planShop.value) return false
  const s = entry.summary
  switch (planRowFilter.value) {
    case 'pending':
      return s.plannedQty > s.shippedQty
    case 'done':
      return s.plannedQty > 0 && s.plannedQty === s.shippedQty
    case 'batch':
      return !!entry.item.qtyByBatch[planBatch.value]
    default:
      return true
  }
}

const activePlan = computed(() => orderedPlans.value.find((p) => p.shop === planShop.value) || null)
const activePlanSummary = computed(() => (activePlan.value ? planSummaries.value[activePlan.value.shop] : null))

function planShopLabel(code) {
  return findShopByCode(shops.value, code)?.name || code
}

function inventoryHealthClass(row) {
  return inventoryHealthText(row) === '健康' ? 'inventory-health-good' : 'inventory-health-low'
}

const allRows = computed(() => currentWeek.value?.rows ?? [])

function rowMatchesSupplyFilter(row) {
  const product = rowProduct(row)
  const suggested = rowSuggested(row)
  return matchesSupplyFilter(supplyFilter.value, {
    localWarehouse: product?.localWarehouse,
    orderedQty: product?.orderedQty,
    needRestock: hasRestockNeed(row),
    restockQty: getCell(row, '静态补货'),
    suggestedQty: suggested.state === 'pending' ? suggested.qty : null,
  })
}

const filteredRows = computed(() => {
  let rows = allRows.value
  if (viewMode.value === 'focus') rows = rows.filter(isFocus)
  // 补货视图按补货店铺筛选，忽略店铺下拉
  if (viewMode.value === 'plan') rows = rows.filter(rowMatchesPlanFilter)
  else if (shopFilter.value !== '__all__') {
    rows = rows.filter((r) => getCell(r, '店铺') === shopFilter.value)
  }
  rows = rows.filter(rowMatchesSupplyFilter)
  if (categoryFilter.value !== '__all__') {
    rows = rows.filter((r) => (rowProduct(r)?.category || '') === categoryFilter.value)
  }
  if (inventoryHealthFilter.value !== '__all__') {
    rows = rows.filter((r) => inventoryHealthText(r) === inventoryHealthFilter.value)
  }

  const q = asinSearch.value.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) =>
    [getCell(r, 'ASIN'), getCell(r, 'FNSKU'), getCell(r, '品名')].some((v) =>
      String(v || '').toLowerCase().includes(q),
    ),
  )
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

  // 值未变则跳过，避免 @change + @blur 双重触发时重复请求
  if (text === getWeekNote(asin)) return

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
 *  3. ROI = 毛利润 / 采购成本（不取整，展示两位小数）
 *  4. 静态补货：库存位置不够 3 个月 + 补货用时 → 发 1 个月（见 lib/restockRules.js）
 *  5. 建议补货 / 批次进度 取补货批次计划 CSV
 *  6. 其余取 xlsx 快照
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

  if (colName === '商品标题' || colName === '标题') {
    const fromProduct = String(product?.productTitle || '').trim()
    if (fromProduct) return fromProduct
    const i = colIndex.value[colName]
    return i != null ? row.values[i] ?? '' : ''
  }

  const extra = EXTRA_COL_BY_NAME[colName]
  if (extra) {
    if (extra.type === 'edit-week-text') {
      return getWeekNote(row.asin)
    }
    if (extra.type === 'calc') {
      if (extra.key === 'roi') return formatRoi(rowRoi(row))
      if (extra.key === 'suggestedQty') {
        const s = rowSuggested(row)
        if (s.state === 'done') return '已发完'
        if (s.state === 'pending') return `${s.qty} · ${s.batch}`
        return rowPlan(row) ? '计划不补' : ''
      }
      if (extra.key === 'batchProgress') {
        const summary = rowPlan(row)?.summary
        if (!summary?.plannedQty) return ''
        return `${summary.shippedQty}/${summary.plannedQty}`
      }
      if (extra.key === 'restockQty') return rowRestock(row).text
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

function rowRoi(row) {
  return weekRoi(row, colIndex.value)
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
  const fromProduct = String(rowProduct(row)?.productTitle || '').trim()
  if (fromProduct) return fromProduct
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

const DETAIL_CLOSE_MS = 200

/** 系统开了“减弱动态效果”或环境不支持（测试）时直接收起，不等动画 */
function prefersInstantMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 把当前展开的行收起：先标记 closing 播放动画，动画结束再从 DOM 里移掉 */
function closeExpandedRows() {
  const closing = [...expandedInventoryRows.value]
  expandedInventoryRows.value = new Set()
  if (!closing.length || prefersInstantMotion()) return
  closingInventoryRows.value = new Set([...closingInventoryRows.value, ...closing])
  setTimeout(() => {
    const next = new Set(closingInventoryRows.value)
    closing.forEach((a) => next.delete(a))
    closingInventoryRows.value = next
  }, DETAIL_CLOSE_MS)
}

/** 同时只展开一行；tab 指定时直接打开该 Tab（再次点同一 Tab 收起） */
function toggleInventoryRow(asin, tab) {
  if (!asin) return
  const current = expandedInventoryRows.value
  if (current.has(asin) && (!tab || tab === detailTab.value)) {
    closeExpandedRows()
    return
  }
  if (tab) detailTab.value = tab
  if (!current.has(asin)) closeExpandedRows()
  if (closingInventoryRows.value.has(asin)) {
    const next = new Set(closingInventoryRows.value)
    next.delete(asin)
    closingInventoryRows.value = next
  }
  expandedInventoryRows.value = new Set([asin])
}

function isInventoryRowClosing(asin) {
  return !!(asin && closingInventoryRows.value.has(asin))
}

/** 点行里的空白处展开 / 收起详情；点到输入框、按钮、下拉等控件或正在选中文字时不触发 */
const ROW_CLICK_IGNORE = 'input, textarea, select, button, a, label, [role="button"], .el-select, .el-input, .el-radio-group'
function onRowClick(asin, event) {
  if (event.target instanceof Element && event.target.closest(ROW_CLICK_IGNORE)) return
  if (window.getSelection?.()?.toString()) return
  toggleInventoryRow(asin)
}

function isInventoryRowExpanded(asin) {
  return !!(asin && expandedInventoryRows.value.has(asin))
}

/** 同时写入 HTML 表格和纯文本表格：Word/Excel 等识别 HTML，纯文本聊天框使用全角对齐文本 */
async function writeClipboardTable(header, rows) {
  const text = buildClipboardTableText(header, rows)
  const html = buildClipboardTableHtml(header, rows)

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }

  const container = document.createElement('div')
  container.innerHTML = html
  container.style.position = 'absolute'
  container.style.left = '-9999px'
  document.body.appendChild(container)
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  const ok = document.execCommand('copy')
  selection.removeAllRanges()
  document.body.removeChild(container)
  if (!ok) await writeClipboard(text)
}

/** 判断某行是否被标记为「放弃」 */
function isAbandoned(row) {
  if (!row) return false
  return rowProduct(row)?.category === '放弃'
}

/** 单元格告警高亮：
 *  - 广告费率 > 15、退款率 / 退货率 > 10、毛利润 / ROI 为负 → 红（规则见 isWeekFieldAlert）
 *  - 静态补货 是数字（库存位置不够 3 个月 + 补货用时） → 黄
 *  - 建议补货 / 批次进度：有逾期未发的批次 → 红；7 天内要发 → 黄
 */
function cellAlertClass(row, colName) {
  if (!row) return ''
  if (colName === 'ROI') return isWeekFieldAlert('ROI', rowRoi(row)) ? 'alert-red' : ''
  if (colName === '广告费率' || colName === '退款率' || colName === '退货率' || colName === '毛利润') {
    const i = colIndex.value[colName]
    return i != null && isWeekFieldAlert(colName, row.values[i]) ? 'alert-red' : ''
  }
  if (colName === '静态补货') return hasRestockNeed(row) ? 'alert-yellow' : ''
  if (colName === '建议补货' || colName === '批次进度') {
    const s = rowSuggested(row)
    if (s.state !== 'pending') return ''
    if (s.overdue) return 'alert-red'
    if (colName === '建议补货' && s.inDays != null && s.inDays <= 7) return 'alert-yellow'
  }
  return ''
}

/** 建议补货的悬停提示 */
function suggestedTitle(row) {
  const entry = rowPlan(row)
  if (!entry) return '没有补货批次计划'
  const s = rowSuggested(row)
  const total = `春节前合计 ${entry.item.preHolidayTotal ?? '—'} 件`
  if (s.state !== 'pending') return total
  const when = s.inDays == null ? '' : s.inDays < 0 ? `，已逾期 ${-s.inDays} 天` : s.inDays === 0 ? '，今天发货' : `，${s.inDays} 天后`
  return `下一批 ${s.date}${when}\n${total}`
}

/** 普通单元格：告警值加红色小底；0 / 0.00% / 空值显示为淡灰 —，让真正的数字更显眼 */
function cellView(row, colName) {
  const text = String(getCell(row, colName) ?? '')
  if (cellAlertClass(row, colName) === 'alert-red') return { text, cls: 'v-bad' }
  if (text === '' || (numericColumns.value[colName] && toNum(text) === 0)) return { text: '—', cls: 'v-dim' }
  return { text, cls: '' }
}

function suggestedView(row) {
  return buildSuggestedView(rowSuggested(row), !!rowPlan(row))
}

function progressView(row) {
  return buildProgressView(rowPlan(row)?.summary)
}

function decideRowRestock(row) {
  const product = rowProduct(row)
  return decideRestock({
    basis: restockBasis.value[`${rowShopId(row)}::${String(row?.asin || '').trim()}`],
    category: product?.category,
    fbaTotal: product?.fbaTotal,
    localWarehouse: product?.localWarehouse,
    orderedQty: product?.orderedQty,
    cycle: product?.restockCycle,
    cartonQty: product?.maxCartonQty1,
    packingMode: product?.packingMode,
    config: restockConfig.value,
  })
}

/** 最新周每行的静态补货结论；本地仓 / 已下单 / 补货用时改了会跟着重算 */
const restockByRow = computed(() => {
  const map = new Map()
  for (const row of allRows.value) {
    const decision = decideRowRestock(row)
    map.set(row, { decision, view: buildRestockView(decision), title: buildRestockTitle(decision, restockConfig.value) })
  }
  return map
})

function rowRestock(row) {
  return restockByRow.value.get(row)?.decision || decideRowRestock(row)
}

function restockCell(row) {
  return restockByRow.value.get(row) || { view: null, title: '' }
}

function hasRestockNeed(row) {
  return !!row && isRestockQty(getCell(row, '静态补货'))
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

function rowPackingMode(row) {
  return rowProduct(row)?.packingMode === 'full' ? 'full' : 'mixed'
}

/** 按父 ASIN 分组；主表不展示「放弃」分类的 ASIN。补货 / 重点视图再按各自的顺序重排 */
const groups = computed(() => {
  const sorted = groupByParent(
    filteredRows.value.filter((row) => !isAbandoned(row)),
    {
      parentKey: groupParentKey,
      profit: (row) => toNum(getCell(row, '毛利润')),
      packingMode: rowPackingMode,
    },
  )
  if (viewMode.value === 'plan') return sortGroupsBy(sorted, planUrgencyKey)
  if (viewMode.value === 'focus') return sortGroupsBy(sorted, focusOrderKey)
  return sorted
})

/** 补货视图：首批在临近窗口内的 SKU 按首批日期置顶，其余保持原顺序 */
function planUrgencyKey(row) {
  const s = rowPlan(row)?.summary
  return s?.urgent ? `0-${s.firstDate}` : '1'
}

/** 重点视图：按 focusProducts.json 里的顺序 */
function focusOrderKey(row) {
  const i = focusOrder.value.get(rowShopId(row))?.get(String(row?.asin || '').trim())
  return i == null ? 'z' : String(i).padStart(5, '0')
}

const visibleRows = computed(() => {
  const rows = []
  for (const g of groups.value) {
    rows.push(g.header)
    rows.push(...g.children)
  }
  return rows
})

const tableRows = computed(() => flattenGroups(groups.value))

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

/** 复制包装信息只导出该包装类型的产品 */
const PACKAGE_COPY_TYPE = '飞机盒'

const selectedPackageAndOrderedRows = computed(() => {
  const rows = []
  for (const asin of selectedAsins.value) {
    const product = productMap.value.get(asin)
    if (!product) continue
    const packageType = String(
      product.packageType || product.packageType1 || product.packageType2 || '',
    ).trim()
    if (packageType !== PACKAGE_COPY_TYPE) continue
    const packageSize = String(
      product.packageSize || product.packageSize1 || product.packageSize2 || '',
    ).trim()
    const orderedQtyRaw = product.orderedQty
    const orderedQty = orderedQtyRaw == null || orderedQtyRaw === '' ? 0 : Number(orderedQtyRaw)
    const packageCost = [product.packageCost1, product.packageCost2]
      .filter((value) => value != null && value !== '')
      .join(' / ')
    rows.push({
      asin,
      packageSize: packageSize || '—',
      orderedQty: Number.isFinite(orderedQty) ? orderedQty : 0,
      packageCost: packageCost || '—',
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
    weightType: weightTypeText(row),
    note: String(getWeekNote(asinValue(row)) || productField(row, 'note') || getCell(row, '备注') || '').trim(),
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
    showToast(`勾选的产品中没有包装类型为「${PACKAGE_COPY_TYPE}」的`, 'warn')
    return
  }
  const header = ['包装尺寸', '包装数量', '包装价格']
  const lines = rows.map((x) => [x.packageSize, x.orderedQty, x.packageCost])
  try {
    await writeClipboardTable(header, lines)
    const skipped = selectedAsinCount.value - rows.length
    showToast(
      skipped > 0
        ? `已复制 ${rows.length} 条${PACKAGE_COPY_TYPE}包装信息，跳过 ${skipped} 条其他包装类型`
        : `已复制 ${rows.length} 条${PACKAGE_COPY_TYPE}包装信息`,
      'success',
    )
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

/** 表头第一行：勾选列 + 固定列合成一格，其余按 COL_GROUPS 合并相邻同组列 */
const headerGroups = computed(() => buildHeaderGroups(displayCols.value, GROUP_OF_COL))
const groupStartCols = computed(() => new Set(headerGroups.value.map((g) => g.first)))
const fixedSpan = computed(() => displayCols.value.filter((c) => c.fixed).length + 1)

const groupCount = computed(() => groups.value.length)
const asinCount = computed(() => tableRows.value.length)
const shopNames = computed(() => shops.value.map((s) => s.name))
const shopOptions = computed(() => [{ value: '__all__', label: '全部' }, ...shopNames.value.map((n) => ({ value: n, label: n }))])
const categoryOptions = [{ value: '__all__', label: '全部' }, ...CATEGORY_OPTIONS.map((c) => ({ value: c, label: c }))]
const shopMdNameByName = computed(() => {
  const map = new Map()
  for (const shop of shops.value) {
    const mdName = String(shop?.mdExportName || '').trim()
    map.set(shop.name, mdName || shop.name)
  }
  return map
})

function fixedLeft(displayIndex) {
  let left = compact13Mode.value ? SELECT_COL_WIDTH_COMPACT : SELECT_COL_WIDTH
  const widthMap = compact13Mode.value ? FIXED_WIDTHS_COMPACT : FIXED_WIDTHS
  for (let i = 0; i < displayIndex; i++) {
    const name = FIXED_COLS[i]
    left += widthMap[name] ?? 120
  }
  return left + 'px'
}

function fixedColStyle(displayIndex, colName) {
  const widthMap = compact13Mode.value ? FIXED_WIDTHS_COMPACT : FIXED_WIDTHS
  const width = widthMap[colName] ?? 120
  return {
    left: fixedLeft(displayIndex),
    width: width + 'px',
    minWidth: width + 'px',
    maxWidth: width + 'px',
  }
}

/* ================= 重点关注 ================= */
/** 当前筛选下的重点 ASIN 最新周合计，与上一周比 */
const focusSummary = computed(() => {
  if (viewMode.value !== 'focus') return null
  const rows = visibleRows.value
  const weeksAsc = trendWeeks.value
  if (!rows.length || !weeksAsc.length) return null
  const lastTwo = weeksAsc.slice(-2)
  const seriesList = rows.map((row) => buildSeries(lastTwo, rowShopName(row), String(row.asin || '').trim()))
  const cur = lastTwo.length - 1
  return ['sales', 'revenue', 'profit', 'adSpend'].map((key) => {
    const metric = METRIC_BY_KEY[key]
    const now = sumMetric(seriesList, cur, key)
    const prev = cur > 0 ? sumMetric(seriesList, cur - 1, key) : NaN
    return { key, label: `${metric.label}合计`, value: fmtMetric(metric, now), delta: deltaOf(metric, now, prev) }
  })
})

/** 复制当前筛选下的重点 ASIN，顺序与表格一致 */
async function copyFocusAsins() {
  const asins = visibleAsinList.value
  if (!asins.length) {
    showToast('当前没有可导出的重点关注 ASIN', 'warn')
    return
  }
  try {
    await writeClipboard(asins.join('\n'))
    showToast(`已复制 ${asins.length} 个重点关注 ASIN`)
  } catch {
    showToast('复制失败，请重试', 'error')
  }
}

/* ================= 补货批次 ================= */
async function toggleRowShipped(row, batch) {
  const entry = rowPlan(row)
  if (!entry) return
  const { plan, item } = entry
  const shipped = !cellShipped(plan.shop, item.asin, batch.date)
  const ok = await saveShipped(plan.shop, [{ asin: item.asin, date: batch.date }], shipped)
  if (ok) showToast(`${item.sku} · ${batch.key} ${shipped ? '已标记发货' : '已撤销发货'}`)
}

async function markPlanBatch(batch, shipped) {
  const plan = activePlan.value
  if (!plan || !batch) return
  const entries = plan.items
    .filter((item) => item.asin && item.qtyByBatch[batch.key] && cellShipped(plan.shop, item.asin, batch.date) !== shipped)
    .map((item) => ({ asin: item.asin, date: batch.date }))
  if (!entries.length) return
  const verb = shipped ? '标记为已发货' : '撤销已发货'
  if (!confirm(`把 ${batch.key} 批次的 ${entries.length} 个 SKU ${verb}？`)) return
  const ok = await saveShipped(plan.shop, entries, shipped)
  if (ok) showToast(`${batch.key} 批次 ${entries.length} 个 SKU 已${shipped ? '标记发货' : '撤销发货'}`)
}

async function copyPlanBatch(batch) {
  const plan = activePlan.value
  if (!plan || !batch) return
  const items = plan.items.filter((item) => item.qtyByBatch[batch.key])
  const lines = [
    ['SKU', '品名', 'ASIN', '件数'].join('\t'),
    ...items.map((item) => [item.sku, item.name, item.asin, item.qtyByBatch[batch.key]].join('\t')),
    ['合计', '', '', batch.plannedQty].join('\t'),
  ]
  try {
    await writeClipboard(lines.join('\n'))
    showToast(`已复制 ${batch.key} 批次 ${items.length} 个 SKU`)
  } catch {
    showToast('复制失败，请重试', 'error')
  }
}

/* ================= 展开行 ================= */
function rowTrendSeries(row) {
  return buildSeries(trendWeeks.value, rowShopName(row), String(row?.asin || '').trim())
}

function isDetailTabDisabled(row, tab) {
  return tab === 'plan' && !rowPlan(row)
}

/** 当前 Tab 在这一行不可用时（没有补货计划）退回库存详情 */
function rowDetailTab(row) {
  return isDetailTabDisabled(row, detailTab.value) ? 'inventory' : detailTab.value
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
  const [r, basis] = await Promise.all([
    fetch('/api/restock-config', { cache: 'no-store' }),
    fetch('/api/restock-basis', { cache: 'no-store' }),
  ])
  restockConfig.value = r.ok ? await r.json() : {}
  restockBasis.value = basis.ok ? (await basis.json())?.basis || {} : {}
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
    seedTrendWeek(currentWeekId.value, currentWeek.value)
  } else {
    currentWeek.value = null
  }
}

/** 整页只看最新一周（weeks.json 按时间倒序，第一条即最新） */
async function loadLatestWeek() {
  currentWeekId.value = weeks.value[0]?.id || ''
  await loadCurrentWeek()
}

function ensurePlanShop() {
  if (!orderedPlans.value.some((p) => p.shop === planShop.value)) {
    planShop.value = orderedPlans.value[0]?.shop || ''
  }
}

async function bootstrap() {
  try {
    status.value = '正在加载...'
    await Promise.all([loadShops(), loadProducts(), loadWeeks(), loadRestockConfig()])
    await Promise.all([
      loadLatestWeek(),
      loadReplenishment().catch((e) => showToast('补货计划加载失败：' + (e.message || e), 'error')),
    ])
    ensurePlanShop()
    if (viewMode.value === 'focus') ensureTrendWeeks()

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
      'need-restock-no-local-no-ordered': '需补货未下单',
      'no-restock': '不需要补货',
      ordered: '已经下单的',
      'local-warehouse': '本地仓库有的',
    }[supplyFilter.value]
    const viewText = VIEWS.find((v) => v.id === viewMode.value)?.label || '全部'
    status.value = `订单 ${allRows.value.length} 行 · 当前 ${filteredRows.value.length} 行 · 店铺 ${shops.value.length} · ASIN ${products.value.length} · 视图 ${viewText} · 补货筛选 ${supplyFilterText}`
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

/** 当前周可配置的列：周表的列（去掉固定列）+ 扩展列 */
function availableCols(xlsxCols) {
  return [...(xlsxCols || []).filter((h) => h && !FIXED_COLS.includes(h)), ...EXTRA_COL_NAMES]
}

function mergeCustomCols(xlsxCols) {
  customCols.value = mergeColumnConfig(availableCols(xlsxCols), loadStoredConfig(), DEFAULT_VISIBLE_ORDER)
}

/* ================= 交互 ================= */

function moveCol(idx, delta) {
  customCols.value = moveItem(customCols.value, idx, delta)
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
  customCols.value = mergeColumnConfig(availableCols(currentWeek.value?.columns), [], DEFAULT_VISIBLE_ORDER)
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
  productTitle: '',
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
    productTitle: '',
    shopId: shops.value[0]?.id || '',
  }
  productEditing.value = false
}
function pickProduct(p) {
  productForm.value = {
    asin: p.asin,
    parentAsin: p.parentAsin || '',
    name: p.name || '',
    productTitle: p.productTitle || '',
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
        productTitle: productForm.value.productTitle.trim(),
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
  const targets = buildProductPatchTargets(products.value, asin, patch, preferredShopId)

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

function commitEditableNumber(row, key, value) {
  if (!row || !key) return
  const raw = value && typeof value === 'object' && 'target' in value
    ? value.target?.value
    : value
  const text = raw == null ? '' : String(raw).trim()
  const emptyValue = key === 'restockCycle' ? '' : 0
  const nextValue = text === '' ? emptyValue : Number(text)
  if (text !== '' && !Number.isFinite(nextValue)) return
  patchProduct(row.asin, { [key]: nextValue }, { shopId: rowShopId(row) })
}

function commitEditableText(row, key, value) {
  if (!row || !key) return
  const raw = value && typeof value === 'object' && 'target' in value
    ? value.target?.value
    : value
  const nextValue = raw == null ? '' : String(raw).trim()
  const currentValue = String(rowProduct(row)?.[key] ?? '').trim()
  if (nextValue === currentValue) return
  patchProduct(row.asin, { [key]: nextValue }, { shopId: rowShopId(row) })
}

function setPackingMode(row, value) {
  if (!row) return
  const nextValue = value === 'full' ? 'full' : 'mixed'
  if (rowPackingMode(row) === nextValue) return
  patchProduct(row.asin, { packingMode: nextValue }, { shopId: rowShopId(row) })
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

/** 浮动操作条：选一个分类直接批量修改（会联动子体，先确认） */
async function applyBatchCategory(category) {
  if (!confirm(`把勾选的 ${selectedAsinCount.value} 个 ASIN 改为「${category}」？`)) return
  batchCategoryValue.value = category
  await applyBatchCategoryChange()
  batchCategoryValue.value = ''
}

async function copySelectedAsins() {
  const asins = Array.from(selectedAsins.value)
  try {
    await writeClipboard(asins.join('\n'))
    showToast(`已复制 ${asins.length} 个 ASIN`)
  } catch {
    showToast('复制失败，请手动复制', 'error')
  }
}

/** 顶部「更多」菜单 */
function onMoreCommand(command) {
  if (command === 'shops') showShopPanel.value = true
  else if (command === 'products') showProductPanel.value = true
  else if (command === 'fields') showFieldPanel.value = true
  else if (command === 'copy-non-abandoned') copyNonAbandonedAsins()
  else if (command === 'export-pdf') exportLocalWarehousePdf()
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
    const scanData = r.ok ? await r.json() : { unimported: [], imported: [] }
    importScan.value = prepareImportScan(scanData)
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
    resetTrendWeeks()
    await loadLatestWeek()
    // 刷新扫描列表
    const r2 = await fetch('/api/scan', { cache: 'no-store' })
    const scanData = r2.ok ? await r2.json() : { unimported: [], imported: [] }
    importScan.value = prepareImportScan(scanData)
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
    // 月销量按全部已导入周算，删了周要重新拉
    await Promise.all([loadWeeks(), loadRestockConfig()])
    resetTrendWeeks()
    await loadLatestWeek()
    const r2 = await fetch('/api/scan', { cache: 'no-store' })
    const scanData = r2.ok ? await r2.json() : { unimported: [], imported: [] }
    importScan.value = prepareImportScan(scanData)
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
watch(viewMode, (v) => {
  writeStored(VIEW_KEY, v)
  if (v === 'focus') ensureTrendWeeks()
  updateStatus()
})
watch(planShop, (v) => {
  writeStored(PLAN_SHOP_KEY, v)
  planBatch.value = ''
  if (planRowFilter.value === 'batch') planRowFilter.value = 'all'
})
watch(detailTab, (tab) => {
  if (tab === 'trend') ensureTrendWeeks()
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
      <div class="brand">
        <span class="title-badge">OPA</span>
        <strong>ASIN 工作台</strong>
      </div>
      <span v-if="currentWeekMeta" class="latest-week-tag">
        最新周 {{ currentWeekMeta.id }} · {{ currentWeekMeta.startDate.slice(5).replace('-', '/') }}–{{ currentWeekMeta.endDate.slice(5).replace('-', '/') }}
      </span>
      <el-radio-group v-model="viewMode" class="view-switch">
        <el-radio-button v-for="v in VIEWS" :key="v.id" :value="v.id">{{ v.label }}</el-radio-button>
      </el-radio-group>
      <span class="topbar-spacer" />
      <el-input v-model="asinSearch" class="top-search" placeholder="搜索 ASIN / FNSKU / 品名" clearable />
      <el-dropdown trigger="click" @command="onMoreCommand">
        <el-button>⋯ 更多</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="shops">店铺管理</el-dropdown-item>
            <el-dropdown-item command="products">ASIN 主数据</el-dropdown-item>
            <el-dropdown-item command="fields">字段设置</el-dropdown-item>
            <el-dropdown-item command="copy-non-abandoned" :disabled="!nonAbandonedVisibleAsins.length" divided>
              复制非放弃 ASIN（{{ nonAbandonedVisibleAsins.length }}）
            </el-dropdown-item>
            <el-dropdown-item command="export-pdf" :disabled="!canExportLocalWarehousePdf || exportPdfBusy">
              <div class="more-item">
                <span>{{ exportPdfBusy ? '导出 PDF 中...' : '导出本地仓库 PDF' }}</span>
                <small v-if="!canExportLocalWarehousePdf">{{ exportLocalWarehouseDisabledReason }}</small>
              </div>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button type="primary" :loading="importLoading || importBusy" :disabled="importLoading || importBusy" @click="openImport">
        {{ importLoading ? '扫描中...' : importBusy ? '导入中...' : '扫描并导入' }}
      </el-button>
    </header>

    <div class="filter-row">
      <span class="result-count"><strong>{{ groupCount }}</strong> 个父组 · <strong>{{ asinCount }}</strong> 个 ASIN</span>
      <el-button size="small" @click="showFieldPanel = true">字段</el-button>
      <span class="topbar-spacer" />
      <button v-if="hasActiveFilters" type="button" class="filter-reset" @click="resetFilters">重置</button>
      <FilterChip v-if="viewMode !== 'plan'" v-model="shopFilter" label="店铺" :options="shopOptions" />
      <FilterChip v-model="categoryFilter" label="分类" :options="categoryOptions" />
      <FilterChip v-model="supplyFilter" label="补货" :options="SUPPLY_OPTIONS" />
      <FilterChip v-model="inventoryHealthFilter" label="库存健康" :options="HEALTH_OPTIONS" />
    </div>

    <section v-if="viewMode === 'focus'" class="focus-bar">
      <div class="focus-bar-head">
        <strong>重点产品汇总</strong>
        <span>当前筛选下 {{ asinCount }} 个重点 ASIN · {{ currentWeekId }} 对比上一周</span>
        <span class="focus-bar-spacer" />
        <el-button :disabled="!asinCount" title="复制当前筛选下的重点关注 ASIN，每行一个" @click="copyFocusAsins">一键导出ASIN</el-button>
      </div>
      <div v-if="focusSummary" class="focus-bar-grid">
        <div v-for="it in focusSummary" :key="it.key" class="focus-bar-kpi">
          <div class="focus-bar-label">{{ it.label }}</div>
          <div class="focus-bar-value">{{ it.value }}</div>
          <div v-if="it.delta" class="focus-bar-delta" :class="`trend-${it.delta.tone}`">
            {{ it.delta.arrow }} {{ it.delta.text }} <span class="muted">环比</span>
          </div>
        </div>
      </div>
      <div v-else class="muted">{{ trendLoading ? '正在加载上一周数据…' : '当前筛选下没有重点关注 ASIN' }}</div>
    </section>

    <PlanOverview
      v-if="viewMode === 'plan'"
      v-model:shop="planShop"
      v-model:batch="planBatch"
      v-model:row-filter="planRowFilter"
      v-model:collapsed="planOverviewCollapsed"
      :plans="orderedPlans"
      :plan="activePlan"
      :summary="activePlanSummary"
      :warnings="planWarnings"
      :today="today"
      :saving="planSaving"
      :shop-label="planShopLabel"
      @mark="markPlanBatch"
      @copy="copyPlanBatch"
    />

    <div class="table-wrap">
      <div v-if="!currentWeek || !tableRows.length" class="empty">
        {{
          status === '正在加载...'
            ? '正在加载…'
            : !weeks.length
              ? '尚未导入任何周数据，点击右上「扫描并导入」开始'
              : '当前筛选条件下没有数据'
        }}
      </div>
      <table v-else>
        <thead>
          <tr class="group-row">
            <th :colspan="fixedSpan" class="group-head-fixed"></th>
            <th
              v-for="g in headerGroups"
              :key="g.first"
              :colspan="g.span"
              class="group-head"
              :class="{ 'group-start': g.name }"
            >
              {{ g.name }}
            </th>
          </tr>
          <tr class="col-row">
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
              :class="{
                'fix-left': col.fixed,
                'fix-last': col.fixed && col.name === 'ASIN',
                num: numericColumns[col.name] || GROUP_OF_COL[col.name] === '补货',
                'group-start': !col.fixed && groupStartCols.has(col.name),
              }"
              :style="col.fixed ? fixedColStyle(i, col.name) : null"
              :title="HEADER_TITLES[col.name]"
            >
              {{ headerParts(col.name)[0] }}<wbr />{{ headerParts(col.name)[1] }}
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
                isAsinSelected(item.row.asin) ? 'row-selected' : '',
              ]"
              @click="onRowClick(item.row.asin, $event)"
            >
              <td class="select-col">
                <div class="select-cell">
                  <input
                    type="checkbox"
                    :checked="isAsinSelected(item.row.asin)"
                    @change="toggleAsinSelected(item.row.asin, $event.target.checked)"
                  />
                </div>
              </td>
              <td
                v-for="(col, i) in displayCols"
                :key="col.name + '-' + (item.row.asin || item.row._rowIndex)"
                :class="{
                  'fix-left': col.fixed,
                  'fix-last': col.fixed && col.name === 'ASIN',
                  num: numericColumns[col.name] || GROUP_OF_COL[col.name] === '补货',
                  'cell-name': col.name === '品名',
                  'cell-edit': isEditableCol(col.name),
                  'group-start': !col.fixed && groupStartCols.has(col.name),
                }"
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
                <template v-else-if="col.name === '品名'">
                  <div class="product-cell">
                  <button
                    v-if="amazonMainImageUrl(item.row)"
                    class="name-image-btn"
                    type="button"
                    @click="openImagePreview(item.row, 0)"
                  >
                    <img
                      :src="amazonMainImageUrl(item.row)"
                      :alt="displayProductName(item.row) || asinValue(item.row)"
                      class="name-image-thumb"
                      loading="lazy"
                    />
                  </button>
                  <div v-else class="name-image-placeholder">—</div>
                  <div class="name-cell-stack">
                    <input
                      class="cell-input cell-input-name"
                      type="text"
                      :value="rowProduct(item.row)?.name ?? ''"
                      @change="commitEditableText(item.row, 'name', $event)"
                      @blur="commitEditableText(item.row, 'name', $event)"
                    />
                    <div class="title-tooltip-wrap name-title-subrow">
                      <input
                        class="cell-input cell-input-title"
                        type="text"
                        :value="displayProductTitle(item.row)"
                        :title="displayProductTitle(item.row)"
                        placeholder="产品标题"
                        @change="commitEditableText(item.row, 'productTitle', $event)"
                        @blur="commitEditableText(item.row, 'productTitle', $event)"
                      />
                    </div>
                  </div>
                  </div>
                </template>
                <template v-else-if="editColKey(col.name) === 'productTitle'">
                  <input
                    class="cell-input"
                    type="text"
                    :value="displayProductTitle(item.row)"
                    @change="commitEditableText(item.row, 'productTitle', $event)"
                    @blur="commitEditableText(item.row, 'productTitle', $event)"
                  />
                </template>
                <template
                  v-else-if="editColKey(col.name) === 'restockCycle' || editColKey(col.name) === 'localWarehouse' || editColKey(col.name) === 'orderedQty'"
                >
                  <el-input
                    class="cell-ep-input cell-ep-input-num"
                    type="number"
                    size="small"
                    :model-value="rowProduct(item.row)?.[editColKey(col.name)] ?? ''"
                    @change="commitEditableNumber(item.row, editColKey(col.name), $event)"
                    @blur="commitEditableNumber(item.row, editColKey(col.name), $event)"
                  />
                </template>
                <template v-else-if="editColKey(col.name) === 'note'">
                  <div class="note-tooltip-wrap">
                    <input
                      class="cell-input"
                      type="text"
                      :value="getWeekNote(item.row.asin)"
                      placeholder="本周备注"
                      @mouseenter="updateNoteOverflow(item.row.asin, $event)"
                      @focus="updateNoteOverflow(item.row.asin, $event)"
                      @change="patchWeekNote(item.row.asin, $event.target.value)"
                      @blur="patchWeekNote(item.row.asin, $event.target.value)"
                    />
                    <span v-if="shouldShowNoteTooltip(item.row.asin)" class="note-tooltip-bubble">{{ getWeekNote(item.row.asin) }}</span>
                  </div>
                </template>
                <template v-else-if="col.name === 'ASIN'">
                  <div v-if="asinValue(item.row)" class="asin-block">
                    <div class="asin-line">
                      <span v-if="isFocus(item.row)" class="focus-star" title="重点关注（src/data/focusProducts.json）">★</span>
                      <a
                        v-if="asinUrl(item.row)"
                        class="asin-link"
                        :href="asinUrl(item.row)"
                        target="_blank"
                        rel="noopener noreferrer"
                      >{{ asinValue(item.row) }}</a>
                      <button
                        class="asin-copy-icon"
                        :class="{ copied: isAsinCopied(item.row) }"
                        type="button"
                        :title="isAsinCopied(item.row) ? '已复制' : '复制 ASIN'"
                        @click="copyAsin(item.row)"
                      >
                        {{ isAsinCopied(item.row) ? '✓' : '⧉' }}
                      </button>
                    </div>
                    <span class="shop-code">{{ shopCodeOf(rowShopName(item.row)) }}</span>
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
                <template v-else-if="col.name === '建议补货'">
                  <button
                    v-if="rowPlan(item.row)"
                    type="button"
                    class="suggest-cell"
                    :class="`tone-${suggestedView(item.row).tone}`"
                    :title="suggestedTitle(item.row)"
                    @click="toggleInventoryRow(item.row.asin, 'plan')"
                  >
                    <strong v-if="suggestedView(item.row).qty">{{ suggestedView(item.row).qty }}</strong>
                    <small>{{ suggestedView(item.row).sub }}</small>
                  </button>
                  <span v-else class="v-dim" title="没有补货批次计划">—</span>
                </template>
                <template v-else-if="col.name === '静态补货'">
                  <div v-if="restockCell(item.row).view" class="restock-cell" :title="restockCell(item.row).title">
                    <span class="restock-head">
                      <i v-for="f in restockCell(item.row).view.flags" :key="f" class="restock-flag">{{ f }}</i>
                      <strong v-if="restockCell(item.row).view.qty" class="v-amber">{{ restockCell(item.row).view.qty }}<span class="restock-unit"> 件</span><span v-if="restockCell(item.row).view.boxes" class="restock-boxes">{{ restockCell(item.row).view.boxes }}</span></strong>
                      <strong v-else-if="restockCell(item.row).view.status" class="v-amber">{{ restockCell(item.row).view.status }}</strong>
                      <span v-else class="v-dim">—</span>
                    </span>
                    <small class="restock-sub">
                      <template v-for="(part, i) in restockCell(item.row).view.subParts" :key="i">
                        <span v-if="i" class="restock-sep"> · </span><span>{{ part }}</span>
                      </template>
                    </small>
                  </div>
                  <span v-else class="v-dim" :title="restockCell(item.row).title">—</span>
                </template>
                <template v-else-if="col.name === '批次进度'">
                  <div v-if="progressView(item.row)" class="progress-cell" :class="{ overdue: cellAlertClass(item.row, col.name) }">
                    <small>{{ progressView(item.row).text }}</small>
                    <span class="progress-bar"><i :style="{ width: `${progressView(item.row).pct}%` }" /></span>
                  </div>
                  <span v-else class="v-dim">—</span>
                </template>
                <template v-else>
                  <span :class="cellView(item.row, col.name).cls">{{ cellView(item.row, col.name).text }}</span>
                </template>
              </td>
            </tr>
            <tr
              v-if="isInventoryRowExpanded(item.row.asin) || isInventoryRowClosing(item.row.asin)"
              class="inventory-row"
            >
              <td :colspan="displayCols.length + 1" class="inventory-detail-cell">
                <div class="detail-collapse" :class="{ closing: isInventoryRowClosing(item.row.asin) }">
                <div class="detail-collapse-inner">
                <div class="detail-sticky">
                <div class="detail-tabs">
                  <button
                    v-for="t in DETAIL_TABS"
                    :key="t.id"
                    type="button"
                    class="detail-tab"
                    :class="{ active: rowDetailTab(item.row) === t.id }"
                    :disabled="isDetailTabDisabled(item.row, t.id)"
                    :title="isDetailTabDisabled(item.row, t.id) ? '这个 ASIN 没有补货批次计划' : ''"
                    @click="detailTab = t.id"
                  >
                    {{ t.label }}
                  </button>
                </div>

                <TrendPanel
                  v-if="rowDetailTab(item.row) === 'trend'"
                  :series="rowTrendSeries(item.row)"
                  :loading="trendLoading"
                />

                <PlanDetail
                  v-else-if="rowDetailTab(item.row) === 'plan'"
                  :plan="rowPlan(item.row).plan"
                  :item="rowPlan(item.row).item"
                  :summary="rowPlan(item.row).summary"
                  :batches="planSummaries[rowPlan(item.row).plan.shop]?.batches || []"
                  :is-shipped="(date) => cellShipped(rowPlan(item.row).plan.shop, rowPlan(item.row).item.asin, date)"
                  :shipped-at="(date) => shippedAt(rowPlan(item.row).plan.shop, rowPlan(item.row).item.asin, date)"
                  :saving="planSaving"
                  @toggle="toggleRowShipped(item.row, $event)"
                />

                <template v-else>
                <div class="inventory-detail-grid">
                  <div class="inventory-item">
                    <span>库存健康</span>
                    <strong :class="inventoryHealthClass(item.row)">{{ inventoryHealthText(item.row) }}</strong>
                  </div>
                  <div class="inventory-item"><span>FNSKU</span><strong>{{ getCell(item.row, 'FNSKU') || '—' }}</strong></div>
                  <div class="inventory-item"><span>可售</span><strong>{{ getCell(item.row, '可售') || '—' }}</strong></div>
                  <div class="inventory-item"><span>入库中</span><strong>{{ getCell(item.row, '入库中') || '—' }}</strong></div>
                  <div class="inventory-item"><span>不可售</span><strong>{{ getCell(item.row, '不可售') || '—' }}</strong></div>
                  <div class="inventory-item"><span>预留</span><strong>{{ getCell(item.row, '预留') || '—' }}</strong></div>
                  <div class="inventory-item"><span>FBA总量</span><strong>{{ getCell(item.row, 'FBA总量') || '—' }}</strong></div>
                  <div class="inventory-item"><span>包装尺寸/cm</span><strong>{{ rowProduct(item.row)?.packageSize || rowProduct(item.row)?.packageSize1 || rowProduct(item.row)?.packageSize2 || '—' }}</strong></div>
                  <div class="inventory-item"><span>包装类型</span><strong>{{ rowProduct(item.row)?.packageType || rowProduct(item.row)?.packageType1 || rowProduct(item.row)?.packageType2 || '—' }}</strong></div>
                  <div class="inventory-item"><span>包装成本/CNY</span><strong class="inventory-paired-value">{{ pairedInventoryText(item.row, 'packageCost1', 'packageCost2') }}</strong></div>
                  <div class="inventory-item"><span>外箱尺寸/cm</span><strong class="inventory-paired-value">{{ pairedInventoryText(item.row, 'outerCartonSize1', 'outerCartonSize2') }}</strong></div>
                  <div class="inventory-item"><span>最大装箱数</span><strong class="inventory-paired-value">{{ pairedInventoryText(item.row, 'maxCartonQty1', 'maxCartonQty2') }}</strong></div>
                  <div class="inventory-item"><span>单品重量/g</span><strong>{{ rowProduct(item.row)?.itemWeight || '—' }}</strong></div>
                  <div class="inventory-item"><span>重量类型</span><strong>{{ weightTypeText(item.row) }}</strong></div>
                  <div class="inventory-item inventory-packing-mode">
                    <span>装箱方式</span>
                    <el-radio-group
                      class="packing-mode-control"
                      :model-value="rowPackingMode(item.row)"
                      size="small"
                      @change="setPackingMode(item.row, $event)"
                    >
                      <el-radio-button value="full">整箱</el-radio-button>
                      <el-radio-button value="mixed">混装</el-radio-button>
                    </el-radio-group>
                  </div>
                  <div class="inventory-item"><span>静态补货</span><strong :title="restockCell(item.row).title">{{ getCell(item.row, '静态补货') || '—' }}{{ restockCell(item.row).view?.boxes || '' }}</strong></div>
                  <label class="inventory-item inventory-input-item">
                    <span>补货用时</span>
                    <input
                      class="cell-input"
                      type="number"
                      :value="rowProduct(item.row)?.restockCycle ?? ''"
                      @change="commitEditableNumber(item.row, 'restockCycle', $event)"
                      @blur="commitEditableNumber(item.row, 'restockCycle', $event)"
                    />
                  </label>
                  <label class="inventory-item inventory-input-item">
                    <span>已下单</span>
                    <input
                      class="cell-input"
                      type="number"
                      :value="rowProduct(item.row)?.orderedQty ?? 0"
                      @change="commitEditableNumber(item.row, 'orderedQty', $event)"
                      @blur="commitEditableNumber(item.row, 'orderedQty', $event)"
                    />
                  </label>
                  <label class="inventory-item inventory-input-item">
                    <span>本地仓库</span>
                    <input
                      class="cell-input"
                      type="number"
                      :value="rowProduct(item.row)?.localWarehouse ?? 0"
                      @change="commitEditableNumber(item.row, 'localWarehouse', $event)"
                      @blur="commitEditableNumber(item.row, 'localWarehouse', $event)"
                    />
                  </label>
                  <div class="inventory-item"><span>静态月销</span><strong :title="restockCell(item.row).title">{{ restockCell(item.row).view?.sub || '—' }}</strong></div>
                  <div class="inventory-item inventory-item-end"><span>建议补货</span><strong :title="suggestedTitle(item.row)">{{ getCell(item.row, '建议补货') || '—' }}</strong></div>
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
                </template>
                </div>
                </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <transition name="selbar">
      <div v-if="selectedAsinCount" class="selbar">
        <strong>已选 {{ selectedAsinCount }} 个 ASIN</strong>
        <el-dropdown trigger="click" :disabled="batchCategoryBusy" @command="applyBatchCategory">
          <button type="button" class="selbar-btn">{{ batchCategoryBusy ? '修改中...' : '改分类 ▾' }}</button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="opt in CATEGORY_OPTIONS" :key="`batch-${opt}`" :command="opt">{{ opt }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button type="button" class="selbar-btn" @click="copySelectedAsins">复制 ASIN</button>
        <button
          type="button"
          class="selbar-btn"
          :disabled="!selectedPackageAndOrderedRows.length"
          :title="selectedPackageAndOrderedRows.length ? '' : '勾选里没有飞机盒包装的产品'"
          @click="copySelectedPackageAndOrdered"
        >
          复制飞机盒包装（{{ selectedPackageAndOrderedRows.length }}）
        </button>
        <button type="button" class="selbar-close" title="清空勾选" @click="clearSelectedAsins">✕</button>
      </div>
    </transition>

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
            <el-form-item label="产品标题" class="form-row-wide">
              <el-input v-model="productForm.productTitle" />
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
        <el-table-column label="产品标题" min-width="300">
          <template #default="scope">{{ scope.row.productTitle || '—' }}</template>
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
