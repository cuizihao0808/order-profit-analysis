<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import focusConfig from '../data/focusProducts.json'

/* ================= 工具 ================= */
function toNum(v) {
  if (v == null || v === '') return NaN
  const s = String(v).replace(/[$,\s]/g, '').replace(/%$/, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

function fmtNum(n, digits = 0) {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function fmtPct(n) {
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—'
}

/**
 * 指标定义
 * - pick: 从周快照行中取值
 * - kind: 'num' | 'money' | 'pct' | 'ratio'
 * - better: 'up' 越高越好 / 'down' 越低越好（用于环比着色）
 */
const METRICS = [
  { key: 'sales', label: '周销量', kind: 'num', better: 'up', pick: (g) => toNum(g('销量')) },
  { key: 'revenue', label: '销售额', kind: 'money', better: 'up', pick: (g) => toNum(g('销售额')) },
  { key: 'profit', label: '毛利润', kind: 'money', better: 'up', pick: (g) => toNum(g('毛利润')) },
  { key: 'margin', label: '毛利率', kind: 'pct', better: 'up', pick: (g) => toNum(g('毛利率')) },
  { key: 'price', label: '平均售价', kind: 'money', better: 'up', pick: (g) => toNum(g('平均售价')) },
  { key: 'adSpend', label: '广告花费', kind: 'money', better: 'down', pick: (g) => Math.abs(toNum(g('广告花费'))) },
  { key: 'adRate', label: '广告费率', kind: 'pct', better: 'down', pick: (g) => toNum(g('广告费率')) },
  {
    key: 'adShare',
    label: '广告单占比',
    kind: 'pct',
    better: 'down',
    pick: (g) => {
      const ad = toNum(g('广告销量'))
      const total = toNum(g('销量'))
      return Number.isFinite(ad) && total > 0 ? (ad / total) * 100 : NaN
    },
  },
  {
    key: 'roi',
    label: 'ROI',
    kind: 'ratio',
    better: 'up',
    pick: (g) => {
      const profit = toNum(g('毛利润'))
      const cost = Math.abs(toNum(g('采购成本')))
      return Number.isFinite(profit) && cost > 0 ? profit / cost : NaN
    },
  },
  { key: 'refundRate', label: '退款率', kind: 'pct', better: 'down', pick: (g) => toNum(g('退款率')) },
]
const KPI_KEYS = ['sales', 'revenue', 'profit', 'margin', 'adRate', 'roi', 'refundRate']
const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]))

function fmtMetric(metric, n) {
  if (!Number.isFinite(n)) return '—'
  if (metric.kind === 'pct') return fmtPct(n)
  if (metric.kind === 'money') return `${n < 0 ? '-' : ''}$${fmtNum(Math.abs(n), 2)}`
  if (metric.kind === 'ratio') return n.toFixed(2)
  return fmtNum(n)
}

/** 环比：百分比类指标用 pp 差值，其它用变化率 */
function deltaOf(metric, cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null
  const diff = cur - prev
  let text
  if (metric.kind === 'pct') {
    text = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp`
  } else if (metric.kind === 'ratio') {
    text = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`
  } else if (prev === 0) {
    text = diff === 0 ? '0%' : '新增'
  } else {
    const rate = (diff / Math.abs(prev)) * 100
    text = `${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%`
  }
  let tone = 'flat'
  if (Math.abs(diff) > 1e-9) {
    const good = metric.better === 'up' ? diff > 0 : diff < 0
    tone = good ? 'good' : 'bad'
  }
  return { text, tone, arrow: diff > 0 ? '▲' : diff < 0 ? '▼' : '' }
}

/* ================= 数据加载 ================= */
const shops = ref([])
const products = ref([])
const weekSnapshots = ref([]) // 按时间升序 [{ id, startDate, endDate, columns, rows }]
const loading = ref(true)
const loadError = ref('')
const activeShopId = ref('shop-1')

async function getJson(url, fallback) {
  const r = await fetch(url, { cache: 'no-store' })
  return r.ok ? r.json() : fallback
}

async function loadAll() {
  loading.value = true
  loadError.value = ''
  try {
    const [shopList, productList, weekList] = await Promise.all([
      getJson('/api/shops', []),
      getJson('/api/products', []),
      getJson('/api/weeks', []),
    ])
    shops.value = shopList
    products.value = productList
    if (!shopList.some((s) => s.id === activeShopId.value) && shopList.length) {
      activeShopId.value = shopList[0].id
    }

    const sorted = weekList.slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
    const snapshots = await Promise.all(
      sorted.map(async (w) => {
        const data = await getJson(`/api/weeks/${encodeURIComponent(w.id)}`, null)
        return data ? { ...w, columns: data.columns || [], rows: data.rows || [], notes: data.notes || {} } : null
      }),
    )
    weekSnapshots.value = snapshots.filter(Boolean)
  } catch (e) {
    loadError.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)

/* ================= 折叠 ================= */
const COLLAPSED_KEY = 'opa:focus-collapsed:v1'

function readCollapsed() {
  try {
    const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

const collapsedKeys = ref(readCollapsed())

watch(collapsedKeys, (set) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore */
  }
})

function collapseKey(asin) {
  return `${activeShopId.value}::${asin}`
}
function isCollapsed(asin) {
  return collapsedKeys.value.has(collapseKey(asin))
}
function toggleCollapsed(asin) {
  const next = new Set(collapsedKeys.value)
  const key = collapseKey(asin)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
}
function setAllCollapsed(collapsed) {
  const next = new Set(collapsedKeys.value)
  for (const v of shopViews.value) {
    const key = collapseKey(v.asin)
    if (collapsed) next.add(key)
    else next.delete(key)
  }
  collapsedKeys.value = next
}

/* ================= 派生 ================= */
const focusAsinsByShop = computed(() => {
  const out = {}
  for (const s of shops.value) {
    const list = Array.isArray(focusConfig[s.id]) ? focusConfig[s.id] : []
    out[s.id] = list.map((a) => String(a).trim()).filter(Boolean)
  }
  return out
})

const focusTotal = computed(() =>
  Object.values(focusAsinsByShop.value).reduce((acc, list) => acc + list.length, 0),
)

const activeShop = computed(() => shops.value.find((s) => s.id === activeShopId.value) || null)

/** 某周某店某 ASIN 的行 */
function findWeekRow(week, shopName, asin) {
  const cols = week.columns
  const shopIdx = cols.indexOf('店铺')
  let fallback = null
  for (const row of week.rows) {
    if (String(row.asin || '').trim() !== asin) continue
    if (shopIdx < 0) return row
    if (String(row.values?.[shopIdx] ?? '').trim() === shopName) return row
    fallback = fallback || row
  }
  return fallback
}

function buildProductView(shop, asin) {
  const product = products.value.find((p) => p.asin === asin && p.shopId === shop.id)
    || products.value.find((p) => p.asin === asin)
    || null

  const series = weekSnapshots.value.map((week) => {
    const row = findWeekRow(week, shop.name, asin)
    const idx = {}
    week.columns.forEach((c, i) => (idx[c] = i))
    const g = (col) => (row && idx[col] != null ? row.values[idx[col]] : '')
    const metrics = {}
    for (const m of METRICS) metrics[m.key] = row ? m.pick(g) : NaN
    return {
      weekId: week.id,
      range: `${String(week.startDate).slice(5)}~${String(week.endDate).slice(5)}`,
      hasData: !!row,
      rowTitle: g('标题'),
      rowName: g('品名'),
      note: week.notes?.[asin] || '',
      metrics,
    }
  })

  const withData = series.filter((s) => s.hasData)
  const latest = withData[withData.length - 1] || null
  const previous = withData[withData.length - 2] || null

  const kpis = KPI_KEYS.map((key) => {
    const metric = METRIC_BY_KEY[key]
    const cur = latest?.metrics[key]
    return {
      key,
      label: metric.label,
      value: fmtMetric(metric, cur),
      delta: previous ? deltaOf(metric, cur, previous.metrics[key]) : null,
    }
  })

  const daily = toNum(product?.dailySales)
  const fbaTotal = toNum(product?.fbaTotal)
  const inventory = [
    { label: '可售', value: fmtNum(toNum(product?.sellable)) },
    { label: '入库中', value: fmtNum(toNum(product?.inbound)) },
    { label: '预留', value: fmtNum(toNum(product?.reserved)) },
    { label: 'FBA总量', value: fmtNum(fbaTotal) },
    { label: '本地仓库', value: fmtNum(toNum(product?.localWarehouse)) },
    { label: '已下单', value: fmtNum(toNum(product?.orderedQty)) },
    { label: '日均销量', value: fmtNum(daily, 2) },
    {
      label: 'FBA可售天数',
      value: Number.isFinite(fbaTotal) && daily > 0 ? `${Math.floor(fbaTotal / daily)} 天` : '—',
      warn: Number.isFinite(fbaTotal) && daily > 0 && fbaTotal / daily < 30,
    },
  ]

  const brief = latest
    ? ['sales', 'profit', 'margin'].map((key) => {
        const metric = METRIC_BY_KEY[key]
        return {
          key,
          label: metric.label,
          value: fmtMetric(metric, latest.metrics[key]),
          delta: previous ? deltaOf(metric, latest.metrics[key], previous.metrics[key]) : null,
        }
      })
    : []

  return {
    asin,
    brief,
    name: product?.name || latest?.rowName || '(未命名)',
    title: product?.productTitle || latest?.rowTitle || '',
    parentAsin: product?.parentAsin && product.parentAsin !== '-' ? product.parentAsin : '',
    category: product?.category || '',
    fnsku: product?.fnsku || '',
    image: product?.amazonMainImage || product?.productImage || '',
    latest,
    previous,
    kpis,
    inventory,
    series,
    missingProduct: !product,
  }
}

const shopViews = computed(() => {
  const shop = activeShop.value
  if (!shop) return []
  return (focusAsinsByShop.value[shop.id] || []).map((asin) => buildProductView(shop, asin))
})

/** 店铺汇总：重点产品最新周合计 */
const shopSummary = computed(() => {
  const views = shopViews.value
  if (!views.length || !weekSnapshots.value.length) return null
  const lastIdx = weekSnapshots.value.length - 1
  const sumAt = (i, key) => views.reduce((acc, v) => {
    const n = v.series[i]?.metrics[key]
    return acc + (Number.isFinite(n) ? n : 0)
  }, 0)
  const week = weekSnapshots.value[lastIdx]
  return {
    weekId: week.id,
    range: `${week.startDate} ~ ${week.endDate}`,
    items: ['sales', 'revenue', 'profit', 'adSpend'].map((key) => {
      const metric = METRIC_BY_KEY[key]
      const cur = sumAt(lastIdx, key)
      const prev = lastIdx > 0 ? sumAt(lastIdx - 1, key) : NaN
      return { key, label: `${metric.label}合计`, value: fmtMetric(metric, cur), delta: deltaOf(metric, cur, prev) }
    }),
  }
})

/* ================= 趋势图 ================= */
const TREND_TABLE_KEYS = ['sales', 'revenue', 'profit', 'margin', 'price', 'adSpend', 'adRate', 'adShare', 'roi', 'refundRate']
const TREND_TABLE_METRICS = TREND_TABLE_KEYS.map((k) => METRIC_BY_KEY[k])

const CHART_W = 520
const CHART_H = 150
const CHART_PAD = { top: 16, right: 12, bottom: 24, left: 12 }

function chartOf(series) {
  const n = series.length
  const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right
  const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
  const x = (i) => CHART_PAD.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1))

  const salesVals = series.map((s) => s.metrics.sales)
  const profitVals = series.map((s) => s.metrics.profit)
  const maxSales = Math.max(1, ...salesVals.filter(Number.isFinite))
  const profitFinite = profitVals.filter(Number.isFinite)
  const pMin = Math.min(0, ...profitFinite)
  const pMax = Math.max(1, ...profitFinite)

  const barW = Math.min(28, (innerW / Math.max(n, 1)) * 0.5)
  const bars = series.map((s, i) => {
    const v = Number.isFinite(s.metrics.sales) ? s.metrics.sales : 0
    const h = (v / maxSales) * innerH
    return { x: x(i) - barW / 2, y: CHART_PAD.top + innerH - h, w: barW, h, label: s.weekId, value: v }
  })

  const py = (v) => CHART_PAD.top + innerH - ((v - pMin) / (pMax - pMin || 1)) * innerH
  const points = series
    .map((s, i) => (Number.isFinite(s.metrics.profit) ? { x: x(i), y: py(s.metrics.profit), v: s.metrics.profit } : null))
    .filter(Boolean)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const zeroY = pMin < 0 ? py(0) : null

  const labels = series.map((s, i) => ({ x: x(i), text: s.weekId }))
  return { bars, points, path, zeroY, labels }
}

function cellClass(metric, series, i) {
  if (i === 0) return ''
  const d = deltaOf(metric, series[i].metrics[metric.key], series[i - 1].metrics[metric.key])
  return d ? `trend-${d.tone}` : ''
}
</script>

<template>
  <div class="app focus-page">
    <header class="topbar">
      <div class="topbar-left">
        <span class="crumb">订单利润分析</span>
        <span class="crumb-sep">/</span>
        <span class="title">
          <span class="title-badge">OPA</span>
          重点关注产品
        </span>
      </div>
    </header>

    <div class="toolbar toolbar-modern">
      <span class="tool-label">店铺</span>
      <el-button
        v-for="s in shops"
        :key="s.id"
        :type="s.id === activeShopId ? 'primary' : ''"
        class="focus-shop-btn"
        :class="{ active: s.id === activeShopId }"
        @click="activeShopId = s.id"
      >
        {{ s.name }}
        <span class="focus-shop-count">{{ (focusAsinsByShop[s.id] || []).length }}</span>
      </el-button>
      <span class="focus-total">合计 <strong>{{ focusTotal }}</strong></span>
      <span class="focus-toolbar-spacer" />
      <el-button :disabled="!shopViews.length" @click="setAllCollapsed(false)">全部展开</el-button>
      <el-button :disabled="!shopViews.length" @click="setAllCollapsed(true)">全部折叠</el-button>
      <el-button type="primary" :loading="loading" @click="loadAll">{{ loading ? '加载中...' : '刷新数据' }}</el-button>
    </div>

    <div class="metabar">
      <el-tag effect="light" round disable-transitions>重点ASIN {{ focusTotal }}</el-tag>
      <el-tag v-if="activeShop" effect="light" round disable-transitions>{{ activeShop.name }} {{ shopViews.length }}</el-tag>
      <div class="status">
        {{
          loading
            ? '正在加载...'
            : weekSnapshots.length
              ? `数据范围 ${weekSnapshots[0].id} ~ ${weekSnapshots[weekSnapshots.length - 1].id}（共 ${weekSnapshots.length} 周）`
              : '尚未导入任何周数据'
        }}
      </div>
    </div>

    <div class="focus-body">
      <div v-if="loading" class="focus-empty">正在加载周数据…</div>
      <div v-else-if="loadError" class="focus-empty">加载失败：{{ loadError }}</div>
      <div v-else-if="!shopViews.length" class="focus-empty">
        该店铺暂无重点关注产品<br />
        <small>在 src/data/focusProducts.json 中配置 ASIN</small>
      </div>

      <template v-else>
        <section v-if="shopSummary" class="focus-summary">
          <div class="focus-summary-head">
            <strong>{{ activeShop?.name }} · 重点产品汇总</strong>
            <span>{{ shopSummary.weekId }}（{{ shopSummary.range }}）</span>
          </div>
          <div class="focus-summary-grid">
            <div v-for="it in shopSummary.items" :key="it.key" class="focus-kpi">
              <div class="focus-kpi-label">{{ it.label }}</div>
              <div class="focus-kpi-value">{{ it.value }}</div>
              <div v-if="it.delta" class="focus-kpi-delta" :class="`trend-${it.delta.tone}`">
                {{ it.delta.arrow }} {{ it.delta.text }} <span class="muted">环比</span>
              </div>
            </div>
          </div>
        </section>

        <article
          v-for="v in shopViews"
          :key="v.asin"
          class="focus-card"
          :class="{ 'focus-card-collapsed': isCollapsed(v.asin) }"
        >
          <div class="focus-card-head" @click="toggleCollapsed(v.asin)">
            <a v-if="v.image" class="focus-thumb" :href="`https://www.amazon.com/dp/${v.asin}`" target="_blank" rel="noopener" @click.stop>
              <img :src="v.image" :alt="v.name" loading="lazy" />
            </a>
            <div v-else class="focus-thumb focus-thumb-empty">无图</div>
            <div class="focus-ident">
              <div class="focus-name">
                {{ v.name }}
                <span v-if="v.category" class="focus-tag" :class="`focus-tag-${v.category}`">{{ v.category }}</span>
              </div>
              <div class="focus-meta">
                <a :href="`https://www.amazon.com/dp/${v.asin}`" target="_blank" rel="noopener" class="focus-asin" @click.stop>{{ v.asin }}</a>
                <span v-if="v.parentAsin">父 {{ v.parentAsin }}</span>
                <span v-if="v.fnsku">FNSKU {{ v.fnsku }}</span>
                <span v-if="v.latest">最新 {{ v.latest.weekId }}（{{ v.latest.range }}）</span>
                <span v-else class="trend-bad">暂无周数据</span>
              </div>
              <template v-if="!isCollapsed(v.asin)">
                <div v-if="v.title" class="focus-title" :title="v.title">{{ v.title }}</div>
                <div v-if="v.latest?.note" class="focus-note">备注：{{ v.latest.note }}</div>
              </template>
            </div>
            <div v-if="isCollapsed(v.asin) && v.brief.length" class="focus-brief">
              <div v-for="b in v.brief" :key="b.key" class="focus-brief-item">
                <span>{{ b.label }}</span>
                <strong>{{ b.value }}</strong>
                <em v-if="b.delta" :class="`trend-${b.delta.tone}`">{{ b.delta.arrow }} {{ b.delta.text }}</em>
              </div>
            </div>
            <button
              class="focus-collapse-btn"
              :title="isCollapsed(v.asin) ? '展开详情' : '折叠详情'"
              @click.stop="toggleCollapsed(v.asin)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" :class="{ rotated: isCollapsed(v.asin) }">
                <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              {{ isCollapsed(v.asin) ? '展开' : '折叠' }}
            </button>
          </div>

          <div v-show="!isCollapsed(v.asin)" class="focus-card-body">

          <div class="focus-kpi-grid">
            <div v-for="k in v.kpis" :key="k.key" class="focus-kpi">
              <div class="focus-kpi-label">{{ k.label }}</div>
              <div class="focus-kpi-value">{{ k.value }}</div>
              <div v-if="k.delta" class="focus-kpi-delta" :class="`trend-${k.delta.tone}`">{{ k.delta.arrow }} {{ k.delta.text }}</div>
              <div v-else class="focus-kpi-delta muted">—</div>
            </div>
          </div>

          <div class="focus-split">
            <div class="focus-chart">
              <div class="focus-section-title">
                周趋势
                <span class="legend"><i class="legend-bar"></i>周销量</span>
                <span class="legend"><i class="legend-line"></i>毛利润</span>
              </div>
              <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="focus-chart-svg">
                <template v-for="c in [chartOf(v.series)]" :key="'c'">
                  <line v-if="c.zeroY != null" :x1="CHART_PAD.left" :x2="CHART_W - CHART_PAD.right" :y1="c.zeroY" :y2="c.zeroY" class="chart-zero" />
                  <rect v-for="b in c.bars" :key="b.label" :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="2" class="chart-bar">
                    <title>{{ b.label }} 周销量 {{ b.value }}</title>
                  </rect>
                  <path :d="c.path" class="chart-line" />
                  <circle v-for="(p, i) in c.points" :key="i" :cx="p.x" :cy="p.y" r="3" class="chart-dot">
                    <title>毛利润 {{ fmtMetric(METRIC_BY_KEY.profit, p.v) }}</title>
                  </circle>
                  <text v-for="l in c.labels" :key="l.text" :x="l.x" :y="CHART_H - 6" text-anchor="middle" class="chart-label">{{ l.text }}</text>
                </template>
              </svg>
            </div>
            <div class="focus-inventory">
              <div class="focus-section-title">库存</div>
              <div class="focus-inv-grid">
                <div v-for="it in v.inventory" :key="it.label" class="focus-inv-item" :class="{ warn: it.warn }">
                  <span>{{ it.label }}</span>
                  <strong>{{ it.value }}</strong>
                </div>
              </div>
            </div>
          </div>

          <div class="focus-trend-table-wrap">
            <table class="focus-trend-table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th v-for="s in v.series" :key="s.weekId">
                    {{ s.weekId }}<br /><small>{{ s.range }}</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in TREND_TABLE_METRICS" :key="m.key">
                  <td class="metric-name">{{ m.label }}</td>
                  <td v-for="(s, i) in v.series" :key="s.weekId" :class="cellClass(m, v.series, i)">
                    {{ s.hasData ? fmtMetric(m, s.metrics[m.key]) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          </div>
        </article>
      </template>
    </div>
  </div>
</template>

<style scoped>
.focus-toolbar-spacer {
  flex: 1;
}
.focus-shop-btn .focus-shop-count {
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
.focus-shop-btn.active .focus-shop-count {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}
.focus-shop-btn + .focus-shop-btn {
  margin-left: 0;
}
.focus-total {
  color: var(--muted);
  font-size: 12px;
  margin-left: 4px;
}
.focus-total strong {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}

.focus-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.focus-empty {
  margin: 60px auto;
  text-align: center;
  color: var(--muted);
  line-height: 1.8;
}

.focus-summary,
.focus-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px 16px;
  box-shadow: 0 8px 24px rgba(38, 35, 30, 0.06);
}

.focus-summary-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--muted);
}
.focus-summary-head strong {
  color: var(--text-strong);
  font-size: 14px;
}
.focus-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.focus-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.focus-card-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
  cursor: pointer;
}
.focus-card-collapsed .focus-card-head {
  align-items: center;
}
.focus-card-collapsed .focus-thumb {
  flex-basis: 48px;
  width: 48px;
  height: 48px;
}
.focus-card-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.focus-collapse-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  border: 1px solid var(--line-soft);
  background: linear-gradient(180deg, #ffffff, #f7f7f7);
  color: var(--text);
  border-radius: 10px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.focus-collapse-btn:hover {
  color: var(--text-strong);
  background: var(--row-hover);
}
.focus-collapse-btn svg {
  transition: transform 0.15s ease;
}
.focus-collapse-btn svg.rotated {
  transform: rotate(-90deg);
}
.focus-brief {
  display: flex;
  gap: 18px;
  flex: 0 0 auto;
}
.focus-brief-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.focus-brief-item strong {
  font-size: 14px;
  color: var(--text-strong);
}
.focus-brief-item em {
  font-style: normal;
  font-size: 11px;
}
.focus-thumb {
  flex: 0 0 72px;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  overflow: hidden;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.focus-thumb:focus-visible,
.focus-asin:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
a.focus-thumb {
  color: inherit;
}
.focus-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.focus-thumb-empty {
  color: var(--muted);
  font-size: 12px;
}
.focus-ident {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.focus-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-strong);
  display: flex;
  align-items: center;
  gap: 8px;
}
.focus-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--tag-text);
}
.focus-tag-新品 { background: #111111; color: #ffffff; }
.focus-tag-观望 { background: #fff5dc; color: #946200; }
.focus-tag-断货 { background: #ffe8e6; color: #b42318; }
.focus-tag-放弃 { background: #eeeeee; color: #888888; }
.focus-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--muted);
  font-size: 12px;
}
.focus-asin {
  color: var(--text-strong);
  font-weight: 600;
  text-decoration: none;
  font-family: ui-monospace, Menlo, monospace;
}
.focus-asin:hover {
  text-decoration: underline;
}
.focus-title {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.focus-note {
  font-size: 12px;
  color: #946200;
}

.focus-kpi-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}
.focus-kpi {
  background: var(--accent-soft-2);
  border-radius: 8px;
  padding: 8px 10px;
  min-width: 0;
}
.focus-kpi-label {
  color: var(--muted);
  font-size: 12px;
}
.focus-kpi-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 2px 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.focus-kpi-delta {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.trend-good { color: #13795b; }
.trend-bad { color: #c0392b; }
.trend-flat,
.muted { color: var(--muted); }

.focus-split {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 14px;
}
.focus-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-strong);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.legend {
  font-weight: 400;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-bar {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: #c9c9c9;
}
.legend-line {
  width: 14px;
  height: 2px;
  background: #111111;
}
.focus-chart-svg {
  width: 100%;
  height: auto;
  max-height: 220px;
  display: block;
}
.chart-bar { fill: #d4d4d4; }
.chart-bar:hover { fill: #b5b5b5; }
.chart-line {
  fill: none;
  stroke: #111111;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.chart-dot { fill: #111111; }
.chart-zero {
  stroke: #c0392b;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}
.chart-label {
  font-size: 10px;
  fill: var(--muted);
}

.focus-inv-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.focus-inv-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--accent-soft-2);
  font-size: 12px;
  color: var(--muted);
}
.focus-inv-item strong {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.focus-inv-item.warn {
  background: #ffe8e6;
}
.focus-inv-item.warn strong {
  color: #b42318;
}

.focus-trend-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
}
.focus-trend-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.focus-trend-table th,
.focus-trend-table td {
  padding: 6px 10px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--line-soft);
}
.focus-trend-table th {
  background: var(--header-bg);
  font-weight: 600;
  color: var(--text-strong);
}
.focus-trend-table th small {
  font-weight: 400;
  color: var(--muted);
}
.focus-trend-table th:first-child,
.focus-trend-table td.metric-name {
  text-align: left;
  position: sticky;
  left: 0;
  background: var(--panel);
  color: var(--text-strong);
}
.focus-trend-table th:first-child {
  background: var(--header-bg);
}
.focus-trend-table tbody tr:last-child td {
  border-bottom: none;
}

@media (max-width: 1280px) {
  .focus-kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .focus-split { grid-template-columns: minmax(0, 1fr); }
}
</style>
