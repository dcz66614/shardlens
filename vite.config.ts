import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// P0002 ShardLens — T002 工程骨架配置。
// 仅固定构建与测试运行环境；测试文件（tests/*.spec.ts(x)）由后续任务提供，
// scripts/benchmark.ts 由 T023 提供。此处不包含任何业务算法配置。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
})
