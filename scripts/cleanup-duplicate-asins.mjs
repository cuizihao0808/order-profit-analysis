import { promises as fs } from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const dataDir = path.join(rootDir, 'src', 'data')
const productsDir = path.join(dataDir, 'products')
const weeksDir = path.join(dataDir, 'weeks')
const shopsPath = path.join(dataDir, 'shops.json')

const SHOP_NAME_ALIAS = new Map([
  ['LPH-主店三号-US', 'LPH-主店三号'],
])

function normalizeShopName(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  return SHOP_NAME_ALIAS.get(raw) || raw
}

function isBlank(v) {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

function toNum(v) {
  if (v == null || v === '') return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function unionStrings(...lists) {
  const out = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const s = String(item || '').trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  return out
}

function scoreProduct(p) {
  const fields = [
    'name',
    'fnsku',
    'category',
    'packageSize',
    'packageType',
    'itemWeight',
    'amazonMainImage',
    'productImage',
  ]
  let score = 0
  for (const f of fields) {
    if (!isBlank(p?.[f])) score += 1
  }
  if (Array.isArray(p?.listingDetailImages) && p.listingDetailImages.length) score += 1
  if (Array.isArray(p?.productImages) && p.productImages.length) score += 1
  const localWarehouse = toNum(p?.localWarehouse)
  const orderedQty = toNum(p?.orderedQty)
  if (Number.isFinite(localWarehouse) && localWarehouse > 0) score += 1
  if (Number.isFinite(orderedQty) && orderedQty > 0) score += 1
  return score
}

function mergeProducts(base, incoming) {
  const merged = { ...base }

  const arrayKeys = ['productImages', 'listingDetailImages']
  for (const key of arrayKeys) {
    merged[key] = unionStrings(base?.[key], incoming?.[key])
  }

  const imageKeys = ['amazonMainImage', 'productImage']
  for (const key of imageKeys) {
    if (isBlank(merged[key]) && !isBlank(incoming?.[key])) {
      merged[key] = incoming[key]
    }
  }

  for (const [key, value] of Object.entries(incoming || {})) {
    if (arrayKeys.includes(key) || imageKeys.includes(key)) continue
    if (isBlank(merged[key]) && !isBlank(value)) {
      merged[key] = value
    }
  }

  const numericPreferMax = [
    'localWarehouse',
    'orderedQty',
    'monthSales',
    'monthRevenue',
    'monthOrders',
    'dailySales',
    'vineGiftSales',
    'sellable',
    'inbound',
    'unsellable',
    'reserved',
    'fbaTotal',
  ]
  for (const key of numericPreferMax) {
    const a = toNum(merged[key])
    const b = toNum(incoming?.[key])
    if (!Number.isFinite(a) && Number.isFinite(b)) merged[key] = incoming[key]
    else if (Number.isFinite(a) && Number.isFinite(b) && b > a) merged[key] = incoming[key]
  }

  const firstSeenA = String(merged.firstSeenWeek || '').trim()
  const firstSeenB = String(incoming?.firstSeenWeek || '').trim()
  if (!firstSeenA && firstSeenB) merged.firstSeenWeek = firstSeenB

  const lastSeenA = String(merged.lastSeenWeek || '').trim()
  const lastSeenB = String(incoming?.lastSeenWeek || '').trim()
  if (!lastSeenA && lastSeenB) merged.lastSeenWeek = lastSeenB

  return merged
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function loadWeekShopCounts(shopIdByName) {
  const counts = new Map()
  const files = (await fs.readdir(weeksDir)).filter((f) => f.endsWith('.json'))

  for (const file of files) {
    const week = await readJson(path.join(weeksDir, file), null)
    if (!week || !Array.isArray(week.columns) || !Array.isArray(week.rows)) continue

    const asinIdx = week.columns.indexOf('ASIN')
    const shopIdx = week.columns.indexOf('店铺')
    if (asinIdx < 0 || shopIdx < 0) continue

    for (const row of week.rows) {
      if (!row || !Array.isArray(row.values)) continue
      const asin = String(row.values[asinIdx] || '').trim()
      if (!asin) continue

      const shopName = normalizeShopName(row.values[shopIdx])
      const shopId = shopIdByName.get(shopName)
      if (!shopId) continue

      if (!counts.has(asin)) counts.set(asin, new Map())
      const perShop = counts.get(asin)
      perShop.set(shopId, (perShop.get(shopId) || 0) + 1)
    }
  }

  return counts
}

async function main() {
  const shops = await readJson(shopsPath, [])
  if (!Array.isArray(shops) || !shops.length) {
    console.log('No shops found, nothing to clean.')
    return
  }

  const shopOrder = shops.map((s) => s.id)
  const shopNameById = new Map(shops.map((s) => [s.id, s.name]))
  const shopIdByName = new Map(shops.map((s) => [normalizeShopName(s.name), s.id]))

  const productsByShop = new Map()
  for (const shop of shops) {
    const file = path.join(productsDir, `${shop.id}.json`)
    const list = await readJson(file, [])
    productsByShop.set(shop.id, Array.isArray(list) ? list : [])
  }

  const weekShopCounts = await loadWeekShopCounts(shopIdByName)

  const occurrences = new Map()
  for (const [shopId, list] of productsByShop) {
    for (const product of list) {
      const asin = String(product?.asin || '').trim()
      if (!asin) continue
      if (!occurrences.has(asin)) occurrences.set(asin, [])
      occurrences.get(asin).push({ shopId, product })
    }
  }

  const duplicates = Array.from(occurrences.entries()).filter(([, items]) => items.length > 1)
  if (!duplicates.length) {
    console.log(JSON.stringify({ duplicateAsinCount: 0, changed: false }, null, 2))
    return
  }

  const removeByShop = new Map()
  const upsertByShopAsin = new Map()
  const report = []

  for (const [asin, items] of duplicates) {
    const counts = weekShopCounts.get(asin) || new Map()

    items.sort((a, b) => {
      const countA = counts.get(a.shopId) || 0
      const countB = counts.get(b.shopId) || 0
      if (countA !== countB) return countB - countA

      const scoreA = scoreProduct(a.product)
      const scoreB = scoreProduct(b.product)
      if (scoreA !== scoreB) return scoreB - scoreA

      return shopOrder.indexOf(a.shopId) - shopOrder.indexOf(b.shopId)
    })

    const keep = items[0]
    let merged = { ...keep.product }
    const removedFrom = []

    for (let i = 1; i < items.length; i++) {
      const loser = items[i]
      merged = mergeProducts(merged, loser.product)
      if (!removeByShop.has(loser.shopId)) removeByShop.set(loser.shopId, new Set())
      removeByShop.get(loser.shopId).add(asin)
      removedFrom.push(loser.shopId)
    }

    const key = `${keep.shopId}::${asin}`
    upsertByShopAsin.set(key, merged)
    report.push({
      asin,
      keepShopId: keep.shopId,
      keepShopName: shopNameById.get(keep.shopId) || keep.shopId,
      removedFrom,
      weekCounts: Object.fromEntries(counts),
    })
  }

  for (const shop of shops) {
    const list = productsByShop.get(shop.id) || []
    const toRemove = removeByShop.get(shop.id) || new Set()

    const next = []
    for (const product of list) {
      const asin = String(product?.asin || '').trim()
      if (!asin) continue
      if (toRemove.has(asin)) continue

      const key = `${shop.id}::${asin}`
      if (upsertByShopAsin.has(key)) {
        next.push(upsertByShopAsin.get(key))
      } else {
        next.push(product)
      }
    }

    next.sort((a, b) => String(a.asin || '').localeCompare(String(b.asin || '')))
    await writeJson(path.join(productsDir, `${shop.id}.json`), next)
  }

  const removedTotal = Array.from(removeByShop.values()).reduce((sum, s) => sum + s.size, 0)
  const summary = {
    duplicateAsinCount: duplicates.length,
    removedRecords: removedTotal,
    keptRecords: duplicates.length,
    changed: true,
    report,
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
