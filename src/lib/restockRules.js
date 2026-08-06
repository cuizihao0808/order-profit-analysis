export function computeRestockQty({ fbaTotal, sales, cycle, config }) {
  const parseFinite = (v) => {
    if (v == null || v === '') return NaN
    return Number(v)
  }

  const nFba = parseFinite(fbaTotal)
  const nSales = parseFinite(sales)
  const nCycle = parseFinite(cycle)
  if (!Number.isFinite(nFba) || !Number.isFinite(nSales) || !Number.isFinite(nCycle)) return ''
  if (nSales <= 0) return '无需补货'

  const restockMonths = config?.restockMonths || 12
  const restockMultiplier = config?.restockMultiplier || 4
  const monthlyThreshold = config?.monthlyThreshold || 1
  const doubleRestockMultiplier = config?.doubleRestockMultiplier || 8
  const quantityDiscount = config?.quantityDiscount || 0.8

  const threshold = nSales * (restockMonths + nCycle)
  if (nFba >= threshold) return '无需补货'

  const monthlyStock = nSales * 4
  const multiplier =
    nFba < monthlyStock * monthlyThreshold ? doubleRestockMultiplier : restockMultiplier

  return String(Math.round(nSales * multiplier * quantityDiscount))
}
