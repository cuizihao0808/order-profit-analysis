import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import ImportDialog from '../src/components/ImportDialog.vue'

const DialogStub = {
  props: ['modelValue'],
  template: '<section v-if="modelValue"><slot /></section>',
}

const ButtonStub = {
  template: '<button><slot /></button>',
}

function jsonResponse(data) {
  return { ok: true, json: async () => data }
}

function mockApi(url) {
  if (url === '/api/scan') {
    return jsonResponse({
      unimported: [
        { weekId: '36周', importMode: 'new', folderName: '36周', listingFiles: ['listing.csv'] },
        { weekId: '35周', importMode: 'reimport', folderName: '35周', listingFiles: ['listing.csv'] },
      ],
      imported: [{ id: '35周' }],
    })
  }
  if (url === '/api/dev-session') return jsonResponse({ sessionId: 'test' })
  if (url === '/api/weeks') return jsonResponse([])
  if (url === '/api/shops' || url === '/api/products') return jsonResponse([])
  if (url === '/api/restock-config') return jsonResponse({})
  return jsonResponse({})
}

describe('import dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows only new weeks after the scan flow receives reimport recommendations', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(mockApi(url))))
    const wrapper = mount(App, {
      global: {
        stubs: {
          'el-dialog': DialogStub,
          'el-button': ButtonStub,
          'el-table': { template: '<div><slot /></div>' },
          'el-table-column': { template: '<div />' },
          'el-form': { template: '<div><slot /></div>' },
          'el-form-item': { template: '<div><slot /></div>' },
          'el-select': { template: '<select><slot /></select>' },
          'el-option': { template: '<option />' },
          'el-input': { template: '<input />' },
          'el-switch': { template: '<input type="checkbox" />' },
          'el-tag': { template: '<span><slot /></span>' },
        },
      },
    })

    await flushPromises()
  const scanButton = wrapper.findAll('button').find((button) => button.text() === '扫描并导入')
  await scanButton.trigger('click')
    await flushPromises()
  await vi.dynamicImportSettled()
  await flushPromises()

    expect(wrapper.text()).toContain('待导入（1）')
    expect(wrapper.text()).not.toContain('待导入（2）')
    expect(fetch).toHaveBeenCalledWith('/api/scan', { cache: 'no-store' })
  })

  it('sends only importable new weeks when importing all', async () => {
    const wrapper = mount(ImportDialog, {
      props: {
        showImportPanel: true,
        importLoading: false,
        importBusy: false,
        importScan: {
          unimported: [
            { weekId: '36周', listingFiles: ['listing.csv'] },
            { weekId: '37周', listingFiles: [] },
          ],
          imported: [],
        },
        importResult: null,
        resolvePanel: { show: false, busy: false, items: [], message: '' },
        resolveReady: false,
        shops: [],
      },
      global: {
        stubs: {
          'el-dialog': DialogStub,
          'el-button': ButtonStub,
          'el-table': { template: '<div><slot /></div>' },
          'el-table-column': { template: '<div />' },
          'el-tag': { template: '<span><slot /></span>' },
          'el-select': { template: '<select><slot /></select>' },
          'el-option': { template: '<option />' },
        },
      },
    })

    const allButton = wrapper.findAll('button').find((button) => button.text() === '全部导入')
    await allButton.trigger('click')
    expect(wrapper.emitted('import-weeks')).toEqual([[['36周']]])
  })
})