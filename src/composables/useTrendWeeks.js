import { computed, ref } from 'vue'
import { TREND_WEEKS } from '../lib/trendMetrics.js'

/**
 * 最近 TREND_WEEKS 周的快照，按需加载并缓存。
 * weeks 为 weeks.json 的 ref（按时间倒序）；首屏只用到最新周，趋势打开时才拉其余几周。
 */
export function useTrendWeeks(weeks) {
  const cache = ref({}) // weekId → snapshot
  const loading = ref(false)
  let pending = null

  /** 最近几周的元信息，按时间升序 */
  const trendMeta = computed(() => weeks.value.slice(0, TREND_WEEKS).reverse())

  /** 已加载的最近几周快照，按时间升序；没加载到的周跳过 */
  const trendWeeks = computed(() =>
    trendMeta.value.map((w) => (cache.value[w.id] ? { ...w, ...cache.value[w.id] } : null)).filter(Boolean),
  )

  const ready = computed(() => trendMeta.value.every((w) => cache.value[w.id]))

  function seed(weekId, snapshot) {
    if (weekId && snapshot) cache.value = { ...cache.value, [weekId]: snapshot }
  }

  async function ensureTrendWeeks() {
    if (ready.value) return
    if (pending) return pending
    loading.value = true
    pending = (async () => {
      const missing = trendMeta.value.filter((w) => !cache.value[w.id])
      const loaded = await Promise.all(
        missing.map(async (w) => {
          const r = await fetch(`/api/weeks/${encodeURIComponent(w.id)}`, { cache: 'no-store' })
          return r.ok ? [w.id, await r.json()] : null
        }),
      )
      const next = { ...cache.value }
      for (const hit of loaded) if (hit) next[hit[0]] = hit[1]
      cache.value = next
    })().finally(() => {
      loading.value = false
      pending = null
    })
    return pending
  }

  function resetTrendWeeks() {
    cache.value = {}
  }

  return { trendWeeks, trendLoading: loading, trendReady: ready, ensureTrendWeeks, resetTrendWeeks, seedTrendWeek: seed }
}
