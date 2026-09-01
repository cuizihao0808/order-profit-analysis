import { describe, expect, it } from 'vitest'
import { buildProductPatchTargets } from '../src/lib/productUpdates.js'

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
})