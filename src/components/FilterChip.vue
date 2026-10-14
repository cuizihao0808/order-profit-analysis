<script setup>
import { computed } from 'vue'

/**
 * 筛选胶囊：「标签 当前值 ▾」，点开选项；选了非默认值时高亮并出现 ✕ 一键清除。
 * options: [{ value, label }]，第一项视为默认值（“全部”）。
 */
const props = defineProps({
  label: { type: String, required: true },
  options: { type: Array, required: true },
})
const model = defineModel({ type: String, default: '__all__' })

const defaultValue = computed(() => props.options[0]?.value ?? '__all__')
const active = computed(() => model.value !== defaultValue.value)
const currentLabel = computed(() => props.options.find((o) => o.value === model.value)?.label ?? '全部')
</script>

<template>
  <el-dropdown trigger="click" max-height="360px" @command="(v) => (model = v)">
    <button type="button" class="filter-chip" :class="{ on: active }">
      <span class="filter-chip-label">{{ label }}</span>
      <span class="filter-chip-value">{{ currentLabel }}</span>
      <span v-if="active" class="filter-chip-clear" title="清除" @click.stop="model = defaultValue">✕</span>
      <span v-else class="filter-chip-caret">▾</span>
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="o in options"
          :key="o.value"
          :command="o.value"
          :class="{ 'filter-chip-picked': o.value === model }"
        >
          {{ o.label }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
