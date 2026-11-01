/**
 * 静态补货规则配置（2026-10-24 确认），没写的项取 src/lib/restockRules.js 的默认值
 *
 * 基础逻辑：库存位置（FBA总量 + 本地仓 + 已下单）< 月销量 × 3（覆盖不到 3 个月）→ 发 1 个月销量
 * 月销量 = 指数平滑周销 × 30/7；大促周用前后两周均值代替；下滑时不超过近 4 周均
 */
export const restockConfig = {
  // 库存位置不够几个月就补
  coverMonths: 3,

  // 每次补几个月
  shipMonths: 1,

  // 阈值是否再加 补货用时(周) × 周销；2026-11-01 改为只看覆盖不到 3 个月
  restockCycleInThreshold: false,

  // 大促周（会员日 10/06~07 在 41 周；黑五网一过后加 48周、49周）
  eventWeeks: ['41周'],
}
