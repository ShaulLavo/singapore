import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
          // A hang cap, not a speed judgment: the oracle and property tests are
          // CPU-heavy and their duration depends on how busy the machine is.
          testTimeout: 120_000,
        },
      },
      {
        // Cascade and box geometry: which layer the widget lands on and where
        // its edge falls once a strip is claimed. happy-dom resolves neither,
        // so it would answer every one of these assertions with a default.
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
