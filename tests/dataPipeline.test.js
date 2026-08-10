import { describe, expect, it } from 'vitest'
import {
  buildListingRowRecord,
  choosePreferredFile,
  isListingStockFile,
  isOrderProfitFile,
  normalizeInventoryProduct,
  normalizeNumber,
  parseDatesFromFilename,
  parseWeekIdFromFolder,
} from '../src/lib/dataPipeline.js'

describe('dataPipeline: number normalization', () => {
  it('parses comma numbers and trims spaces', () => {
    expect(normalizeNumber(' 1,234.5 ')).toBe(1234.5)
  })

  it('returns fallback for invalid values', () => {
    expect(normalizeNumber('N/A', 0)).toBe(0)
    expect(normalizeNumber('', 7)).toBe(7)
  })
})

describe('dataPipeline: product normalization', () => {
  it('normalizes inventory and migrates legacy package fields', () => {
    const next = normalizeInventoryProduct({
      stock: '100',
      localWarehouse: '3',
      orderedQty: '',
      monthSales: '1,233',
      packageSize1: '10×20×30',
      packageType2: '纸箱',
      itemWeight: '250',
    })

    expect(next.fbaTotal).toBe(100)
    expect(next.localWarehouse).toBe(3)
    expect(next.orderedQty).toBe(0)
    expect(next.monthSales).toBe(1233)
    expect(next.packageSize).toBe('10×20×30')
    expect(next.packageType).toBe('纸箱')
    expect(next.itemWeight).toBe(250)
  })

  it('keeps explicit fbaTotal and explicit package fields', () => {
    const next = normalizeInventoryProduct({
      stock: '999',
      fbaTotal: '123',
      packageSize: 'A',
      packageType: 'B',
      productImage: ' https://img ',
    })

    expect(next.fbaTotal).toBe(123)
    expect(next.packageSize).toBe('A')
    expect(next.packageType).toBe('B')
    expect(next.productImage).toBe('https://img')
  })

  it('normalizes amazonMainImage and merges image candidates', () => {
    const next = normalizeInventoryProduct({
      amazonMainImage: ' https://m.media-amazon.com/images/I/abc.jpg ',
      productImage: 'https://detail.example/b.jpg',
      productImages: ['https://detail.example/b.jpg'],
    })

    expect(next.amazonMainImage).toBe('https://m.media-amazon.com/images/I/abc.jpg')
    expect(next.productImages[0]).toBe('https://m.media-amazon.com/images/I/abc.jpg')
    expect(next.productImages).toContain('https://detail.example/b.jpg')
    expect(next.productImages).toContain('https://m.media-amazon.com/images/I/abc.jpg')
  })
})

describe('dataPipeline: folder/file parsing', () => {
  it('parses weekId from folder', () => {
    expect(parseWeekIdFromFolder('31周 (07:26～08:01)')).toBe('31周')
    expect(parseWeekIdFromFolder('自定义周目录')).toBe('自定义周目录')
  })

  it('parses date range from filename', () => {
    expect(parseDatesFromFilename('订单利润-ASIN-2026-07-26~2026-08-01-xxx.xlsx')).toEqual({
      startDate: '2026-07-26',
      endDate: '2026-08-01',
    })
    expect(parseDatesFromFilename('bad-file')).toEqual({ startDate: '', endDate: '' })
  })

  it('selects preferred file and recognizes file types', () => {
    const files = ['Listing销售库存_2026.csv', 'Listing销售库存_2026的副本.csv']
    expect(choosePreferredFile(files)).toBe('Listing销售库存_2026.csv')
    expect(isOrderProfitFile('订单利润-ASIN-2026-07-26~2026-08-01.xlsx')).toBe(true)
    expect(isListingStockFile('Listing销售库存_2026-07.csv')).toBe(true)
    expect(isListingStockFile('other.csv')).toBe(false)
  })

  it('handles empty file candidates', () => {
    expect(choosePreferredFile([])).toBe('')
    expect(isOrderProfitFile('x.csv')).toBe(false)
  })

  it('scores bracketed duplicate names correctly', () => {
    const files = ['Listing销售库存_2026 (1).csv', 'Listing销售库存_2026.csv']
    expect(choosePreferredFile(files)).toBe('Listing销售库存_2026.csv')
  })

  it('recognizes multiple listing file suffixes', () => {
    expect(isListingStockFile('Listing销售库存_2026-08.csv')).toBe(true)
    expect(isListingStockFile('Listing销售库存_2026-08.xlsx')).toBe(true)
  })
})

describe('dataPipeline: listing row mapping', () => {
  it('maps single-column package fields and monthly metrics', () => {
    const cols = [
      'ASIN',
      'FNSKU',
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
      '包装尺寸(长×宽×高cm)',
      '包装类型',
      '单品重量(g)',
      '产品图片',
    ]
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = [
      'B0TEST',
      'X00TEST',
      '中文名',
      '300',
      '12345.6',
      '280',
      '10',
      '3',
      '100',
      '10',
      '0',
      '1',
      '111',
      '30×20×10',
      '纸箱',
      '250',
      'https://example.com/a.jpg',
    ]

    const mapped = buildListingRowRecord(row, idx)
    expect(mapped.fnsku).toBe('X00TEST')
    expect(mapped.name).toBe('中文名')
    expect(mapped.monthSales).toBe(300)
    expect(mapped.monthRevenue).toBe(12345.6)
    expect(mapped.monthOrders).toBe(280)
    expect(mapped.dailySales).toBe(10)
    expect(mapped.vineGiftSales).toBe(3)
    expect(mapped.fbaTotal).toBe(111)
    expect(mapped.packageSize).toBe('30×20×10')
    expect(mapped.packageType).toBe('纸箱')
    expect(mapped.productImage).toBe('https://example.com/a.jpg')
    expect(mapped.listingDetailImages).toEqual(['https://example.com/a.jpg'])
  })

  it('falls back to legacy package columns when single-column fields are empty', () => {
    const cols = [
      'ASIN',
      '包装尺寸1(长×宽×高cm)',
      '包装尺寸2(长×宽×高cm)',
      '包装类型1',
      '包装类型2',
      '产品图片',
    ]
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = ['B0FALLBACK', '10×10×10', '', '', '袋装', '']
    const mapped = buildListingRowRecord(row, idx)
    expect(mapped.packageSize).toBe('10×10×10')
    expect(mapped.packageType).toBe('袋装')
    expect(mapped.productImage).toBe('')
  })

  it('falls back to 产品图片1/产品图片2 when 产品图片 is empty', () => {
    const cols = ['ASIN', '产品图片', '产品图片1', '产品图片2']
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = ['B0IMG', '', 'https://example.com/1.jpg', 'https://example.com/2.jpg']
    const mapped = buildListingRowRecord(row, idx)
    expect(mapped.productImage).toBe('https://example.com/1.jpg')
    expect(mapped.listingDetailImages).toEqual([
      'https://example.com/1.jpg',
      'https://example.com/2.jpg',
    ])
  })

  it('uses 图片URL as 亚马逊主图 and puts it in image list first', () => {
    const cols = ['ASIN', '图片URL', '产品图片1', '产品图片2']
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = ['B0MAIN', 'https://m.media-amazon.com/images/I/main.jpg', 'https://cdn.example/1.jpg', '']
    const mapped = buildListingRowRecord(row, idx)

    expect(mapped.amazonMainImage).toBe('https://m.media-amazon.com/images/I/main.jpg')
    expect(mapped.listingDetailImages).toEqual(['https://cdn.example/1.jpg'])
    expect(mapped.productImage).toBe('https://m.media-amazon.com/images/I/main.jpg')
    expect(mapped.productImages[0]).toBe('https://m.media-amazon.com/images/I/main.jpg')
    expect(mapped.productImages).toContain('https://cdn.example/1.jpg')
  })

  it('ignores non media-amazon 图片URL for 亚马逊主图', () => {
    const cols = ['ASIN', '图片URL', '产品图片1']
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = ['B0NONMAIN', 'https://amz-client-global.example.com/a.jpg', 'https://cdn.example/1.jpg']
    const mapped = buildListingRowRecord(row, idx)

    expect(mapped.amazonMainImage).toBe('')
    expect(mapped.productImage).toBe('https://cdn.example/1.jpg')
    expect(mapped.productImages[0]).toBe('https://cdn.example/1.jpg')
  })

  it('falls back to second legacy package size/type when first is empty', () => {
    const cols = ['ASIN', '包装尺寸1(长×宽×高cm)', '包装尺寸2(长×宽×高cm)', '包装类型1', '包装类型2']
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
    const row = ['B0ALT', '', '22×11×5', '', '塑封']
    const mapped = buildListingRowRecord(row, idx)
    expect(mapped.packageSize).toBe('22×11×5')
    expect(mapped.packageType).toBe('塑封')
  })
})
