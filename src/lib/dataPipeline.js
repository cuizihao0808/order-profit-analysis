export function normalizeNumber(value, fallback = '') {
  if (value == null || value === '') return fallback
  const n = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : fallback
}

export function normalizeInventoryProduct(product) {
  const next = { ...product }
  next.fnsku = next.fnsku == null ? '' : String(next.fnsku).trim()
  if (next.fbaTotal == null || next.fbaTotal === '') {
    next.fbaTotal = normalizeNumber(next.stock, '')
  } else {
    next.fbaTotal = normalizeNumber(next.fbaTotal, '')
  }
  next.sellable = normalizeNumber(next.sellable, '')
  next.inbound = normalizeNumber(next.inbound, '')
  next.unsellable = normalizeNumber(next.unsellable, '')
  next.reserved = normalizeNumber(next.reserved, '')
  next.localWarehouse = normalizeNumber(next.localWarehouse, 0)
  next.orderedQty = normalizeNumber(next.orderedQty, 0)
  next.monthSales = normalizeNumber(next.monthSales, '')
  next.monthRevenue = normalizeNumber(next.monthRevenue, '')
  next.monthOrders = normalizeNumber(next.monthOrders, '')
  next.dailySales = normalizeNumber(next.dailySales, '')
  next.vineGiftSales = normalizeNumber(next.vineGiftSales, '')

  const legacyPackageSize =
    (next.packageSize1 == null ? '' : String(next.packageSize1)) ||
    (next.packageSize2 == null ? '' : String(next.packageSize2))
  const legacyPackageType =
    (next.packageType1 == null ? '' : String(next.packageType1)) ||
    (next.packageType2 == null ? '' : String(next.packageType2))

  next.packageSize = next.packageSize == null ? legacyPackageSize : String(next.packageSize)
  next.packageType = next.packageType == null ? legacyPackageType : String(next.packageType)
  next.itemWeight = normalizeNumber(next.itemWeight, '')
  const normalizedImages = Array.isArray(next.productImages)
    ? next.productImages
        .map((x) => String(x == null ? '' : x).trim())
        .filter(Boolean)
    : []
  const normalizedProductImage = String(next.productImage == null ? '' : next.productImage).trim()
  if (normalizedProductImage && !normalizedImages.includes(normalizedProductImage)) {
    normalizedImages.unshift(normalizedProductImage)
  }
  next.productImages = normalizedImages
  next.productImage = normalizedProductImage || normalizedImages[0] || ''
  return next
}

function collectListingImageUrls(values, listingColIdx) {
  const cols = Object.entries(listingColIdx)
    .filter(([name]) => /^产品图片(?:\d+)?$/.test(name))
    .sort(([a], [b]) => {
      const ma = a.match(/^产品图片(\d+)?$/)
      const mb = b.match(/^产品图片(\d+)?$/)
      const na = ma?.[1] ? Number(ma[1]) : 0
      const nb = mb?.[1] ? Number(mb[1]) : 0
      return na - nb
    })

  const urls = cols
    .map(([, idx]) => String(values[idx] ?? '').trim())
    .filter(Boolean)

  return Array.from(new Set(urls))
}

export function parseWeekIdFromFolder(folderName) {
  const m = String(folderName || '').match(/(\d+)\s*周/)
  if (m) return `${m[1]}周`
  return String(folderName || '').trim()
}

export function parseDatesFromFilename(name) {
  const m = String(name || '').match(/(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})/)
  if (!m) return { startDate: '', endDate: '' }
  return { startDate: m[1], endDate: m[2] }
}

export function choosePreferredFile(files) {
  if (!files.length) return ''
  const score = (name) => {
    let s = 0
    if (/副本/i.test(name)) s += 20
    if (/\(\d+\)/.test(name)) s += 12
    s += name.length * 0.01
    return s
  }
  return files.slice().sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0]
}

export function isOrderProfitFile(name) {
  return /订单利润.*\.xlsx$/i.test(name)
}

export function isListingStockFile(name) {
  return /^Listing销售库存.*\.(csv|xlsx)$/i.test(name)
}

export function buildListingRowRecord(values, listingColIdx) {
  const productImages = collectListingImageUrls(values, listingColIdx)
  return {
    fnsku: String(values[listingColIdx['FNSKU']] ?? '').trim(),
    name: String(values[listingColIdx['产品中文名']] ?? '').trim(),
    monthSales: normalizeNumber(values[listingColIdx['销量']], ''),
    monthRevenue: normalizeNumber(values[listingColIdx['销售额']], ''),
    monthOrders: normalizeNumber(values[listingColIdx['订单数']], ''),
    dailySales: normalizeNumber(values[listingColIdx['日均销量']], ''),
    vineGiftSales: normalizeNumber(values[listingColIdx['Vine赠品销量(已扣除)']], ''),
    sellable: normalizeNumber(values[listingColIdx['可售']], ''),
    inbound: normalizeNumber(values[listingColIdx['入库中']], ''),
    unsellable: normalizeNumber(values[listingColIdx['不可售']], ''),
    reserved: normalizeNumber(values[listingColIdx['预留']], ''),
    fbaTotal: normalizeNumber(values[listingColIdx['FBA总量']], ''),
    packageSize:
      String(values[listingColIdx['包装尺寸(长×宽×高cm)']] ?? '').trim() ||
      String(values[listingColIdx['包装尺寸1(长×宽×高cm)']] ?? '').trim() ||
      String(values[listingColIdx['包装尺寸2(长×宽×高cm)']] ?? '').trim(),
    packageType:
      String(values[listingColIdx['包装类型']] ?? '').trim() ||
      String(values[listingColIdx['包装类型1']] ?? '').trim() ||
      String(values[listingColIdx['包装类型2']] ?? '').trim(),
    itemWeight: normalizeNumber(values[listingColIdx['单品重量(g)']], ''),
    productImage: productImages[0] || '',
    productImages,
  }
}
