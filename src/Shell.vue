<script setup>
import { ref, watch } from 'vue'
import App from './App.vue'
import FocusProducts from './components/FocusProducts.vue'
import ReplenishmentPlan from './components/ReplenishmentPlan.vue'

const PAGE_KEY = 'opa:page:v1'
const SIDEBAR_KEY = 'opa:sidebar-collapsed:v1'

const PAGES = [
  { id: 'weekly', label: '周订单利润', short: '周' },
  { id: 'focus', label: '重点关注产品', short: '重' },
  { id: 'replenish', label: '补货批次计划', short: '补' },
]

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
function writeStored(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

const storedPage = readStored(PAGE_KEY, 'weekly')
const page = ref(PAGES.some((p) => p.id === storedPage) ? storedPage : 'weekly')
const collapsed = ref(readStored(SIDEBAR_KEY, '0') === '1')

watch(page, (v) => writeStored(PAGE_KEY, v))
watch(collapsed, (v) => writeStored(SIDEBAR_KEY, v ? '1' : '0'))
</script>

<template>
  <div class="shell" :class="{ 'shell-collapsed': collapsed }">
    <aside class="side-nav">
      <div class="side-nav-head">
        <span class="title-badge">OPA</span>
        <span v-if="!collapsed" class="side-nav-brand">订单利润分析</span>
      </div>
      <nav class="side-nav-list">
        <button
          v-for="p in PAGES"
          :key="p.id"
          class="side-nav-item"
          :class="{ active: page === p.id }"
          :title="p.label"
          @click="page = p.id"
        >
          <span class="side-nav-icon">{{ p.short }}</span>
          <span v-if="!collapsed" class="side-nav-label">{{ p.label }}</span>
        </button>
      </nav>
      <button class="side-nav-toggle" :title="collapsed ? '展开侧栏' : '折叠侧栏'" @click="collapsed = !collapsed">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" :style="{ transform: collapsed ? 'rotate(180deg)' : '' }">
          <path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="!collapsed">折叠</span>
      </button>
    </aside>
    <main class="shell-main">
      <KeepAlive>
        <App v-if="page === 'weekly'" />
        <FocusProducts v-else-if="page === 'focus'" />
        <ReplenishmentPlan v-else-if="page === 'replenish'" />
      </KeepAlive>
    </main>
  </div>
</template>
