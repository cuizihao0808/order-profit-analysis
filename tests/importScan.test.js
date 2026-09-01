import { describe, expect, it } from 'vitest'
import { prepareImportScan } from '../src/lib/importScan.js'

describe('prepareImportScan', () => {
  it('keeps new weeks but hides reimport recommendations from the pending-import list', () => {
    const scan = prepareImportScan({
      unimported: [
        { weekId: '36周', importMode: 'new' },
        { weekId: '35周', importMode: 'reimport' },
        { weekId: '34周', importMode: 'reimport' },
      ],
      imported: [{ id: '35周' }],
    })

    expect(scan.unimported).toEqual([{ weekId: '36周', importMode: 'new' }])
    expect(scan.imported).toEqual([{ id: '35周' }])
  })

  it('returns an empty pending-import list for malformed scan responses', () => {
    expect(prepareImportScan(null).unimported).toEqual([])
    expect(prepareImportScan({ unimported: 'invalid' }).unimported).toEqual([])
  })
})