import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // 每个测试文件一个独立进程：集成测试里的 process.chdir 不会影响其它文件，可以并行
    pool: 'forks',
    environmentMatchGlobs: [['tests/**/*.ui.test.js', 'jsdom']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 业务规则、composables、组件、页面、工具函数都统计
      include: ['src/**/*.{js,vue}'],
      exclude: ['src/main.js', 'src/data/**'],
      thresholds: {
        // 整体底线（含 App.vue）：防止新代码完全不写测试
        lines: 90,
        functions: 80,
        branches: 80,
        statements: 90,
        // 纯业务规则要求最高
        'src/lib/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
        'src/composables/**': { lines: 95, functions: 95, branches: 85, statements: 95 },
        'src/components/**': { lines: 90, functions: 60, branches: 80, statements: 90 },
      },
    },
  },
})
