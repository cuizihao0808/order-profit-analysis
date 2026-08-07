import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import {
  buildListingRowRecord,
  choosePreferredFile,
  isListingStockFile,
  isOrderProfitFile,
  normalizeInventoryProduct,
  parseDatesFromFilename,
  parseWeekIdFromFolder,
} from './src/lib/dataPipeline.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const PDFDocument = require('pdfkit')

const DATA_DIR = 'src/data'
const WEEKS_DIR = 'src/data/weeks'
const PRODUCTS_DIR = 'src/data/products'
const XLSX_DIR = 'public/data'
const DEV_SESSION_ID = String(Date.now())

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
  const list = readJson(productFilePath(shopId), [])
  return Array.isArray(list) ? list.map(normalizeInventoryProduct) : []
}

function writeProductsByShop(shopId, list) {
  const normalized = Array.isArray(list) ? list.map(normalizeInventoryProduct) : []
  writeJson(productFilePath(shopId), normalized)
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

function sanitizeFilename(name, fallback = 'export') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
  return cleaned || fallback
}

function choosePdfFontPath() {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',
  ]
  return candidates.find((p) => existsSync(p)) || ''
}

async function generateLocalWarehousePdfBuffer(payload) {
  const weekId = String(payload?.weekId || '').trim() || '周次'
  const shopName = String(payload?.shopName || '').trim() || '店铺'
  const rows = Array.isArray(payload?.rows) ? payload.rows : []

  const doc = new PDFDocument({ size: 'A4', margin: 18, bufferPages: true })
  const chunks = []
  doc.on('data', (c) => chunks.push(c))
  const done = new Promise((resolveP, rejectP) => {
    doc.on('end', resolveP)
    doc.on('error', rejectP)
  })

  const fontPath = choosePdfFontPath()
  if (fontPath) doc.font(fontPath)

  const pageWidth = doc.page.width
  const pageHeight = doc.page.height
  const marginLeft = 18
  const marginRight = 18
  const marginTop = 18
  const marginBottom = 24
  const contentWidth = pageWidth - marginLeft - marginRight
  const tableTopGap = 4
  const cellPadding = 5
  const maxImageCount = rows.reduce((m, r) => {
    const c = Array.isArray(r?.images) ? r.images.filter((x) => String(x || '').trim()).length : 0
    return Math.max(m, c)
  }, 0)
  const imageCols = 1
  const baseImageSize = rows.length <= 6 ? 52 : rows.length <= 10 ? 46 : rows.length <= 16 ? 40 : 36
  const imageSize = baseImageSize
  const imageGap = 3
  const imageCache = new Map()

  const colWidths = [0.27, 0.17, 0.15, 0.08, 0.11, 0.11, 0.11].map((r) => contentWidth * r)
  const headers = ['产品图片（多图）', '品名', 'FNSKU', '本地仓库', '包装尺寸/cm', '单品重量/g', '包装类型']

  const colX = [marginLeft]
  for (let i = 1; i < colWidths.length; i++) colX[i] = colX[i - 1] + colWidths[i - 1]

  let cursorY = marginTop
  let pageNo = 1

  const drawPageTitle = () => {
    const bandHeight = 30
    doc.save()
    doc.rect(marginLeft, cursorY, contentWidth, bandHeight).fill('#edf3ff')
    doc.restore()
    doc.rect(marginLeft, cursorY, contentWidth, bandHeight).stroke('#d3def5')

    doc.fontSize(13).fillColor('#0f172a').text(`${shopName} 本地仓库清单`, marginLeft + 8, cursorY + 7, {
      width: contentWidth * 0.62,
    })
    doc.fontSize(8.4).fillColor('#334155')
    doc.text(`周次：${weekId}`, marginLeft + contentWidth * 0.62, cursorY + 7, {
      width: contentWidth * 0.38 - 8,
      align: 'right',
    })
    doc.text(`总行数：${rows.length}    第 ${pageNo} 页`, marginLeft + contentWidth * 0.62, cursorY + 17, {
      width: contentWidth * 0.38 - 8,
      align: 'right',
    })
    cursorY += bandHeight
  }

  const drawTableHeader = () => {
    const headerHeight = 18
    for (let i = 0; i < headers.length; i++) {
      const x = colX[i]
      doc.save()
      doc.rect(x, cursorY, colWidths[i], headerHeight).fill('#e2e8f0')
      doc.restore()
      doc.rect(x, cursorY, colWidths[i], headerHeight).stroke('#c3cfde')
      const label = headers[i]
      const headerFontSize = i === 5 ? 7.8 : 8.2
      doc.fontSize(headerFontSize).fillColor('#0f172a')
      const h = doc.heightOfString(label, { width: colWidths[i] - cellPadding * 2 })
      const textY = cursorY + Math.max(1, (headerHeight - h) / 2)
      doc.text(label, x + cellPadding, textY, {
        width: colWidths[i] - cellPadding * 2,
        align: 'left',
        lineBreak: i === 5 ? false : true,
      })
    }
    cursorY += headerHeight
  }

  const addPageIfNeeded = (requiredHeight) => {
    if (cursorY + requiredHeight <= pageHeight - marginBottom) return
    doc.addPage({ size: 'A4', margin: 18 })
    if (fontPath) doc.font(fontPath)
    pageNo += 1
    cursorY = marginTop
    drawPageTitle()
    cursorY += tableTopGap
    drawTableHeader()
  }

  const getImageBuffer = async (url) => {
    const key = String(url || '').trim()
    if (!key) return null
    if (imageCache.has(key)) return imageCache.get(key)
    try {
      const resp = await fetch(key)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const arr = await resp.arrayBuffer()
      const buf = Buffer.from(arr)
      imageCache.set(key, buf)
      return buf
    } catch {
      imageCache.set(key, null)
      return null
    }
  }

  drawPageTitle()
  cursorY += tableTopGap
  drawTableHeader()

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const fnsku = String(row?.fnsku || '').trim() || '—'
    const name = String(row?.name || '').trim() || '—'
    const localWarehouse =
      row?.localWarehouse == null || row?.localWarehouse === ''
        ? '0'
        : String(row.localWarehouse)
    const packageSize = String(row?.packageSize || '').trim() || '—'
    const packageType = String(row?.packageType || '').trim() || '—'
    const itemWeight = String(row?.itemWeight || '').trim() || '—'
    const images = Array.isArray(row?.images)
      ? row.images.map((x) => String(x || '').trim()).filter(Boolean)
      : []

    const imageRows = Math.max(1, Math.ceil(images.length / imageCols))
    const imageBlockHeight = images.length
      ? imageRows * imageSize + (imageRows - 1) * imageGap
      : 16

    const displayName = name
    doc.fontSize(8.2)
    const oneLineHeight = Math.max(12, Math.ceil(doc.currentLineHeight()))
    const textHeightName = Math.max(16, doc.heightOfString(displayName, { width: colWidths[1] - cellPadding * 2 }))
    const textHeightFnsku = oneLineHeight
    const textHeightQty = oneLineHeight
    const textHeightSize = Math.max(14, doc.heightOfString(packageSize, { width: colWidths[4] - cellPadding * 2 }))
    const textHeightWeight = oneLineHeight
    const textHeightType = Math.max(14, doc.heightOfString(packageType, { width: colWidths[6] - cellPadding * 2 }))

    const rowHeight = Math.max(
      imageBlockHeight + cellPadding * 2,
      textHeightName + cellPadding * 2,
      textHeightFnsku + cellPadding * 2,
      textHeightQty + cellPadding * 2,
      textHeightSize + cellPadding * 2,
      textHeightWeight + cellPadding * 2,
      textHeightType + cellPadding * 2,
      24,
    )

    addPageIfNeeded(rowHeight + 0.5)

    if (rowIndex % 2 === 1) {
      doc.save()
      doc.rect(marginLeft, cursorY, contentWidth, rowHeight).fill('#fafcff')
      doc.restore()
    }

    for (let i = 0; i < colWidths.length; i++) {
      doc.rect(colX[i], cursorY, colWidths[i], rowHeight).stroke('#d0d9e6')
    }

    doc.fontSize(8.2).fillColor('#0f172a')
    const nameY = cursorY + Math.max(cellPadding, (rowHeight - textHeightName) / 2)
    const fnskuY = cursorY + Math.max(cellPadding, (rowHeight - textHeightFnsku) / 2)
    const qtyY = cursorY + Math.max(cellPadding, (rowHeight - textHeightQty) / 2)
    const sizeY = cursorY + Math.max(cellPadding, (rowHeight - textHeightSize) / 2)
    const weightY = cursorY + Math.max(cellPadding, (rowHeight - textHeightWeight) / 2)
    const typeY = cursorY + Math.max(cellPadding, (rowHeight - textHeightType) / 2)

    doc.text(displayName, colX[1] + cellPadding, nameY, {
      width: colWidths[1] - cellPadding * 2,
      align: 'left',
    })
    doc.text(fnsku, colX[2] + cellPadding, fnskuY, {
      width: colWidths[2] - cellPadding * 2,
      lineBreak: false,
      align: 'left',
    })
    doc.text(localWarehouse, colX[3] + cellPadding, qtyY, {
      width: colWidths[3] - cellPadding * 2,
      lineBreak: false,
      align: 'left',
    })
    doc.text(packageSize, colX[4] + cellPadding, sizeY, {
      width: colWidths[4] - cellPadding * 2,
      align: 'left',
    })
    doc.text(itemWeight, colX[5] + cellPadding, weightY, {
      width: colWidths[5] - cellPadding * 2,
      lineBreak: false,
      align: 'left',
    })
    doc.text(packageType, colX[6] + cellPadding, typeY, {
      width: colWidths[6] - cellPadding * 2,
      align: 'left',
    })

    const imageOffsetY = cursorY + (rowHeight - imageBlockHeight) / 2
    if (!images.length) {
      doc.fillColor('#64748b').text('—', colX[0] + cellPadding, imageOffsetY, { align: 'left' })
      doc.fillColor('#0f172a')
    } else {
      for (let idx = 0; idx < images.length; idx++) {
        const imgX = colX[0] + cellPadding + (idx % imageCols) * (imageSize + imageGap)
        const imgY = imageOffsetY + Math.floor(idx / imageCols) * (imageSize + imageGap)
        const buf = await getImageBuffer(images[idx])
        if (!buf) {
          doc.save()
          doc.rect(imgX, imgY, imageSize, imageSize).fill('#f1f5f9')
          doc.restore()
          doc.rect(imgX, imgY, imageSize, imageSize).stroke('#d0d9e6')
          doc.fillColor('#64748b').fontSize(7.2).text('加载失败', imgX + 5, imgY + imageSize / 2 - 4)
          doc.fillColor('#0f172a').fontSize(8.2)
          continue
        }
        try {
          doc.image(buf, imgX, imgY, {
            fit: [imageSize, imageSize],
            align: 'center',
            valign: 'center',
          })
          doc.rect(imgX, imgY, imageSize, imageSize).stroke('#d0d9e6')
        } catch {
          doc.save()
          doc.rect(imgX, imgY, imageSize, imageSize).fill('#f1f5f9')
          doc.restore()
          doc.rect(imgX, imgY, imageSize, imageSize).stroke('#d0d9e6')
          doc.fillColor('#64748b').fontSize(7).text('格式不支持', imgX + 2, imgY + imageSize / 2 - 4)
          doc.fillColor('#0f172a').fontSize(8.2)
        }
      }
    }

    cursorY += rowHeight
  }

  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    doc.fontSize(8).fillColor('#64748b')
    doc.text(`页码 ${i + 1}/${range.count}`, marginLeft, pageHeight - marginBottom - 10, {
      width: contentWidth,
      align: 'right',
      lineBreak: false,
    })
  }

  doc.end()
  await done
  return Buffer.concat(chunks)
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

function cmpWeekByDateDesc(a, b) {
  const ad = a?.startDate || ''
  const bd = b?.startDate || ''
  if (ad === bd) return 0
  return ad < bd ? 1 : -1
}

function readTableFile(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false })
  const sh = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sh, {
    header: 1,
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd',
  })
  const columns = (rows[0] ?? []).map((v) => (v == null ? '' : String(v).trim()))
  const dataRows = rows.slice(1).map((r) => {
    const filled = r.map((v) => (v == null ? '' : String(v).trim()))
    while (filled.length < columns.length) filled.push('')
    return filled
  })
  return { columns, rows: dataRows }
}

function readListingDataForBundle(folderName, listingFiles) {
  const validListingFiles = (Array.isArray(listingFiles) ? listingFiles : []).filter((f) =>
    existsSync(fp(XLSX_DIR, folderName, f)),
  )

  const listingMap = new Map()
  const listingAsinsByFile = new Map()
  const listingRowsByFile = new Map()

  for (const listingFile of validListingFiles) {
    const listingPath = fp(XLSX_DIR, folderName, listingFile)
    const listing = readTableFile(listingPath)
    const listingColIdx = {}
    listing.columns.forEach((c, i) => (listingColIdx[c] = i))
    const listingAsinIdx = listingColIdx['ASIN']
    if (listingAsinIdx == null) continue

    const fileAsins = new Set()
    const fileRows = new Map()

    for (const values of listing.rows) {
      const asin = String(values[listingAsinIdx] ?? '').trim()
      if (!asin) continue
      fileAsins.add(asin)
      const incoming = buildListingRowRecord(values, listingColIdx)

      const prevFromFile = fileRows.get(asin)
      if (!prevFromFile) {
        fileRows.set(asin, incoming)
      } else {
        const mergedFromFile = { ...prevFromFile }
        for (const [k, v] of Object.entries(incoming)) {
          if (v === '' || v == null) continue
          mergedFromFile[k] = v
        }
        fileRows.set(asin, mergedFromFile)
      }

      const prev = listingMap.get(asin)
      if (!prev) {
        listingMap.set(asin, incoming)
      } else {
        const merged = { ...prev }
        for (const [k, v] of Object.entries(incoming)) {
          if (v === '' || v == null) continue
          merged[k] = v
        }
        listingMap.set(asin, merged)
      }
    }

    listingAsinsByFile.set(listingFile, fileAsins)
    listingRowsByFile.set(listingFile, fileRows)
  }

  return { validListingFiles, listingMap, listingAsinsByFile, listingRowsByFile }
}

function scanWeekBundles() {
  const baseDir = fp(XLSX_DIR)
  if (!existsSync(baseDir)) return []
  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const folderName = d.name
      const weekId = parseWeekIdFromFolder(folderName)
      const dir = fp(XLSX_DIR, folderName)
      const files = readdirSync(dir)
        .map((f) => String(f).trim())
        .filter(Boolean)
        .filter((f) => !f.startsWith('.'))
        .filter((f) => /\.(xlsx|csv)$/i.test(f))

      const orderFile = choosePreferredFile(files.filter(isOrderProfitFile))
      const listingFiles = files.filter(isListingStockFile).sort((a, b) => a.localeCompare(b))
      const dateSource = orderFile || listingFiles[0] || folderName
      return {
        weekId,
        folderName,
        orderFile,
        listingFiles,
        ...parseDatesFromFilename(dateSource),
      }
    })
    .filter((x) => x.orderFile)

  return entries.sort((a, b) => {
    if (a.startDate && b.startDate && a.startDate !== b.startDate) {
      return a.startDate < b.startDate ? 1 : -1
    }
    return a.weekId < b.weekId ? 1 : -1
  })
}

function buildDataScanSignature() {
  const baseDir = fp(XLSX_DIR)
  if (!existsSync(baseDir)) return 'missing'

  const chunks = []
  const folders = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))

  for (const folderName of folders) {
    const dir = fp(XLSX_DIR, folderName)
    const files = readdirSync(dir)
      .map((f) => String(f).trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith('.'))
      .filter((f) => /\.(xlsx|csv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b))

    for (const file of files) {
      const full = fp(XLSX_DIR, folderName, file)
      try {
        const st = statSync(full)
        chunks.push(`${folderName}/${file}:${st.size}:${Math.floor(st.mtimeMs)}`)
      } catch {
        chunks.push(`${folderName}/${file}:missing`)
      }
    }
  }

  return chunks.join('|') || 'empty'
}

function readImportedWeeksFallback() {
  const fromIndex = readJson(`${DATA_DIR}/weeks.json`, [])
  if (Array.isArray(fromIndex) && fromIndex.length) return fromIndex

  const dir = fp(WEEKS_DIR)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir)
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => String(f))

  const rebuilt = []
  for (const file of files) {
    const snap = readJson(`${WEEKS_DIR}/${file}`, null)
    if (!snap || !snap.id) continue
    const filename = String(snap.filename || file)
    const { startDate, endDate } = parseDatesFromFilename(filename)
    const rowCount = Array.isArray(snap.rows) ? snap.rows.length : 0
    const listingFiles = Array.isArray(snap.listingFiles)
      ? snap.listingFiles.filter((x) => typeof x === 'string')
      : []
    rebuilt.push({
      id: snap.id,
      filename,
      startDate,
      endDate,
      rowCount,
      listingFiles,
      importedAt: '',
    })
  }

  rebuilt.sort(cmpWeekByDateDesc)
  if (rebuilt.length) writeJson(`${DATA_DIR}/weeks.json`, rebuilt)
  return rebuilt
}

function importWeekBundle(bundle) {
  const folderName = bundle?.folderName || ''
  const weekId = bundle?.weekId || ''
  const orderFile = bundle?.orderFile || ''
  const listingFiles = Array.isArray(bundle?.listingFiles) ? bundle.listingFiles : []
  if (!folderName || !weekId || !orderFile) {
    throw new Error('周目录数据不完整')
  }

  const orderPath = fp(XLSX_DIR, folderName, orderFile)
  if (!existsSync(orderPath)) throw new Error('订单利润表不存在')
  const validListingFiles = listingFiles.filter((f) => existsSync(fp(XLSX_DIR, folderName, f)))

  const { columns, rows } = readTableFile(orderPath)

  const colIdx = {}
  columns.forEach((c, i) => (colIdx[c] = i))

  const listingData = readListingDataForBundle(folderName, validListingFiles)
  const listingMap = listingData.listingMap
  const listingAsinsByFile = listingData.listingAsinsByFile
  const listingRowsByFile = listingData.listingRowsByFile

  // 先读取 weeks 索引并定位上一周，用于继承每个 ASIN 的备注
  const weeks = readJson(`${DATA_DIR}/weeks.json`, [])
  const filtered = weeks.filter((w) => w.id !== weekId)
  const dateSource = orderFile || validListingFiles[0] || folderName
  const { startDate, endDate } = parseDatesFromFilename(dateSource)
  const nextWeeks = filtered.slice()
  nextWeeks.push({
    id: weekId,
    filename: `${folderName}/${orderFile}`,
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
  const snapshotAsinSet = new Set(
    snapshotRows.map((r) => String(r?.asin || '').trim()).filter(Boolean),
  )

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
    filename: `${folderName}/${orderFile}`,
    listingFiles: validListingFiles,
    columns,
    rows: snapshotRows,
    notes: nextNotes,
  })

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
  const shopNameById = new Map(shopsAfter.map((s) => [s.id, s.name]))

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
  const unmatchedByShopMap = new Map()
  let listingOnlyAddedByShop = []
  let listingOnlyAddedTotal = 0
  let listingOnlyUnresolvedByFile = []
  let listingOnlyUnresolvedTotal = 0

  const addUnmatchedAsin = (shopName, asin) => {
    if (!shopName || !asin) return
    if (!unmatchedByShopMap.has(shopName)) {
      unmatchedByShopMap.set(shopName, new Set())
    }
    unmatchedByShopMap.get(shopName).add(asin)
  }

  const applyListingRow = (product, listingRow) => {
    if (!listingRow) return false
    const before = JSON.stringify({
      fnsku: product.fnsku,
      name: product.name,
      monthSales: product.monthSales,
      monthRevenue: product.monthRevenue,
      monthOrders: product.monthOrders,
      dailySales: product.dailySales,
      vineGiftSales: product.vineGiftSales,
      sellable: product.sellable,
      inbound: product.inbound,
      unsellable: product.unsellable,
      reserved: product.reserved,
      fbaTotal: product.fbaTotal,
      packageSize: product.packageSize,
      packageType: product.packageType,
      itemWeight: product.itemWeight,
      productImage: product.productImage,
      productImages: product.productImages,
      localWarehouse: product.localWarehouse,
      orderedQty: product.orderedQty,
    })

    product.fnsku = listingRow.fnsku
    if (listingRow.name) product.name = listingRow.name
    product.monthSales = listingRow.monthSales
    product.monthRevenue = listingRow.monthRevenue
    product.monthOrders = listingRow.monthOrders
    product.dailySales = listingRow.dailySales
    product.vineGiftSales = listingRow.vineGiftSales
    product.sellable = listingRow.sellable
    product.inbound = listingRow.inbound
    product.unsellable = listingRow.unsellable
    product.reserved = listingRow.reserved
    product.fbaTotal = listingRow.fbaTotal
    product.packageSize = listingRow.packageSize
    product.packageType = listingRow.packageType
    product.itemWeight = listingRow.itemWeight
    product.productImage = listingRow.productImage
    product.productImages = Array.isArray(listingRow.productImages) ? listingRow.productImages : []
    if (product.localWarehouse == null || product.localWarehouse === '') product.localWarehouse = 0
    if (product.orderedQty == null || product.orderedQty === '') product.orderedQty = 0

    const after = JSON.stringify({
      fnsku: product.fnsku,
      name: product.name,
      monthSales: product.monthSales,
      monthRevenue: product.monthRevenue,
      monthOrders: product.monthOrders,
      dailySales: product.dailySales,
      vineGiftSales: product.vineGiftSales,
      sellable: product.sellable,
      inbound: product.inbound,
      unsellable: product.unsellable,
      reserved: product.reserved,
      fbaTotal: product.fbaTotal,
      packageSize: product.packageSize,
      packageType: product.packageType,
      itemWeight: product.itemWeight,
      productImage: product.productImage,
      productImages: product.productImages,
      localWarehouse: product.localWarehouse,
      orderedQty: product.orderedQty,
    })
    return before !== after
  }

  const applyUnmatchedInventoryFallback = (product) => {
    if (product.fbaTotal === '' || product.fbaTotal == null) return
    if (product.sellable === '' || product.sellable == null) product.sellable = product.fbaTotal
    if (product.inbound === '' || product.inbound == null) product.inbound = 0
    if (product.unsellable === '' || product.unsellable == null) product.unsellable = 0
    if (product.reserved === '' || product.reserved == null) product.reserved = 0
  }

  const appendSnapshotRowIfMissing = (asin, shopId, listingRow, category = '新品') => {
    const key = String(asin || '').trim()
    if (!key || snapshotAsinSet.has(key)) return

    const shop = shopsAfter.find((s) => s.id === shopId) || null
    const values = Array(columns.length).fill('')
    if (colIdx['ASIN'] != null) values[colIdx['ASIN']] = key
    if (colIdx['FNSKU'] != null) values[colIdx['FNSKU']] = listingRow?.fnsku || ''
    if (colIdx['父ASIN'] != null) values[colIdx['父ASIN']] = key
    if (colIdx['店铺'] != null) values[colIdx['店铺']] = shop?.name || ''
    if (colIdx['国家'] != null) values[colIdx['国家']] = shop?.country || ''
    if (colIdx['品名'] != null) values[colIdx['品名']] = listingRow?.name || ''
    if (colIdx['分类'] != null) values[colIdx['分类']] = category

    snapshotRows.push({ asin: key, values, _rowIndex: snapshotRows.length })
    snapshotAsinSet.add(key)
  }

  const orderAsinSet = new Set()
  const orderAsinsByShop = new Map()
  const addOrderAsinByShop = (shopId, asin) => {
    if (!shopId || !asin) return
    if (!orderAsinsByShop.has(shopId)) orderAsinsByShop.set(shopId, new Set())
    orderAsinsByShop.get(shopId).add(asin)
  }

  if (asinIdx != null && shopIdx != null) {
    for (const values of rows) {
      const asin = (values[asinIdx] ?? '').trim()
      if (!asin) continue
      orderAsinSet.add(asin)
      const shopName = (values[shopIdx] ?? '').trim()
      const shopId = shopNameToId.get(shopName)
      if (!shopId) continue // 理论上不会：上一步已经补齐 shops
      addOrderAsinByShop(shopId, asin)

      const bucket = ensureBucket(shopId)
      const listingRow = listingMap.get(asin)
      if (!listingRow) {
        addUnmatchedAsin(shopName, asin)
      }

      if (!bucket.map.has(asin)) {
        const master = {}
        for (const f of MASTER_FIELDS) {
          const i = colIdx[f.column]
          master[f.key] = i != null ? values[i] ?? '' : ''
        }
        const product = {
          ...master,
          fnsku: '',
          category: '正常',
          restockCycle: 2,
          sellable: '',
          inbound: '',
          unsellable: '',
          reserved: '',
          fbaTotal: '',
          localWarehouse: 0,
          orderedQty: 0,
          monthSales: '',
          monthRevenue: '',
          monthOrders: '',
          dailySales: '',
          vineGiftSales: '',
          packageSize: '',
          packageType: '',
          itemWeight: '',
          productImage: '',
          productImages: [],
          firstSeenWeek: weekId,
          lastSeenWeek: weekId,
        }
        if (listingRow) {
          applyListingRow(product, listingRow)
        } else {
          applyUnmatchedInventoryFallback(product)
        }
        bucket.map.set(asin, product)
        bucket.changed = true
        newAsins.push({ ...product, shopId })
      } else {
        const p = bucket.map.get(asin)
        if (listingRow) {
          if (applyListingRow(p, listingRow)) bucket.changed = true
        } else {
          const before = JSON.stringify({
            sellable: p.sellable,
            inbound: p.inbound,
            unsellable: p.unsellable,
            reserved: p.reserved,
          })
          applyUnmatchedInventoryFallback(p)
          const after = JSON.stringify({
            sellable: p.sellable,
            inbound: p.inbound,
            unsellable: p.unsellable,
            reserved: p.reserved,
          })
          if (before !== after) bucket.changed = true
        }
        if (p.lastSeenWeek !== weekId) {
          p.lastSeenWeek = weekId
          bucket.changed = true
        }
      }
    }

    const findAsinBucket = (asin) => {
      for (const [shopId, bucket] of shopBuckets) {
        if (bucket.map.has(asin)) return { shopId, bucket, product: bucket.map.get(asin) }
      }
      return null
    }

    const pickShopFromCounts = (counts) => {
      let bestShopId = ''
      let bestCount = 0
      let tied = false
      for (const [shopId, count] of counts) {
        if (count > bestCount) {
          bestShopId = shopId
          bestCount = count
          tied = false
        } else if (count === bestCount && count > 0) {
          tied = true
        }
      }
      if (bestCount <= 0 || tied) return ''
      return bestShopId
    }

    const inferShopIdForListingFile = (fileAsins) => {
      const overlapWithOrder = new Map()
      for (const [shopId, asinSet] of orderAsinsByShop) {
        let hit = 0
        for (const asin of fileAsins) {
          if (asinSet.has(asin)) hit += 1
        }
        if (hit > 0) overlapWithOrder.set(shopId, hit)
      }
      const fromOrder = pickShopFromCounts(overlapWithOrder)
      if (fromOrder) return fromOrder

      const overlapWithMaster = new Map()
      for (const [shopId, bucket] of shopBuckets) {
        let hit = 0
        for (const asin of fileAsins) {
          if (bucket.map.has(asin)) hit += 1
        }
        if (hit > 0) overlapWithMaster.set(shopId, hit)
      }
      const fromMaster = pickShopFromCounts(overlapWithMaster)
      if (fromMaster) return fromMaster

      // 兜底：当目录只有一个店铺时可直接归属。
      if (shopsAfter.length === 1) return shopsAfter[0].id
      return ''
    }

    const listingOnlyAdded = []
    const listingOnlyUnresolved = []
    const processedListingOnly = new Set()

    for (const listingFile of validListingFiles) {
      const fileAsins = listingAsinsByFile.get(listingFile) || new Set()
      if (!fileAsins.size) continue
      const fileRows = listingRowsByFile.get(listingFile) || new Map()
      const inferredShopId = inferShopIdForListingFile(fileAsins)

      for (const asin of fileAsins) {
        if (orderAsinSet.has(asin) || processedListingOnly.has(asin)) continue
        processedListingOnly.add(asin)

        const listingRow = fileRows.get(asin) || listingMap.get(asin)
        const located = findAsinBucket(asin)
        if (located) {
          if (applyListingRow(located.product, listingRow)) located.bucket.changed = true
          if (located.product.lastSeenWeek !== weekId) {
            located.product.lastSeenWeek = weekId
            located.bucket.changed = true
          }
          appendSnapshotRowIfMissing(asin, located.shopId, listingRow, located.product.category || '新品')
          continue
        }

        if (!inferredShopId) {
          listingOnlyUnresolved.push({ listingFile, asin })
          continue
        }

        const targetBucket = ensureBucket(inferredShopId)
        const product = {
          asin,
          parentAsin: asin,
          fnsku: listingRow?.fnsku ?? '',
          name: listingRow?.name || '',
          category: '新品',
          restockCycle: 2,
          sellable: listingRow?.sellable ?? '',
          inbound: listingRow?.inbound ?? '',
          unsellable: listingRow?.unsellable ?? '',
          reserved: listingRow?.reserved ?? '',
          fbaTotal: listingRow?.fbaTotal ?? '',
          localWarehouse: 0,
          orderedQty: 0,
          monthSales: listingRow?.monthSales ?? '',
          monthRevenue: listingRow?.monthRevenue ?? '',
          monthOrders: listingRow?.monthOrders ?? '',
          dailySales: listingRow?.dailySales ?? '',
          vineGiftSales: listingRow?.vineGiftSales ?? '',
          packageSize: listingRow?.packageSize ?? '',
          packageType: listingRow?.packageType ?? '',
          itemWeight: listingRow?.itemWeight ?? '',
          productImage: listingRow?.productImage ?? '',
          productImages: Array.isArray(listingRow?.productImages) ? listingRow.productImages : [],
          firstSeenWeek: weekId,
          lastSeenWeek: weekId,
        }
        targetBucket.map.set(asin, product)
        targetBucket.changed = true
        newAsins.push({ ...product, shopId: inferredShopId })
        appendSnapshotRowIfMissing(asin, inferredShopId, listingRow, '新品')
        listingOnlyAdded.push({
          asin,
          shopId: inferredShopId,
          shopName: shopNameById.get(inferredShopId) || inferredShopId,
        })
      }
    }

    for (const [shopId, bucket] of shopBuckets) {
      if (bucket.changed) {
        writeProductsByShop(shopId, Array.from(bucket.map.values()))
      }
    }

    listingOnlyUnresolvedByFile = Array.from(
      listingOnlyUnresolved.reduce((acc, item) => {
        if (!acc.has(item.listingFile)) acc.set(item.listingFile, [])
        acc.get(item.listingFile).push(item.asin)
        return acc
      }, new Map()),
    )
      .map(([listingFile, asins]) => ({
        listingFile,
        count: asins.length,
        asins: asins.slice().sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => b.count - a.count || a.listingFile.localeCompare(b.listingFile))

    listingOnlyAddedByShop = Array.from(
      listingOnlyAdded.reduce((acc, item) => {
        if (!acc.has(item.shopName)) acc.set(item.shopName, [])
        acc.get(item.shopName).push(item.asin)
        return acc
      }, new Map()),
    )
      .map(([shopName, asins]) => ({
        shopName,
        count: asins.length,
        asins: asins.slice().sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => b.count - a.count || a.shopName.localeCompare(b.shopName))

    listingOnlyAddedTotal = listingOnlyAdded.length
    listingOnlyUnresolvedTotal = listingOnlyUnresolved.length
  }

  const unmatchedByShop = Array.from(unmatchedByShopMap.entries())
    .map(([shopName, asins]) => {
      const uniqAsins = Array.from(asins).sort((a, b) => a.localeCompare(b))
      return {
        shopName,
        count: uniqAsins.length,
        asins: uniqAsins,
      }
    })
    .sort((a, b) => b.count - a.count || a.shopName.localeCompare(b.shopName))

  const unmatchedTotal = unmatchedByShop.reduce((sum, x) => sum + x.count, 0)

  // 以最终快照覆盖写回：确保仅 Listing ASIN 不会在重导入后丢失。
  writeJson(`${WEEKS_DIR}/${weekId}.json`, {
    id: weekId,
    filename: `${folderName}/${orderFile}`,
    listingFiles: validListingFiles,
    columns,
    rows: snapshotRows,
    notes: nextNotes,
  })

  const finalWeeks = filtered.slice()
  finalWeeks.push({
    id: weekId,
    filename: `${folderName}/${orderFile}`,
    startDate,
    endDate,
    rowCount: snapshotRows.length,
    listingFiles: validListingFiles,
    importedAt: new Date().toISOString(),
  })
  finalWeeks.sort(cmpWeekByDateDesc)
  writeJson(`${DATA_DIR}/weeks.json`, finalWeeks)

  return {
    weekId,
    folderName,
    orderFile,
    listingFiles: validListingFiles,
    rowCount: snapshotRows.length,
    newShops,
    newAsins,
    listingMatched: listingMap.size,
    unmatchedByShop,
    unmatchedTotal,
    listingOnlyAddedByShop,
    listingOnlyAddedTotal,
    listingOnlyUnresolvedByFile,
    listingOnlyUnresolvedTotal,
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
          if (url === '/dev-session' && req.method === 'GET') {
            return sendJson(res, 200, { sessionId: DEV_SESSION_ID })
          }

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
              sellable: body.sellable ?? '',
              inbound: body.inbound ?? '',
              unsellable: body.unsellable ?? '',
              reserved: body.reserved ?? '',
              fbaTotal: body.fbaTotal ?? '',
              monthSales: body.monthSales ?? '',
              monthRevenue: body.monthRevenue ?? '',
              monthOrders: body.monthOrders ?? '',
              dailySales: body.dailySales ?? '',
              vineGiftSales: body.vineGiftSales ?? '',
              packageSize: body.packageSize ?? '',
              packageType: body.packageType ?? '',
              itemWeight: body.itemWeight ?? '',
              productImage: body.productImage ?? '',
              localWarehouse:
                body.localWarehouse == null || body.localWarehouse === ''
                  ? 0
                  : Number(body.localWarehouse),
              orderedQty:
                body.orderedQty == null || body.orderedQty === '' ? 0 : Number(body.orderedQty),
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
          if (url === '/export/local-warehouse-pdf' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            const rows = Array.isArray(body.rows) ? body.rows : []
            if (!rows.length) return sendJson(res, 400, { error: 'rows required' })

            const weekId = String(body.weekId || '').trim() || '周次'
            const shopName = String(body.shopName || '').trim() || '店铺'
            const safeWeek = sanitizeFilename(weekId, '周次')
            const safeShop = sanitizeFilename(shopName, '店铺')
            const filename = `${safeWeek}-${safeShop}-本地仓库.pdf`

            const pdfBuffer = await generateLocalWarehousePdfBuffer({
              weekId,
              shopName,
              rows,
            })

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
            return res.end(pdfBuffer)
          }

          if (url === '/scan' && req.method === 'GET') {
            const bundles = scanWeekBundles()
            const weeks = readImportedWeeksFallback()
            const importedMap = new Map(weeks.map((w) => [w.id, w]))

            const listEquals = (a, b) => {
              const sa = Array.isArray(a) ? a.slice().sort((x, y) => String(x).localeCompare(String(y))) : []
              const sb = Array.isArray(b) ? b.slice().sort((x, y) => String(x).localeCompare(String(y))) : []
              if (sa.length !== sb.length) return false
              for (let i = 0; i < sa.length; i++) {
                if (String(sa[i]) !== String(sb[i])) return false
              }
              return true
            }

            const hasSourceChangedByMtime = (bundle, importedAt) => {
              if (!bundle?.folderName || !importedAt) return false
              const importedTs = Date.parse(importedAt)
              if (!Number.isFinite(importedTs)) return false

              const files = [bundle.orderFile, ...(bundle.listingFiles || [])].filter(Boolean)
              for (const file of files) {
                const full = fp(XLSX_DIR, bundle.folderName, file)
                try {
                  const st = statSync(full)
                  if (st.mtimeMs > importedTs) return true
                } catch {
                  // ignore
                }
              }
              return false
            }

            const unimported = []
            for (const b of bundles) {
              const imported = importedMap.get(b.weekId)
              if (!imported) {
                unimported.push({ ...b, importMode: 'new', importHint: '新周数据' })
                continue
              }

              const currentOrderPath = `${b.folderName}/${b.orderFile}`
              const importedOrderPath = String(imported.filename || '')
              const importedListingFiles = Array.isArray(imported.listingFiles)
                ? imported.listingFiles
                : []

              let changed = false
              let hint = ''

              if (importedOrderPath && importedOrderPath !== currentOrderPath) {
                changed = true
                hint = '订单文件已变化'
              }

              if (!changed && importedListingFiles.length) {
                if (!listEquals(importedListingFiles, b.listingFiles || [])) {
                  changed = true
                  hint = 'Listing 文件有新增或变化'
                }
              }

              if (!changed && hasSourceChangedByMtime(b, imported.importedAt)) {
                changed = true
                hint = '源文件时间晚于上次导入'
              }

              if (changed) {
                unimported.push({
                  ...b,
                  importMode: 'reimport',
                  importHint: hint || '源文件已变化，建议重新导入',
                })
              }
            }

            return sendJson(res, 200, {
              unimported,
              imported: weeks,
              scanSignature: buildDataScanSignature(),
            })
          }
          if (url === '/scan-signature' && req.method === 'GET') {
            return sendJson(res, 200, { scanSignature: buildDataScanSignature() })
          }
          if (url === '/import' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            const weekIds = Array.isArray(body.weekIds)
              ? body.weekIds
              : body.weekId
                ? [body.weekId]
                : []
            if (!weekIds.length) {
              return sendJson(res, 400, { error: 'weekIds required' })
            }
            const bundleMap = new Map(scanWeekBundles().map((b) => [b.weekId, b]))
            const results = []
            for (const weekId of weekIds) {
              try {
                const bundle = bundleMap.get(weekId)
                if (!bundle) throw new Error(`未找到周目录：${weekId}`)
                if (!bundle.listingFiles || !bundle.listingFiles.length) {
                  throw new Error('缺少 Listing销售库存 文件')
                }
                results.push(importWeekBundle(bundle))
              } catch (e) {
                results.push({ weekId, error: String(e?.message || e) })
              }
            }
            return sendJson(res, 200, { results })
          }

          if (url === '/import/resolve-listing-only' && req.method === 'POST') {
            const body = (await readBody(req)) || {}
            const weekId = String(body.weekId || '').trim()
            const assignments = Array.isArray(body.assignments) ? body.assignments : []
            if (!weekId) return sendJson(res, 400, { error: 'weekId required' })
            if (!assignments.length) return sendJson(res, 400, { error: 'assignments required' })

            const bundleMap = new Map(scanWeekBundles().map((b) => [b.weekId, b]))
            const bundle = bundleMap.get(weekId)
            if (!bundle) return sendJson(res, 404, { error: 'week bundle not found' })

            const shops = readJson(`${DATA_DIR}/shops.json`, [])
            const shopNameById = new Map(shops.map((s) => [s.id, s.name]))
            const shopIdSet = new Set(shops.map((s) => s.id))

            const listingData = readListingDataForBundle(bundle.folderName, bundle.listingFiles || [])
            const listingMap = listingData.listingMap

            const applyListingRow = (product, listingRow) => {
              if (!listingRow) return false
              const before = JSON.stringify({
                fnsku: product.fnsku,
                name: product.name,
                monthSales: product.monthSales,
                monthRevenue: product.monthRevenue,
                monthOrders: product.monthOrders,
                dailySales: product.dailySales,
                vineGiftSales: product.vineGiftSales,
                sellable: product.sellable,
                inbound: product.inbound,
                unsellable: product.unsellable,
                reserved: product.reserved,
                fbaTotal: product.fbaTotal,
                packageSize: product.packageSize,
                packageType: product.packageType,
                itemWeight: product.itemWeight,
                productImage: product.productImage,
                productImages: product.productImages,
                localWarehouse: product.localWarehouse,
                orderedQty: product.orderedQty,
              })

              product.fnsku = listingRow.fnsku
              if (listingRow.name) product.name = listingRow.name
              product.monthSales = listingRow.monthSales
              product.monthRevenue = listingRow.monthRevenue
              product.monthOrders = listingRow.monthOrders
              product.dailySales = listingRow.dailySales
              product.vineGiftSales = listingRow.vineGiftSales
              product.sellable = listingRow.sellable
              product.inbound = listingRow.inbound
              product.unsellable = listingRow.unsellable
              product.reserved = listingRow.reserved
              product.fbaTotal = listingRow.fbaTotal
              product.packageSize = listingRow.packageSize
              product.packageType = listingRow.packageType
              product.itemWeight = listingRow.itemWeight
              product.productImage = listingRow.productImage
              product.productImages = Array.isArray(listingRow.productImages)
                ? listingRow.productImages
                : []
              if (product.localWarehouse == null || product.localWarehouse === '') product.localWarehouse = 0
              if (product.orderedQty == null || product.orderedQty === '') product.orderedQty = 0

              const after = JSON.stringify({
                fnsku: product.fnsku,
                name: product.name,
                monthSales: product.monthSales,
                monthRevenue: product.monthRevenue,
                monthOrders: product.monthOrders,
                dailySales: product.dailySales,
                vineGiftSales: product.vineGiftSales,
                sellable: product.sellable,
                inbound: product.inbound,
                unsellable: product.unsellable,
                reserved: product.reserved,
                fbaTotal: product.fbaTotal,
                packageSize: product.packageSize,
                packageType: product.packageType,
                itemWeight: product.itemWeight,
                productImage: product.productImage,
                productImages: product.productImages,
                localWarehouse: product.localWarehouse,
                orderedQty: product.orderedQty,
              })
              return before !== after
            }

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

            const findAsinBucket = (asin) => {
              for (const [shopId, bucket] of shopBuckets) {
                if (bucket.map.has(asin)) return { shopId, bucket, product: bucket.map.get(asin) }
              }
              for (const s of shops) {
                const b = ensureBucket(s.id)
                if (b.map.has(asin)) return { shopId: s.id, bucket: b, product: b.map.get(asin) }
              }
              return null
            }

            const added = []
            const unresolved = []
            const seen = new Set()

            for (const item of assignments) {
              const asin = String(item?.asin || '').trim()
              const shopId = String(item?.shopId || '').trim()
              if (!asin || !shopId) continue
              const uniq = `${asin}@@${shopId}`
              if (seen.has(uniq)) continue
              seen.add(uniq)

              if (!shopIdSet.has(shopId)) {
                unresolved.push({ asin, reason: 'shopId 不存在' })
                continue
              }

              const listingRow = listingMap.get(asin)
              if (!listingRow) {
                unresolved.push({ asin, reason: 'Listing 文件中未找到该 ASIN' })
                continue
              }

              const located = findAsinBucket(asin)
              if (located) {
                if (applyListingRow(located.product, listingRow)) located.bucket.changed = true
                if (located.product.lastSeenWeek !== weekId) {
                  located.product.lastSeenWeek = weekId
                  located.bucket.changed = true
                }
                added.push({ asin, shopId: located.shopId, shopName: shopNameById.get(located.shopId) || located.shopId, mode: 'updated' })
                continue
              }

              const target = ensureBucket(shopId)
              const product = {
                asin,
                parentAsin: asin,
                fnsku: listingRow.fnsku,
                name: listingRow.name || '',
                category: '新品',
                restockCycle: 2,
                sellable: listingRow.sellable,
                inbound: listingRow.inbound,
                unsellable: listingRow.unsellable,
                reserved: listingRow.reserved,
                fbaTotal: listingRow.fbaTotal,
                localWarehouse: 0,
                orderedQty: 0,
                monthSales: listingRow.monthSales,
                monthRevenue: listingRow.monthRevenue,
                monthOrders: listingRow.monthOrders,
                dailySales: listingRow.dailySales,
                vineGiftSales: listingRow.vineGiftSales,
                packageSize: listingRow.packageSize,
                packageType: listingRow.packageType,
                itemWeight: listingRow.itemWeight,
                productImage: listingRow.productImage,
                productImages: Array.isArray(listingRow.productImages)
                  ? listingRow.productImages
                  : [],
                firstSeenWeek: weekId,
                lastSeenWeek: weekId,
              }
              target.map.set(asin, product)
              target.changed = true
              added.push({ asin, shopId, shopName: shopNameById.get(shopId) || shopId, mode: 'created' })
            }

            for (const [shopId, bucket] of shopBuckets) {
              if (bucket.changed) writeProductsByShop(shopId, Array.from(bucket.map.values()))
            }

            const weekSnapshotPath = `${WEEKS_DIR}/${weekId}.json`
            const weekSnapshot = readJson(weekSnapshotPath, null)
            if (
              weekSnapshot &&
              Array.isArray(weekSnapshot.columns) &&
              Array.isArray(weekSnapshot.rows)
            ) {
              const colIdx = {}
              weekSnapshot.columns.forEach((c, i) => {
                colIdx[c] = i
              })
              const existingAsins = new Set(
                weekSnapshot.rows
                  .map((r) => String(r?.asin || '').trim())
                  .filter(Boolean),
              )
              let nextRowIndex =
                weekSnapshot.rows.reduce((maxIdx, r) => {
                  const n = Number(r?._rowIndex)
                  return Number.isFinite(n) ? Math.max(maxIdx, n) : maxIdx
                }, -1) + 1

              const shopById = new Map(shops.map((s) => [s.id, s]))
              let snapshotChanged = false
              for (const item of added) {
                const asin = String(item?.asin || '').trim()
                if (!asin || existingAsins.has(asin)) continue

                const listingRow = listingMap.get(asin) || {}
                const shop = shopById.get(item.shopId) || {}
                const values = Array(weekSnapshot.columns.length).fill('')

                if (colIdx['ASIN'] != null) values[colIdx['ASIN']] = asin
                if (colIdx['FNSKU'] != null) values[colIdx['FNSKU']] = listingRow.fnsku || ''
                if (colIdx['父ASIN'] != null) values[colIdx['父ASIN']] = asin
                if (colIdx['店铺'] != null) values[colIdx['店铺']] = shop.name || item.shopName || ''
                if (colIdx['国家'] != null) values[colIdx['国家']] = shop.country || ''
                if (colIdx['品名'] != null) values[colIdx['品名']] = listingRow.name || ''
                if (colIdx['分类'] != null) values[colIdx['分类']] = '新品'

                weekSnapshot.rows.push({ asin, values, _rowIndex: nextRowIndex++ })
                existingAsins.add(asin)
                snapshotChanged = true
              }

              if (snapshotChanged) writeJson(weekSnapshotPath, weekSnapshot)
            }

            const addedByShop = Array.from(
              added.reduce((acc, item) => {
                if (!acc.has(item.shopName)) acc.set(item.shopName, [])
                acc.get(item.shopName).push(item.asin)
                return acc
              }, new Map()),
            )
              .map(([shopName, asins]) => ({
                shopName,
                count: asins.length,
                asins: asins.slice().sort((a, b) => a.localeCompare(b)),
              }))
              .sort((a, b) => b.count - a.count || a.shopName.localeCompare(b.shopName))

            return sendJson(res, 200, {
              weekId,
              addedCount: added.length,
              addedByShop,
              unresolved,
            })
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
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
})


