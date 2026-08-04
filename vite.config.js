import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

// 导入补货配置
let restockConfigData = {
  restockMonths: 12,
  restockMultiplier: 4,
  monthlyThreshold: 1,
  doubleRestockMultiplier: 8,
  quantityDiscount: 0.8,
}
try {
  const configPath = fp(`${DATA_DIR}/restockConfig.js`)
  if (existsSync(configPath)) {
    const configModule = require(configPath)
    if (configModule.restockConfig) {
      restockConfigData = configModule.restockConfig
    }
  }
} catch (e) {
  // 使用默认值
}

const DATA_DIR = 'src/data'
const WEEKS_DIR = 'src/data/weeks'
const PRODUCTS_DIR = 'src/data/products'
const XLSX_DIR = 'public/data'

/* ============== 主数据字段定义（服务端与前端共享同一 schema） ============== */
/**
 * ASIN 主数据只保留下列字段，其它信息全部从 xlsx 快照按周读取。
 * 店铺归属由文件所在的 shopId 决定（src/data/products/{shopId}.json），
 * 因此 product 记录里不再冗余保存 shop 字段。
 */
const MASTER_FIELDS = [
  { key: 'asin', column: 'ASIN' },
  { key: 'parentAsin', column: '父ASIN' },
  { key: 'name', column: '品名' },
]

/* ============== 工具函数 ============== */
function fp(...parts) {
  return resolve(process.cwd(), ...parts)
}

function readJson(path, fallback) {
  const p = fp(path)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(path, data) {
  const p = fp(path)
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
}

/* ============== products：按店铺拆分文件 ============== */
function productFilePath(shopId) {
  return `${PRODUCTS_DIR}/${shopId}.json`
}

function readProductsByShop(shopId) {
  return readJson(productFilePath(shopId), [])
}

function writeProductsByShop(shopId, list) {
  writeJson(productFilePath(shopId), list)
}

/** 读全部 shop 的产品并附上 shopId，供前端拉平使用 */
function readAllProducts(shops) {
  const all = []
  for (const s of shops) {
    for (const p of readProductsByShop(s.id)) {
      all.push({ ...p, shopId: s.id })
    }
  }
  return all
}

/** 查找某 ASIN 所在的 shopId（全店扫描） */
function findShopIdByAsin(shops, asin) {
  for (const s of shops) {
    const list = readProductsByShop(s.id)
    if (list.some((p) => p.asin === asin)) return s.id
  }
  return ''
}

function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolveP, rejectP) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolveP(null)
      try {
        resolveP(JSON.parse(raw))
      } catch (e) {
        rejectP(e)
      }
    })
    req.on('error', rejectP)
  })
}

function genShopId(existing) {
  const nums = existing
    .map((x) => x.id)
    .filter((v) => typeof v === 'string' && v.startsWith('shop-'))
    .map((v) => Number(v.slice(5)))
    .filter((n) => Number.isFinite(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `shop-${next}`
}

function parseWeekIdFromFilename(name) {
  return name.replace(/\.xlsx$/i, '')
}

function parseDatesFromFilename(name) {
  // 订单利润-ASIN-2026-07-12~2026-07-18-937769247582007296.xlsx
  const m = name.match(/(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})/)
  if (!m) return { startDate: '', endDate: '' }
  return { startDate: m[1], endDate: m[2] }
}

function cmpWeekByDateDesc(a, b) {
  const ad = a?.startDate || ''
  const bd = b?.startDate || ''
  if (ad === bd) return 0
  return ad < bd ? 1 : -1
}

function readXlsx(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath)
  const sh = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sh, {
    header: 1,
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd',
  })
  const columns = (rows[0] ?? []).map((v) => (v == null ? '' : String(v)))
  const dataRows = rows.slice(1).map((r) => {
    const filled = r.map((v) => (v == null ? '' : String(v)))
    while (filled.length < columns.length) filled.push('')
    return filled
  })
  return { columns, rows: dataRows }
}

/**
 * 导入一个 xlsx：
 * 1. 解析并写入 src/data/weeks/{id}.json
 * 2. 记录到 weeks.json 索引
 * 3. 自动同步新店铺到 shops.json
 * 4. 自动同步新 ASIN 到 products.json
 * 返回 { weekId, newShops, newAsins, rowCount }
 */
function importXlsx(filename) {
  const xlsxPath = fp(XLSX_DIR, filename)
  if (!existsSync(xlsxPath)) throw new Error('xlsx 文件不存在')

  const weekId = parseWeekIdFromFilename(filename)
  const { columns, rows } = readXlsx(xlsxPath)

  const colIdx = {}
  columns.forEach((c, i) => (colIdx[c] = i))

  // 先读取 weeks 索引并定位上一周，用于继承每个 ASIN 的备注
  const weeks = readJson(`${DATA_DIR}/weeks.json`, [])
  const filtered = weeks.filter((w) => w.id !== weekId)
  const { startDate, endDate } = parseDatesFromFilename(filename)
  const nextWeeks = filtered.slice()
  nextWeeks.push({
    id: weekId,
    filename,
    startDate,
    endDate,
    rowCount: 0,
    importedAt: new Date().toISOString(),
  })
  nextWeeks.sort(cmpWeekByDateDesc)
  const currentIdx = nextWeeks.findIndex((w) => w.id === weekId)
  const previousWeek = currentIdx >= 0 ? nextWeeks[currentIdx + 1] : null
  const prevSnapshot = previousWeek?.id
    ? readJson(`${WEEKS_DIR}/${previousWeek.id}.json`, null)
    : null
  const prevNotes = prevSnapshot && typeof prevSnapshot.notes === 'object' ? prevSnapshot.notes : {}

  // 组装 rows 快照，附带 asin 主键便于后续 join
  const asinIdx = colIdx['ASIN']
  const snapshotRows = rows.map((values, i) => ({
    asin: asinIdx != null ? values[asinIdx] : '',
    values,
    _rowIndex: i,
  }))

  const nextNotes = {}
  for (const row of snapshotRows) {
    const asin = (row.asin || '').trim()
    if (!asin) continue
    const note = prevNotes[asin]
    if (typeof note === 'string' && note.trim()) {
      nextNotes[asin] = note
    }
  }

  writeJson(`${WEEKS_DIR}/${weekId}.json`, {
    id: weekId,
    filename,
    columns,
    rows: snapshotRows,
    notes: nextNotes,
  })

  // 更新 weeks 索引
  const finalWeeks = filtered.slice()
  finalWeeks.push({
    id: weekId,
    filename,
    startDate,
    endDate,
    rowCount: snapshotRows.length,
    importedAt: new Date().toISOString(),
  })
  finalWeeks.sort(cmpWeekByDateDesc)
  writeJson(`${DATA_DIR}/weeks.json`, finalWeeks)

  // 同步 shops
  const shopIdx = colIdx['店铺']
  const countryIdx = colIdx['国家']
  const shops = readJson(`${DATA_DIR}/shops.json`, [])
  const existingShopNames = new Set(shops.map((s) => s.name))
  const newShops = []
  if (shopIdx != null) {
    for (const values of rows) {
      const name = (values[shopIdx] ?? '').trim()
      if (!name || existingShopNames.has(name)) continue
      const country = countryIdx != null ? values[countryIdx] : ''
      const shop = { id: genShopId(shops), name, country, note: '' }
      shops.push(shop)
      existingShopNames.add(name)
      newShops.push(shop)
    }
    if (newShops.length) writeJson(`${DATA_DIR}/shops.json`, shops)
  }

  // 同步 products（按店铺分文件）
  // 重新读取一次 shops，包含刚新增的
  const shopsAfter = readJson(`${DATA_DIR}/shops.json`, [])
  const shopNameToId = new Map(shopsAfter.map((s) => [s.name, s.id]))

  // 每个 shop 一份 map，避免每行都读文件
  const shopBuckets = new Map()
  const ensureBucket = (shopId) => {
    if (!shopBuckets.has(shopId)) {
      const list = readProductsByShop(shopId)
      shopBuckets.set(shopId, {
        map: new Map(list.map((p) => [p.asin, p])),
        changed: false,
      })
    }
    return shopBuckets.get(shopId)
  }

  const newAsins = []
  if (asinIdx != null && shopIdx != null) {
    for (const values of rows) {
      const asin = (values[asinIdx] ?? '').trim()
      if (!asin) continue
      const shopName = (values[shopIdx] ?? '').trim()
      const shopId = shopNameToId.get(shopName)
      if (!shopId) continue // 理论上不会：上一步已经补齐 shops

      const bucket = ensureBucket(shopId)
      if (!bucket.map.has(asin)) {
        const master = {}
        for (const f of MASTER_FIELDS) {
          const i = colIdx[f.column]
          master[f.key] = i != null ? values[i] ?? '' : ''
        }
        const product = {
          ...master,
          category: '正常',
          restockCycle: 2,
          stock: '',
          firstSeenWeek: weekId,
          lastSeenWeek: weekId,
        }
        bucket.map.set(asin, product)
        bucket.changed = true
        newAsins.push({ ...product, shopId })
      } else {
        const p = bucket.map.get(asin)
        if (p.lastSeenWeek !== weekId) {
          p.lastSeenWeek = weekId
          bucket.changed = true
        }
      }
    }
    for (const [shopId, bucket] of shopBuckets) {
      if (bucket.changed) {
        writeProductsByShop(shopId, Array.from(bucket.map.values()))
      }
    }
  }

  return {
    weekId,
    filename,
    rowCount: snapshotRows.length,
    newShops,
    newAsins,
  }
}

/* ============== Vite 插件 ============== */
function apiPlugin() {
  return {
    name: 'app-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const url = (req.url || '').split('?')[0]
        try {
          /* ---------- shops ---------- */
          if (url === '/shops' && req.method === 'GET') {
            return sendJson(res, 200, readJson(`${DATA_DIR}/shops.json`, []))
          }
          if (url === '/shops' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            if (!body.name) return sendJson(res, 400, { error: 'name required' })
            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            if (shops.some((s) => s.name === body.name)) {
              return sendJson(res, 409, { error: '店铺名已存在' })
            }
            const shop = {
              id: body.id || genShopId(shops),
              name: body.name,
              country: body.country || '',
              note: body.note || '',
            }
            shops.push(shop)
            writeJson(`${DATA_DIR}/shops.json`, shops)
            return sendJson(res, 201, shop)
          }
          if (url.startsWith('/shops/')) {
            const id = decodeURIComponent(url.slice('/shops/'.length))
            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            const idx = shops.findIndex((s) => s.id === id)
            if (idx < 0) return sendJson(res, 404, { error: 'not found' })
            if (req.method === 'PUT') {
              const body = (await readBody(req)) || {}
              shops[idx] = { ...shops[idx], ...body, id }
              writeJson(`${DATA_DIR}/shops.json`, shops)
              return sendJson(res, 200, shops[idx])
            }
            if (req.method === 'DELETE') {
              const removed = shops.splice(idx, 1)[0]
              writeJson(`${DATA_DIR}/shops.json`, shops)
              return sendJson(res, 200, removed)
            }
          }

          /* ---------- products (主键 ASIN；按店铺分文件) ---------- */
          if (url === '/products' && req.method === 'GET') {
            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            return sendJson(res, 200, readAllProducts(shops))
          }
          if (url === '/products' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            if (!body.asin) return sendJson(res, 400, { error: 'asin required' })
            if (!body.shopId) return sendJson(res, 400, { error: 'shopId required' })
            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            if (!shops.some((s) => s.id === body.shopId)) {
              return sendJson(res, 400, { error: 'shopId 不存在' })
            }
            // 全局唯一性检查
            if (findShopIdByAsin(shops, body.asin)) {
              return sendJson(res, 409, { error: 'ASIN 已存在' })
            }
            const list = readProductsByShop(body.shopId)
            const product = {
              asin: body.asin,
              parentAsin: body.parentAsin ?? '',
              name: body.name ?? '',
              category: body.category ?? '正常',
              restockCycle:
                body.restockCycle == null || body.restockCycle === ''
                  ? 1
                  : Number(body.restockCycle),
              stock: body.stock ?? '',
              firstSeenWeek: body.firstSeenWeek ?? '',
              lastSeenWeek: body.lastSeenWeek ?? '',
            }
            list.push(product)
            writeProductsByShop(body.shopId, list)
            return sendJson(res, 201, { ...product, shopId: body.shopId })
          }
          if (url.startsWith('/products/')) {
            const asin = decodeURIComponent(url.slice('/products/'.length))
            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            const shopId = findShopIdByAsin(shops, asin)
            if (!shopId) return sendJson(res, 404, { error: 'not found' })
            const list = readProductsByShop(shopId)
            const idx = list.findIndex((p) => p.asin === asin)
            if (idx < 0) return sendJson(res, 404, { error: 'not found' })
            if (req.method === 'PUT') {
              const body = (await readBody(req)) || {}
              // 支持迁移到另一个店铺
              if (body.shopId && body.shopId !== shopId) {
                if (!shops.some((s) => s.id === body.shopId)) {
                  return sendJson(res, 400, { error: 'shopId 不存在' })
                }
                const removed = list.splice(idx, 1)[0]
                writeProductsByShop(shopId, list)
                const targetList = readProductsByShop(body.shopId)
                const merged = { ...removed, ...body, asin }
                delete merged.shopId
                targetList.push(merged)
                writeProductsByShop(body.shopId, targetList)
                return sendJson(res, 200, { ...merged, shopId: body.shopId })
              }
              const merged = { ...list[idx], ...body, asin }
              delete merged.shopId
              list[idx] = merged
              writeProductsByShop(shopId, list)
              return sendJson(res, 200, { ...list[idx], shopId })
            }
            if (req.method === 'DELETE') {
              const removed = list.splice(idx, 1)[0]
              writeProductsByShop(shopId, list)
              return sendJson(res, 200, { ...removed, shopId })
            }
          }

          /* ---------- weeks ---------- */
          if (url === '/weeks' && req.method === 'GET') {
            return sendJson(res, 200, readJson(`${DATA_DIR}/weeks.json`, []))
          }
          if (url.startsWith('/weeks/') && url.includes('/notes/') && req.method === 'PUT') {
            const m = url.match(/^\/weeks\/([^/]+)\/notes\/([^/]+)$/)
            if (!m) return sendJson(res, 400, { error: 'bad request' })
            const id = decodeURIComponent(m[1])
            const asin = decodeURIComponent(m[2])
            const body = (await readBody(req)) || {}
            const note = typeof body.note === 'string' ? body.note : ''

            const data = readJson(`${WEEKS_DIR}/${id}.json`, null)
            if (!data) return sendJson(res, 404, { error: 'not found' })

            const notes = data.notes && typeof data.notes === 'object' ? { ...data.notes } : {}
            if (note.trim()) notes[asin] = note
            else delete notes[asin]
            data.notes = notes
            writeJson(`${WEEKS_DIR}/${id}.json`, data)
            return sendJson(res, 200, { ok: true, id, asin, note: notes[asin] || '' })
          }
          if (url.startsWith('/weeks/')) {
            const id = decodeURIComponent(url.slice('/weeks/'.length))
            if (req.method === 'GET') {
              const data = readJson(`${WEEKS_DIR}/${id}.json`, null)
              if (!data) return sendJson(res, 404, { error: 'not found' })
              return sendJson(res, 200, data)
            }
            if (req.method === 'DELETE') {
              const weeks = readJson(`${DATA_DIR}/weeks.json`, [])
              const filtered = weeks.filter((w) => w.id !== id)
              writeJson(`${DATA_DIR}/weeks.json`, filtered)
              const snapshotPath = fp(WEEKS_DIR, `${id}.json`)
              if (existsSync(snapshotPath)) unlinkSync(snapshotPath)
              return sendJson(res, 200, { ok: true })
            }
          }

          /* ---------- 补货配置 ---------- */
          if (url === '/restock-config' && req.method === 'GET') {
            return sendJson(res, 200, restockConfigData)
          }

          /* ---------- 导入 ---------- */
          if (url === '/scan' && req.method === 'GET') {
            const xlsxDir = fp(XLSX_DIR)
            const files = existsSync(xlsxDir)
              ? readdirSync(xlsxDir).filter(
                  (f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'),
                )
              : []
            const weeks = readJson(`${DATA_DIR}/weeks.json`, [])
            const importedIds = new Set(weeks.map((w) => w.id))
            const unimported = files
              .map((f) => ({
                filename: f,
                weekId: parseWeekIdFromFilename(f),
                ...parseDatesFromFilename(f),
              }))
              .filter((f) => !importedIds.has(f.weekId))
              .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
            return sendJson(res, 200, { unimported, imported: weeks })
          }
          if (url === '/import' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            const files = Array.isArray(body.files)
              ? body.files
              : body.filename
                ? [body.filename]
                : []
            if (!files.length) {
              return sendJson(res, 400, { error: 'files required' })
            }
            const results = []
            for (const filename of files) {
              try {
                results.push(importXlsx(filename))
              } catch (e) {
                results.push({ filename, error: String(e?.message || e) })
              }
            }
            return sendJson(res, 200, { results })
          }
        } catch (e) {
          return sendJson(res, 500, { error: String(e?.message || e) })
        }

        return next()
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 8000,
    open: true,
  },
})


