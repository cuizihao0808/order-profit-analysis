import { describe, expect, it } from 'vitest'
import { computeRestockQty } from '../src/lib/restockRules.js'

describe('restockRules: computeRestockQty', () => {
  const cfg = {
    restockMonths: 12,
    restockMultiplier: 4,
    monthlyThreshold: 1,
    doubleRestockMultiplier: 8,
    quantityDiscount: 0.8,
  }

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

  it('uses normal multiplier when below threshold but not monthly shortage', () => {
    expect(computeRestockQty({ fbaTotal: 60, sales: 10, cycle: 2, config: cfg })).toBe('32')
  })

  it('uses double multiplier when monthly shortage is severe', () => {
    expect(computeRestockQty({ fbaTotal: 20, sales: 10, cycle: 2, config: cfg })).toBe('64')
  })

  it('works with default config fallback', () => {
    expect(computeRestockQty({ fbaTotal: 20, sales: 10, cycle: 2, config: undefined })).toBe('64')
  })
})
