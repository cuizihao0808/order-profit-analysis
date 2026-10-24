import { DOMWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FilterChip from '../src/components/FilterChip.vue'
import PlanOverview from '../src/components/PlanOverview.vue'
import { TZH, asins, createApi, mountApp, rowOf, settle, stubBrowser } from './helpers/appHarness.js'

vi.mock('../src/data/focusProducts.json', () => ({ default: { 'shop-2': ['B0B1', 'B0A1'] } }))

let api
let browser

beforeEach(() => {
  api = createApi()
  browser = stubBrowser(api)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

/* ---------- 小工具：弹窗会传送到 body 下，按标题 / 文字找 ---------- */
function dialog(title) {
  const el = [...document.querySelectorAll('.el-dialog')].find((d) => d.querySelector('.el-dialog__title')?.textContent.startsWith(title))
  return el ? new DOMWrapper(el) : null
}
function button(scope, text) {
  return scope.findAll('button').find((b) => b.text() === text)
}
const toastText = (wrapper) => wrapper.find('.toast').text()

function moreMenu(wrapper) {
  return wrapper.findAllComponents({ name: 'ElDropdown' }).find((d) => d.text().includes('更多'))
}
async function runMore(wrapper, command) {
  moreMenu(wrapper).vm.$emit('command', command)
  await settle()
}
function filterChip(wrapper, label) {
  return wrapper.findAllComponents(FilterChip).find((c) => c.props('label') === label)
}
async function switchView(wrapper, value) {
  await wrapper.findAll('.view-switch .el-radio-button__original-radio').find((r) => r.element.value === value).setValue(true)
  await settle()
}

describe('inline edits', () => {
  it('saves name, title and category to the product of the right shop', async () => {
    const wrapper = await mountApp()
    const a1 = () => rowOf(wrapper, 'B0A1')
    await a1().find('.cell-input-name').setValue('黑垫高块 Pro')
    await a1().find('.cell-input-name').trigger('blur') // 值没变，不会重复保存
    await a1().find('.cell-input-title').setValue('Treadmill Blocks v2')
    a1().findComponent({ name: 'ElSelect' }).vm.$emit('change', '观望')
    await settle()

    expect(api.calls('PUT', '/api/products/B0A1')).toEqual([
      { name: '黑垫高块 Pro', shopId: 'shop-2' },
      { productTitle: 'Treadmill Blocks v2', shopId: 'shop-2' },
      { category: '观望', shopId: 'shop-2' },
    ])
    expect(a1().find('.cell-ep-select').classes()).toContain('cat-观望')
    wrapper.unmount()
  })

  it('saves and clears this week note, rolling back when the save fails', async () => {
    const wrapper = await mountApp()
    const noteOf = (asin) => rowOf(wrapper, asin).find('input[placeholder="本周备注"]')
    await noteOf('B0B1').trigger('mouseenter')
    await noteOf('B0B1').setValue('  下周断货  ')
    await noteOf('B0B1').trigger('blur') // 同样的值不再请求
    await noteOf('B0A1').setValue('')
    await settle()
    expect(api.calls('PUT', '/api/weeks/2周/notes/B0B1')).toEqual([{ note: '下周断货' }])
    expect(api.calls('PUT', '/api/weeks/2周/notes/B0A1')).toEqual([{ note: '' }])

    api.fail.add('PUT /api/weeks')
    await noteOf('B0C1').setValue('会失败')
    await settle()
    expect(noteOf('B0C1').element.value).toBe('')
    expect(toastText(wrapper)).toContain('备注保存失败：服务器出错了')
    wrapper.unmount()
  })

  it('edits inventory numbers, packing mode and moves stock with arrived / shipped', async () => {
    const wrapper = await mountApp()
    await rowOf(wrapper, 'B0A1').find('td.num').trigger('click')
    const grid = () => wrapper.find('.inventory-detail-grid')
    const input = (label) => grid().findAll('.inventory-input-item').find((i) => i.text().startsWith(label)).find('input')

    await input('本地仓库').setValue('7')
    await input('补货用时').setValue('')
    await input('已下单').setValue('5')
    grid().findComponent({ name: 'ElRadioGroup' }).vm.$emit('change', 'full')
    await settle()
    await button(wrapper.find('.inventory-footer-bar'), '已到库').trigger('click')
    await settle()
    await button(wrapper.find('.inventory-footer-bar'), '已发出').trigger('click')
    await settle()

    expect(api.calls('PUT', '/api/products/B0A1')).toEqual([
      { localWarehouse: 7, shopId: 'shop-2' },
      { restockCycle: '', shopId: 'shop-2' },
      { orderedQty: 5, shopId: 'shop-2' },
      { packingMode: 'full', shopId: 'shop-2' },
      { localWarehouse: 12, orderedQty: 0, shopId: 'shop-2' },
      { localWarehouse: 0, shopId: 'shop-2' },
    ])
    // 没有已下单 / 本地仓时两个按钮都不可用
    expect(button(wrapper.find('.inventory-footer-bar'), '已到库').attributes('disabled')).toBeDefined()
    expect(button(wrapper.find('.inventory-footer-bar'), '已发出').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('rolls back an edit and alerts when the server rejects it', async () => {
    const wrapper = await mountApp()
    api.fail.add('PUT /api/products')
    await rowOf(wrapper, 'B0B1').find('.cell-input-name').setValue('改不了')
    await settle()
    expect(browser.alert).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
    expect(rowOf(wrapper, 'B0B1').find('.cell-input-name').element.value).toBe('收纳包')
    wrapper.unmount()
  })
})

describe('selection and batch actions', () => {
  it('selects all visible rows and changes their category after confirming', async () => {
    const wrapper = await mountApp()
    await wrapper.find('thead .select-col input').setValue(true)
    expect(wrapper.find('.selbar').text()).toContain('已选 4 个 ASIN')

    const batchMenu = () => wrapper.find('.selbar').findComponent({ name: 'ElDropdown' })
    browser.confirm.mockReturnValueOnce(false)
    batchMenu().vm.$emit('command', '正常')
    await settle()
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false)

    batchMenu().vm.$emit('command', '正常')
    await settle()
    // 已经是「正常」的不再请求，只改 B0A1（新品）
    expect(api.requests.filter((r) => r.method === 'PUT').map((r) => r.path)).toEqual(['/api/products/B0A1'])
    expect(toastText(wrapper)).toContain('已批量修改 1 个 ASIN 的分类')
    expect(wrapper.find('.selbar').exists()).toBe(false)

    await wrapper.find('thead .select-col input').setValue(true)
    batchMenu().vm.$emit('command', '正常')
    await settle()
    expect(toastText(wrapper)).toContain('无需修改')
    await wrapper.find('thead .select-col input').setValue(false)
    expect(wrapper.find('.selbar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('copies only 飞机盒 packaging as a rich + plain text table', async () => {
    const wrapper = await mountApp()
    await rowOf(wrapper, 'B0A1').find('input[type=checkbox]').setValue(true)
    await rowOf(wrapper, 'B0C1').find('input[type=checkbox]').setValue(true)

    // 不支持 ClipboardItem 时走 execCommand
    document.execCommand = vi.fn(() => true)
    await button(wrapper.find('.selbar'), '复制飞机盒包装（1）').trigger('click')
    await settle()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(toastText(wrapper)).toBe('✓已复制 1 条飞机盒包装信息，跳过 1 条其他包装类型')

    // 支持时同时写入 HTML 和纯文本
    const write = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: browser.writeText }, configurable: true })
    vi.stubGlobal('ClipboardItem', class {
      constructor(items) {
        this.items = items
      }
    })
    await button(wrapper.find('.selbar'), '复制飞机盒包装（1）').trigger('click')
    await settle()
    const item = write.mock.calls[0][0][0]
    expect(Object.keys(item.items)).toEqual(['text/html', 'text/plain'])
    expect(await item.items['text/plain'].text()).toContain('２０ｘ１５ｘ１０')

    // execCommand 失败时退回纯文本
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: browser.writeText }, configurable: true })
    vi.stubGlobal('ClipboardItem', undefined)
    document.execCommand = vi.fn(() => false)
    await button(wrapper.find('.selbar'), '复制飞机盒包装（1）').trigger('click')
    await settle()
    expect(browser.writeText).toHaveBeenLastCalledWith(expect.stringContaining('包装尺寸'))
    wrapper.unmount()
  })

  it('copies a single ASIN from its hover button', async () => {
    const wrapper = await mountApp()
    await rowOf(wrapper, 'B0A1').find('.asin-copy-icon').trigger('click')
    await settle()
    expect(browser.writeText).toHaveBeenCalledWith('B0A1')
    expect(rowOf(wrapper, 'B0A1').find('.asin-copy-icon').classes()).toContain('copied')

    browser.writeText.mockRejectedValueOnce(new Error('denied'))
    await rowOf(wrapper, 'B0B1').find('.asin-copy-icon').trigger('click')
    await settle()
    expect(toastText(wrapper)).toContain('复制失败')
    wrapper.unmount()
  })
})

describe('more menu', () => {
  it('copies all non-abandoned ASINs of the current filter', async () => {
    const wrapper = await mountApp()
    await runMore(wrapper, 'copy-non-abandoned')
    expect(browser.writeText).toHaveBeenCalledWith('B0C1\nB0A1\nB0A2\nB0B1')
    wrapper.unmount()
  })

  it('exports the local warehouse PDF for one shop and the 本地仓有货 filter only', async () => {
    const clicked = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push(this.download)
    })
    const wrapper = await mountApp()
    expect(moreMenu(wrapper).text()).toContain('更多')
    await runMore(wrapper, 'export-pdf')
    expect(api.calls('POST', '/api/export/local-warehouse-pdf')).toEqual([])

    filterChip(wrapper, '店铺').vm.$emit('update:modelValue', TZH)
    filterChip(wrapper, '补货').vm.$emit('update:modelValue', 'local-warehouse')
    await settle()
    expect(asins(wrapper)).toEqual(['B0A2'])
    await runMore(wrapper, 'export-pdf')

    const [payload] = api.calls('POST', '/api/export/local-warehouse-pdf')
    expect(payload).toMatchObject({ weekId: '2周', shopName: '二号店' })
    expect(payload.rows).toEqual([expect.objectContaining({ asin: 'B0A2', name: '白垫高块', localWarehouse: 12, images: [] })])
    expect(clicked).toEqual(['2周-二号店-本地仓库.pdf'])
    expect(toastText(wrapper)).toContain('已导出 1 行本地仓库 PDF')

    api.fail.add('POST /api/export')
    await runMore(wrapper, 'export-pdf')
    expect(toastText(wrapper)).toContain('导出 PDF 失败')
    wrapper.unmount()
  })

  it('configures columns: hide, show, move and reset, persisted per browser', async () => {
    const wrapper = await mountApp()
    await runMore(wrapper, 'fields')
    const fields = dialog('字段配置')
    const headers = () => wrapper.findAll('thead tr.col-row th').map((th) => th.text())
    expect(headers()).toContain('周销量')

    await button(fields, '全不选').trigger('click')
    expect(headers()).toEqual(['', '产品', 'ASIN'])
    await button(fields, '全选').trigger('click')
    expect(headers()).toContain('销售额')
    await button(fields, '重置').trigger('click')
    expect(headers()).not.toContain('销售额') // 周表里的列默认隐藏
    expect(headers()).toContain('退货率')

    // 第一行的「上移」不可用；把第二列上移到第一
    const moveButtons = fields.findAll('.el-table__body tr').map((tr) => tr.findAll('button'))
    expect(moveButtons[0][0].attributes('disabled')).toBeDefined()
    await moveButtons[1][0].trigger('click')
    expect(headers().slice(3, 5)).toEqual(['周销量', '产品分类'])
    await moveButtons[0][1].trigger('click')
    expect(headers().slice(3, 5)).toEqual(['产品分类', '周销量'])

    wrapper.findAllComponents({ name: 'ElSwitch' })[0].vm.$emit('change', false)
    await settle()
    expect(headers()).not.toContain('产品分类')
    expect(JSON.parse(localStorage.getItem('opa:column-config:v6'))[0]).toEqual({ name: '产品分类', visible: false })
    wrapper.unmount()
  })
})

describe('shop and ASIN master data', () => {
  it('creates, edits and deletes shops', async () => {
    const wrapper = await mountApp()
    await runMore(wrapper, 'shops')
    const shops = dialog('店铺管理')

    await button(shops, '新增店铺').trigger('click')
    expect(shops.text()).toContain('店铺名称不能为空')

    await shops.find('input[placeholder="例如 LPH-主店三号"]').setValue('LPH-主店三号')
    await shops.find('input[placeholder="美国 / 日本..."]').setValue('美国')
    await button(shops, '新增店铺').trigger('click')
    await settle()
    expect(api.calls('POST', '/api/shops')).toEqual([{ name: 'LPH-主店三号', country: '美国', note: '' }])
    expect(shops.text()).toContain('已保存')

    await button(shops.findAll('.el-table__body tr')[1], '编辑').trigger('click')
    expect(shops.find('input[placeholder="例如 LPH-主店三号"]').element.value).toBe(TZH)
    await button(shops, '取消').trigger('click')
    await button(shops.findAll('.el-table__body tr')[1], '编辑').trigger('click')
    await shops.find('input[placeholder="选填"]').setValue('主力店')
    await button(shops, '保存修改').trigger('click')
    await settle()
    expect(api.calls('PUT', '/api/shops/shop-2')).toEqual([{ name: TZH, country: '', note: '主力店' }])

    api.fail.add('POST /api/shops')
    await shops.find('input[placeholder="例如 LPH-主店三号"]').setValue('坏店')
    await button(shops, '新增店铺').trigger('click')
    await settle()
    expect(shops.text()).toContain('服务器出错了')

    // 删掉当前筛选的店铺时，店铺筛选回到全部
    filterChip(wrapper, '店铺').vm.$emit('update:modelValue', TZH)
    await settle()
    browser.confirm.mockReturnValueOnce(false)
    await button(shops.findAll('.el-table__body tr')[1], '删除').trigger('click')
    expect(api.calls('DELETE', '/api/shops/shop-2')).toEqual([])
    await button(shops.findAll('.el-table__body tr')[1], '删除').trigger('click')
    await settle()
    expect(api.calls('DELETE', '/api/shops/shop-2')).toHaveLength(1)
    expect(filterChip(wrapper, '店铺').props('modelValue')).toBe('__all__')
    wrapper.unmount()
  })

  it('searches, creates, edits and deletes ASIN master data', async () => {
    const wrapper = await mountApp()
    await runMore(wrapper, 'products')
    const products = dialog('ASIN 主数据')
    expect(products.findAll('.el-table__body tr')).toHaveLength(5)
    await products.find('input[placeholder="搜索 ASIN / 品名 / 店铺"]').setValue('一号')
    expect(products.findAll('.el-table__body tr')).toHaveLength(1)

    const form = () => products.findAll('.el-form-item input')
    await form()[0].setValue('')
    await button(products, '新增 ASIN').trigger('click')
    expect(products.text()).toContain('ASIN 不能为空')

    await form()[0].setValue('B0NEW')
    const shopSelect = wrapper.findAllComponents({ name: 'ElSelect' }).find((s) => s.props('placeholder') === '请选择店铺')
    shopSelect.vm.$emit('update:modelValue', '')
    await settle()
    await button(products, '新增 ASIN').trigger('click')
    expect(products.text()).toContain('请选择店铺')

    shopSelect.vm.$emit('update:modelValue', 'shop-2')
    await form()[2].setValue('新品A')
    await button(products, '新增 ASIN').trigger('click')
    await settle()
    expect(api.calls('POST', '/api/products')).toEqual([
      { asin: 'B0NEW', parentAsin: '', name: '新品A', productTitle: '', shopId: 'shop-2' },
    ])

    await button(products, '新增 ASIN').trigger('click')
    await settle()
    expect(products.text()).toContain('ASIN 已存在')

    await products.find('input[placeholder="搜索 ASIN / 品名 / 店铺"]').setValue('B0B1')
    await button(products.findAll('.el-table__body tr')[0], '编辑').trigger('click')
    expect(form()[0].element.value).toBe('B0B1')
    await form()[2].setValue('收纳包 L')
    await button(products, '保存修改').trigger('click')
    await settle()
    expect(api.calls('PUT', '/api/products/B0B1')).toEqual([
      { asin: 'B0B1', parentAsin: '', name: '收纳包 L', productTitle: '', shopId: 'shop-2' },
    ])
    await button(products, '取消编辑').trigger('click')
    expect(form()[0].element.value).toBe('')

    await products.find('input[placeholder="搜索 ASIN / 品名 / 店铺"]').setValue('B0B1')
    await button(products.findAll('.el-table__body tr')[0], '编辑').trigger('click')
    await button(products.findAll('.el-table__body tr')[0], '删除').trigger('click')
    await settle()
    expect(api.calls('DELETE', '/api/products/B0B1')).toHaveLength(1)
    expect(form()[0].element.value).toBe('')
    // 只删主数据：弹窗列表里没了，周数据里的行还在
    await products.find('input[placeholder="搜索 ASIN / 品名 / 店铺"]').setValue('')
    expect(products.text()).not.toContain('B0B1')
    expect(products.text()).toContain('ASIN 主数据（5）')
    wrapper.unmount()
  })
})

describe('import flow', () => {
  async function openImportDialog(wrapper) {
    await button(wrapper.find('.topbar'), '扫描并导入').trigger('click')
    await settle()
    return wrapper.findComponent({ name: 'ImportDialog' })
  }

  it('scans, imports, switches to the new latest week and assigns listing-only ASINs', async () => {
    const wrapper = await mountApp()
    const importDialog = await openImportDialog(wrapper)
    expect(importDialog.props('importMessage')).toBe('扫描完成，发现 1 个待导入文件')
    // 扫描结果没有已导入列表时，用 weeks.json 补上
    expect(importDialog.props('importScan').imported.map((w) => w.id)).toEqual(['2周', '1周'])

    importDialog.vm.$emit('import-weeks', ['3周', '4周'])
    await settle()
    expect(api.calls('POST', '/api/import')).toEqual([{ weekIds: ['3周', '4周'] }])
    expect(wrapper.find('.latest-week-tag').text()).toContain('3周')
    expect(importDialog.props('importMessage')).toBe('导入完成：成功 1，失败 1')
    expect(toastText(wrapper)).toContain('导入完成：成功 1，失败 1')

    // 仅 Listing 表里出现的 ASIN：选好店铺后写入
    const panel = importDialog.props('resolvePanel')
    expect(panel.show).toBe(true)
    expect(panel.items).toEqual([{ asin: 'B0NEW', listingFile: 'listing.csv', shopId: '' }])
    expect(importDialog.props('resolveReady')).toBe(false)
    panel.items[0].shopId = 'shop-2'
    await settle()
    expect(importDialog.props('resolveReady')).toBe(true)
    importDialog.vm.$emit('submit-resolve')
    await settle()
    expect(api.calls('POST', '/api/import/resolve-listing-only')).toEqual([
      { weekId: '3周', assignments: [{ asin: 'B0NEW', shopId: 'shop-2' }] },
    ])
    expect(importDialog.props('resolvePanel').show).toBe(false)
    expect(importDialog.props('importResult')[0]).toMatchObject({ listingOnlyUnresolvedTotal: 0, listingOnlyAddedTotal: 1 })
    expect(toastText(wrapper)).toContain('已写入 1 个 ASIN')

    // 重新打开面板、关闭面板、关闭弹窗
    importDialog.vm.$emit('open-resolve', { row: { ...importDialog.props('importResult')[0], listingOnlyUnresolvedByFile: [{ listingFile: 'b.csv', asins: ['B0X'] }] }, index: 0 })
    await settle()
    expect(importDialog.props('resolvePanel').show).toBe(true)
    importDialog.vm.$emit('close-resolve')
    importDialog.vm.$emit('close')
    await settle()
    expect(importDialog.props('showImportPanel')).toBe(false)
    wrapper.unmount()
  })

  it('reports failures while scanning, importing and resolving', async () => {
    const wrapper = await mountApp()
    api.fail.add('GET /api/scan')
    const importDialog = await openImportDialog(wrapper)
    expect(importDialog.props('importScan').unimported).toEqual([])
    api.fail.delete('GET /api/scan')
    importDialog.vm.$emit('scan')
    await settle()
    expect(importDialog.props('importMessage')).toContain('发现 1 个待导入文件')

    api.fail.add('POST /api/import/resolve')
    importDialog.vm.$emit('import-weeks', ['3周'])
    await settle()
    importDialog.props('resolvePanel').items[0].shopId = 'shop-2'
    importDialog.vm.$emit('submit-resolve')
    await settle()
    expect(importDialog.props('resolvePanel')).toMatchObject({ show: true, busy: false, message: '服务器出错了' })
    expect(toastText(wrapper)).toContain('服务器出错了')
    wrapper.unmount()
  })

  it('deletes a week snapshot after confirming and reloads the latest week', async () => {
    const wrapper = await mountApp()
    const importDialog = await openImportDialog(wrapper)
    browser.confirm.mockReturnValueOnce(false)
    importDialog.vm.$emit('delete-week', { id: '2周', filename: '2周/订单利润.xlsx' })
    await settle()
    expect(api.calls('DELETE', '/api/weeks/2周')).toEqual([])

    importDialog.vm.$emit('delete-week', { id: '2周', filename: '2周/订单利润.xlsx' })
    await settle()
    expect(api.calls('DELETE', '/api/weeks/2周')).toHaveLength(1)
    expect(wrapper.find('.latest-week-tag').text()).toContain('1周')
    expect(asins(wrapper)).toEqual(['B0A1'])
    // 月销量按剩下的周重算：只剩 1 周卖 5 件
    expect(api.requests.filter((r) => r.path === '/api/restock-basis')).toHaveLength(2)
    expect(rowOf(wrapper, 'B0A1').find('.restock-cell small').text()).toBe('月销 21 · 覆盖 1.9 月')
    wrapper.unmount()
  })
})

describe('images and plan batches', () => {
  it('previews product images and listing detail images', async () => {
    const wrapper = await mountApp()
    await rowOf(wrapper, 'B0A1').find('.name-image-btn').trigger('click')
    const preview = () => new DOMWrapper(document.querySelector('.image-preview-ep'))
    expect(preview().find('.image-preview-indicator').text()).toBe('1 / 2')
    await preview().find('.image-preview-nav-next').trigger('click')
    expect(preview().find('.image-preview-large').attributes('src')).toBe('https://img.test/a1-2.jpg')
    await preview().find('.image-preview-nav-prev').trigger('click')
    await preview().find('.image-preview-nav-prev').trigger('click')
    expect(preview().find('.image-preview-indicator').text()).toBe('2 / 2')
    await button(preview(), '✕').trigger('click')
    await settle()

    await rowOf(wrapper, 'B0A1').find('td.num').trigger('click')
    await wrapper.find('.inventory-footer-bar .product-image-link').trigger('click')
    expect(preview().find('.image-preview-head').text()).toContain('B0A1 库存详情图片')
    expect(preview().find('.image-preview-large').attributes('src')).toBe('https://img.test/a1-detail.jpg')
    wrapper.unmount()
  })

  it('marks, undoes and copies a whole batch from the plan view', async () => {
    const wrapper = await mountApp()
    await switchView(wrapper, 'plan')
    const overview = wrapper.findComponent(PlanOverview)
    const batch = overview.props('summary').batches.find((b) => b.key === '10/24')

    browser.confirm.mockReturnValueOnce(false)
    overview.vm.$emit('mark', batch, true)
    await settle()
    expect(api.calls('PUT', '/api/replenishment/shipped')).toEqual([])

    overview.vm.$emit('mark', batch, true)
    await settle()
    expect(api.calls('PUT', '/api/replenishment/shipped')[0]).toEqual({
      shop: 'TZH',
      entries: [
        { asin: 'B0A1', date: '2026-10-24' },
        { asin: 'B0B1', date: '2026-10-24' },
      ],
      shipped: true,
    })
    expect(toastText(wrapper)).toContain('10/24 批次 2 个 SKU 已标记发货')
    // 已经全部发货时再点不会发请求
    overview.vm.$emit('mark', batch, true)
    await settle()
    expect(api.calls('PUT', '/api/replenishment/shipped')).toHaveLength(1)
    overview.vm.$emit('mark', batch, false)
    await settle()
    expect(api.calls('PUT', '/api/replenishment/shipped')[1].shipped).toBe(false)

    overview.vm.$emit('copy', { ...batch, plannedQty: 28 })
    await settle()
    expect(browser.writeText).toHaveBeenLastCalledWith('SKU\t品名\tASIN\t件数\nTR-A1\t黑垫高块\tB0A1\t20\nTR-B1\t收纳包\tB0B1\t8\n合计\t\t\t28')

    // 行筛选：只看所选批次
    overview.vm.$emit('update:batch', '10/17')
    overview.vm.$emit('update:rowFilter', 'batch')
    await settle()
    expect(asins(wrapper)).toEqual(['B0A1'])
    overview.vm.$emit('update:rowFilter', 'pending')
    await settle()
    expect(asins(wrapper)).toEqual(['B0A1', 'B0B1'])
    overview.vm.$emit('update:rowFilter', 'done')
    await settle()
    expect(asins(wrapper)).toEqual([])
    expect(wrapper.find('.empty').text()).toBe('当前筛选条件下没有数据')
    wrapper.unmount()
  })
})
