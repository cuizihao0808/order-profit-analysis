import { describe, expect, it } from 'vitest'
import { restockConfig } from '../src/data/restockConfig.js'
import { computeRestockQty } from '../src/lib/restockRules.js'

describe('restockRules: computeRestockQty', () => {
  const cfg = restockConfig

  it('returns empty when inputs are invalid', () => {
    expect(computeRestockQty({ fbaTotal: '', sales: 10, cycle: 2, config: cfg })).toBe('')
    expect(computeRestockQty({ fbaTotal: 1, sales: 'x', cycle: 2, config: cfg })).toBe('')
  })

  it('returns no-restock when sales <= 0', () => {
    expect(computeRestockQty({ fbaTotal: 1, sales: 0, cycle: 2, config: cfg })).toBe('无需补货')
  })

  it('returns no-restock when stock meets threshold', () => {
    expect(computeRestockQty({ fbaTotal: 200, sales: 10, cycle: 2, config: cfg })).toBe('无需补货')
  })

  it('adds two months when stock is below the two-month-plus-cycle threshold', () => {
    expect(computeRestockQty({ fbaTotal: 99, sales: 10, cycle: 2, config: cfg })).toBe('80')
  })

  it('still adds two months when stock is very low', () => {
    expect(computeRestockQty({ fbaTotal: 20, sales: 10, cycle: 2, config: cfg })).toBe('80')
  })

  it('works with default config fallback', () => {
    expect(computeRestockQty({ fbaTotal: 20, sales: 10, cycle: 2, config: undefined })).toBe('80')
  })

  it('keeps explicitly configured zero values instead of replacing them with defaults', () => {
    expect(computeRestockQty({
      fbaTotal: 1,
      sales: 10,
      cycle: 2,
      config: { restockMonths: 0, restockMultiplier: 0, quantityDiscount: 0 },
    })).toBe('0')
  })

  it('accepts numeric strings and rounds fractional replenishment quantities', () => {
    expect(computeRestockQty({
      fbaTotal: '1',
      sales: '1.6',
      cycle: '2',
      config: cfg,
    })).toBe('13')
  })

  it('does not replenish at the exact stock threshold', () => {
    expect(computeRestockQty({ fbaTotal: 100, sales: 10, cycle: 2, config: cfg })).toBe('无需补货')
  })
})
