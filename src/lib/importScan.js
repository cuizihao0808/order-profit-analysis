export function prepareImportScan(scanData) {
  const scan = scanData && typeof scanData === 'object' ? scanData : {}
  return {
    ...scan,
    unimported: Array.isArray(scan.unimported)
      ? scan.unimported.filter((item) => item?.importMode !== 'reimport')
      : [],
  }
}