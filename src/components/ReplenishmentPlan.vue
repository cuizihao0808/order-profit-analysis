<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { buildShippingSummary, isShipped } from '../lib/replenishmentPlan.js'
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
    const [data, shopList, productList] = await Promise.all([
      getJson('/api/replenishment'),
      getJson('/api/shops', []),
      getJson('/api/products', []),
    ])
    plans.value = data.plans || []
    warnings.value = data.warnings || []
    shippedState.value = data.shipped || {}
    shops.value = shopList
    products.value = productList
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
  return p.items.filter((item) => {
    if (kw && ![item.sku, item.name, item.asin].some((v) => String(v).toLowerCase().includes(kw))) return false
    const s = summary.value.items[item.sku]
    if (rowFilter.value === 'pending') return s.plannedQty > s.shippedQty
    if (rowFilter.value === 'done') return s.plannedQty > 0 && s.plannedQty === s.shippedQty
    if (rowFilter.value === 'batch') return !!item.qtyByBatch[activeBatch.value]
    return true
  })
})

/* ================= 展开 ================= */
const expanded = ref(new Set())
function rowKey(item) {
  return `${plan.value?.shop}::${item.sku}`
}
function isOpen(item) {
  return expanded.value.has(rowKey(item))
}
function toggleOpen(item) {
  const next = new Set(expanded.value)
  const key = rowKey(item)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
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
          <div class="rp-table-wrap">
            <div v-if="!rows.length" class="rp-empty">当前筛选条件下没有 SKU</div>
            <table v-else class="rp-table">
              <thead>
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
                        <div class="rp-detail-grid">
                          <div><span>日均需求参考</span>{{ item.dailyDemand || '—' }}</div>
                          <div><span>在途晚到 7 天时残余缺口</span>{{ item.lateGap || '—' }}</div>
                          <div><span>9/26 应急量</span>{{ item.emergency || '—' }}</div>
                        </div>
                        <div class="rp-detail-block"><span>判断说明</span>{{ item.reason || '—' }}</div>
                        <div class="rp-detail-block"><span>备注</span>{{ item.remark || '—' }}</div>
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

.rp-row-open td {
  background: #fafafa;
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
}
</style>
