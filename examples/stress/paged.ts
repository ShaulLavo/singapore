import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type CDPSession, type Page, type Route } from '@playwright/test'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const origin = 'https://paged.local'
const mime = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
])
const pageBytes = 65_536
type Mode = 'demand' | 'indexed' | 'traverse' | 'resident' | 'streamed'
type Opened = Awaited<ReturnType<typeof __paged.open>>
type Stats = Opened['stats']

const availableModes: readonly Mode[] = ['demand', 'indexed', 'traverse', 'resident', 'streamed']
const isMode = (value: string): value is Mode => availableModes.some((mode) => mode === value)
const viewport = { width: 1200, height: 720 }
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    sizes: { type: 'string', default: '10485760' },
    modes: { type: 'string', default: 'demand,indexed' },
  },
})
assert(values.output, '--output is required')
const sizes = values.sizes.split(',').map(Number)
const modes = values.modes.split(',')
assert(
  sizes.every((size) => Number.isSafeInteger(size) && size >= 1024),
  'Invalid sizes',
)
assert(modes.every(isMode), 'Invalid modes')
assert(
  !modes.includes('demand') || sizes.every((size) => size >= 2 * pageBytes + 4096),
  'The demand proof needs room for two pages and a cancellation probe',
)

await mkdir(dirname(resolve(values.output)), { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'singapore-paged-'))
let browser: Browser | undefined
let interrupted = false
const interrupt = () => {
  interrupted = true
  void browser?.close().catch(() => {})
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    build: { outDir: directory, rolldownOptions: { input: resolve(root, 'paged.html') } },
  })
  assert(!interrupted, 'Interrupted')
  browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: directory } })
  assert(!interrupted, 'Interrupted')
  const samples = []
  for (const size of sizes) {
    for (const mode of modes) samples.push(await sample(browser, size, mode))
  }
  await writeFile(
    values.output,
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        at: new Date().toISOString(),
        browser: browser.version(),
        memory:
          'Main-renderer JS heap sampled with CDP. Peak excludes brief allocations and process RSS.',
        viewport,
        samples,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await browser?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}

async function asset(route: Route) {
  const path = resolve(directory, '.' + new URL(route.request().url()).pathname)
  if (!path.startsWith(directory + sep)) return route.abort()
  await route.fulfill({
    body: await readFile(path),
    contentType: mime.get(extname(path)) ?? 'application/octet-stream',
  })
}

async function heap(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage')
  return cdp.send('Runtime.getHeapUsage')
}

async function sample(browser: Browser, size: number, mode: Mode) {
  const context = await browser.newContext({
    viewport,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  try {
    await context.route(`${origin}/**`, asset)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await page.goto(`${origin}/paged.html`)
    const cdp = await context.newCDPSession(page)
    const emptyHeap = await heap(cdp)
    let peakHeap = emptyHeap.usedSize
    const timer = setInterval(() => {
      void cdp
        .send('Runtime.getHeapUsage')
        .then((usage) => {
          peakHeap = Math.max(peakHeap, usage.usedSize)
        })
        .catch(() => {})
    }, 100)
    try {
      const scenario = await runScenario(page, size, mode)
      const liveHeap = await heap(cdp)
      peakHeap = Math.max(peakHeap, liveHeap.usedSize)
      await page.getByRole('button', { name: 'Close file' }).click()
      assert.equal(await page.locator('#view').textContent(), '')
      const disposedHeap = await heap(cdp)
      const row = { mode, size, ...scenario, emptyHeap, liveHeap, peakHeap, disposedHeap }
      console.log(JSON.stringify(row))
      return row
    } finally {
      clearInterval(timer)
    }
  } finally {
    await context.close()
  }
}

async function runScenario(page: Page, size: number, mode: Mode) {
  if (mode === 'resident' || mode === 'streamed') {
    const opened = await page.evaluate(({ size, mode }) => __paged.compare(mode, size), {
      size,
      mode,
    })
    return { opened }
  }
  const opened = await page.evaluate(({ size, mode }) => __paged.open(size, mode), { size, mode })
  assert.equal(
    await page.locator('[data-line="1"] [data-text]').textContent(),
    opened.tile.slice(0, -2),
  )
  if (mode === 'demand') return { opened, demand: await demand(page, opened) }
  if (mode === 'indexed') return { opened, indexed: await indexedJump(page, opened) }
  const traversal = await page.evaluate(() => __paged.traverse())
  assert.equal(traversal.through, opened.bytes)
  assert.equal(traversal.pieces, opened.bytes / opened.tileBytes + 1)
  assert.equal(traversal.stats.totals.byteLength, opened.bytes)
  assertBounds(traversal.stats)
  return { opened, traversal }
}

async function demand(page: Page, opened: Opened) {
  assert.equal(opened.stats.sourceRequests, 1)
  assert.equal(opened.stats.requestedBytes, pageBytes)
  assert.equal(opened.stats.deliveredBytes, 27 * opened.tileBytes)
  assert.equal(opened.stats.totals.byteLength, undefined)
  assert.equal(opened.stats.totals.lineCount, undefined)
  assert.equal(await page.getByRole('button', { name: 'Go to line' }).isVisible(), false)
  await page.waitForTimeout(100)
  const idle = await stats(page)
  assert.equal(idle.sourceRequests, opened.stats.sourceRequests)
  const scroll = await scrollAndLearnLength(page, opened)
  const copy = await copySelection(page, opened)
  const cancellation = await closeDuringRead(page)
  assertBounds(copy.stats)
  return { idle, scroll, copy, cancellation }
}

async function scrollAndLearnLength(page: Page, opened: Opened) {
  const view = page.getByRole('region', { name: 'Read-only file range' })
  await page.evaluate(() => __paged.revealLength())
  await view.hover()
  const start = performance.now()
  const offset = 2 * opened.tileBytes
  await page.mouse.wheel(0, 47)
  await page.locator(`[data-fragment="0"][data-byte="${offset}"]`).waitFor()
  await page.getByRole('button', { name: 'Go to byte' }).waitFor()
  const ms = performance.now() - start
  const anchor = await view.evaluate((region) => ({
    byte: Number(region.querySelector<HTMLElement>('[data-byte]')?.dataset.byte),
    intraRowPixels: region.scrollTop,
  }))
  assert.deepEqual(anchor, { byte: offset, intraRowPixels: 7 })
  const after = await stats(page)
  assert.equal(after.sourceRequests, 2)
  assert.equal(after.totals.byteLength, opened.bytes)
  assert.equal(after.totals.lineCount, undefined)
  return { ms, anchor, stats: after }
}

async function copySelection(page: Page, opened: Opened) {
  const view = page.getByRole('region', { name: 'Read-only file range' })
  const before = await stats(page)
  await view.evaluate((region) => {
    if (region instanceof HTMLElement) region.focus({ preventScroll: true })
    const nodes = region.querySelectorAll('[data-text]')
    document.getSelection()!.setBaseAndExtent(nodes[0]!.firstChild!, 3, nodes[1]!.firstChild!, 5)
  })
  const start = performance.now()
  await page.keyboard.press('Control+c')
  const text = await page.evaluate(() => navigator.clipboard.readText())
  const ms = performance.now() - start
  assert.equal(text, opened.tile.slice(3) + opened.tile.slice(0, 5))
  const after = await stats(page)
  assert.equal(after.sourceRequests, before.sourceRequests)
  assert.equal(after.deliveredBytes, before.deliveredBytes)
  return { ms, text, stats: after }
}

async function closeDuringRead(page: Page) {
  await page.evaluate(() => __paged.holdReads())
  await page.getByRole('spinbutton', { name: 'Byte offset' }).fill(String(pageBytes + 4096))
  await page.getByRole('button', { name: 'Go to byte' }).click()
  await page.waitForFunction(() => __paged.stats()?.inFlight === 1)
  await page.getByRole('button', { name: 'Close file' }).click()
  await page.waitForFunction(() => __paged.closed().cancelled === 1)
  const closed = await page.evaluate(() => __paged.closed())
  assert.equal(closed.stats?.state, 'disposed')
  assert.equal(closed.stats.cachedBytes, 0)
  assert.equal(closed.stats.checkpoints, 0)
  return closed
}

async function indexedJump(page: Page, opened: Opened) {
  await page.evaluate((start) => __paged.requireReadStart(start), opened.farByte)
  await page
    .getByRole('spinbutton', { name: 'Global line number' })
    .fill(String(opened.farLine + 1))
  const start = performance.now()
  await page.getByRole('button', { name: 'Go to line' }).click()
  const first = page.locator(`[data-fragment="0"][data-line="${opened.farLine + 1}"] [data-text]`)
  assert.equal(await first.textContent(), opened.tile.slice(0, -2))
  const ms = performance.now() - start
  const after = await stats(page)
  assert.equal(after.sourceRequests - opened.stats.sourceRequests, 1)
  assert.equal(after.indexCheckpoints, 1)
  assertBounds(after)
  return { ms, line: opened.farLine, firstPermittedByte: opened.farByte, stats: after }
}

async function stats(page: Page) {
  const value = await page.evaluate(() => __paged.stats())
  assert(value, 'The paged document is closed')
  return value
}

function assertBounds(data: Stats) {
  assert(data.peakCachedBytes <= 8 * 1024 * 1024)
  assert(data.checkpoints <= 4096)
  assert(data.peakInFlight <= 2)
}
