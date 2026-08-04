/**
 * 补货数量计算规则配置
 * 
 * 基础逻辑：IF([库存数量] < [预估 7 天销量] * (12 + [补货用时]), [预估 7 天销量] * 补货倍数 * 0.8, "无需补货")
 * 
 * 增强规则：如果库存数量不足一个月的销量，则使用双倍补货倍数
 */
export const restockConfig = {
  // 库存周数：计算库存阈值时使用的月数常数
  restockMonths: 12,
  
  // 补货倍数：当库存不足时，计算补货数量的倍数
  restockMultiplier: 4,
  
  // 库存不足多少个月时，触发双倍补货倍数
  monthlyThreshold: 1,
  
  // 双倍补货倍数：当库存不足 monthlyThreshold 个月时使用
  doubleRestockMultiplier: 8,
  
  // 数量折扣系数：补货数量的折扣系数
  quantityDiscount: 0.8,
}

