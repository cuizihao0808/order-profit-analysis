import { computed, ref } from 'vue'
import { buildPlanIndex, buildShippingSummary, findShopByCode, isShipped } from '../lib/replenishmentPlan.js'

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 补货批次计划：/api/replenishment 的数据、按店铺的发货汇总、按「shopId::ASIN」的条目索引，
 * 以及标记已发货。shops 为 shops.json 的 ref。
 */
export function useReplenishment(shops, { onError } = {}) {
  const plans = ref([])
  const warnings = ref([])
  const shippedState = ref({})
  const today = ref(localDate())
  const saving = ref(false)

  async function loadReplenishment() {
    today.value = localDate()
    const r = await fetch('/api/replenishment', { cache: 'no-store' })
    const data = r.ok ? await r.json() : {}
    plans.value = data.plans || []
    warnings.value = data.warnings || []
    shippedState.value = data.shipped || {}
  }

  /** 店铺按钮顺序与 shops.json 一致，未匹配的店铺排最后 */
  const orderedPlans = computed(() => {
    const rank = (p) => {
      const idx = shops.value.indexOf(findShopByCode(shops.value, p.shop))
      return idx < 0 ? Number.MAX_SAFE_INTEGER : idx
    }
    return plans.value.slice().sort((a, b) => rank(a) - rank(b) || a.shop.localeCompare(b.shop))
  })

  const summaries = computed(() => {
    const out = {}
    for (const plan of plans.value) {
      out[plan.shop] = buildShippingSummary(plan, shippedState.value[plan.shop] || {}, today.value)
    }
    return out
  })

  const planIndex = computed(() => buildPlanIndex(plans.value, shops.value))
  const allWarnings = computed(() => [
    ...warnings.value,
    ...planIndex.value.unmatchedShops.map((code) => `补货清单店铺 ${code} 在店铺列表里找不到，已忽略`),
  ])

  /** 主表一行对应的计划条目：{ plan, item, summary } 或 null */
  function planEntry(shopId, asin) {
    const hit = planIndex.value.index.get(`${shopId}::${asin}`)
    if (!hit) return null
    return { ...hit, summary: summaries.value[hit.plan.shop]?.items[hit.item.sku] || null }
  }

  /** 已发货按「店铺 + ASIN + 批次完整日期」记录 */
  function cellShipped(shop, asin, date) {
    return isShipped(shippedState.value[shop], asin, date)
  }

  function shippedAt(shop, asin, date) {
    return shippedState.value[shop]?.[asin]?.[date] || ''
  }

  async function saveShipped(shop, entries, shipped) {
    if (saving.value || !entries.length) return false
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
      onError?.('保存失败：' + (e.message || e))
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    plans,
    orderedPlans,
    warnings: allWarnings,
    summaries,
    today,
    saving,
    loadReplenishment,
    planEntry,
    cellShipped,
    shippedAt,
    saveShipped,
  }
}
