import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportDialog from '../src/components/ImportDialog.vue'

const DialogStub = {
  props: ['modelValue'],
  template: '<section v-if="modelValue"><slot /></section>',
}

const ButtonStub = {
  template: '<button><slot /></button>',
}

describe('import dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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