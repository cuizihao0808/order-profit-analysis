<script setup>
const props = defineProps({
  showImportPanel: { type: Boolean, required: true },
  importLoading: { type: Boolean, required: true },
  importBusy: { type: Boolean, required: true },
  importMessage: { type: String, default: '' },
  importScan: { type: Object, required: true },
  importResult: { type: Array, default: null },
  resolvePanel: { type: Object, required: true },
  resolveReady: { type: Boolean, required: true },
  shops: { type: Array, required: true },
})

const emit = defineEmits([
  'close',
  'scan',
  'import-weeks',
  'open-resolve',
  'submit-resolve',
  'close-resolve',
  'delete-week',
])

function importOne(weekId) {
  emit('import-weeks', [weekId])
}

function importAll() {
  const list = (props.importScan?.unimported || [])
    .filter((f) => f.listingFiles && f.listingFiles.length)
    .map((f) => f.weekId)
  emit('import-weeks', list)
}

function openResolve(row, index) {
  emit('open-resolve', { row, index })
}
</script>

<template>
  <el-dialog
    :model-value="showImportPanel"
    class="opa-dialog import-dialog"
    title="扫描并导入周数据"
    width="1200px"
    top="3vh"
    @close="emit('close')"
    @update:model-value="(v) => { if (!v) emit('close') }"
  >
    <div class="drawer-tip">
      周数据目录放在 <code>public/data/第x周/</code>，目录内需包含订单利润表和 Listing销售库存表。导入后每周数据会永久保存到 <code>src/data/weeks/</code>。
    </div>
    <div class="drawer-actions" style="margin-top: 8px">
      <el-button :disabled="importLoading || importBusy" @click="emit('scan')">{{ importLoading ? '扫描中...' : '重新扫描' }}</el-button>
    </div>
    <div v-if="importMessage" class="drawer-tip" :class="{ 'is-loading': importLoading || importBusy }">
      <span v-if="importLoading || importBusy" class="loading-dot loading-spin"></span>
      {{ importMessage }}
    </div>

    <section v-if="importScan.unimported.length" class="shop-form">
      <div class="shop-list-head">待导入（{{ importScan.unimported.length }}）</div>
      <el-table :data="importScan.unimported" border class="opa-table" max-height="280">
        <el-table-column label="周次 / 目录" min-width="220">
          <template #default="scope">{{ scope.row.weekId }} · {{ scope.row.folderName }}</template>
        </el-table-column>
        <el-table-column label="导入类型" width="100">
          <template #default="scope">
            <el-tag v-if="scope.row.importMode === 'reimport'" type="warning" effect="plain">重新导入</el-tag>
            <el-tag v-else type="success" effect="plain">新导入</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="文件" min-width="330">
          <template #default="scope">
            <div>订单：{{ scope.row.orderFile }}</div>
            <div>
              {{ (scope.row.listingFiles && scope.row.listingFiles.length)
                ? `库存：${scope.row.listingFiles.join('、')}`
                : '缺少 Listing销售库存' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="时间范围" min-width="170">
          <template #default="scope">{{ scope.row.startDate || '—' }} ~ {{ scope.row.endDate || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="scope">
            <el-button
              type="primary"
              size="small"
              :loading="importBusy"
              :disabled="importBusy || importLoading || !(scope.row.listingFiles && scope.row.listingFiles.length)"
              @click="importOne(scope.row.weekId)"
            >
              导入
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="form-actions">
        <el-button
          type="primary"
          :loading="importBusy"
          :disabled="importBusy || importLoading || !importScan.unimported.some((f) => f.listingFiles && f.listingFiles.length)"
          @click="importAll"
        >
          全部导入
        </el-button>
      </div>
    </section>
    <div v-else class="drawer-tip" style="padding: 20px 16px">
      没有待导入的周目录。请把新一周文件放到 <code>public/data/第x周/</code> 后再次扫描。
    </div>

    <section v-if="importResult && importResult.length" class="shop-form">
      <div class="shop-list-head">导入结果</div>
      <el-table :data="importResult" border class="opa-table" max-height="280">
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag v-if="scope.row.error" type="danger">失败</el-tag>
            <el-tag v-else type="success">成功</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="周次" width="160">
          <template #default="scope">{{ scope.row.weekId || '未知周次' }}</template>
        </el-table-column>
        <el-table-column label="摘要" min-width="520">
          <template #default="scope">
            <template v-if="scope.row.error">
              <span style="color: #f54a45">{{ scope.row.error }}</span>
            </template>
            <template v-else>
              <div>{{ scope.row.folderName }} · {{ scope.row.rowCount }} 行</div>
              <div class="shop-meta">
                新增店铺 {{ (scope.row.newShops || []).length }} · 新增 ASIN {{ (scope.row.newAsins || []).length }}
                · 未命中 {{ scope.row.unmatchedTotal || 0 }} · Listing 新品 {{ scope.row.listingOnlyAddedTotal || 0 }}
              </div>
              <div v-if="scope.row.listingOnlyUnresolvedByFile && scope.row.listingOnlyUnresolvedByFile.length" class="shop-meta" style="color: #f5b32f">
                待确认：{{ scope.row.listingOnlyUnresolvedByFile.map((x) => `${x.listingFile}(${x.count})`).join(' ｜ ') }}
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="150" fixed="right">
          <template #default="scope">
            <el-button
              v-if="!scope.row.error && scope.row.listingOnlyUnresolvedByFile && scope.row.listingOnlyUnresolvedByFile.length"
              size="small"
              :disabled="resolvePanel.busy"
              @click="openResolve(scope.row, scope.$index)"
            >
              选择店铺并写入
            </el-button>
            <span v-else class="shop-meta">-</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="resolvePanel.show" class="shop-form resolve-card">
      <div class="shop-list-head">无法推断店铺，手动分配</div>
      <div class="drawer-tip" style="margin-top: 8px">{{ resolvePanel.message }}</div>
      <el-table :data="resolvePanel.items" border class="opa-table" max-height="260">
        <el-table-column label="ASIN" width="180">
          <template #default="scope"><span class="shop-id">{{ scope.row.asin }}</span></template>
        </el-table-column>
        <el-table-column label="来源 Listing" min-width="240">
          <template #default="scope">{{ scope.row.listingFile || '—' }}</template>
        </el-table-column>
        <el-table-column label="店铺" min-width="220">
          <template #default="scope">
            <el-select v-model="scope.row.shopId" :disabled="resolvePanel.busy" placeholder="请选择店铺" style="width: 100%" filterable>
              <el-option v-for="s in shops" :key="s.id" :value="s.id" :label="s.name" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
      <div class="form-actions">
        <el-button type="primary" :loading="resolvePanel.busy" :disabled="!resolveReady || resolvePanel.busy" @click="emit('submit-resolve')">
          确认写入
        </el-button>
        <el-button :disabled="resolvePanel.busy" @click="emit('close-resolve')">取消</el-button>
      </div>
    </section>

    <div class="shop-list-head">已导入（{{ importScan.imported.length }}）</div>
    <el-table :data="importScan.imported" border class="opa-table" max-height="260" empty-text="尚未导入任何周">
      <el-table-column prop="filename" label="周文件" min-width="270" />
      <el-table-column label="时间范围" min-width="170">
        <template #default="scope">{{ scope.row.startDate }} ~ {{ scope.row.endDate }}</template>
      </el-table-column>
      <el-table-column label="行数" width="110" align="right">
        <template #default="scope">{{ scope.row.rowCount }}</template>
      </el-table-column>
      <el-table-column label="导入时间" min-width="170">
        <template #default="scope">{{ (scope.row.importedAt || '').replace('T', ' ').slice(0, 19) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="scope">
          <el-button size="small" type="danger" plain @click="emit('delete-week', scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>
