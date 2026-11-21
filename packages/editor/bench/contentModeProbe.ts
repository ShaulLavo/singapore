import { chromium, firefox, webkit } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(join(tmpdir(), 'singapore-fling-'))

try {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dirname, 'contentModeFling.ts')],
    outdir: directory,
  })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  const paths = new Map(
    build.outputs.map((output) => [`/${output.path.split('/').at(-1)}`, output.path]),
  )
  paths.set('/', join(import.meta.dirname, 'content-mode-fling.html'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = paths.get(new URL(request.url).pathname)
      return path ? new Response(Bun.file(path)) : new Response(null, { status: 404 })
    },
  })
  try {
    for (const engine of [chromium, firefox, webkit]) {
      await probe(engine, server.url.href)
    }
  } finally {
    await server.stop(true)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

async function probe(engine: typeof chromium, url: string): Promise<void> {
  const browser = await engine.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 660 },
      deviceScaleFactor: 2,
    })
    await page.goto(url)
    await page.waitForSelector('#fling[data-results]')
    await page.mouse.move(190, 300)
    for (const delta of [184, 330, 610, 920, 780, 420, 210, -200, -720, -940, -505]) {
      await page.mouse.wheel(0, delta)
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
      )
    }
    await page.waitForFunction(() => {
      const result = document.querySelector<HTMLElement>('#fling')?.dataset.results
      return result && JSON.parse(result).distance > 1800
    })
    const result = JSON.parse((await page.locator('#fling').getAttribute('data-results'))!)
    console.log(engine.name(), browser.version(), result)
    assert.equal(result.missingFrames, 0, 'A frame was missing visible document rows')
    assert.ok(result.peakMounted < 200, 'Too many rows mounted')
  } finally {
    await browser.close()
  }
}
