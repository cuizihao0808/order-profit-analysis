import { describe, expect, it } from 'vitest'
import { buildProductPatchTargets, sortFullCartonFirst } from '../src/lib/productUpdates.js'

describe('buildProductPatchTargets', () => {
  const products = [
    { asin: 'PARENT', parentAsin: 'PARENT', shopId: 'shop-1', category: '正常' },
    { asin: 'CHILD-1', parentAsin: 'PARENT', shopId: 'shop-1', category: '正常' },
    { asin: 'CHILD-2', parentAsin: 'PARENT', shopId: 'shop-1', category: '放弃' },
    { asin: 'OTHER-SHOP', parentAsin: 'PARENT', shopId: 'shop-2', category: '正常' },
  ]

  it('cascades abandon status only to active children in the same shop', () => {
    expect(buildProductPatchTargets(products, 'PARENT', { category: '放弃' }, 'shop-1')).toEqual([
      { asin: 'PARENT', patch: { category: '放弃' }, shopId: 'shop-1' },
      { asin: 'CHILD-1', patch: { category: '放弃' }, shopId: 'shop-1' },
    ])
  })

  it('does not cascade ordinary product edits', () => {
    expect(buildProductPatchTargets(products, 'PARENT', { localWarehouse: 5 }, 'shop-1')).toEqual([
      { asin: 'PARENT', patch: { localWarehouse: 5 }, shopId: 'shop-1' },
    ])
  })

  it('moves full-carton rows first while preserving the order within each mode', () => {
    const rows = [
      { asin: 'MIXED-1', packingMode: 'mixed' },
      { asin: 'FULL-1', packingMode: 'full' },
      { asin: 'MIXED-2' },
      { asin: 'FULL-2', packingMode: 'full' },
    ]

    expect(sortFullCartonFirst(rows).map((row) => row.asin)).toEqual([
      'FULL-1',
      'FULL-2',
      'MIXED-1',
      'MIXED-2',
    ])
    expect(rows.map((row) => row.asin)).toEqual(['MIXED-1', 'FULL-1', 'MIXED-2', 'FULL-2'])
  })
})