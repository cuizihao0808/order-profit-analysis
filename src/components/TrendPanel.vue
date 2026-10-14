<script setup>
import { computed } from 'vue'
import { CHART, METRIC_BY_KEY, chartOf, fmtMetric, latestKpis, trendTone } from '../lib/trendMetrics.js'
import { isWeekFieldAlert } from '../lib/weekSnapshot.js'

/** 展开行「8 周趋势」：KPI 环比 + 周销量/毛利润图 + 逐周表 + 历史备注 */
const props = defineProps({
  series: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
})

const TABLE_METRICS = ['sales', 'revenue', 'profit', 'margin', 'price', 'adSpend', 'adRate', 'adShare', 'roi', 'refundRate'].map(
  (k) => METRIC_BY_KEY[k],
)

const kpis = computed(() => latestKpis(props.series))
const chart = computed(() => chartOf(props.series))
const hasData = computed(() => props.series.some((s) => s.hasData))
const notes = computed(() => props.series.filter((s) => s.note).reverse())
</script>

<template>
  <div class="trend-panel">
    <div v-if="loading && !series.length" class="trend-empty">正在加载最近几周数据…</div>
    <div v-else-if="!hasData" class="trend-empty">最近几周都没有这个 ASIN 的订单利润数据</div>
    <template v-else>
      <div class="trend-kpis">
        <div v-for="k in kpis" :key="k.key" class="trend-kpi">
          <div class="trend-kpi-label">{{ k.label }}</div>
          <div class="trend-kpi-value" :class="{ 'trend-bad': k.alertCol && isWeekFieldAlert(k.alertCol, k.raw) }">{{ k.value }}</div>
          <div v-if="k.delta" class="trend-kpi-delta" :class="`trend-${k.delta.tone}`">{{ k.delta.arrow }} {{ k.delta.text }}</div>
          <div v-else class="trend-kpi-delta muted">—</div>
        </div>
      </div>

      <div class="trend-split">
        <div>
          <div class="trend-section-title">
            周趋势
            <span class="legend"><i class="legend-bar"></i>周销量</span>
            <span class="legend"><i class="legend-line"></i>毛利润</span>
          </div>
          <svg :viewBox="`0 0 ${CHART.width} ${CHART.height}`" class="trend-chart">
            <line
              v-if="chart.zeroY != null"
              :x1="CHART.pad.left"
              :x2="CHART.width - CHART.pad.right"
              :y1="chart.zeroY"
              :y2="chart.zeroY"
              class="chart-zero"
            />
            <rect v-for="b in chart.bars" :key="b.label" :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="2" class="chart-bar">
              <title>{{ b.label }} 周销量 {{ b.value }}</title>
            </rect>
            <path :d="chart.path" class="chart-line" />
            <circle v-for="(p, i) in chart.points" :key="i" :cx="p.x" :cy="p.y" r="3" class="chart-dot">
              <title>毛利润 {{ fmtMetric(METRIC_BY_KEY.profit, p.v) }}</title>
            </circle>
            <text v-for="l in chart.labels" :key="l.text" :x="l.x" :y="CHART.height - 6" text-anchor="middle" class="chart-label">
              {{ l.text }}
            </text>
          </svg>
        </div>
        <div>
          <div class="trend-section-title">历史备注</div>
          <div v-if="notes.length" class="trend-notes">
            <div v-for="s in notes" :key="s.weekId" class="trend-note">
              <span>{{ s.weekId }}</span>{{ s.note }}
            </div>
          </div>
          <div v-else class="muted">最近几周没有备注</div>
        </div>
      </div>

      <div class="trend-table-wrap">
        <table class="trend-table">
          <thead>
            <tr>
              <th>指标</th>
              <th v-for="s in series" :key="s.weekId">
                {{ s.weekId }}<br /><small>{{ s.range }}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in TABLE_METRICS" :key="m.key">
              <td class="metric-name">{{ m.label }}</td>
              <td v-for="(s, i) in series" :key="s.weekId" :class="`trend-${trendTone(m, series, i)}`">
                {{ s.hasData ? fmtMetric(m, s.metrics[m.key]) : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.trend-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.trend-empty {
  padding: 18px 0;
  color: var(--muted);
  text-align: center;
}
.trend-kpis {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}
.trend-kpi {
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 7px 10px;
  min-width: 0;
}
.trend-kpi-label {
  color: var(--muted);
  font-size: 11px;
}
.trend-kpi-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 2px 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.trend-kpi-delta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.trend-split {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 14px;
}
.trend-section-title {
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
.trend-chart {
  width: 100%;
  height: auto;
  max-height: 200px;
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
.trend-notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
}
.trend-note {
  font-size: 12px;
  color: #946200;
  line-height: 1.5;
}
.trend-note span {
  display: inline-block;
  min-width: 42px;
  margin-right: 6px;
  color: var(--muted);
}
.trend-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--panel);
}
.trend-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.trend-table th,
.trend-table td {
  position: static;
  padding: 6px 10px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--line-soft);
}
.trend-table th {
  background: var(--header-bg);
  font-weight: 600;
  color: var(--text-strong);
}
.trend-table th small {
  font-weight: 400;
  color: var(--muted);
}
.trend-table th:first-child,
.trend-table td.metric-name {
  text-align: left;
  position: sticky;
  left: 0;
  background: var(--panel);
  color: var(--text-strong);
}
.trend-table th:first-child {
  background: var(--header-bg);
}
.trend-table tbody tr:last-child td {
  border-bottom: none;
}
@media (max-width: 1280px) {
  .trend-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .trend-split { grid-template-columns: minmax(0, 1fr); }
}
</style>
