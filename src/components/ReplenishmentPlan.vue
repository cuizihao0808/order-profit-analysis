<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { URGENT_WINDOW_DAYS, buildShippingSummary, isShipped, sortByUrgency } from '../lib/replenishmentPlan.js'
import { computeRestockQty } from '../lib/restockRules.js'
import {
  buildColIndex,
  buildRowByAsin,
  groupWeekFields,
  inventoryHealthText,
  isWeekFieldAlert,
  pairedText,
  toNum,
  weekCell,
  weekRoi,
  weightTypeText,
} from '../lib/weekSnapshot.js'
import { writeClipboard } from '../utils/clipboard.js'

const SHOP_KEY = 'opa:replenish-shop:v1'

/* ================= 工具 ================= */
function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function fmtMoney(n) {
  return n == null || !Number.isFinite(n) ? '—' : `¥${fmtNum(n)}`
}
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000)
}
function sum(list, pick) {
  return list.reduce((acc, x) => acc + (Number.isFinite(pick(x)) ? pick(x) : 0), 0)
}

/* ================= 数据加载 ================= */
const plans = ref([])
const warnings = ref([])
const shippedState = ref({})
const shops = ref([])
const products = ref([])
const weekMeta = ref(null) // weeks.json 里最新一周的元信息
const week = ref(null) // 最新一周的订单利润快照 { columns, rows, notes }
const restockConfig = ref({})
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const today = ref(localDate())

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const activeShop = ref(readStored(SHOP_KEY, ''))
watch(activeShop, (v) => {
  try {
    localStorage.setItem(SHOP_KEY, v)
  } catch {
    /* ignore */
  }
})

async function getJson(url, fallback) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) {
    if (fallback !== undefined) return fallback
    throw new Error(`HTTP ${r.status}`)
  }
  return r.json()
}

async function loadAll() {
  loading.value = true
  loadError.value = ''
  today.value = localDate()
  try {
    const [data, shopList, productList, weekList, config] = await Promise.all([
      getJson('/api/replenishment'),
      getJson('/api/shops', []),
      getJson('/api/products', []),
      getJson('/api/weeks', []),
      getJson('/api/restock-config', {}),
    ])
    plans.value = data.plans || []
    warnings.value = data.warnings || []
    shippedState.value = data.shipped || {}
    shops.value = shopList
    products.value = productList
    restockConfig.value = config || {}
    // weeks 按时间倒序，第一条即最新一周
    weekMeta.value = weekList[0] || null
    week.value = weekMeta.value ? await getJson(`/api/weeks/${encodeURIComponent(weekMeta.value.id)}`, null) : null
    if (!plans.value.some((p) => p.shop === activeShop.value) && plans.value.length) {
      activeShop.value = orderedPlans.value[0].shop
    }
  } catch (e) {
    loadError.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)

/* ================= 派生 ================= */
const plan = computed(() => plans.value.find((p) => p.shop === activeShop.value) || null)
const shopShipped = computed(() => (plan.value && shippedState.value[plan.value.shop]) || {})
const summary = computed(() => (plan.value ? buildShippingSummary(plan.value, shopShipped.value, today.value) : null))
const batchByKey = computed(() => Object.fromEntries((summary.value?.batches || []).map((b) => [b.key, b])))

/** CSV 里的店铺是简称（TZH），shops.json 里是全称（TZH-主店二号） */
function findShop(code) {
  return shops.value.find((s) => s.name === code || String(s.name).split('-')[0] === code) || null
}
function shopLabel(code) {
  return findShop(code)?.name || code
}

/** 店铺按钮顺序与 shops.json 一致，未匹配的店铺排最后 */
const orderedPlans = computed(() => {
  const rank = (p) => {
    const idx = shops.value.indexOf(findShop(p.shop))
    return idx < 0 ? Number.MAX_SAFE_INTEGER : idx
  }
  return plans.value.slice().sort((a, b) => rank(a) - rank(b) || a.shop.localeCompare(b.shop))
})

const productImageByAsin = computed(() => {
  const out = {}
  for (const p of products.value) {
    const img = p.amazonMainImage || p.productImage
    if (p.asin && img && !out[p.asin]) out[p.asin] = img
  }
  return out
})

const totals = computed(() => {
  const items = plan.value?.items || []
  return {
    postHoliday: sum(items, (i) => i.postHolidayRef),
    amount: sum(items, (i) => i.amount),
    weight: sum(items, (i) => i.weight),
  }
})

const nextBatchText = computed(() => {
  const b = summary.value?.nextBatch
  if (!b) return '全部已发完'
  const days = daysBetween(today.value, b.date)
  if (days > 0) return `还有 ${days} 天 · ${fmtNum(b.plannedQty - b.shippedQty)} 件待发`
  if (days === 0) return `今天发货 · ${fmtNum(b.plannedQty - b.shippedQty)} 件待发`
  return `已逾期 ${-days} 天 · ${fmtNum(b.plannedQty - b.shippedQty)} 件待发`
})

const shippedPct = computed(() => {
  const s = summary.value
  return s && s.plannedQty ? Math.round((s.shippedQty / s.plannedQty) * 100) : 0
})

/* ================= 筛选 ================= */
const activeBatch = ref('')
const rowFilter = ref('all') // all | pending | done | batch
const keyword = ref('')

watch(activeShop, () => {
  openRow.value = ''
  activeBatch.value = ''
  if (rowFilter.value === 'batch') rowFilter.value = 'all'
})
watch(activeBatch, (key) => {
  if (!key && rowFilter.value === 'batch') rowFilter.value = 'all'
})

function selectBatch(key) {
  activeBatch.value = activeBatch.value === key ? '' : key
}

const rows = computed(() => {
  const p = plan.value
  if (!p) return []
  const kw = keyword.value.trim().toLowerCase()
  const matched = p.items.filter((item) => {
    if (kw && ![item.sku, item.name, item.asin].some((v) => String(v).toLowerCase().includes(kw))) return false
    const s = summary.value.items[item.sku]
    if (rowFilter.value === 'pending') return s.plannedQty > s.shippedQty
    if (rowFilter.value === 'done') return s.plannedQty > 0 && s.plannedQty === s.shippedQty
    if (rowFilter.value === 'batch') return !!item.qtyByBatch[activeBatch.value]
    return true
  })
  /* 未来两周要补货的 SKU 置顶 */
  return sortByUrgency(matched, summary.value)
})

/* ================= 临近补货 ================= */
/** 置顶看计划，这里统计的是其中还没发货的（真正要处理的） */
const urgentCount = computed(
  () => Object.values(summary.value?.items || {}).filter((s) => s.urgent && !s.nearTermDone).length,
)

function urgentInfo(item) {
  const s = summary.value.items[item.sku]
  if (!s?.urgent) return null
  if (s.nearTermDone) {
    return {
      text: '两周内已发',
      cls: 'rp-tag-green',
      title: `${URGENT_WINDOW_DAYS} 天内的批次都已标记发货`,
    }
  }
  const d = s.dueInDays
  const text = d < 0 ? `逾期 ${-d} 天` : d === 0 ? '今天发货' : `${d} 天后补货`
  return {
    text,
    cls: d <= 0 ? 'rp-tag-red' : d <= 7 ? 'rp-tag-amber' : 'rp-tag-blue',
    title: `最近待发批次 ${s.dueBatch}（${s.dueDate}）`,
  }
}

/* ================= 最新一周订单利润 ================= */
/** 周列分组展示，未列出的列会进“其它”，保证整行数据都能看到 */
const WEEK_FIELD_GROUPS = [
  { title: '销售', cols: ['销量', '平均日销', '销售额', '含税销售额', '净销售额', '平均售价', '广告销售额', '广告销量', '多渠道销量', '补换货量'] },
  { title: '利润', cols: ['毛利润', '毛利率', '平均毛利润', '净毛利率', '其它收入', 'FBA库存赔偿'] },
  { title: '成本', cols: ['采购成本', '采购均价', '头程成本', '头程均价', '其他成本', '其他均价', '合计成本'] },
  {
    title: '费用',
    cols: [
      '平台费', '平台费占比', 'FBA发货费', 'FBA发货费占比', '其他订单费用', '总仓储费', '仓储费占比',
      '广告花费', '广告费率', '推广费', '站外推广费', 'FBA国际物流运费', '调整费', '平台其他费', '入库配置费(原合仓费)',
    ],
  },
  { title: '退货退款', cols: ['退货量', '退款量', '退货率', '退款率', '退款金额', '促销折扣', '买家运费'] },
  { title: '基础信息', cols: ['ASIN', '父ASIN', '店铺', '国家', '品名', 'SKU', '标题', '分类', '品牌', '币种', 'Listing标签', 'Listing负责人'] },
]

const WEEK_KPI_COLS = ['销量', '销售额', '毛利润', '毛利率', '广告费率', '退货率']
/** 长文本列占两格并换行 */
const WEEK_WIDE_COLS = new Set(['标题', '品名'])

const weekColIndex = computed(() => buildColIndex(week.value?.columns || []))
const weekRowByAsin = computed(() => buildRowByAsin(week.value))
const weekRange = computed(() =>
  weekMeta.value?.startDate ? `${weekMeta.value.startDate} ~ ${weekMeta.value.endDate}` : '',
)

/** products.json 拉平后带 shopId，同 ASIN 可能出现在多个店铺 */
const productByShopAsin = computed(() => {
  const map = new Map()
  for (const p of products.value) {
    if (p?.asin && p?.shopId) map.set(`${p.shopId}::${p.asin}`, p)
  }
  return map
})
const productByAsin = computed(() => {
  const map = new Map()
  for (const p of products.value) {
    if (p?.asin && !map.has(p.asin)) map.set(p.asin, p)
  }
  return map
})

/** 补货清单的 SKU 与周表的 SKU 命名不同，按 ASIN 关联 */
function weekRowFor(item) {
  return (item.asin && weekRowByAsin.value.get(item.asin)) || null
}
function productFor(item) {
  const shopId = findShop(plan.value?.shop)?.id
  if (shopId) {
    const exact = productByShopAsin.value.get(`${shopId}::${item.asin}`)
    if (exact) return exact
  }
  return productByAsin.value.get(item.asin) || null
}
function weekValue(item, col) {
  const row = weekRowFor(item)
  return row ? weekCell(row, weekColIndex.value, col) : ''
}
function weekNote(item) {
  return String(week.value?.notes?.[item.asin] || '').trim()
}

function show(v) {
  return v == null || v === '' ? '—' : String(v)
}

function weekKpis(item) {
  const row = weekRowFor(item)
  if (!row) return []
  const cols = WEEK_KPI_COLS.map((name) => ({ name, value: weekCell(row, weekColIndex.value, name) }))
  cols.splice(4, 0, { name: 'ROI', value: weekRoi(row, weekColIndex.value) })
  return cols.map((c) => ({ ...c, alert: isWeekFieldAlert(c.name, c.value) }))
}

function weekGroups(item) {
  const row = weekRowFor(item)
  if (!row || !week.value) return []
  return groupWeekFields(week.value.columns, row, WEEK_FIELD_GROUPS).map((g) => ({
    ...g,
    fields: g.fields.map((f) => ({
      ...f,
      alert: isWeekFieldAlert(f.name, f.value),
      wide: WEEK_WIDE_COLS.has(f.name),
    })),
  }))
}

/** 与周订单利润页“库存详情”一致的字段（此处只读） */
function inventoryFields(item) {
  const p = productFor(item)
  const restockQty = computeRestockQty({
    fbaTotal: toNum(p?.fbaTotal),
    sales: toNum(weekValue(item, '销量')),
    cycle: toNum(p?.restockCycle),
    config: restockConfig.value,
  })
  const health = p ? inventoryHealthText(p) : ''
  return [
    { name: '库存健康', value: show(health), tone: health === '健康' ? 'good' : health ? 'bad' : '' },
    { name: 'FNSKU', value: show(p?.fnsku) },
    { name: '可售', value: show(p?.sellable) },
    { name: '入库中', value: show(p?.inbound) },
    { name: '不可售', value: show(p?.unsellable) },
    { name: '预留', value: show(p?.reserved) },
    { name: 'FBA总量', value: show(p?.fbaTotal) },
    { name: '本地仓库', value: show(p?.localWarehouse) },
    { name: '已下单', value: show(p?.orderedQty), edit: 'orderedQty' },
    { name: '补货用时', value: show(p?.restockCycle) },
    { name: '补货数量', value: show(restockQty), tone: restockQty && restockQty !== '无需补货' ? 'warn' : '' },
    { name: '产品分类', value: show(p?.category) },
    { name: '月销量', value: show(p?.monthSales) },
    { name: '月销售额', value: show(p?.monthRevenue) },
    { name: '月订单数', value: show(p?.monthOrders) },
    { name: '日均销量', value: show(p?.dailySales) },
    { name: 'Vine赠品销量', value: show(p?.vineGiftSales) },
    { name: '包装尺寸/cm', value: show(p?.packageSize || p?.packageSize1 || p?.packageSize2) },
    { name: '包装类型', value: show(p?.packageType || p?.packageType1 || p?.packageType2) },
    { name: '包装成本/CNY', value: pairedText(p, 'packageCost1', 'packageCost2') },
    { name: '外箱尺寸/cm', value: pairedText(p, 'outerCartonSize1', 'outerCartonSize2') },
    { name: '最大装箱数', value: pairedText(p, 'maxCartonQty1', 'maxCartonQty2') },
    { name: '单品重量/g', value: show(p?.itemWeight) },
    { name: '重量类型', value: weightTypeText(p) },
    { name: '装箱方式', value: p?.packingMode === 'full' ? '整箱' : '混装' },
  ]
}

function productImages(item) {
  const p = productFor(item)
  const list = p?.listingDetailImages?.length ? p.listingDetailImages : p?.productImages || []
  return list.slice(0, 8)
}

/** 改“已下单”：写回 products.json，与周订单利润页的内联编辑同一个接口 */
const productSaving = ref(false)
async function commitOrderedQty(item, event) {
  const input = event?.target
  const product = productFor(item)
  if (!product) {
    showToast('没有找到这个 ASIN 的产品资料', 'error')
    return
  }
  const text = String(input?.value ?? '').trim()
  const next = text === '' ? 0 : Number(text)
  const current = Number(product.orderedQty ?? 0)
  if (!Number.isFinite(next)) {
    if (input) input.value = current
    return
  }
  if (next === current || productSaving.value) return

  // 乐观更新：先改本地，失败再回滚
  const idx = products.value.indexOf(product)
  products.value[idx] = { ...product, orderedQty: next }
  productSaving.value = true
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(product.asin)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product.shopId ? { orderedQty: next, shopId: product.shopId } : { orderedQty: next }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    if (input) input.value = next // 清空输入框时回填成 0
    showToast(`${item.sku} 已下单改为 ${next}`)
  } catch (e) {
    products.value[idx] = product
    if (input) input.value = current
    showToast('保存失败：' + (e.message || e), 'error')
  } finally {
    productSaving.value = false
  }
}

/* ================= 展开 ================= */
/** 同时只展开一行：打开新的一行会自动收起上一行 */
const openRow = ref('')
function rowKey(item) {
  return `${plan.value?.shop}::${item.sku}`
}
function isOpen(item) {
  return openRow.value === rowKey(item)
}
function toggleOpen(item) {
  const key = rowKey(item)
  openRow.value = openRow.value === key ? '' : key
}

/**
 * 展开的那一行会吸附在表头下面，所以要知道表头实际多高。
 * 批次列是两行文字，高度会随数据变，测量比写死可靠。
 */
const tableWrapRef = ref(null)
const headRef = ref(null)
const headHeight = ref(0)
function measureHead() {
  headHeight.value = headRef.value?.offsetHeight || 0
}
onMounted(() => {
  measureHead()
  window.addEventListener('resize', measureHead)
})
onBeforeUnmount(() => window.removeEventListener('resize', measureHead))
watch([plan, rows, openRow], () => nextTick(measureHead))

/** 收起明细后把表格滚回最上面（等明细行移除、高度回落之后再滚，否则会被浏览器的滚动锚定打断） */
watch(openRow, (next, prev) => {
  if (next || !prev) return
  nextTick(() => {
    if (tableWrapRef.value) tableWrapRef.value.scrollTop = 0
  })
})

/** 折叠面板分页：plan 为原有的补货判断，week 为最新一周订单利润 */
const detailTab = ref({})
function tabOf(item) {
  return urgentInfo(item) ? detailTab.value[rowKey(item)] || 'plan' : 'plan'
}
function setTab(item, tab) {
  detailTab.value = { ...detailTab.value, [rowKey(item)]: tab }
}

/* ================= 标记已发货 ================= */
const toast = ref({ show: false, text: '', type: 'success' })
let toastTimer = null
function showToast(text, type = 'success') {
  toast.value = { show: true, text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value.show = false
  }, 2400)
}

function cellShipped(item, batchKey) {
  return isShipped(shopShipped.value, item.sku, batchKey)
}

function cellTitle(item, b) {
  const at = shopShipped.value[item.sku]?.[b.key]
  return at ? `已于 ${fmtTime(at)} 标记发货，点击撤销` : `${b.key} 批次 ${item.qtyByBatch[b.key]} 件，点击标记已发货`
}

async function saveShipped(entries, shipped) {
  const shop = plan.value.shop
  saving.value = true
  try {
    const r = await fetch('/api/replenishment/shipped', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, entries, shipped }),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
    shippedState.value = { ...shippedState.value, [shop]: data.shipped }
    return true
  } catch (e) {
    showToast('保存失败：' + (e.message || e), 'error')
    return false
  } finally {
    saving.value = false
  }
}

async function toggleCell(item, b) {
  if (saving.value) return
  const shipped = !cellShipped(item, b.key)
  const ok = await saveShipped([{ sku: item.sku, batch: b.key }], shipped)
  if (ok) showToast(`${item.sku} · ${b.key} ${shipped ? '已标记发货' : '已撤销发货'}`)
}

const activeBatchInfo = computed(() => (activeBatch.value ? batchByKey.value[activeBatch.value] || null : null))

async function markBatch(shipped) {
  const b = activeBatchInfo.value
  if (!b || saving.value) return
  const entries = plan.value.items
    .filter((item) => item.qtyByBatch[b.key] && cellShipped(item, b.key) !== shipped)
    .map((item) => ({ sku: item.sku, batch: b.key }))
  if (!entries.length) return
  const verb = shipped ? '标记为已发货' : '撤销已发货'
  if (!confirm(`把 ${b.key} 批次的 ${entries.length} 个 SKU ${verb}？`)) return
  const ok = await saveShipped(entries, shipped)
  if (ok) showToast(`${b.key} 批次 ${entries.length} 个 SKU 已${shipped ? '标记发货' : '撤销发货'}`)
}

async function copyBatchList() {
  const b = activeBatchInfo.value
  if (!b) return
  const items = plan.value.items.filter((item) => item.qtyByBatch[b.key])
  const lines = [
    ['SKU', '品名', 'ASIN', '件数'].join('\t'),
    ...items.map((item) => [item.sku, item.name, item.asin, item.qtyByBatch[b.key]].join('\t')),
    ['合计', '', '', b.plannedQty].join('\t'),
  ]
  try {
    await writeClipboard(lines.join('\n'))
    showToast(`已复制 ${b.key} 批次 ${items.length} 个 SKU`)
  } catch {
    showToast('复制失败，请重试', 'error')
  }
}

/* ================= 展示辅助 ================= */
function batchStatusText(b) {
  if (b.status === 'empty') return '无计划'
  if (b.status === 'done') return '已发货'
  if (b.overdue) return b.status === 'partial' ? `逾期 ${b.shippedSkus}/${b.plannedSkus}` : '逾期未发'
  if (b.status === 'partial') return `已发 ${b.shippedSkus}/${b.plannedSkus}`
  return '待发货'
}

function emergencyClass(text) {
  if (text.startsWith('有必要')) return 'rp-tag-red'
  if (text.startsWith('建议带')) return 'rp-tag-amber'
  if (text.includes('可选')) return 'rp-tag-outline'
  return ''
}

function itemProgress(item) {
  return summary.value.items[item.sku]
}

const TAIL_COLS = 5
const colCount = computed(() => 6 + (plan.value?.batches.length || 0) + TAIL_COLS)
</script>

<template>
  <div class="app rp-page">
    <header class="topbar">
      <div class="topbar-left">
        <span class="crumb">订单利润分析</span>
        <span class="crumb-sep">/</span>
        <span class="title">
          <span class="title-badge">OPA</span>
          补货批次计划
        </span>
      </div>
    </header>

    <div class="toolbar toolbar-modern">
      <span class="tool-label">店铺</span>
      <el-button
        v-for="p in orderedPlans"
        :key="p.shop"
        :type="p.shop === activeShop ? 'primary' : ''"
        class="rp-shop-btn"
        :class="{ active: p.shop === activeShop }"
        @click="activeShop = p.shop"
      >
        {{ shopLabel(p.shop) }}
        <span class="rp-shop-count">{{ p.items.length }}</span>
      </el-button>
      <span class="tool-label rp-tool-gap">显示</span>
      <el-radio-group v-model="rowFilter" class="rp-filter">
        <el-radio-button value="all">全部SKU</el-radio-button>
        <el-radio-button value="pending">有待发</el-radio-button>
        <el-radio-button value="done">已发完</el-radio-button>
        <el-radio-button value="batch" :disabled="!activeBatch">仅所选批次</el-radio-button>
      </el-radio-group>
      <el-input v-model="keyword" class="tool-ep-input rp-search" clearable placeholder="SKU / 品名 / ASIN" />
      <span class="rp-spacer" />
      <el-button type="primary" :loading="loading" @click="loadAll">{{ loading ? '加载中...' : '刷新数据' }}</el-button>
    </div>

    <div class="metabar">
      <template v-if="plan">
        <el-tag effect="light" round disable-transitions>SKU {{ plan.items.length }}</el-tag>
        <el-tag effect="light" round disable-transitions>批次 {{ plan.batches.length }}</el-tag>
        <el-tag v-if="urgentCount" type="danger" effect="light" round disable-transitions>
          {{ URGENT_WINDOW_DAYS }} 天内待发 {{ urgentCount }} SKU（已置顶）
        </el-tag>
        <el-tag v-if="rows.length !== plan.items.length" effect="light" round disable-transitions>当前显示 {{ rows.length }}</el-tag>
      </template>
      <div class="status">
        {{ loading ? '正在加载...' : plan ? `${plan.file} · 更新于 ${fmtTime(plan.updatedAt)}` : '' }}
      </div>
    </div>

    <div class="rp-body">
      <div v-if="loading && !plans.length" class="rp-empty">正在加载补货清单…</div>
      <div v-else-if="loadError" class="rp-empty">加载失败：{{ loadError }}</div>
      <div v-else-if="!plan" class="rp-empty">
        还没有补货清单<br />
        <small>把“补货清单_周批次版” CSV 放到 src/data/replenishment/ 后点“刷新数据”</small>
      </div>

      <template v-else>
        <div v-for="w in warnings" :key="w" class="rp-warning">{{ w }}</div>

        <section class="rp-panel rp-summary">
          <div class="rp-kpi">
            <div class="rp-kpi-label">春节前计划</div>
            <div class="rp-kpi-value">{{ fmtNum(summary.plannedQty) }}<small>件</small></div>
            <div class="rp-kpi-sub">{{ summary.batches.filter((b) => b.status !== 'empty').length }} 个批次</div>
          </div>
          <div class="rp-kpi">
            <div class="rp-kpi-label">已发货</div>
            <div class="rp-kpi-value">{{ fmtNum(summary.shippedQty) }}<small>件</small></div>
            <div class="rp-progress"><i :style="{ width: `${shippedPct}%` }" /></div>
            <div class="rp-kpi-sub">完成 {{ shippedPct }}%，待发 {{ fmtNum(summary.plannedQty - summary.shippedQty) }} 件</div>
          </div>
          <div class="rp-kpi" :class="{ 'rp-kpi-warn': summary.nextBatch?.overdue }">
            <div class="rp-kpi-label">下一批</div>
            <div class="rp-kpi-value">{{ summary.nextBatch ? summary.nextBatch.key : '—' }}</div>
            <div class="rp-kpi-sub">{{ nextBatchText }}</div>
          </div>
          <div class="rp-kpi">
            <div class="rp-kpi-label">采购金额参考</div>
            <div class="rp-kpi-value">{{ fmtMoney(totals.amount) }}</div>
            <div class="rp-kpi-sub">{{ plan.weeklyNotes.amount || '春节前合计' }}</div>
          </div>
          <div class="rp-kpi">
            <div class="rp-kpi-label">净重参考</div>
            <div class="rp-kpi-value">{{ fmtNum(totals.weight, 1) }}<small>kg</small></div>
            <div class="rp-kpi-sub">{{ plan.weeklyNotes.weight || '春节前合计' }}</div>
          </div>
          <div class="rp-kpi">
            <div class="rp-kpi-label">节后首班参考</div>
            <div class="rp-kpi-value">{{ fmtNum(totals.postHoliday) }}<small>件</small></div>
            <div class="rp-kpi-sub">须节前备好</div>
          </div>
        </section>

        <section class="rp-panel rp-batches">
          <div class="rp-section-head">
            <strong>发货批次</strong>
            <span>{{ plan.weeklyNotes.qty || '每周一批' }} · 点击批次查看明细和批量操作</span>
          </div>
          <div class="rp-batch-strip">
            <button
              v-for="b in summary.batches"
              :key="b.key"
              type="button"
              class="rp-batch"
              :class="[`is-${b.status}`, { active: b.key === activeBatch, overdue: b.overdue }]"
              :disabled="b.status === 'empty'"
              @click="selectBatch(b.key)"
            >
              <div class="rp-batch-top">
                <strong>{{ b.key }}</strong>
                <span class="rp-batch-status">{{ batchStatusText(b) }}</span>
              </div>
              <div class="rp-batch-note">{{ b.note || ' ' }}</div>
              <div class="rp-batch-qty">{{ fmtNum(b.plannedQty) }}<small> 件 · {{ b.plannedSkus }} SKU</small></div>
              <div class="rp-batch-meta">
                {{ fmtMoney(plan.weekly.amount[b.key]) }} · {{ fmtNum(plan.weekly.weight[b.key], 1) }}kg
              </div>
              <div class="rp-progress">
                <i :style="{ width: b.plannedQty ? `${(b.shippedQty / b.plannedQty) * 100}%` : '0%' }" />
              </div>
            </button>
          </div>

          <div v-if="activeBatchInfo" class="rp-batch-bar">
            <div class="rp-batch-bar-info">
              <strong>{{ activeBatchInfo.key }} 批次</strong>
              <span>{{ activeBatchInfo.date }}</span>
              <span v-if="activeBatchInfo.note">{{ activeBatchInfo.note }}</span>
              <span>{{ activeBatchInfo.plannedSkus }} SKU · {{ fmtNum(activeBatchInfo.plannedQty) }} 件</span>
              <span :class="activeBatchInfo.status === 'done' ? 'trend-good' : activeBatchInfo.overdue ? 'trend-bad' : ''">
                已发 {{ activeBatchInfo.shippedSkus }}/{{ activeBatchInfo.plannedSkus }} SKU · {{ fmtNum(activeBatchInfo.shippedQty) }} 件
              </span>
            </div>
            <div class="rp-batch-bar-actions">
              <el-button @click="copyBatchList">复制本批清单</el-button>
              <el-button
                v-if="activeBatchInfo.shippedSkus"
                :disabled="saving"
                @click="markBatch(false)"
              >
                撤销本批已发货
              </el-button>
              <el-button
                type="primary"
                :disabled="saving || activeBatchInfo.status === 'done'"
                @click="markBatch(true)"
              >
                {{ activeBatchInfo.status === 'done' ? '本批已全部发货' : '整批标记已发货' }}
              </el-button>
              <el-button text @click="activeBatch = ''">取消选择</el-button>
            </div>
          </div>
        </section>

        <section class="rp-panel rp-table-panel">
          <div class="rp-section-head">
            <strong>SKU 批次明细</strong>
            <span>点击数字标记该批次已发货，再点一次撤销；点击 ▶ 查看判断说明</span>
          </div>
          <div ref="tableWrapRef" class="rp-table-wrap" :style="{ '--rp-head-h': `${headHeight}px` }">
            <div v-if="!rows.length" class="rp-empty">当前筛选条件下没有 SKU</div>
            <table v-else class="rp-table">
              <thead ref="headRef">
                <tr>
                  <th class="fix-left rp-col-expand"></th>
                  <th class="fix-left fix-last rp-col-product">产品</th>
                  <th>ASIN</th>
                  <th class="num">当前可用</th>
                  <th class="num">在途</th>
                  <th>应急判断</th>
                  <th
                    v-for="b in summary.batches"
                    :key="b.key"
                    class="rp-col-batch"
                    :class="{ 'is-active': b.key === activeBatch, 'is-done': b.status === 'done', 'is-overdue': b.overdue }"
                    :title="`${b.date}${b.note ? ` · ${b.note}` : ''} · 点击选中该批次`"
                    @click="b.status !== 'empty' && selectBatch(b.key)"
                  >
                    <div>{{ b.key }}</div>
                    <small>{{ b.status === 'done' ? '已发货' : b.note || ' ' }}</small>
                  </th>
                  <th class="num">春节前合计</th>
                  <th>发货进度</th>
                  <th class="num">节后首班</th>
                  <th class="num">采购金额</th>
                  <th class="num">净重kg</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="item in rows" :key="item.sku">
                  <tr
                    :class="{
                      'rp-row-open': isOpen(item),
                      'rp-row-done': itemProgress(item).plannedQty && itemProgress(item).plannedQty === itemProgress(item).shippedQty,
                      'rp-row-urgent': !!urgentInfo(item),
                    }"
                  >
                    <td class="fix-left rp-col-expand">
                      <button class="expand-btn" :class="{ open: isOpen(item) }" title="判断说明" @click="toggleOpen(item)">▶</button>
                    </td>
                    <td class="fix-left fix-last rp-col-product">
                      <div class="rp-product">
                        <img v-if="productImageByAsin[item.asin]" :src="productImageByAsin[item.asin]" :alt="item.name" loading="lazy" />
                        <div v-else class="rp-thumb-empty">无图</div>
                        <div class="rp-product-text">
                          <div class="rp-name" :title="item.name">{{ item.name || '—' }}</div>
                          <div class="rp-sku">
                            {{ item.sku }}
                            <span
                              v-if="urgentInfo(item)"
                              class="rp-tag"
                              :class="urgentInfo(item).cls"
                              :title="urgentInfo(item).title"
                            >
                              {{ urgentInfo(item).text }}
                            </span>
                            <span v-if="item.remark.includes('利润红旗')" class="rp-tag rp-tag-red">利润红旗</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <a v-if="item.asin" class="rp-asin" :href="`https://www.amazon.com/dp/${item.asin}`" target="_blank" rel="noopener">
                        {{ item.asin }}
                      </a>
                      <span v-else class="muted">—</span>
                    </td>
                    <td class="num">{{ fmtNum(item.available) }}</td>
                    <td class="num">{{ fmtNum(item.inbound) }}</td>
                    <td>
                      <span v-if="item.emergency" class="rp-tag" :class="emergencyClass(item.emergency)">{{ item.emergency }}</span>
                    </td>
                    <td
                      v-for="b in summary.batches"
                      :key="b.key"
                      class="rp-cell"
                      :class="{ 'is-active': b.key === activeBatch }"
                    >
                      <button
                        v-if="item.qtyByBatch[b.key]"
                        type="button"
                        class="rp-qty"
                        :class="{ shipped: cellShipped(item, b.key), overdue: b.overdue && !cellShipped(item, b.key) }"
                        :disabled="saving"
                        :title="cellTitle(item, b)"
                        @click="toggleCell(item, b)"
                      >
                        <span v-if="cellShipped(item, b.key)" class="rp-check">✓</span>{{ item.qtyByBatch[b.key] }}
                      </button>
                    </td>
                    <td class="num rp-strong">{{ fmtNum(item.preHolidayTotal) }}</td>
                    <td class="rp-col-progress">
                      <div class="rp-mini">
                        <span>{{ fmtNum(itemProgress(item).shippedQty) }}/{{ fmtNum(itemProgress(item).plannedQty) }}</span>
                        <div class="rp-progress">
                          <i
                            :style="{
                              width: itemProgress(item).plannedQty
                                ? `${(itemProgress(item).shippedQty / itemProgress(item).plannedQty) * 100}%`
                                : '0%',
                            }"
                          />
                        </div>
                      </div>
                    </td>
                    <td class="num">{{ fmtNum(item.postHolidayRef) }}</td>
                    <td class="num">{{ fmtMoney(item.amount) }}</td>
                    <td class="num">{{ fmtNum(item.weight, 1) }}</td>
                  </tr>
                  <tr v-if="isOpen(item)" class="rp-detail-row">
                    <td :colspan="colCount">
                      <div class="rp-detail">
                        <div class="rp-detail-tabs">
                          <button
                            type="button"
                            class="rp-detail-tab"
                            :class="{ active: tabOf(item) === 'plan' }"
                            @click="setTab(item, 'plan')"
                          >
                            补货判断
                          </button>
                          <button
                            type="button"
                            class="rp-detail-tab"
                            :class="{ active: tabOf(item) === 'week' }"
                            :disabled="!urgentInfo(item)"
                            :title="urgentInfo(item) ? '最新一周订单利润的全部数据' : '仅两周内需要补货的产品展示'"
                            @click="setTab(item, 'week')"
                          >
                            最新周订单利润
                            <small v-if="weekMeta">{{ weekMeta.id }}</small>
                          </button>
                          <span v-if="!urgentInfo(item)" class="rp-detail-tab-hint">仅两周内需补货的产品可查看周数据</span>
                        </div>

                        <div v-if="tabOf(item) === 'plan'" class="rp-detail-pane">
                          <div class="rp-detail-grid">
                            <div><span>日均需求参考</span>{{ item.dailyDemand || '—' }}</div>
                            <div><span>在途晚到 7 天时残余缺口</span>{{ item.lateGap || '—' }}</div>
                            <div><span>9/26 应急量</span>{{ item.emergency || '—' }}</div>
                          </div>
                          <div class="rp-detail-block"><span>判断说明</span>{{ item.reason || '—' }}</div>
                          <div class="rp-detail-block"><span>备注</span>{{ item.remark || '—' }}</div>
                        </div>

                        <div v-else class="rp-detail-pane">
                          <template v-if="weekRowFor(item)">
                            <div class="rp-week-head">
                              <strong>{{ weekMeta.id }}</strong>
                              <span class="rp-week-range">{{ weekRange }}</span>
                              <span class="rp-tag">{{ weekValue(item, '店铺') || shopLabel(plan.shop) }}</span>
                              <span class="rp-tag rp-tag-outline">SKU {{ weekValue(item, 'SKU') || item.sku }}</span>
                              <span v-if="productFor(item)?.category" class="rp-tag">{{ productFor(item).category }}</span>
                              <a
                                v-if="item.asin"
                                class="rp-asin rp-week-link"
                                :href="`https://www.amazon.com/dp/${item.asin}`"
                                target="_blank"
                                rel="noopener"
                              >{{ item.asin }}</a>
                            </div>

                            <div class="rp-week-kpis">
                              <div v-for="k in weekKpis(item)" :key="k.name" class="rp-week-kpi">
                                <span>{{ k.name === '销量' ? '周销量' : k.name }}</span>
                                <strong :class="{ 'rp-val-bad': k.alert }">{{ k.value || '—' }}</strong>
                              </div>
                            </div>

                            <div class="rp-week-cards">
                              <section v-for="g in weekGroups(item)" :key="g.title" class="rp-week-card">
                                <h4>{{ g.title }}</h4>
                                <div class="rp-week-grid">
                                  <div
                                    v-for="f in g.fields"
                                    :key="f.name"
                                    class="rp-week-field"
                                    :class="{ 'rp-week-field-wide': f.wide }"
                                  >
                                    <span :title="f.name">{{ f.name === '销量' ? '周销量' : f.name }}</span>
                                    <strong :class="{ 'rp-val-bad': f.alert }" :title="String(f.value)">{{ f.value || '—' }}</strong>
                                  </div>
                                </div>
                              </section>

                              <section class="rp-week-card rp-week-card-wide">
                                <h4>库存详情</h4>
                                <div class="rp-week-grid">
                                  <div v-for="f in inventoryFields(item)" :key="f.name" class="rp-week-field">
                                    <span :title="f.name">{{ f.name }}</span>
                                    <input
                                      v-if="f.edit === 'orderedQty'"
                                      class="rp-week-input"
                                      type="number"
                                      min="0"
                                      step="1"
                                      :value="productFor(item)?.orderedQty ?? 0"
                                      :disabled="!productFor(item)"
                                      title="改完回车或点空白处自动保存"
                                      @change="commitOrderedQty(item, $event)"
                                      @blur="commitOrderedQty(item, $event)"
                                      @keyup.enter="$event.target.blur()"
                                    />
                                    <strong
                                      v-else
                                      :class="{
                                        'rp-val-bad': f.tone === 'bad',
                                        'rp-val-good': f.tone === 'good',
                                        'rp-val-warn': f.tone === 'warn',
                                      }"
                                      :title="String(f.value)"
                                    >{{ f.value }}</strong>
                                  </div>
                                </div>
                                <div v-if="productImages(item).length" class="rp-week-images">
                                  <a
                                    v-for="(img, i) in productImages(item)"
                                    :key="`${item.sku}-img-${i}`"
                                    :href="img"
                                    target="_blank"
                                    rel="noopener"
                                    title="打开大图"
                                  >
                                    <img :src="img" :alt="`${item.name} 图片 ${i + 1}`" loading="lazy" />
                                  </a>
                                </div>
                              </section>
                            </div>

                            <div class="rp-detail-block"><span>本周备注</span>{{ weekNote(item) || '—' }}</div>
                          </template>
                          <div v-else class="rp-week-empty">
                            最新一周（{{ weekMeta ? weekMeta.id : '—' }}）里没有 {{ item.asin || item.sku }} 的订单利润数据
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
              <tfoot>
                <tr>
                  <td class="fix-left rp-col-expand"></td>
                  <td class="fix-left fix-last rp-col-product"><strong>每周合计</strong><small class="muted">（全部 SKU）</small></td>
                  <td colspan="4"></td>
                  <td v-for="b in summary.batches" :key="b.key" class="rp-cell" :class="{ 'is-active': b.key === activeBatch }">
                    <div class="rp-foot-qty">{{ b.plannedQty ? fmtNum(b.plannedQty) : '' }}</div>
                    <small v-if="b.shippedQty" class="trend-good">已发 {{ fmtNum(b.shippedQty) }}</small>
                  </td>
                  <td class="num rp-strong">{{ fmtNum(summary.plannedQty) }}</td>
                  <td>{{ fmtNum(summary.shippedQty) }}/{{ fmtNum(summary.plannedQty) }}</td>
                  <td class="num">{{ fmtNum(totals.postHoliday) }}</td>
                  <td class="num">{{ fmtMoney(totals.amount) }}</td>
                  <td class="num">{{ fmtNum(totals.weight, 1) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </template>
    </div>

    <div v-if="toast.show" class="toast" :class="`toast-${toast.type}`">
      <span class="loading-dot toast-icon">✓</span>
      <span>{{ toast.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.rp-spacer {
  flex: 1;
}
.rp-tool-gap {
  margin-left: 8px;
}
.rp-shop-btn + .rp-shop-btn {
  margin-left: 0;
}
.rp-shop-btn .rp-shop-count {
  margin-left: 6px;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--tag-text);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.rp-shop-btn.active .rp-shop-count {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}
.rp-search {
  width: 200px;
}

.rp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rp-body > * {
  flex-shrink: 0;
}
.rp-empty {
  margin: 60px auto;
  text-align: center;
  color: var(--muted);
  line-height: 1.8;
}
.rp-warning {
  padding: 8px 12px;
  border: 1px solid #f8dfb0;
  background: #fffaf0;
  color: #946200;
  border-radius: 10px;
  font-size: 12px;
}

.rp-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px 16px;
  box-shadow: 0 8px 24px rgba(38, 35, 30, 0.06);
}
.rp-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}
.rp-section-head strong {
  color: var(--text-strong);
  font-size: 14px;
}

/* ---------- 汇总 ---------- */
.rp-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.rp-kpi {
  background: var(--accent-soft-2);
  border-radius: 8px;
  padding: 8px 10px;
  min-width: 0;
}
.rp-kpi-warn {
  background: #fdf3f2;
}
.rp-kpi-label {
  color: var(--muted);
  font-size: 12px;
}
.rp-kpi-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 2px 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rp-kpi-value small {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
.rp-kpi-sub {
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rp-kpi-warn .rp-kpi-sub {
  color: #b42318;
}

.rp-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--line-soft);
  overflow: hidden;
  margin: 4px 0;
}
.rp-progress i {
  display: block;
  height: 100%;
  background: #13795b;
  border-radius: inherit;
  transition: width 0.2s ease;
}

/* ---------- 批次 ---------- */
.rp-batch-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.rp-batch {
  flex: 0 0 132px;
  text-align: left;
  font: inherit;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.rp-batch:hover {
  border-color: #888;
}
.rp-batch.active {
  border-color: #111;
  box-shadow: inset 0 0 0 1px #111;
}
.rp-batch.is-done {
  background: #f3faf6;
  border-color: #cce7d5;
}
.rp-batch.is-done.active {
  border-color: #13795b;
  box-shadow: inset 0 0 0 1px #13795b;
}
.rp-batch.overdue {
  border-color: #f3c7c5;
  background: #fdf8f7;
}
.rp-batch.is-empty {
  opacity: 0.45;
  cursor: default;
}
.rp-batch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.rp-batch-top strong {
  font-size: 14px;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.rp-batch-status {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--muted);
  white-space: nowrap;
}
.is-done .rp-batch-status {
  background: #dff1e7;
  color: #13795b;
}
.is-partial .rp-batch-status {
  background: #111;
  color: #fff;
}
.overdue .rp-batch-status {
  background: #ffe8e6;
  color: #b42318;
}
.rp-batch-note {
  font-size: 11px;
  color: #946200;
  min-height: 16px;
}
.rp-batch-qty {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.rp-batch-qty small {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
.rp-batch-meta {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rp-batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--accent-soft-2);
}
.rp-batch-bar-info {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rp-batch-bar-info strong {
  color: var(--text-strong);
  font-size: 14px;
}
.rp-batch-bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.rp-batch-bar-actions .el-button + .el-button {
  margin-left: 0;
}

/* ---------- 明细表 ---------- */
.rp-table-panel {
  padding-bottom: 0;
  overflow: hidden;
}
.rp-table-wrap {
  max-height: calc(100vh - 150px);
  min-height: 240px;
  overflow: auto;
  margin: 0 -16px;
  border-top: 1px solid var(--line-soft);
}
.rp-table {
  width: max-content;
  min-width: 100%;
}
.rp-table thead th {
  font-size: 12px;
}
.rp-table th.num,
.rp-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rp-col-expand {
  left: 0;
  width: 40px;
  min-width: 40px;
  max-width: 40px;
  text-align: center;
  padding: 0 !important;
}
.rp-col-product {
  left: 40px;
  width: 250px;
  min-width: 250px;
  max-width: 250px;
}
.rp-product {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rp-product img,
.rp-thumb-empty {
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid var(--line-soft);
  object-fit: contain;
  background: #fff;
}
.rp-thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--muted);
}
.rp-product-text {
  min-width: 0;
}
.rp-name {
  font-weight: 600;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
}
.rp-sku {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
}
.rp-row-done .rp-name {
  color: var(--muted);
}
.rp-asin {
  color: var(--text);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}
.rp-asin:hover {
  text-decoration: underline;
}
.rp-strong {
  font-weight: 700;
  color: var(--text-strong);
}

.rp-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--muted);
  white-space: nowrap;
}
.rp-tag-red {
  background: #ffe8e6;
  color: #b42318;
}
.rp-tag-amber {
  background: #fff5dc;
  color: #946200;
}
.rp-tag-outline {
  background: #fff;
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--line);
}
.rp-tag-blue {
  background: #e8f1ff;
  color: #1d4ed8;
}
.rp-tag-green {
  background: #e6f4ec;
  color: #1a7f45;
}

/* 未来两周要补货的 SKU 置顶并加左侧标识 */
.rp-row-urgent td {
  background: #fffaf5;
}
.rp-row-urgent .rp-col-expand {
  box-shadow: inset 3px 0 0 0 #e08a2e;
}
.rp-row-urgent.rp-row-done td {
  background: #f7faf8;
}
.rp-row-urgent.rp-row-done .rp-col-expand {
  box-shadow: inset 3px 0 0 0 #7fb99a;
}
.rp-row-urgent .rp-name {
  font-weight: 600;
  color: var(--text-strong);
}

.rp-col-batch {
  min-width: 64px;
  text-align: center !important;
  cursor: pointer;
  line-height: 1.25;
}
.rp-col-batch small {
  display: block;
  font-size: 10px;
  color: #946200;
  font-weight: 400;
}
.rp-col-batch.is-done small {
  color: #13795b;
}
.rp-col-batch.is-overdue {
  color: #b42318;
}
.rp-table thead th.rp-col-batch.is-active {
  background: #111;
  color: #fff;
}
.rp-table thead th.rp-col-batch.is-active small {
  color: rgba(255, 255, 255, 0.75);
}
.rp-cell {
  text-align: center;
  padding: 6px 8px !important;
}
.rp-table tbody td.rp-cell.is-active,
.rp-table tfoot td.rp-cell.is-active {
  background: #f4f4f4;
}
.rp-qty {
  min-width: 44px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--text-strong);
  font: inherit;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.rp-qty:hover:not(:disabled) {
  border-color: #111;
}
.rp-qty:disabled {
  cursor: progress;
}
.rp-qty.shipped {
  background: #e8f5ee;
  border-color: #bfe3cf;
  color: #13795b;
}
.rp-qty.shipped:hover:not(:disabled) {
  border-color: #13795b;
}
.rp-qty.overdue {
  background: #fdf3f2;
  border-color: #f3c7c5;
  color: #b42318;
}
.rp-check {
  margin-right: 3px;
  font-size: 11px;
}

.rp-col-progress {
  min-width: 110px;
}
.rp-mini span {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rp-mini .rp-progress {
  margin: 3px 0 0;
}

/* 展开的那一行吸附在表头下面，下拉时始终能看到行数据 */
.rp-table tbody tr.rp-row-open > td {
  position: sticky;
  top: var(--rp-head-h, 44px);
  z-index: 6;
  background: #fff6e9;
  border-bottom: 1px solid var(--line);
  box-shadow: 0 2px 6px rgba(38, 35, 30, 0.08);
}
.rp-table tbody tr.rp-row-open > td.fix-left {
  z-index: 7;
  background: #fff6e9;
}
.rp-table tbody tr.rp-row-open:hover > td {
  background: #fff1dd;
}
.rp-row-open .rp-name {
  color: var(--text-strong);
}
.rp-detail-row td {
  background: #fafafa;
  padding: 0 !important;
  white-space: normal;
}
.rp-detail {
  position: sticky;
  left: 0;
  max-width: min(1100px, calc(100vw - 260px));
  padding: 10px 16px 14px 56px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
}
.rp-detail span {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.rp-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.rp-detail-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ---------- 折叠面板分页 ---------- */
.rp-detail-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px;
  border-radius: 10px;
  background: var(--accent-soft-2);
  align-self: flex-start;
}
.rp-detail-tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  border: 0;
  border-radius: 8px;
  padding: 5px 14px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.rp-detail-tab:hover:not(:disabled) {
  color: var(--text-strong);
}
.rp-detail-tab.active {
  background: var(--panel);
  color: var(--text-strong);
  box-shadow: 0 1px 3px rgba(38, 35, 30, 0.14);
}
.rp-detail-tab:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.rp-detail-tab small {
  font-size: 10px;
  color: var(--muted);
}
.rp-detail-tab-hint {
  padding-right: 8px;
  color: var(--muted);
  font-size: 11px;
}

/* ---------- 最新一周订单利润 ---------- */
.rp-week-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rp-week-head strong {
  color: var(--text-strong);
  font-size: 13px;
}
.rp-week-head span {
  display: inline-block;
}
.rp-week-range {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.rp-week-link {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
}
.rp-week-kpis {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}
.rp-week-kpi {
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  min-width: 0;
}
.rp-week-kpi span {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.rp-week-kpi strong {
  display: block;
  margin-top: 2px;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rp-week-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.rp-week-card {
  padding: 10px 12px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--panel);
  min-width: 0;
}
.rp-week-card-wide {
  grid-column: 1 / -1;
}
.rp-week-card h4 {
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.rp-week-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px 12px;
}
.rp-week-field {
  min-width: 0;
}
.rp-week-field span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.rp-week-field-wide {
  grid-column: span 2;
}
.rp-week-field-wide strong {
  white-space: normal !important;
  line-height: 1.5;
}
.rp-week-field strong {
  display: block;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.rp-week-input {
  width: 100%;
  margin-top: 1px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.rp-week-input:hover:not(:disabled) {
  border-color: var(--accent);
}
.rp-week-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.rp-week-input:disabled {
  background: var(--accent-soft-2);
  color: var(--muted);
}
.rp-val-bad {
  color: #b42318 !important;
}
.rp-val-good {
  color: #1a7f45 !important;
}
.rp-val-warn {
  color: #946200 !important;
}
.rp-week-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.rp-week-images img {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: #fff;
}
.rp-week-empty {
  padding: 18px 0;
  color: var(--muted);
  text-align: center;
}

.rp-table tfoot td {
  position: sticky;
  bottom: 0;
  z-index: 3;
  background: var(--header-bg);
  border-top: 1px solid var(--line);
  padding: 8px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.rp-table tfoot td.fix-left {
  z-index: 5;
  background: var(--header-bg);
}
.rp-table tfoot small {
  display: block;
  font-size: 10px;
}
.rp-foot-qty {
  font-weight: 700;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1280px) {
  .rp-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .rp-week-kpis {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .rp-week-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
