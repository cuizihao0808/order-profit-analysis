/**
 * 页面级测试的公共夹具：一份最小的店铺 / 产品 / 两周快照 / 补货计划，
 * 以及一个有状态的模拟 /api（写操作会真的改动内存里的数据，并记录每个请求）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { vi } from 'vitest'
import App from '../../src/App.vue'
import { buildRestockBasis, collectRestockHistories } from '../../src/lib/restockRules.js'

export const TZH = 'TZH-主店二号'
export const CZH = 'CZH-主店一号'

const COLUMNS = ['ASIN', '父ASIN', '店铺', '品名', '销量', '销售额', '毛利润', '采购成本', '广告费率', '退货率', '退款率']
const row = (asin, parent, shop, sales, profit, cost, adRate = '5%') => ({
  asin,
  values: [asin, parent, shop, '', sales, '100', profit, cost, adRate, '0%', '0%'],
})

function fixtures() {
  return {
    shops: [
      { id: 'shop-1', name: CZH, mdExportName: '一号店' },
      { id: 'shop-2', name: TZH, mdExportName: '二号店' },
    ],
    weeks: [
      { id: '2周', startDate: '2026-10-04', endDate: '2026-10-10', rowCount: 5, filename: '2周/订单利润.xlsx' },
      { id: '1周', startDate: '2026-09-27', endDate: '2026-10-03', rowCount: 1, filename: '1周/订单利润.xlsx' },
    ],
    snapshots: {
      '2周': {
        columns: COLUMNS,
        rows: [
          row('B0A1', 'B0P1', TZH, '10', '50', '-20', '20%'),
          row('B0A2', 'B0P1', TZH, '5', '30', '-10'),
          row('B0B1', '', TZH, '8', '-5', '-10'),
          row('B0C1', '', CZH, '3', '100', '-40'),
          row('B0D1', '', TZH, '1', '1', '-1'),
        ],
        notes: { B0A1: '10整箱' },
      },
      '1周': { columns: COLUMNS, rows: [row('B0A1', 'B0P1', TZH, '5', '20', '-20')], notes: {} },
    },
    products: [
      {
        asin: 'B0A1',
        parentAsin: 'B0P1',
        shopId: 'shop-2',
        name: '黑垫高块',
        productTitle: 'Treadmill Blocks',
        category: '新品',
        fbaTotal: 10,
        restockCycle: 2,
        monthSales: 40,
        localWarehouse: 0,
        orderedQty: 30,
        packageType: '飞机盒',
        packageSize: '20×15×10',
        packageCost1: 0.87,
        fnsku: 'X00A1',
        itemWeight: 600,
        amazonMainImage: 'https://img.test/a1-main.jpg',
        productImages: ['https://img.test/a1-main.jpg', 'https://img.test/a1-2.jpg'],
        listingDetailImages: ['https://img.test/a1-detail.jpg'],
      },
      { asin: 'B0A2', parentAsin: 'B0P1', shopId: 'shop-2', name: '白垫高块', category: '正常', fbaTotal: 999, restockCycle: 2, localWarehouse: 12 },
      { asin: 'B0B1', shopId: 'shop-2', name: '收纳包', category: '正常', fbaTotal: 500, restockCycle: 2 },
      { asin: 'B0C1', shopId: 'shop-1', name: '笔记本', category: '正常', fbaTotal: 500, restockCycle: 2, localWarehouse: 5, packageType: '磨砂袋' },
      { asin: 'B0D1', shopId: 'shop-2', name: '已放弃', category: '放弃' },
    ],
    plan: {
      shop: 'TZH',
      file: 'TZH补货清单.csv',
      updatedAt: '2026-10-10T04:00:00.000Z',
      labels: {},
      batches: [
        { key: '10/17', date: '2026-10-17', note: '' },
        { key: '10/24', date: '2026-10-24', note: '' },
      ],
      weekly: { amount: {}, weight: {} },
      weeklyNotes: {},
      items: [
        { sku: 'TR-A1', asin: 'B0A1', name: '黑垫高块', qtyByBatch: { '10/17': 30, '10/24': 20 }, preHolidayTotal: 50 },
        { sku: 'TR-B1', asin: 'B0B1', name: '收纳包', qtyByBatch: { '10/24': 8 }, preHolidayTotal: 8 },
        { sku: 'TR-A2', asin: 'B0A2', name: '白垫高块', qtyByBatch: {}, preHolidayTotal: 0 },
      ],
    },
    shipped: {},
    restockBasisOverride: {}, // 'shopId::ASIN' → basis，测试里直接塞特殊情况（停滞等）
    scan: { unimported: [{ weekId: '3周', importMode: 'new', folderName: '3周', listingFiles: ['listing.csv'] }], imported: [] },
  }
}

/** 和中间件一样，用全部周快照算每个「店铺 + ASIN」的月销量 */
function restockBasis(db) {
  const shopIdOf = (name) => db.shops.find((s) => s.name === name)?.id || ''
  const histories = collectRestockHistories({ weeks: db.weeks, snapshots: db.snapshots, listings: {}, shopIdOf })
  const basis = {}
  for (const [key, history] of Object.entries(histories)) {
    const b = buildRestockBasis(history)
    if (b) basis[key] = b
  }
  return basis
}

function respond(data, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
    blob: async () => new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
  })
}

/**
 * 有状态的模拟 API。fail 里放「METHOD 路径前缀」即可让对应请求返回 500。
 */
export function createApi() {
  const db = fixtures()
  const requests = []
  const fail = new Set()

  function handle(method, path, body) {
    const key = `${method} ${path}`
    if ([...fail].some((prefix) => key.startsWith(prefix))) return respond({ error: '服务器出错了' }, 500)

    if (path === '/api/dev-session') return respond({ sessionId: 'test' })
    if (path === '/api/restock-config') return respond({})
    if (path === '/api/restock-basis') {
      return respond({ weeks: db.weeks.map((w) => w.id), basis: { ...restockBasis(db), ...db.restockBasisOverride } })
    }
    if (path === '/api/weeks' && method === 'GET') return respond(db.weeks)
    if (path === '/api/products' && method === 'GET') return respond(db.products)
    if (path === '/api/shops' && method === 'GET') return respond(db.shops)
    if (path === '/api/replenishment') return respond({ plans: [db.plan], warnings: [], shipped: db.shipped })
    if (path === '/api/scan') return respond(db.scan)

    const note = path.match(/^\/api\/weeks\/([^/]+)\/notes\/([^/]+)$/)
    if (note && method === 'PUT') {
      db.snapshots[note[1]].notes[note[2]] = body.note
      return respond({ ok: true })
    }
    const week = path.match(/^\/api\/weeks\/([^/]+)$/)
    if (week && method === 'GET') return db.snapshots[week[1]] ? respond(db.snapshots[week[1]]) : respond({ error: 'not found' }, 404)
    if (week && method === 'DELETE') {
      db.weeks = db.weeks.filter((w) => w.id !== week[1])
      return respond({ ok: true })
    }

    const product = path.match(/^\/api\/products\/([^/]+)$/)
    if (product && method === 'PUT') {
      const target = db.products.find((p) => p.asin === product[1] && (!body.shopId || p.shopId === body.shopId))
      Object.assign(target, body)
      return respond(target)
    }
    if (product && method === 'DELETE') {
      db.products = db.products.filter((p) => p.asin !== product[1])
      return respond({ ok: true })
    }
    if (path === '/api/products' && method === 'POST') {
      if (db.products.some((p) => p.asin === body.asin)) return respond({ error: 'ASIN 已存在' }, 409)
      db.products.push(body)
      return respond(body)
    }

    const shop = path.match(/^\/api\/shops\/([^/]+)$/)
    if (shop && method === 'PUT') {
      Object.assign(db.shops.find((s) => s.id === shop[1]), body)
      return respond({ ok: true })
    }
    if (shop && method === 'DELETE') {
      db.shops = db.shops.filter((s) => s.id !== shop[1])
      return respond({ ok: true })
    }
    if (path === '/api/shops' && method === 'POST') {
      db.shops.push({ id: `shop-${db.shops.length + 1}`, ...body })
      return respond({ ok: true })
    }

    if (path === '/api/replenishment/shipped' && method === 'PUT') {
      const next = { ...(db.shipped[body.shop] || {}) }
      for (const { asin, date } of body.entries) {
        next[asin] = { ...(next[asin] || {}) }
        if (body.shipped) next[asin][date] = 'now'
        else delete next[asin][date]
      }
      db.shipped = { ...db.shipped, [body.shop]: next }
      return respond({ shop: body.shop, shipped: next })
    }

    if (path === '/api/import' && method === 'POST') {
      db.weeks = [{ id: '3周', startDate: '2026-10-11', endDate: '2026-10-17', rowCount: 1 }, ...db.weeks]
      db.snapshots['3周'] = { ...db.snapshots['2周'], notes: {} }
      db.scan = { unimported: [], imported: db.weeks }
      return respond({
        results: [
          {
            weekId: '3周',
            listingOnlyUnresolvedTotal: 1,
            listingOnlyUnresolvedByFile: [{ listingFile: 'listing.csv', asins: ['B0NEW'] }],
            listingOnlyAddedByShop: [],
          },
          { weekId: '4周', error: '缺少 Listing销售库存 文件' },
        ],
      })
    }
    if (path === '/api/import/resolve-listing-only' && method === 'POST') {
      return respond({ addedCount: 1, addedByShop: [{ shopName: TZH, count: 1, asins: ['B0NEW'] }] })
    }
    if (path === '/api/export/local-warehouse-pdf' && method === 'POST') return respond('%PDF')

    throw new Error(`unexpected request ${key}`)
  }

  const fetchMock = vi.fn((url, init = {}) => {
    const method = init.method || 'GET'
    const path = decodeURIComponent(String(url))
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ method, path, body })
    return handle(method, path, body)
  })

  return {
    db,
    fetchMock,
    fail,
    /** 某类写请求的 body 列表，例如 calls('PUT', '/api/products/B0A1') */
    calls: (method, path) => requests.filter((r) => r.method === method && r.path === path).map((r) => r.body),
    requests,
  }
}

export async function mountApp() {
  const wrapper = mount(App, { global: { plugins: [ElementPlus] }, attachTo: document.body })
  await settle()
  return wrapper
}

export async function settle() {
  await flushPromises()
  await vi.dynamicImportSettled()
  await flushPromises()
}

export const asins = (wrapper) => wrapper.findAll('tbody .asin-link').map((a) => a.text())

export function rowOf(wrapper, asin) {
  return wrapper.findAll('tbody tr').find((tr) => tr.find('.asin-link').exists() && tr.find('.asin-link').text() === asin)
}

/** 统一的浏览器桩：固定今天、剪贴板、confirm / alert、下载 */
export function stubBrowser(api) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 14, 9, 0))
  localStorage.clear()
  vi.stubGlobal('fetch', api.fetchMock)
  const confirm = vi.fn(() => true)
  const alert = vi.fn()
  vi.stubGlobal('confirm', confirm)
  vi.stubGlobal('alert', alert)
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  URL.createObjectURL = vi.fn(() => 'blob:pdf')
  URL.revokeObjectURL = vi.fn()
  return { confirm, alert, writeText }
}
