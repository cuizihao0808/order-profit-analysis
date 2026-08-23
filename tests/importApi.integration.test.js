import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
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

  it('fixes title missing and shop mismatch through /api/import, and prevents cross-shop duplicates', async () => {
    const resp = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekIds: ['32周'] }),
    })
    expect(resp.status).toBe(200)
    const payload = await resp.json()
    expect(payload.results[0].weekId).toBe('32周')

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
})
