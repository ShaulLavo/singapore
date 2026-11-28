import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { browserTestResponses } from '../../scripts/browser-test-responses.ts'
import { workspaceRoot } from '../../scripts/workspace-root.ts'

export default defineConfig({
  server: { fs: { allow: [workspaceRoot] } },
  test: {
    reporters: process.env.CI === 'true' ? 'verbose' : undefined,
    projects: [
      {
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        plugins: [browserTestResponses()],
        server: { fs: { allow: [workspaceRoot] } },
        optimizeDeps: {
          exclude: ['web-tree-sitter', 'tree-sitter-md'],
          include: [
            '@shikijs/engine-oniguruma',
            '@shikijs/engine-oniguruma/wasm-inlined',
            'shiki/core',
          ],
        },
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            viewport: { width: 800, height: 600 },
            fileParallelism: false,
            provider: playwright(),
            commands: {
              proofInsertText: async ({ page }, text: string) => {
                const cdp = await page.context().newCDPSession(page)
                await cdp.send('Input.insertText', { text })
                await cdp.detach()
              },
              proofViewportScreenshot: async ({ iframe }, hostId: string) => {
                const image = await iframe
                  .locator(`#${hostId}`)
                  .screenshot({ animations: 'disabled' })
                return image.toString('base64')
              },
            },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
