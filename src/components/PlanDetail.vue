<script setup>
import { computed } from 'vue'
import { fmtNum } from '../lib/trendMetrics.js'

/** 展开行「补货批次」：该 SKU 在各批次的件数（点击标记已发货）+ CSV 里的判断说明 */
const props = defineProps({
  plan: { type: Object, required: true },
  item: { type: Object, required: true },
  summary: { type: Object, default: null }, // buildShippingSummary(...).items[sku]
  batches: { type: Array, default: () => [] }, // buildShippingSummary(...).batches
  isShipped: { type: Function, required: true }, // (批次完整日期) => boolean
  shippedAt: { type: Function, required: true }, // (批次完整日期) => iso
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])

const planned = computed(() => props.batches.filter((b) => props.item.qtyByBatch[b.key]))
/** 清单文件的生成（修改）日期，计划里的库存数据截至这一天 */
const generatedOn = computed(() => (props.plan.updatedAt ? fmtTime(props.plan.updatedAt).slice(0, 10) : '—'))

function fmtMoney(n) {
  return n == null || !Number.isFinite(n) ? '—' : `¥${fmtNum(n)}`
}
function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function chipTitle(b) {
  const at = props.shippedAt(b.date)
  const head = `${b.date}${b.note ? ` · ${b.note}` : ''}`
  return at ? `${head}\n已于 ${fmtTime(at)} 标记发货，点击撤销` : `${head}\n点击标记已发货`
}
function emergencyClass(text) {
  if (text.startsWith('有必要')) return 'pd-tag-red'
  if (text.startsWith('建议带')) return 'pd-tag-amber'
  return ''
}
</script>

<template>
  <div class="plan-detail">
    <div class="pd-head">
      <strong>{{ plan.shop }} · {{ item.sku }}</strong>
      <span v-if="summary">已发 {{ fmtNum(summary.shippedQty) }} / {{ fmtNum(summary.plannedQty) }} 件</span>
      <span class="muted">{{ plan.file }}</span>
    </div>

    <div class="pd-batches">
      <button
        v-for="b in planned"
        :key="b.key"
        type="button"
        class="pd-batch"
        :class="{ shipped: isShipped(b.date), overdue: b.overdue && !isShipped(b.date) }"
        :disabled="saving"
        :title="chipTitle(b)"
        @click="emit('toggle', b)"
      >
        <span class="pd-batch-key">{{ b.key }}</span>
        <strong><span v-if="isShipped(b.date)">✓ </span>{{ item.qtyByBatch[b.key] }}</strong>
        <small>{{ isShipped(b.date) ? '已发货' : b.overdue ? '逾期' : b.note || '待发' }}</small>
      </button>
      <span v-if="!planned.length" class="muted">这个 SKU 在本计划里没有批次</span>
    </div>

    <div class="pd-grid">
      <div><span>春节前合计</span>{{ fmtNum(item.preHolidayTotal) }}</div>
      <div><span>{{ plan.labels?.postHolidayRef || '节后首班参考' }}</span>{{ fmtNum(item.postHolidayRef) }}</div>
      <div><span>采购金额参考</span>{{ fmtMoney(item.amount) }}</div>
      <div><span>净重参考</span>{{ fmtNum(item.weight, 1) }} kg</div>
      <div :title="'补货计划按清单生成时的库存测算，与「库存详情」里的实时库存可能不同'">
        <span>生成时可用 / 在途（截至 {{ generatedOn }}）</span>{{ fmtNum(item.available) }} / {{ fmtNum(item.inbound) }}
      </div>
      <div><span>日均需求参考</span>{{ item.dailyDemand || '—' }}</div>
      <div><span>{{ plan.labels?.lateGap || '在途晚到 7 天时残余缺口' }}</span>{{ item.lateGap || '—' }}</div>
      <div>
        <span>{{ plan.labels?.emergency || '应急判断' }}</span>
        <em v-if="item.emergency" class="pd-tag" :class="emergencyClass(item.emergency)">{{ item.emergency }}</em>
        <template v-else>—</template>
      </div>
    </div>
    <div class="pd-block"><span>判断说明</span>{{ item.reason || '—' }}</div>
    <div class="pd-block"><span>备注</span>{{ item.remark || '—' }}</div>
  </div>
</template>

<style scoped>
.plan-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
}
.pd-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  color: var(--muted);
}
.pd-head strong {
  color: var(--text-strong);
  font-size: 13px;
}
.pd-batches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pd-batch {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 64px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  color: var(--text-strong);
  font: inherit;
  line-height: 1.35;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.pd-batch:hover:not(:disabled) {
  border-color: #111;
}
.pd-batch:disabled {
  cursor: progress;
}
.pd-batch-key {
  font-size: 11px;
  color: var(--muted);
}
.pd-batch strong {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.pd-batch small {
  font-size: 10px;
  color: #946200;
}
.pd-batch.shipped {
  background: #e8f5ee;
  border-color: #bfe3cf;
  color: #13795b;
}
.pd-batch.shipped small {
  color: #13795b;
}
.pd-batch.overdue {
  background: #fdf3f2;
  border-color: #f3c7c5;
  color: #b42318;
}
.pd-batch.overdue small {
  color: #b42318;
}
.pd-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 14px;
}
.pd-grid span,
.pd-block span {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.pd-grid > div {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.pd-tag {
  font-style: normal;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--muted);
}
.pd-tag-red {
  background: #ffe8e6;
  color: #b42318;
}
.pd-tag-amber {
  background: #fff5dc;
  color: #946200;
}
@media (max-width: 1280px) {
  .pd-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
