import { defineConfig } from '../../packages/editor/node_modules/vitest/dist/config.js'

export default defineConfig({
  test: { include: ['scripts/ci/test-projects.test.ts'], fileParallelism: false },
})
