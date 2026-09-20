import { describe, expect, it } from 'vitest'
import {
  buildColIndex,
  buildRowByAsin,
  groupWeekFields,
  inventoryHealthText,
  isWeekFieldAlert,
  pairedText,
  toNum,
  weekCell,
  weekRoi,
  weightTypeText,
} from '../src/lib/weekSnapshot.js'

const COLUMNS = ['ASIN', '店铺', '销量', '销售额', '毛利润', '广告费率', '退货率', '采购成本', '备注列']
const ROW = { asin: 'B0AAA', values: ['B0AAA', 'TZH-主店二号', '52', '1223.49', '576.44', '0.00%', '0.00%', '-169.57', 'x'] }
const WEEK = { columns: COLUMNS, rows: [ROW, { asin: 'B0AAA', values: [] }, { asin: 'B0BBB', values: [] }] }

describe('toNum', () => {
  it('strips $ , % and blanks out non-numbers', () => {
    expect(toNum('$1,234.50')).toBe(1234.5)
    expect(toNum('7.81%')).toBe(7.81)
    expect([toNum(''), toNum(null), toNum('—')].every(Number.isNaN)).toBe(true)
  })
})

describe('week row reading', () => {
  it('indexes columns and keeps the first row per ASIN', () => {
    expect(buildColIndex(COLUMNS)['毛利润']).toBe(4)
    const byAsin = buildRowByAsin(WEEK)
    expect(byAsin.get('B0AAA')).toBe(ROW)
    expect([...byAsin.keys()]).toEqual(['B0AAA', 'B0BBB'])
    expect(buildRowByAsin(null).size).toBe(0)
  })

  it('reads cells and shows 采购成本 as a positive number', () => {
    const idx = buildColIndex(COLUMNS)
    expect(weekCell(ROW, idx, '销量')).toBe('52')
    expect(weekCell(ROW, idx, '采购成本')).toBe('169.57')
    expect(weekCell(ROW, idx, '不存在的列')).toBe('')
  })

  it('computes ROI as 毛利润 / 采购成本', () => {
    const idx = buildColIndex(COLUMNS)
    expect(weekRoi(ROW, idx)).toBe('3.40')
    expect(weekRoi({ values: ['B0AAA', '', '', '', '10', '', '', '0', ''] }, idx)).toBe('')
  })

  it('groups every column, leftovers included', () => {
    const groups = groupWeekFields(COLUMNS, ROW, [
      { title: '销售', cols: ['销量', '销售额', '缺失列'] },
      { title: '空组', cols: ['缺失列'] },
    ])
    expect(groups.map((g) => g.title)).toEqual(['销售', '其它'])
    expect(groups[0].fields).toEqual([
      { name: '销量', value: '52' },
      { name: '销售额', value: '1223.49' },
    ])
    expect(groups[1].fields.map((f) => f.name)).toEqual(['ASIN', '店铺', '毛利润', '广告费率', '退货率', '采购成本', '备注列'])
  })
})

describe('alerts and product fields', () => {
  it('flags the same values the weekly page highlights', () => {
    expect(isWeekFieldAlert('广告费率', '15.01%')).toBe(true)
    expect(isWeekFieldAlert('广告费率', '9%')).toBe(false)
    expect(isWeekFieldAlert('退款率', '10.5%')).toBe(true)
    expect(isWeekFieldAlert('毛利润', '-1')).toBe(true)
    expect(isWeekFieldAlert('ROI', '3.40')).toBe(false)
    expect(isWeekFieldAlert('销量', '-3')).toBe(false)
    expect(isWeekFieldAlert('毛利润', '')).toBe(false)
  })

  it('reads inventory health, paired fields and weight type', () => {
    expect(inventoryHealthText({ sellable: 100, reserved: 10, monthSales: 50 })).toBe('健康')
    expect(inventoryHealthText({ sellable: 5, reserved: 20, monthSales: 80 })).toBe('不足')
    expect(inventoryHealthText(null)).toBe('不足')

    expect(pairedText({ packageCost1: 0.87, packageCost2: 1.2 }, 'packageCost1', 'packageCost2')).toBe('0.87 / 1.2')
    expect(pairedText({ packageCost1: 0.87 }, 'packageCost1', 'packageCost2')).toBe('0.87')
    expect(pairedText(null, 'packageCost1', 'packageCost2')).toBe('—')

    // 18×18×11cm 的体积重 594g > 340g → 抛重
    expect(weightTypeText({ itemWeight: 340, packageSize: '18×18×11' })).toBe('抛重')
    expect(weightTypeText({ itemWeight: 900, packageSize: '18×18×11' })).toBe('实重')
    expect(weightTypeText({ itemWeight: 340, packageSize: '18×18' })).toBe('—')
    expect(weightTypeText({ packageSize: '18×18×11' })).toBe('—')
  })
})
