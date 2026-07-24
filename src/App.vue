<script setup>
import { computed, onMounted, ref, watch } from 'vue'

/* ================= 常量 ================= */
const FIXED_COLS = ['品名', 'ASIN']
const COL_CONFIG_KEY = 'opa:column-config:v4'
const SHOP_FILTER_KEY = 'opa:shop-filter:v1'
const WEEK_KEY = 'opa:current-week:v1'
const FIXED_WIDTHS = { 品名: 260, ASIN: 140 }
const EXPAND_COL_WIDTH = 40

/**
 * ASIN 主数据字段（存于 src/data/products/{shopId}.json）
 * 仅保留下列主属性，其余属性从 xlsx 快照取：
 *   asin / parentAsin / name / category / restockCycle / stock
 */
const MASTER_COL_TO_KEY = {
  ASIN: 'asin',
  '父ASIN': 'parentAsin',
  '品名': 'name',
}

/** 产品分类选项 */
const CATEGORY_OPTIONS = ['正常', '观望', '断货', '放弃']

/**
 * 扩展列定义：
 * - type='edit-select' 可编辑下拉；存于 products.json
 * - type='edit-num'    可编辑数字；存于 products.json
 * - type='calc'        公式计算，不可编辑
 */
const EXTRA_COLS = [
  { name: '备注', key: 'note', type: 'edit-week-text' },
  { name: '产品分类', key: 'category', type: 'edit-select', options: CATEGORY_OPTIONS },
  { name: '补货周期', key: 'restockCycle', type: 'edit-num' },
  { name: '库存数量', key: 'stock', type: 'edit-num' },
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

/** 默认可见列（不含固定列），遵守需求顺序 */
const DEFAULT_VISIBLE_ORDER = [
  '备注',
  '产品分类',
  '销量',
  '采购成本',
  '毛利润',
  '广告费率',
  'ROI',
  '库存数量',
  '补货周期',
  '补货数量',
]
const DEFAULT_VISIBLE_SET = new Set(DEFAULT_VISIBLE_ORDER)

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

const customCols = ref([]) // [{ name, visible }]
const shopFilter = ref('__all__')
const expandedGroups = ref(new Set())
const status = ref('正在加载...')

const showFieldPanel = ref(false)
const showShopPanel = ref(false)
const showProductPanel = ref(false)
const showImportPanel = ref(false)
const importScan = ref({ unimported: [], imported: [] })
const importResult = ref(null) // 导入完成后的汇总
const importLoading = ref(false)
const importBusy = ref(false)
const importMessage = ref('')
const toast = ref({ show: false, text: '', type: 'success' })
let toastTimer = null

/* ================= 派生数据 ================= */
const productMap = computed(() => new Map(products.value.map((p) => [p.asin, p])))

const colIndex = computed(() => {
  const idx = {}
  const cols = currentWeek.value?.columns ?? []
  cols.forEach((name, i) => (idx[name] = i))
  return idx
})

const allRows = computed(() => currentWeek.value?.rows ?? [])

const filteredRows = computed(() => {
  if (shopFilter.value === '__all__') return allRows.value
  return allRows.value.filter((r) => getCell(r, '店铺') === shopFilter.value)
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
 *  2. 扩展字段（产品分类/补货周期/库存数量）取 products.json
 *  3. ROI = ROUND(毛利润 / 采购成本, 2)
 *  4. 补货数量 = IF(库存数量 < 销量*(12+补货周期), 销量*4*0.8, '无需补货')
 *  5. 其余取 xlsx 快照
 */
function getCell(row, colName) {
  if (!row) return ''
  const product = productMap.value.get(row.asin)

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
        const stock = toNum(product?.stock)
        const sales = toNum(row.values[colIndex.value['销量']])
        const cycle = toNum(product?.restockCycle)
        if (!Number.isFinite(stock) || !Number.isFinite(sales) || !Number.isFinite(cycle)) return ''
        if (sales <= 0) return '无需补货'
        const threshold = sales * (12 + cycle)
        if (stock < threshold) {
          return String(Math.round(sales * 4 * 0.8))
        }
        return '无需补货'
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

/** 判断某行是否被标记为「放弃」 */
function isAbandoned(row) {
  if (!row) return false
  return productMap.value.get(row.asin)?.category === '放弃'
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

/**
 * 按 父ASIN 分组
 * - 父体（header）已放弃 → 整组隐藏
 * - 子体已放弃 → 该子体隐藏
 */
const groups = computed(() => {
  const list = filteredRows.value
  if (!list.length) return []

  const map = new Map()
  for (const row of list) {
    const parent = getCell(row, '父ASIN') || row.asin || ''
    if (!map.has(parent)) map.set(parent, [])
    map.get(parent).push(row)
  }

  const result = []
  for (const [key, rows] of map) {
    let headerRow = rows.find((r) => r.asin === key)
    let children
    if (headerRow) children = rows.filter((r) => r !== headerRow)
    else {
      headerRow = rows[0]
      children = rows.slice(1)
    }
    if (isAbandoned(headerRow)) continue
    children = children.filter((r) => !isAbandoned(r)).sort((a, b) => profitValue(b) - profitValue(a))
    result.push({ key, header: headerRow, children })
  }
  return result.sort((a, b) => profitValue(b.header) - profitValue(a.header))
})

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

const rowCount = computed(() => groups.value.length)
const childCount = computed(() =>
  groups.value.reduce((s, g) => s + g.children.length, 0),
)
const shopNames = computed(() => shops.value.map((s) => s.name))

function fixedLeft(displayIndex) {
  let left = EXPAND_COL_WIDTH
  for (let i = 0; i < displayIndex; i++) {
    const name = FIXED_COLS[i]
    left += FIXED_WIDTHS[name] ?? 120
  }
  return left + 'px'
}

function fixedColStyle(displayIndex, colName) {
  const width = FIXED_WIDTHS[colName] ?? 120
  return {
    left: fixedLeft(displayIndex),
    width: width + 'px',
    minWidth: width + 'px',
    maxWidth: width + 'px',
  }
}

const expandColStyle = {
  left: '0px',
  width: EXPAND_COL_WIDTH + 'px',
  minWidth: EXPAND_COL_WIDTH + 'px',
  maxWidth: EXPAND_COL_WIDTH + 'px',
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
    await Promise.all([loadShops(), loadProducts(), loadWeeks()])

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
    status.value = `订单 ${allRows.value.length} 行 · 店铺 ${shops.value.length} · ASIN ${products.value.length}`
  }
}

function showToast(text, type = 'success') {
  toast.value = { show: true, text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value.show = false
  }, 2400)
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
  customCols.value = merged
}

/* ================= 交互 ================= */
function toggleGroup(key) {
  const s = new Set(expandedGroups.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expandedGroups.value = s
}
function expandAll() {
  const s = new Set()
  for (const g of groups.value) if (g.children.length) s.add(g.key)
  expandedGroups.value = s
}
function collapseAll() {
  expandedGroups.value = new Set()
}

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
  customCols.value = list
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
async function patchProduct(asin, patch) {
  if (!asin) return
  const targets = [{ asin, patch }]

  // 联动：父体改为「放弃」时，所有子体同步「放弃」
  if (patch.category === '放弃') {
    for (const p of products.value) {
      if (p.parentAsin === asin && p.asin !== asin && p.category !== '放弃') {
        targets.push({ asin: p.asin, patch: { category: '放弃' } })
      }
    }
  }

  // 乐观更新：先改本地
  const backups = []
  for (const t of targets) {
    const idx = products.value.findIndex((p) => p.asin === t.asin)
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
          body: JSON.stringify(t.patch),
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

/* ================= 导入 ================= */
async function openImport() {
  showImportPanel.value = true
  importResult.value = null
  importMessage.value = '正在扫描 xlsx...'
  importLoading.value = true
  try {
    const r = await fetch('/api/scan', { cache: 'no-store' })
    importScan.value = r.ok ? await r.json() : { unimported: [], imported: [] }
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

async function doImport(files) {
  importBusy.value = true
  importMessage.value = `正在导入 ${files.length} 个文件...`
  try {
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    })
    const data = await r.json()
    importResult.value = data.results
    await Promise.all([loadShops(), loadProducts(), loadWeeks()])
    // 自动切到最新导入的一周
    if (weeks.value.length) {
      currentWeekId.value = weeks.value[0].id
      await loadCurrentWeek()
    }
    // 刷新扫描列表
    const r2 = await fetch('/api/scan', { cache: 'no-store' })
    importScan.value = r2.ok ? await r2.json() : { unimported: [], imported: [] }
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
    updateStatus()
  } catch (e) {
    importMessage.value = e.message || '导入失败'
    showToast(importMessage.value, 'error')
  } finally {
    importBusy.value = false
  }
}

async function deleteWeek(week) {
  if (!confirm(`确定删除周次「${week.filename}」的快照？（xlsx 文件不受影响，可再次导入）`)) return
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

onMounted(() => {
  try {
    const v = localStorage.getItem(SHOP_FILTER_KEY)
    if (v) shopFilter.value = v
  } catch {
    /* ignore */
  }
  bootstrap()
})
</script>

<template>
  <div class="app">
    <div v-if="toast.show" class="toast" :class="`toast-${toast.type}`">
      <span class="loading-dot toast-icon">✓</span>
      <span>{{ toast.text }}</span>
    </div>
    <header class="topbar">
      <div class="topbar-left">
        <span class="crumb">订单利润分析</span>
        <span class="crumb-sep">/</span>
        <span class="title">
          <span class="title-badge">▦</span>
          周订单利润
        </span>
      </div>
    </header>

    <div class="toolbar">
      <span class="tool-label">周次</span>
      <select class="tool-select" v-model="currentWeekId" :disabled="!weeks.length">
        <option v-if="!weeks.length" value="">暂无</option>
        <option v-for="w in weeks" :key="w.id" :value="w.id">
          {{ w.startDate }} ~ {{ w.endDate }}（{{ w.rowCount }} 行）
        </option>
      </select>

      <span class="tool-divider"></span>

      <span class="tool-label">店铺</span>
      <select class="tool-select" v-model="shopFilter" :disabled="!shopNames.length">
        <option value="__all__">全部店铺（{{ shopNames.length }}）</option>
        <option v-for="s in shopNames" :key="s" :value="s">{{ s }}</option>
      </select>

      <span class="tool-divider"></span>

      <button class="tool-btn primary" type="button" :disabled="importLoading || importBusy" @click="openImport">
        <span v-if="importLoading || importBusy" class="loading-dot loading-spin"></span>
        {{ importLoading ? '扫描中...' : importBusy ? '导入中...' : '⇪ 扫描并导入' }}
      </button>
      <button class="tool-btn" type="button" @click="showShopPanel = true">店铺</button>
      <button class="tool-btn" type="button" @click="showProductPanel = true">ASIN</button>

      <span class="tool-divider"></span>

      <button class="tool-btn" type="button" @click="expandAll">展开</button>
      <button class="tool-btn" type="button" @click="collapseAll">收起</button>

      <span class="tool-divider"></span>

      <button class="tool-btn primary" type="button" @click="showFieldPanel = true">
        ⚙ 字段
      </button>
    </div>

    <div class="metabar">
      <div class="pill">父 ASIN {{ rowCount }}</div>
      <div class="pill">子 ASIN {{ childCount }}</div>
      <div class="pill" v-if="shopFilter !== '__all__'">当前店铺：{{ shopFilter }}</div>
      <div class="status">{{ status }}</div>
    </div>

    <div class="table-wrap">
      <div v-if="!currentWeek || !groups.length" class="empty">
        {{
          !weeks.length
            ? '尚未导入任何周数据，点击右上「扫描并导入」开始'
            : '当前筛选条件下没有数据'
        }}
      </div>
      <table v-else>
        <thead>
          <tr>
            <th class="col-expand fix-left" :style="expandColStyle"></th>
            <th
              v-for="(col, i) in displayCols"
              :key="col.name"
              :class="{ 'fix-left': col.fixed, 'fix-last': col.fixed && col.name === 'ASIN' }"
              :style="col.fixed ? fixedColStyle(i, col.name) : null"
            >
              {{ col.name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in groups" :key="g.key">
            <tr :class="['parent-row', { 'row-need-restock': hasRestockNeed(g.header) }]">
              <td class="col-expand fix-left" :style="expandColStyle">
                <button
                  v-if="g.children.length"
                  class="expand-btn"
                  :class="{ open: expandedGroups.has(g.key) }"
                  type="button"
                  @click="toggleGroup(g.key)"
                >
                  ▶
                </button>
              </td>
              <td
                v-for="(col, i) in displayCols"
                :key="col.name"
                :class="[cellAlertClass(g.header, col.name), {
                  'fix-left': col.fixed,
                  'fix-last': col.fixed && col.name === 'ASIN',
                  num: numericColumns[col.name],
                  'cell-name': col.name === '品名',
                  'cell-edit': isEditableCol(col.name),
                }]"
                :style="col.fixed ? fixedColStyle(i, col.name) : null"
              >
                <span
                  v-if="col.name === '品名' && g.children.length"
                  class="badge-count"
                  :title="`共 ${g.children.length + 1} 个 ASIN`"
                >
                  {{ g.children.length + 1 }}
                </span>
                <template v-if="editColKey(col.name) === 'category'">
                  <select
                    class="cell-select"
                    :class="'cat-' + (productMap.get(g.header.asin)?.category || '正常')"
                    :value="productMap.get(g.header.asin)?.category || '正常'"
                    @change="patchProduct(g.header.asin, { category: $event.target.value })"
                  >
                    <option v-for="opt in CATEGORY_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
                  </select>
                </template>
                <template v-else-if="editColKey(col.name) === 'name'">
                  <input
                    class="cell-input"
                    type="text"
                    :value="productMap.get(g.header.asin)?.name ?? ''"
                    @change="patchProduct(g.header.asin, { name: $event.target.value.trim() })"
                  />
                </template>
                <template v-else-if="editColKey(col.name) === 'restockCycle' || editColKey(col.name) === 'stock'">
                  <input
                    class="cell-input"
                    type="number"
                    :value="productMap.get(g.header.asin)?.[editColKey(col.name)] ?? ''"
                    @change="patchProduct(g.header.asin, { [editColKey(col.name)]: $event.target.value === '' ? '' : Number($event.target.value) })"
                  />
                </template>
                <template v-else-if="editColKey(col.name) === 'note'">
                  <input
                    class="cell-input"
                    type="text"
                    :value="getWeekNote(g.header.asin)"
                    placeholder="本周备注"
                    @change="patchWeekNote(g.header.asin, $event.target.value)"
                  />
                </template>
                <template v-else>{{ getCell(g.header, col.name) }}</template>
              </td>
            </tr>
            <template v-if="expandedGroups.has(g.key)">
              <tr
                v-for="child in g.children"
                :key="child.asin || child._rowIndex"
                :class="['child-row', { 'row-need-restock': hasRestockNeed(child) }]"
              >
                <td class="col-expand fix-left" :style="expandColStyle"></td>
                <td
                  v-for="(col, i) in displayCols"
                  :key="col.name"
                  :class="[cellAlertClass(child, col.name), {
                    'fix-left': col.fixed,
                    'fix-last': col.fixed && col.name === 'ASIN',
                    num: numericColumns[col.name],
                    'cell-name': col.name === '品名',
                    'cell-edit': isEditableCol(col.name),
                  }]"
                  :style="col.fixed ? fixedColStyle(i, col.name) : null"
                >
                  <span v-if="col.name === '品名'" class="tree-line">└</span>
                  <template v-if="editColKey(col.name) === 'category'">
                    <select
                      class="cell-select"
                      :class="'cat-' + (productMap.get(child.asin)?.category || '正常')"
                      :value="productMap.get(child.asin)?.category || '正常'"
                      @change="patchProduct(child.asin, { category: $event.target.value })"
                    >
                      <option v-for="opt in CATEGORY_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                  </template>
                  <template v-else-if="editColKey(col.name) === 'name'">
                    <input
                      class="cell-input"
                      type="text"
                      :value="productMap.get(child.asin)?.name ?? ''"
                      @change="patchProduct(child.asin, { name: $event.target.value.trim() })"
                    />
                  </template>
                  <template v-else-if="editColKey(col.name) === 'restockCycle' || editColKey(col.name) === 'stock'">
                    <input
                      class="cell-input"
                      type="number"
                      :value="productMap.get(child.asin)?.[editColKey(col.name)] ?? ''"
                      @change="patchProduct(child.asin, { [editColKey(col.name)]: $event.target.value === '' ? '' : Number($event.target.value) })"
                    />
                  </template>
                  <template v-else-if="editColKey(col.name) === 'note'">
                    <input
                      class="cell-input"
                      type="text"
                      :value="getWeekNote(child.asin)"
                      placeholder="本周备注"
                      @change="patchWeekNote(child.asin, $event.target.value)"
                    />
                  </template>
                  <template v-else>{{ getCell(child, col.name) }}</template>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 字段配置抽屉 -->
    <div v-if="showFieldPanel" class="drawer-mask" @click.self="showFieldPanel = false">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>字段配置</h3>
          <button class="tool-btn" type="button" @click="showFieldPanel = false">✕</button>
        </header>
        <div class="drawer-tip">
          固定列：品名、ASIN（不可调整）。其它字段可自定义显隐与顺序，配置保存在浏览器。
        </div>
        <div class="drawer-actions">
          <button class="tool-btn" type="button" @click="setAllColsVisible(true)">全选</button>
          <button class="tool-btn" type="button" @click="setAllColsVisible(false)">全不选</button>
          <button class="tool-btn" type="button" @click="resetColConfig">重置</button>
        </div>
        <ul class="col-list">
          <li v-for="(col, i) in customCols" :key="col.name" class="col-item">
            <label class="col-check">
              <input type="checkbox" :checked="col.visible" @change="toggleColVisible(i)" />
              <span>
                {{ col.name }}
                <em v-if="isCalcCol(col.name)" class="col-badge col-badge-calc">公式</em>
                <em v-else-if="EXTRA_COL_NAMES.includes(col.name)" class="col-badge">可编辑</em>
              </span>
            </label>
            <div class="col-order">
              <button class="tool-btn icon" type="button" :disabled="i === 0" @click="moveCol(i, -1)">↑</button>
              <button class="tool-btn icon" type="button" :disabled="i === customCols.length - 1" @click="moveCol(i, 1)">↓</button>
            </div>
          </li>
        </ul>
      </aside>
    </div>

    <!-- 店铺管理抽屉 -->
    <div v-if="showShopPanel" class="drawer-mask" @click.self="showShopPanel = false">
      <aside class="drawer drawer-wide">
        <header class="drawer-head">
          <h3>店铺管理</h3>
          <button class="tool-btn" type="button" @click="showShopPanel = false">✕</button>
        </header>
        <div class="drawer-tip">
          数据存于 <code>src/data/shops.json</code>。导入 xlsx 时新店铺会自动追加。
        </div>
        <section class="shop-form">
          <div class="form-row">
            <label>店铺名称 *</label>
            <input v-model="shopForm.name" placeholder="例如 LPH-主店三号-US" />
          </div>
          <div class="form-row">
            <label>国家</label>
            <input v-model="shopForm.country" placeholder="美国 / 日本..." />
          </div>
          <div class="form-row">
            <label>备注</label>
            <input v-model="shopForm.note" placeholder="选填" />
          </div>
          <div class="form-actions">
            <button class="tool-btn primary" type="button" @click="saveShop">
              {{ shopEditingId ? '保存修改' : '新增店铺' }}
            </button>
            <button v-if="shopEditingId" class="tool-btn" type="button" @click="resetShopForm">取消</button>
            <span v-if="shopMessage" class="form-msg">{{ shopMessage }}</span>
          </div>
        </section>
        <div class="shop-list-head">已有店铺（{{ shops.length }}）</div>
        <ul class="shop-list">
          <li v-for="shop in shops" :key="shop.id" class="shop-item">
            <div class="shop-info">
              <div class="shop-name">{{ shop.name }}</div>
              <div class="shop-meta">
                <span>{{ shop.country || '—' }}</span>
                <span v-if="shop.note"> · {{ shop.note }}</span>
                <span class="shop-id">{{ shop.id }}</span>
              </div>
            </div>
            <div class="shop-actions">
              <button class="tool-btn" type="button" @click="pickShop(shop)">编辑</button>
              <button class="tool-btn danger" type="button" @click="deleteShop(shop)">删除</button>
            </div>
          </li>
          <li v-if="!shops.length" class="shop-empty">还没有店铺</li>
        </ul>
      </aside>
    </div>

    <!-- 产品(ASIN) 管理抽屉 -->
    <div v-if="showProductPanel" class="drawer-mask" @click.self="showProductPanel = false">
      <aside class="drawer drawer-wide">
        <header class="drawer-head">
          <h3>ASIN 主数据（{{ products.length }}）</h3>
          <button class="tool-btn" type="button" @click="showProductPanel = false">✕</button>
        </header>
        <div class="drawer-tip">
          数据存于 <code>src/data/products/{shopId}.json</code>（每个店铺一个文件）。导入 xlsx 时新 ASIN 会根据店铺自动归属。
        </div>

        <section class="shop-form">
          <div class="form-grid">
            <div class="form-row">
              <label>ASIN *</label>
              <input v-model="productForm.asin" :disabled="productEditing" />
            </div>
            <div class="form-row">
              <label>父 ASIN</label>
              <input v-model="productForm.parentAsin" />
            </div>
            <div class="form-row form-row-wide">
              <label>品名</label>
              <input v-model="productForm.name" />
            </div>
            <div class="form-row">
              <label>店铺 *</label>
              <select v-model="productForm.shopId">
                <option value="" disabled>请选择</option>
                <option v-for="s in shops" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button class="tool-btn primary" type="button" @click="saveProduct">
              {{ productEditing ? '保存修改' : '新增 ASIN' }}
            </button>
            <button v-if="productEditing" class="tool-btn" type="button" @click="resetProductForm">取消编辑</button>
            <span v-if="productMessage" class="form-msg">{{ productMessage }}</span>
          </div>
        </section>

        <div class="shop-list-head" style="display: flex; gap: 8px; align-items: center">
          <span>已有 ASIN ({{ filteredProducts.length }} / {{ products.length }})</span>
          <input v-model="productSearch" class="tool-select" placeholder="搜索 ASIN / 品名 / 店铺" style="flex: 1; height: 30px; padding: 0 10px" />
        </div>
        <ul class="shop-list">
          <li v-for="p in filteredProducts" :key="p.asin" class="shop-item">
            <div class="shop-info">
              <div class="shop-name">
                {{ p.name || '(未命名)' }}
                <span class="col-badge">{{ p.asin }}</span>
              </div>
              <div class="shop-meta">
                <span>{{ shopNameById.get(p.shopId) || '—' }}</span>
                <span v-if="p.parentAsin"> · 父 {{ p.parentAsin }}</span>
              </div>
            </div>
            <div class="shop-actions">
              <button class="tool-btn" type="button" @click="pickProduct(p)">编辑</button>
              <button class="tool-btn danger" type="button" @click="deleteProduct(p)">删除</button>
            </div>
          </li>
          <li v-if="!filteredProducts.length" class="shop-empty">
            {{ products.length ? '没有匹配结果' : '还没有 ASIN，请先导入 xlsx' }}
          </li>
        </ul>
      </aside>
    </div>

    <!-- 导入抽屉 -->
    <div v-if="showImportPanel" class="drawer-mask" @click.self="showImportPanel = false">
      <aside class="drawer drawer-wide">
        <header class="drawer-head">
          <h3>扫描并导入 xlsx</h3>
          <button class="tool-btn" type="button" @click="showImportPanel = false">✕</button>
        </header>
        <div class="drawer-tip">
          xlsx 文件放在 <code>public/data/</code>。导入后每周数据会永久保存到 <code>src/data/weeks/</code>。
        </div>
        <div v-if="importMessage" class="drawer-tip" :class="{ 'is-loading': importLoading || importBusy }">
          <span v-if="importLoading || importBusy" class="loading-dot loading-spin"></span>
          {{ importMessage }}
        </div>

        <section class="shop-form" v-if="importScan.unimported.length">
          <div class="shop-list-head">
            待导入（{{ importScan.unimported.length }}）
          </div>
          <ul class="shop-list">
            <li v-for="f in importScan.unimported" :key="f.filename" class="shop-item">
              <div class="shop-info">
                <div class="shop-name">{{ f.filename }}</div>
                <div class="shop-meta">
                  <span>{{ f.startDate || '—' }} ~ {{ f.endDate || '—' }}</span>
                </div>
              </div>
              <div class="shop-actions">
                <button class="tool-btn primary" type="button" :disabled="importBusy || importLoading" @click="doImport([f.filename])">
                  <span v-if="importBusy" class="loading-dot loading-spin"></span>
                  {{ importBusy ? '导入中...' : '导入' }}
                </button>
              </div>
            </li>
          </ul>
          <div class="form-actions">
            <button
              class="tool-btn primary"
              type="button"
              :disabled="importBusy || importLoading"
              @click="doImport(importScan.unimported.map((f) => f.filename))"
            >
              <span v-if="importBusy" class="loading-dot loading-spin"></span>
              {{ importBusy ? '导入中...' : '全部导入' }}
            </button>
          </div>
        </section>
        <div v-else class="drawer-tip" style="padding: 20px 16px">
          没有待导入的 xlsx。请把新一周的 xlsx 放到 <code>public/data/</code> 后再次扫描。
        </div>

        <section v-if="importResult && importResult.length" class="shop-form">
          <div class="shop-list-head">导入结果</div>
          <ul class="shop-list">
            <li v-for="r in importResult" :key="r.filename || r.weekId" class="shop-item">
              <div class="shop-info" style="width: 100%">
                <div class="shop-name">
                  <template v-if="r.error">
                    <span style="color: #f54a45">✗ {{ r.filename }}</span>
                  </template>
                  <template v-else>
                    ✓ {{ r.filename }}
                    <span class="col-badge">{{ r.rowCount }} 行</span>
                  </template>
                </div>
                <div class="shop-meta" v-if="!r.error">
                  <span v-if="r.newShops && r.newShops.length">
                    新增店铺 {{ r.newShops.length }}：{{ r.newShops.map((s) => s.name).join('、') }}
                  </span>
                  <span v-if="r.newAsins && r.newAsins.length">
                    · 新增 ASIN {{ r.newAsins.length }}
                  </span>
                  <span v-if="!(r.newShops || []).length && !(r.newAsins || []).length">
                    无新增主数据
                  </span>
                </div>
                <div class="shop-meta" v-else>{{ r.error }}</div>
              </div>
            </li>
          </ul>
        </section>

        <div class="shop-list-head">已导入（{{ importScan.imported.length }}）</div>
        <ul class="shop-list">
          <li v-for="w in importScan.imported" :key="w.id" class="shop-item">
            <div class="shop-info">
              <div class="shop-name">{{ w.filename }}</div>
              <div class="shop-meta">
                <span>{{ w.startDate }} ~ {{ w.endDate }}</span>
                <span> · {{ w.rowCount }} 行</span>
                <span> · {{ (w.importedAt || '').replace('T', ' ').slice(0, 19) }}</span>
              </div>
            </div>
            <div class="shop-actions">
              <button class="tool-btn danger" type="button" @click="deleteWeek(w)">删除</button>
            </div>
          </li>
          <li v-if="!importScan.imported.length" class="shop-empty">尚未导入任何周</li>
        </ul>
      </aside>
    </div>
  </div>
</template>
