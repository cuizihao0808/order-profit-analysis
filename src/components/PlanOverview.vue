<script setup>
import { computed } from 'vue'
import { fmtNum } from '../lib/trendMetrics.js'

/**
 * 「有补货计划」视图顶部：店铺切换、汇总 KPI、发货批次条、所选批次的批量操作、行筛选。
 * 批次是按店铺划分的，所以这里一次只看一个店铺。
 */
const props = defineProps({
  plans: { type: Array, default: () => [] }, // 已排序的计划
  plan: { type: Object, default: null }, // 当前店铺的计划
  summary: { type: Object, default: null }, // buildShippingSummary(plan)
  warnings: { type: Array, default: () => [] },
  today: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  shopLabel: { type: Function, default: (code) => code },
})
const activeShop = defineModel('shop', { type: String, default: '' })
const activeBatch = defineModel('batch', { type: String, default: '' })
const rowFilter = defineModel('rowFilter', { type: String, default: 'all' })
const collapsed = defineModel('collapsed', { type: Boolean, default: false })
const emit = defineEmits(['mark', 'copy'])

function fmtMoney(n) {
  return n == null || !Number.isFinite(n) ? '—' : `¥${fmtNum(n)}`
}
/** ISO 时间 → 本地日期 YYYY-MM-DD */
function localDay(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function sum(list, pick) {
  return list.reduce((acc, x) => acc + (Number.isFinite(pick(x)) ? pick(x) : 0), 0)
}
function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000)
}

const totals = computed(() => {
  const items = props.plan?.items || []
  return {
    postHoliday: sum(items, (i) => i.postHolidayRef),
    amount: sum(items, (i) => i.amount),
    weight: sum(items, (i) => i.weight),
  }
})

const shippedPct = computed(() => {
  const s = props.summary
  return s && s.plannedQty ? Math.round((s.shippedQty / s.plannedQty) * 100) : 0
})

const nextBatchText = computed(() => {
  const b = props.summary?.nextBatch
  if (!b) return '全部已发完'
  const days = daysBetween(props.today, b.date)
  const left = fmtNum(b.plannedQty - b.shippedQty)
  if (days > 0) return `还有 ${days} 天 · ${left} 件待发`
  if (days === 0) return `今天发货 · ${left} 件待发`
  return `已逾期 ${-days} 天 · ${left} 件待发`
})

const activeBatchInfo = computed(() => props.summary?.batches.find((b) => b.key === activeBatch.value) || null)

function selectBatch(key) {
  activeBatch.value = activeBatch.value === key ? '' : key
  if (!activeBatch.value && rowFilter.value === 'batch') rowFilter.value = 'all'
}

function batchStatusText(b) {
  if (b.status === 'empty') return '无计划'
  if (b.status === 'done') return '已发货'
  if (b.overdue) return b.status === 'partial' ? `逾期 ${b.shippedSkus}/${b.plannedSkus}` : '逾期未发'
  if (b.status === 'partial') return `已发 ${b.shippedSkus}/${b.plannedSkus}`
  return '待发货'
}
</script>

<template>
  <section class="po">
    <div class="po-bar">
      <span class="tool-label">补货店铺</span>
      <el-button
        v-for="p in plans"
        :key="p.shop"
        :type="p.shop === activeShop ? 'primary' : ''"
        class="po-shop-btn"
        :class="{ active: p.shop === activeShop }"
        @click="activeShop = p.shop"
      >
        {{ shopLabel(p.shop) }}
        <span class="po-shop-count">{{ p.items.length }}</span>
      </el-button>
      <span class="tool-label po-gap">显示</span>
      <el-radio-group v-model="rowFilter">
        <el-radio-button value="all">全部SKU</el-radio-button>
        <el-radio-button value="pending">有待发</el-radio-button>
        <el-radio-button value="done">已发完</el-radio-button>
        <el-radio-button value="batch" :disabled="!activeBatch">仅所选批次</el-radio-button>
      </el-radio-group>
      <span class="po-spacer" />
      <span v-if="plan" class="po-file" title="计划里的库存、在途按清单生成时的数据测算">
        {{ plan.file }} · 生成于 {{ localDay(plan.updatedAt) }}
      </span>
      <el-button text @click="collapsed = !collapsed">{{ collapsed ? '展开汇总' : '收起汇总' }}</el-button>
    </div>

    <div v-for="w in warnings" :key="w" class="po-warning">{{ w }}</div>

    <div v-if="!plan" class="po-empty">
      还没有补货清单。把“补货清单_周批次版” CSV 放到 src/data/replenishment/ 后刷新页面
    </div>

    <Transition name="po-fold">
      <div v-if="plan && !collapsed" class="po-fold">
        <div class="po-fold-inner">
          <div class="po-kpis">
            <div class="po-kpi">
              <div class="po-kpi-label">春节前计划</div>
              <div class="po-kpi-value">{{ fmtNum(summary.plannedQty) }}<small>件</small></div>
              <div class="po-kpi-sub">{{ summary.batches.filter((b) => b.status !== 'empty').length }} 个批次</div>
            </div>
            <div class="po-kpi">
              <div class="po-kpi-label">已发货</div>
              <div class="po-kpi-value">{{ fmtNum(summary.shippedQty) }}<small>件</small></div>
              <div class="po-progress"><i :style="{ width: `${shippedPct}%` }" /></div>
              <div class="po-kpi-sub">完成 {{ shippedPct }}%，待发 {{ fmtNum(summary.plannedQty - summary.shippedQty) }} 件</div>
            </div>
            <div class="po-kpi" :class="{ 'po-kpi-warn': summary.nextBatch?.overdue }">
              <div class="po-kpi-label">下一批</div>
              <div class="po-kpi-value">{{ summary.nextBatch ? summary.nextBatch.key : '—' }}</div>
              <div class="po-kpi-sub">{{ nextBatchText }}</div>
            </div>
            <div class="po-kpi">
              <div class="po-kpi-label">采购金额参考</div>
              <div class="po-kpi-value">{{ fmtMoney(totals.amount) }}</div>
              <div class="po-kpi-sub">{{ plan.weeklyNotes.amount || '春节前合计' }}</div>
            </div>
            <div class="po-kpi">
              <div class="po-kpi-label">净重参考</div>
              <div class="po-kpi-value">{{ fmtNum(totals.weight, 1) }}<small>kg</small></div>
              <div class="po-kpi-sub">{{ plan.weeklyNotes.weight || '春节前合计' }}</div>
            </div>
            <div class="po-kpi">
              <div class="po-kpi-label">节后首班参考</div>
              <div class="po-kpi-value">{{ fmtNum(totals.postHoliday) }}<small>件</small></div>
              <div class="po-kpi-sub">须节前备好</div>
            </div>
          </div>

          <div class="po-strip">
            <button
              v-for="b in summary.batches"
              :key="b.key"
              type="button"
              class="po-batch"
              :class="[`is-${b.status}`, { active: b.key === activeBatch, overdue: b.overdue }]"
              :disabled="b.status === 'empty'"
              :title="`${b.date}${b.note ? ` · ${b.note}` : ''}`"
              @click="selectBatch(b.key)"
            >
              <div class="po-batch-top">
                <strong>{{ b.key }}</strong>
                <span class="po-batch-status">{{ batchStatusText(b) }}</span>
              </div>
              <div class="po-batch-note">{{ b.note || ' ' }}</div>
              <div class="po-batch-qty">{{ fmtNum(b.plannedQty) }}<small> 件 · {{ b.plannedSkus }} SKU</small></div>
              <div class="po-batch-meta">{{ fmtMoney(plan.weekly.amount[b.key]) }} · {{ fmtNum(plan.weekly.weight[b.key], 1) }}kg</div>
              <div class="po-progress">
                <i :style="{ width: b.plannedQty ? `${(b.shippedQty / b.plannedQty) * 100}%` : '0%' }" />
              </div>
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <div v-if="plan && activeBatchInfo" class="po-batch-bar">
      <div class="po-batch-bar-info">
        <strong>{{ activeBatchInfo.key }} 批次</strong>
        <span>{{ activeBatchInfo.date }}</span>
        <span v-if="activeBatchInfo.note">{{ activeBatchInfo.note }}</span>
        <span>{{ activeBatchInfo.plannedSkus }} SKU · {{ fmtNum(activeBatchInfo.plannedQty) }} 件</span>
        <span :class="activeBatchInfo.status === 'done' ? 'trend-good' : activeBatchInfo.overdue ? 'trend-bad' : ''">
          已发 {{ activeBatchInfo.shippedSkus }}/{{ activeBatchInfo.plannedSkus }} SKU · {{ fmtNum(activeBatchInfo.shippedQty) }} 件
        </span>
      </div>
      <div class="po-batch-bar-actions">
        <el-button @click="emit('copy', activeBatchInfo)">复制本批清单</el-button>
        <el-button v-if="activeBatchInfo.shippedSkus" :disabled="saving" @click="emit('mark', activeBatchInfo, false)">
          撤销本批已发货
        </el-button>
        <el-button
          type="primary"
          :disabled="saving || activeBatchInfo.status === 'done'"
          @click="emit('mark', activeBatchInfo, true)"
        >
          {{ activeBatchInfo.status === 'done' ? '本批已全部发货' : '整批标记已发货' }}
        </el-button>
        <el-button text @click="selectBatch(activeBatchInfo.key)">取消选择</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 收起 / 展开汇总：高度从 0fr 过渡到 1fr，内容同时淡入 */
.po-fold {
  display: grid;
  grid-template-rows: 1fr;
}
.po-fold-inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}
.po-fold-enter-active,
.po-fold-leave-active {
  transition: grid-template-rows 0.24s ease, opacity 0.2s ease;
}
.po-fold-enter-from,
.po-fold-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}

.po {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 12px 8px;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(38, 35, 30, 0.06);
}
.po-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.po-gap {
  margin-left: 8px;
}
.po-spacer {
  flex: 1;
}
.po-file {
  color: var(--muted);
  font-size: 11px;
}
.po-shop-btn + .po-shop-btn {
  margin-left: 0;
}
.po-shop-count {
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
.po-shop-btn.active .po-shop-count {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}
.po-warning {
  padding: 6px 12px;
  border: 1px solid #f8dfb0;
  background: #fffaf0;
  color: #946200;
  border-radius: 10px;
  font-size: 12px;
}
.po-empty {
  padding: 12px 0;
  color: var(--muted);
  text-align: center;
}
.po-kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.po-kpi {
  background: var(--accent-soft-2);
  border-radius: 8px;
  padding: 8px 10px;
  min-width: 0;
}
.po-kpi-warn {
  background: #fdf3f2;
}
.po-kpi-label {
  color: var(--muted);
  font-size: 12px;
}
.po-kpi-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 2px 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.po-kpi-value small {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
.po-kpi-sub {
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-kpi-warn .po-kpi-sub {
  color: #b42318;
}
.po-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--line-soft);
  overflow: hidden;
  margin: 4px 0;
}
.po-progress i {
  display: block;
  height: 100%;
  background: #13795b;
  border-radius: inherit;
  transition: width 0.2s ease;
}
.po-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.po-batch {
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
.po-batch:hover {
  border-color: #888;
}
.po-batch.active {
  border-color: #111;
  box-shadow: inset 0 0 0 1px #111;
}
.po-batch.is-done {
  background: #f3faf6;
  border-color: #cce7d5;
}
.po-batch.is-done.active {
  border-color: #13795b;
  box-shadow: inset 0 0 0 1px #13795b;
}
.po-batch.overdue {
  border-color: #f3c7c5;
  background: #fdf8f7;
}
.po-batch.is-empty {
  opacity: 0.45;
  cursor: default;
}
.po-batch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.po-batch-top strong {
  font-size: 14px;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.po-batch-status {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--muted);
  white-space: nowrap;
}
.is-done .po-batch-status {
  background: #dff1e7;
  color: #13795b;
}
.is-partial .po-batch-status {
  background: #111;
  color: #fff;
}
.overdue .po-batch-status {
  background: #ffe8e6;
  color: #b42318;
}
.po-batch-note {
  font-size: 11px;
  color: #946200;
  min-height: 16px;
}
.po-batch-qty {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.po-batch-qty small {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
.po-batch-meta {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.po-batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--accent-soft-2);
}
.po-batch-bar-info {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.po-batch-bar-info strong {
  color: var(--text-strong);
  font-size: 14px;
}
.po-batch-bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.po-batch-bar-actions .el-button + .el-button {
  margin-left: 0;
}
@media (max-width: 1280px) {
  .po-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
