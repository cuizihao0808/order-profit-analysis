export function buildProductPatchTargets(products, asin, patch, shopId = '') {
  const targets = [{ asin, patch, shopId }]
  if (patch.category !== '放弃') return targets

  for (const product of products) {
    if (
      product.parentAsin === asin &&
      product.asin !== asin &&
      product.category !== '放弃' &&
      String(product.shopId || '').trim() === shopId
    ) {
      targets.push({ asin: product.asin, patch: { category: '放弃' }, shopId })
    }
  }
  return targets
}