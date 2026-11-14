import { join, basename } from 'node:path'
import type { SuiteAdapter } from 'waffle/testing/page-runner'
import {
  apiCase,
  caseIds,
  check,
  checkApi,
  checkCaseResult,
  checkKeySnapshot,
  keySteps,
  keysCase,
} from './contract'

export const singaporeIphoneAdapter: SuiteAdapter<null> = {
  suite: 'singapore-iphone-api-and-keys',
  inventory: () => [
    {
      id: apiCase,
      label: 'API selection, edit, undo, redo, reveal and disposal',
      request: () => null,
      async drive(host) {
        await host.task('window.singaporeApiResult = await window.singaporeNative.api();')
        const result = await host.script('return window.singaporeApiResult;')
        checkApi(result)
        return result
      },
    },
    {
      id: keysCase,
      label: 'WebDriver ArrowRight, Home, ArrowUp and Enter with trusted key edges',
      request: () => null,
      async drive(host) {
        await host.task('await window.singaporeNative.setupKeys();')
        const steps: unknown[] = []
        for (const step of keySteps) {
          await host.script('window.singaporeNative.clearEvents();')
          await host.press(step.key)
          const snapshot = await host.script('return window.singaporeNative.snapshot();')
          checkKeySnapshot(snapshot, step)
          steps.push(snapshot)
        }
        return { channel: 'webdriver-keys', steps }
      },
    },
  ],
  policy: {
    listIds(value) {
      check(JSON.stringify(value) === JSON.stringify(caseIds), 'Case inventory differs')
      return caseIds.slice()
    },
    requireResult: true,
    check: checkCaseResult,
  },
  async assets() {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'page.ts')],
      target: 'browser',
      naming: '[name].[ext]',
    })
    check(built.success, `Page build failed: ${built.logs.join('\n')}`)
    const assets = Object.fromEntries(
      built.outputs.map((output) => [`/${basename(output.path)}`, output]),
    )
    check(assets['/page.js'] && assets['/page.css'], 'Page script or editor stylesheet is missing')
    return assets
  },
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: 60_000,
    operation: 15_000,
    teardown: 5000,
    caseDocument: 90_000,
    group: 90_000,
    run: 240_000,
  }),
}
