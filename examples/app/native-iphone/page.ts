import { cleanupStorage, startPage } from 'waffle/testing/page-runner/page'
import { caseIds } from './contract'
import { installWorkload } from './workload'
import '@singapore-editor/core/style.css'

declare global {
  interface Window {
    singaporeNative: ReturnType<typeof installWorkload>
    singaporeApiResult: Awaited<ReturnType<ReturnType<typeof installWorkload>['api']>>
  }
}

const viewport = document.createElement('meta')
viewport.name = 'viewport'
viewport.content = 'width=device-width, initial-scale=1'
document.head.append(viewport)
document.body.style.margin = '0'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = '/page.css'
await new Promise<void>((resolve, reject) => {
  style.onload = () => resolve()
  style.onerror = () => reject(new Error('Editor stylesheet did not load'))
  document.head.append(style)
})

window.singaporeNative = installWorkload()
window.addEventListener('pagehide', () => window.singaporeNative.dispose(), { once: true })
startPage<null>({
  list: async () => caseIds,
  run: { kind: 'host', teardown: async () => window.singaporeNative.dispose() },
  finish: cleanupStorage,
})
