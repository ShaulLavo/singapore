import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The worker imports it; discovering it mid-run makes Vite reload the page under a running test.
  optimizeDeps: { include: ['cspell-trie-lib'] },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        // The real worker: dictionary fetch, gzip inflation and the message protocol.
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
          include: ['test/**/*.browser.test.ts'],
        },
      },
    ],
  },
})
