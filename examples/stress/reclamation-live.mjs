import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from '@playwright/test'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'

const bundle = await build({
  root: fileURLToPath(new URL('.', import.meta.url)),
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    lib: {
      entry: fileURLToPath(new URL('./reclamation-live-entry.js', import.meta.url)),
      formats: ['es'],
      fileName: () => 'app.js',
    },
  },
})
const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) => result.output)
const files = new Map(
  output.map((file) => [file.fileName, file.type === 'asset' ? file.source : file.code]),
)
const hash = createHash('sha256')
for (const [name, contents] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  hash.update(name).update(contents)
}
const bundleHash = hash.digest('hex')
const css = [...files.keys()].find((name) => name.endsWith('.css'))
const server = createServer((request, response) => {
  const name = request.url.slice(1)
  if (!name) {
    response.setHeader('content-type', 'text/html')
    response.end(
      `<!doctype html><link rel="stylesheet" href="/${css}"><script type="module" src="/app.js"></script>`,
    )
    return
  }
  response.setHeader('content-type', name.endsWith('.css') ? 'text/css' : 'text/javascript')
  response.end(files.get(name) ?? '')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })

async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  return (await cdp.send('Runtime.getHeapUsage')).usedSize
}

async function sample(workload, cycles) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => Boolean(window.reclamationLive))
    const cdp = await context.newCDPSession(page)
    const baseline = await heap(cdp)
    const churn = await page.evaluate(
      ([workload, cycles]) => window.reclamationLive.churn(cycles, workload),
      [workload, cycles],
    )
    const before = await heap(cdp)
    assert.equal(
      await page.evaluate(
        () => window.reclamationLive.buffer.getStorageMaintenanceStats().completed,
      ),
      0,
      'pre-maintenance heap measurement missed its window',
    )
    await page.waitForFunction(
      () => window.reclamationLive.buffer.getStorageMaintenanceStats().completed > 0,
    )
    await page.waitForTimeout(1000)
    const after = await heap(cdp)
    // Only the aligned workload promises a release; the others measure how little is freeable.
    if (workload === 'aligned') {
      assert.ok(
        after - baseline < (before - baseline) * 0.9,
        'automatic maintenance must release retained heap',
      )
    }
    const maintained = await page.evaluate(() => {
      const { buffer, editors } = window.reclamationLive
      return {
        stats: buffer.getStorageMaintenanceStats(),
        revision: buffer.getRevision(),
        dirty: buffer.isDirty(),
        texts: editors.map((editor) => editor.materializeFullText()),
      }
    })
    assert.equal(maintained.revision, churn.revision)
    assert.equal(maintained.dirty, true)
    assert.deepEqual(maintained.texts, [churn.text, churn.text])
    delete maintained.texts
    if (workload === 'aligned') assert.ok(maintained.stats.chunks > 0)
    const history = await page.evaluate(() => window.reclamationLive.undoRedo())
    assert.equal(history.valid, true)
    assert.ok(history.count >= 100)
    await page.evaluate(() => window.reclamationLive.prepareInput())
    await page.keyboard.type('typed ')
    await page.waitForFunction(
      (text) =>
        window.reclamationLive.editors.every(
          (editor) => editor.materializeFullText() === `typed ${text}`,
        ),
      churn.text,
    )
    await page.locator('#editor-1').getByText('typed prefix', { exact: false }).first().waitFor()
    const completed = await page.evaluate(() => {
      const { buffer, editors } = window.reclamationLive
      editors[0].openDocument({ documentId: 'replacement.txt', text: 'replacement' })
      editors[1].dispose()
      return buffer.getStorageMaintenanceStats().completed
    })
    await page.waitForTimeout(500)
    assert.equal(
      await page.evaluate(
        () => window.reclamationLive.buffer.getStorageMaintenanceStats().completed,
      ),
      completed,
    )
    await page.evaluate(() => window.reclamationLive.dispose())
    assert.deepEqual(errors, [])
    const { text, ...churnFacts } = churn
    return {
      workload,
      cycles,
      ...churnFacts,
      liveUnits: text.length,
      heapBefore: before - baseline,
      heapAfter: after - baseline,
      ...maintained,
      history,
      peerTextsMatch: true,
      trustedTyping: true,
      replacementAndDisposal: true,
      consoleErrors: errors,
    }
  } finally {
    await context.close()
  }
}

try {
  const samples = []
  for (const workload of ['aligned', 'survivors', 'mixed']) {
    for (const cycles of [500, 1000]) {
      for (let repetition = 0; repetition < 3; repetition++) {
        samples.push(await sample(workload, cycles))
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        bundleHash,
        measuredAt: new Date().toISOString(),
        note: 'Workloads: aligned (16 KiB inserts, all deleted), survivors (1 KiB inserts keeping 64 units), mixed (1 KiB inserts, three of four deleted). Two mounted editors sharing the default 200-state history. Same-page CDP GC before/after automatic maintenance. Trusted typing and peer rendering checked after full undo/redo. No typing-to-paint latency claim.',
        samples,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
