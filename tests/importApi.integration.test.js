import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function toJson(data) {
  return JSON.stringify(data, null, 2) + '\n'
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, toJson(data), 'utf8')
}

async function writeOrderWorkbook(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const columns = ['ASIN', '父ASIN', '店铺', '国家', '品名', '分类']
  const rows = [
    ['B0HBKJFMMR', 'B0HBKJFMMR', 'TZH-主店二号', '美国', '', '正常'],
    ['B0BASESHOP2', 'B0BASESHOP2', 'TZH-主店二号', '美国', '', '正常'],
  ]
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, filePath)
}

async function writeListingWorkbook(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const header = [
    '店铺',
    'ASIN',
    'FNSKU',
    '商品标题',
    '产品中文名',
    '销量',
    '销售额',
    '订单数',
    '日均销量',
    'Vine赠品销量(已扣除)',
    '可售',
    '入库中',
    '不可售',
    '预留',
    'FBA总量',
    '包装尺寸1(长×宽×高cm)',
    '包装类型1',
    '单品重量(g)',
    '图片URL',
    '产品图片1',
    '销售数据截止',
    '库存数据截止',
  ]

  const rows = [
    [
      'CZH-主店一号',
      'B0HBKJFMMR',
      'X0057PXLYB',
      '5 Pack Replacement Silicone Bands Compatible with Fitbit Air',
      '硅胶表带',
      '0',
      '0.00',
      '0',
      '0.00',
      '0',
      '0',
      '200',
      '0',
      '0',
      '200',
      '',
      '',
      '',
      'https://m.media-amazon.com/images/I/41Cw77MsklL.jpg',
      '',
      '2026-08-09',
      '2026-08-10T06:00:03.234Z',
    ],
    [
      'CZH-主店一号',
      'B0ONLYLIST',
      'X000ONLY1',
      'Listing only title from shop1',
      '仅Listing产品',
      '1',
      '10.00',
      '1',
      '0.03',
      '0',
      '1',
      '0',
      '0',
      '0',
      '1',
      '',
      '',
      '',
      'https://m.media-amazon.com/images/I/only1.jpg',
      '',
      '2026-08-09',
      '2026-08-10T06:00:03.234Z',
    ],
    [
      'LPH-主店三号-US',
      'B0ALIASROW',
      'X000ALIAS',
      'Alias shop title',
      '别名店铺产品',
      '1',
      '5.00',
      '1',
      '0.03',
      '0',
      '1',
      '0',
      '0',
      '0',
      '1',
      '',
      '',
      '',
      'https://m.media-amazon.com/images/I/alias.jpg',
      '',
      '2026-08-09',
      '2026-08-10T06:00:03.234Z',
    ],
    [
      'TZH-主店二号',
      'B0BASESHOP2',
      'X000SHOP2',
      'Shop2 non-amazon image',
      '二号店样例',
      '1',
      '10.00',
      '1',
      '0.03',
      '0',
      '1',
      '0',
      '0',
      '0',
      '1',
      '',
      '',
      '',
      'https://example.com/not-amazon.jpg',
      'https://cdn.example.com/detail.jpg',
      '2026-08-09',
      '2026-08-10T06:00:03.234Z',
    ],
  ]

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, filePath)
}

async function writeWorkbookWithoutAsin(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([['店铺', '品名'], ['测试店', '测试产品']])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, filePath)
}

function getColIndex(columns, name) {
  const idx = columns.indexOf(name)
  if (idx >= 0) return idx
  throw new Error(`column not found: ${name}`)
}

describe('import api integration', () => {
  let tmpRoot = ''
  let previousCwd = ''
  let viteServer = null
  let httpServer = null
  let baseUrl = ''

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'opa-import-api-'))

    await writeJson(path.join(tmpRoot, 'src/data/shops.json'), [
      { id: 'shop-1', name: 'CZH-主店一号', country: '美国', note: '' },
      { id: 'shop-2', name: 'TZH-主店二号', country: '美国', note: '' },
      { id: 'shop-3', name: 'LPH-主店三号', country: '美国', note: '' },
    ])
    await writeJson(path.join(tmpRoot, 'src/data/weeks.json'), [])
    await writeJson(path.join(tmpRoot, 'src/data/products/shop-1.json'), [])
    await writeJson(path.join(tmpRoot, 'src/data/products/shop-2.json'), [
      { asin: 'B0HBKJFMMR', parentAsin: 'B0HBKJFMMR', name: 'wrong shop row', category: '正常' },
      { asin: 'B0ONLYLIST', parentAsin: 'B0ONLYLIST', name: 'listing only wrong shop', category: '正常' },
      { asin: 'B0ALIASROW', parentAsin: 'B0ALIASROW', name: 'alias wrong shop', category: '正常' },
    ])
    await writeJson(path.join(tmpRoot, 'src/data/products/shop-3.json'), [])
    await writeJson(path.join(tmpRoot, 'src/data/weeks.json'), [
      {
        id: '31周',
        filename: '31周/订单利润-ASIN-2026-07-26~2026-08-01-test.xlsx',
        startDate: '2026-07-26',
        endDate: '2026-08-01',
        rowCount: 1,
        listingFiles: [],
        importedAt: '2026-08-22T00:00:00.000Z',
      },
    ])
    await writeJson(path.join(tmpRoot, 'src/data/weeks/31周.json'), {
      id: '31周',
      notes: { B0HBKJFMMR: '上一周备注' },
    })

    const folder = path.join(tmpRoot, 'public/data/32周(8-2~8-8)')
    await writeOrderWorkbook(path.join(folder, '订单利润-ASIN-2026-08-02~2026-08-08-test.xlsx'))
    await writeListingWorkbook(path.join(folder, 'Listing销售库存_2026-07-11_2026-08-09.xlsx'))

    previousCwd = process.cwd()
    process.chdir(tmpRoot)

    viteServer = await createServer({
      root: tmpRoot,
      configFile: path.join(repoRoot, 'vite.config.js'),
      logLevel: 'silent',
      server: { middlewareMode: true },
    })

    httpServer = createHttpServer(viteServer.middlewares)
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const addr = httpServer.address()
    baseUrl = `http://127.0.0.1:${addr.port}`
  }, 30000)

  afterAll(async () => {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve))
    }
    if (viteServer) {
      await viteServer.close()
    }
    if (previousCwd) process.chdir(previousCwd)
  })

  it('validates shop and product CRUD, including an explicit cross-shop move', async () => {
    const missingName = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(missingName.status).toBe(400)
    const unsafeShop = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '../escape', name: '非法店铺' }),
    })
    expect(unsafeShop.status).toBe(400)

    const createdShop = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '测试店铺', country: '美国' }),
    })
    expect(createdShop.status).toBe(201)
    const createdShopData = await createdShop.json()
    const updatedShop = await fetch(`${baseUrl}/api/shops/${createdShopData.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '已更新' }),
    })
    expect((await updatedShop.json()).note).toBe('已更新')
    const duplicateShop = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '测试店铺' }),
    })
    expect(duplicateShop.status).toBe(409)

    const missingAsin = await fetch(`${baseUrl}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(missingAsin.status).toBe(400)
    const createdProduct = await fetch(`${baseUrl}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asin: 'B0CRUD', name: '待迁移产品', shopId: 'shop-1' }),
    })
    expect(createdProduct.status).toBe(201)
    const duplicateProduct = await fetch(`${baseUrl}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asin: 'B0CRUD', shopId: 'shop-2' }),
    })
    expect(duplicateProduct.status).toBe(409)

    const moved = await fetch(`${baseUrl}/api/products/B0CRUD`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-2', name: '已迁移产品' }),
    })
    expect(moved.status).toBe(200)
    expect((await moved.json()).shopId).toBe('shop-2')
    const products = await (await fetch(`${baseUrl}/api/products`)).json()
    expect(products.filter((product) => product.asin === 'B0CRUD')).toEqual([
      expect.objectContaining({ shopId: 'shop-2', name: '已迁移产品' }),
    ])
    const deletedProduct = await fetch(`${baseUrl}/api/products/B0CRUD`, { method: 'DELETE' })
    expect(deletedProduct.status).toBe(200)
    expect((await (await fetch(`${baseUrl}/api/products`)).json()).some((product) => product.asin === 'B0CRUD')).toBe(false)
    const deletedShop = await fetch(`${baseUrl}/api/shops/${createdShopData.id}`, { method: 'DELETE' })
    expect(deletedShop.status).toBe(200)
  })

  it('persists and clears week notes, then deletes an independent week snapshot', async () => {
    const unsafeWeek = await fetch(`${baseUrl}/api/weeks/%2E%2E%2Fshops.json`)
    expect(unsafeWeek.status).toBe(400)
    const saved = await fetch(`${baseUrl}/api/weeks/31%E5%91%A8/notes/B0NOTE`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '需要跟进' }),
    })
    expect(saved.status).toBe(200)
    const cleared = await fetch(`${baseUrl}/api/weeks/31%E5%91%A8/notes/B0NOTE`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '   ' }),
    })
    expect((await cleared.json()).note).toBe('')

    await writeJson(path.join(tmpRoot, 'src/data/weeks/99周.json'), { id: '99周', rows: [] })
    const weeks = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/weeks.json'), 'utf8'))
    await writeJson(path.join(tmpRoot, 'src/data/weeks.json'), [...weeks, { id: '99周' }])
    const deleted = await fetch(`${baseUrl}/api/weeks/99%E5%91%A8`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await fetch(`${baseUrl}/api/weeks/99%E5%91%A8`)).toHaveProperty('status', 404)
  })

  it('fixes title missing and shop mismatch through /api/import, and prevents cross-shop duplicates', async () => {
    const resp = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['32周'] }),
    })
    expect(resp.status).toBe(200)
    const payload = await resp.json()
    expect(payload.results[0].weekId).toBe('32周')
    const backups = await readdir(path.join(tmpRoot, '.opa-backups'))
    expect(backups.some((name) => name.endsWith('-import-32周'))).toBe(true)

    const week = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/weeks/32周.json'), 'utf8'))
    expect(week.notes.B0HBKJFMMR).toBe('上一周备注')
    const cols = week.columns
    const asinIdx = getColIndex(cols, 'ASIN')
    const shopIdx = getColIndex(cols, '店铺')
    const titleIdx = cols.includes('商品标题') ? getColIndex(cols, '商品标题') : getColIndex(cols, '标题')

    const rowMain = week.rows.find((r) => r.asin === 'B0HBKJFMMR')
    expect(rowMain.values[shopIdx]).toBe('CZH-主店一号')
    expect(rowMain.values[titleIdx]).toBe('5 Pack Replacement Silicone Bands Compatible with Fitbit Air')

    const rowListingOnly = week.rows.find((r) => r.asin === 'B0ONLYLIST')
    expect(rowListingOnly).toBeTruthy()
    expect(rowListingOnly.values[shopIdx]).toBe('CZH-主店一号')
    expect(rowListingOnly.values[titleIdx]).toBe('Listing only title from shop1')

    const rowAlias = week.rows.find((r) => r.asin === 'B0ALIASROW')
    expect(rowAlias).toBeTruthy()
    expect(rowAlias.values[shopIdx]).toBe('LPH-主店三号')
    expect(rowAlias.values[titleIdx]).toBe('Alias shop title')

    const shop1 = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/products/shop-1.json'), 'utf8'))
    const shop2 = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/products/shop-2.json'), 'utf8'))
    const shop3 = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/products/shop-3.json'), 'utf8'))

    expect(shop1.some((p) => p.asin === 'B0HBKJFMMR')).toBe(true)
    expect(shop1.some((p) => p.asin === 'B0ONLYLIST')).toBe(true)
    expect(shop3.some((p) => p.asin === 'B0ALIASROW')).toBe(true)

    expect(shop2.some((p) => p.asin === 'B0HBKJFMMR')).toBe(false)
    expect(shop2.some((p) => p.asin === 'B0ONLYLIST')).toBe(false)
    expect(shop2.some((p) => p.asin === 'B0ALIASROW')).toBe(false)

    const allAsins = [...shop1, ...shop2, ...shop3]
      .map((p) => String(p.asin || '').trim())
      .filter(Boolean)
    expect(new Set(allAsins).size).toBe(allAsins.length)

    const shop2Base = shop2.find((p) => p.asin === 'B0BASESHOP2')
    expect(shop2Base).toBeTruthy()
    expect(shop2Base.amazonMainImage || '').toBe('')
    expect(shop2Base.productImage).toBe('https://cdn.example.com/detail.jpg')

    week.notes.B0HBKJFMMR = '本周修改后的备注'
    await writeJson(path.join(tmpRoot, 'src/data/weeks/32周.json'), week)
    const reimportResp = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['32周'] }),
    })
    expect(reimportResp.status).toBe(200)
    const reimportedWeek = JSON.parse(await readFile(path.join(tmpRoot, 'src/data/weeks/32周.json'), 'utf8'))
    expect(reimportedWeek.notes.B0HBKJFMMR).toBe('本周修改后的备注')
  }, 30000)

  it('classifies new and changed folders, and rejects invalid import requests', async () => {
    const missingIds = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(missingIds.status).toBe(400)

    const unknown = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['不存在周'] }),
    })
    expect((await unknown.json()).results[0].error).toContain('未找到周目录')

    const newFolder = path.join(tmpRoot, 'public/data/36周')
    await writeOrderWorkbook(path.join(newFolder, '订单利润-ASIN-2026-08-30~2026-09-05-test.xlsx'))
    await writeListingWorkbook(path.join(newFolder, 'Listing销售库存_2026-08-30_2026-09-05.xlsx'))
    const changedFile = path.join(tmpRoot, 'public/data/32周(8-2~8-8)', 'Listing销售库存_2026-07-11_2026-08-09.xlsx')
    const future = new Date(Date.now() + 60_000)
    await utimes(changedFile, future, future)

    const scan = await (await fetch(`${baseUrl}/api/scan`)).json()
    expect(scan.unimported).toEqual(expect.arrayContaining([
      expect.objectContaining({ weekId: '36周', importMode: 'new' }),
      expect.objectContaining({ weekId: '32周', importMode: 'reimport' }),
    ]))

    const missingListingFolder = path.join(tmpRoot, 'public/data/37周')
    await writeOrderWorkbook(path.join(missingListingFolder, '订单利润-ASIN-2026-09-06~2026-09-12-test.xlsx'))
    const missingListing = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['37周'] }),
    })
    expect((await missingListing.json()).results[0].error).toContain('缺少 Listing销售库存')

    const invalidTableFolder = path.join(tmpRoot, 'public/data/38周')
    await writeWorkbookWithoutAsin(path.join(invalidTableFolder, '订单利润-ASIN-2026-09-13~2026-09-19-test.xlsx'))
    await writeListingWorkbook(path.join(invalidTableFolder, 'Listing销售库存_2026-09-13_2026-09-19.xlsx'))
    const invalidTable = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['38周'] }),
    })
    expect((await invalidTable.json()).results[0].error).toContain('订单利润表缺少必填列：ASIN')
  })

  it('validates unresolved listing assignments', async () => {
    const missingWeek = await fetch(`${baseUrl}/api/import/resolve-listing-only`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: [] }),
    })
    expect(missingWeek.status).toBe(400)
    const emptyAssignments = await fetch(`${baseUrl}/api/import/resolve-listing-only`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekId: '32周', assignments: [] }),
    })
    expect(emptyAssignments.status).toBe(400)
    const unresolved = await fetch(`${baseUrl}/api/import/resolve-listing-only`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekId: '32周', assignments: [{ asin: 'B0MISSING', shopId: 'missing-shop' }] }),
    })
    expect((await unresolved.json()).unresolved).toEqual([{ asin: 'B0MISSING', reason: 'shopId 不存在' }])
  })
})
