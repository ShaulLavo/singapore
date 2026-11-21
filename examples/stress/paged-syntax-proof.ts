import assert from 'node:assert/strict'
import type { Page } from '@playwright/test'

type Snapshot = NonNullable<ReturnType<typeof __pagedCode.inspect>>
type OpenOptions = NonNullable<Parameters<typeof __pagedCode.open>[0]>

const firstRow = '[data-fragment="0"]'
const rows = '[data-fragment] [data-text]'

export async function runPagedSyntaxProof(page: Page) {
  const beforeCold = await open(page)
  assert.equal(beforeCold.source.totals.byteLength, undefined)
  assert.equal(beforeCold.source.totals.lineCount, undefined)
  assert.equal(beforeCold.source.totals.utf16Length, undefined)
  const cold = await colored(page, beforeCold)
  assert.equal(cold.status.quality, 'known-start')
  assert.equal(cold.status.cached, false)
  assert.equal(await page.locator(rows).first().textContent(), '/* Paged 🦊')
  const theme = await verifyPalette(page)

  await page.getByRole('button', { name: 'Next page' }).click()
  await page.waitForFunction(
    (selector) => Number(document.querySelector<HTMLElement>(selector)?.dataset.byte) > 0,
    firstRow,
  )
  const forward = await colored(page, await read(page))
  await page.getByRole('button', { name: 'Previous page' }).click()
  await page.locator(`${firstRow}[data-byte="0"]`).waitFor()
  const back = await read(page)
  assert.equal(
    back.syntax.status.kind,
    'highlighted',
    'Backscroll colors are present with the text',
  )
  assert.equal(back.syntax.status.cached, true)
  assert.equal(back.syntax.cacheHits, 1)
  assert.deepEqual(back.reads, beforeCold.reads)

  const region = page.getByRole('region', { name: 'Read-only file range' })
  await region.hover()
  await page.mouse.wheel(0, 47)
  await page.waitForFunction(
    (selector) => Number(document.querySelector<HTMLElement>(selector)?.dataset.byte) > 0,
    firstRow,
  )
  const normalScroll = await colored(page, await read(page))
  assert.equal(normalScroll.status.quality, 'provisional')

  const beforeWarm = await open(page, { prewarmed: true, lengthKnown: true })
  const warm = await colored(page, beforeWarm)
  assert.deepEqual(beforeWarm.reads, beforeCold.reads)
  const distantBlock = 500_000
  const tileBytes = await page.evaluate(() => __pagedCode.tileBytes)
  const distantByte = distantBlock * tileBytes
  await page.getByRole('spinbutton', { name: 'Byte offset' }).fill(String(distantByte))
  await page.getByRole('button', { name: 'Go to byte' }).click()
  await page.locator(`${firstRow}[data-byte="${distantByte}"]`).waitFor()
  const beforeJumpColor = await read(page)
  assert(beforeJumpColor.reads.length > beforeWarm.reads.length)
  assert(
    beforeJumpColor.reads
      .slice(beforeWarm.reads.length)
      .every(({ start }) => start >= distantByte - 131_072),
  )
  const distant = await colored(page, beforeJumpColor)
  assert.equal(distant.status.quality, 'provisional')
  assert.equal(distant.status.cached, false)
  await assertBlock(page, distantBlock)

  const rapid = await page.evaluate(
    async ({ tileBytes }) => {
      await __pagedCode.showByte(120_000 * tileBytes)
      const superseded = __pagedCode.inspect()?.syntax.status.kind
      await __pagedCode.showByte(320_000 * tileBytes)
      return { superseded, snapshot: __pagedCode.inspect() }
    },
    { tileBytes },
  )
  assert.equal(rapid.superseded, 'pending')
  assert(rapid.snapshot)
  const latest = await colored(page, rapid.snapshot)
  await assertBlock(page, 320_000)

  const retained = await longScroll(page, tileBytes)
  await page.evaluate(async (tileBytes) => {
    __pagedCode.revise()
    await __pagedCode.showByte(600_000 * tileBytes)
  }, tileBytes)
  const invalidated = await read(page)
  assert.equal(invalidated.source.state, 'stale')
  assert.equal(invalidated.syntax.cacheEntries, 0)
  assert.equal(await page.locator(rows).count(), 0)
  assert.equal(await visibleRangeCount(page), 0)

  const beforePlain = await open(page, { language: 'unsupported' })
  const plain = await plainText(page, beforePlain, 'unsupported-language')
  assert.deepEqual(beforePlain.reads, beforeCold.reads)
  assert.equal(await page.locator(rows).first().textContent(), '/* Paged 🦊')
  const beforeGiant = await open(page, { giantLine: true })
  const giant = await plainText(page, beforeGiant, 'over-budget')
  const giantUnits = (await page.locator(rows).first().textContent())?.length ?? 0
  assert(giantUnits > 32_768)
  assert.equal(await visibleRangeCount(page), 0)

  return {
    fixtureBytes: beforeWarm.source.totals.byteLength,
    cold,
    warm,
    theme,
    forward,
    back: back.syntax,
    normalScroll,
    distant,
    latest,
    retained,
    plain,
    giant: { units: giantUnits, ...giant },
  }
}

async function open(page: Page, options: OpenOptions = {}): Promise<Snapshot> {
  const snapshot = await page.evaluate((options) => __pagedCode.open(options), options)
  assert(snapshot)
  assert(snapshot.reads.length > 0)
  return snapshot
}

async function read(page: Page): Promise<Snapshot> {
  const snapshot = await page.evaluate(() => __pagedCode.inspect())
  assert(snapshot)
  return snapshot
}

async function colored(page: Page, before: Snapshot) {
  await page.waitForFunction(() => {
    const kind = __pagedCode.inspect()?.syntax.status.kind
    return kind === 'highlighted' || kind === 'plain'
  })
  const { source, syntax, reads } = await read(page)
  assert.equal(syntax.status.kind, 'highlighted', JSON.stringify(syntax.status))
  assert(syntax.status.tokens > 0)
  assert((await visibleRangeCount(page)) > 0)
  assert.deepEqual(reads, before.reads)
  assert.equal(source.requestedBytes, before.source.requestedBytes)
  return {
    ...syntax,
    status: syntax.status,
    sourceBytesRead: source.requestedBytes,
    sourceReads: reads.length,
  }
}

async function plainText(page: Page, before: Snapshot, reason: string) {
  await page.waitForFunction(() => __pagedCode.inspect()?.syntax.status.kind === 'plain')
  const { syntax, reads, source } = await read(page)
  assert.deepEqual(syntax.status, { kind: 'plain', reason })
  assert.deepEqual(reads, before.reads)
  assert.equal(await visibleRangeCount(page), 0)
  return { ...syntax, sourceBytesRead: source.requestedBytes, sourceReads: reads.length }
}

async function verifyPalette(page: Page) {
  const result = await page.evaluate(() => {
    for (const [name, highlight] of CSS.highlights) {
      const keyword = Array.from(highlight).find(
        (range) => range instanceof Range && range.toString() === 'const',
      )
      const content = keyword?.startContainer.parentElement
      const host = document.querySelector<HTMLElement>('#view')
      if (!content || !host) continue
      const normal = getComputedStyle(content).color
      const original = getComputedStyle(content, `::highlight(${name})`).color
      host.style.setProperty('--editor-syntax-keyword-declaration', '#0b2277')
      const changed = getComputedStyle(content, `::highlight(${name})`).color
      host.style.removeProperty('--editor-syntax-keyword-declaration')
      return { normal, original, changed }
    }
    return null
  })
  assert(result, 'A rendered CSS Highlight owns the exact keyword')
  assert.notEqual(result.original, result.normal)
  assert.equal(result.changed, 'rgb(11, 34, 119)')
  const screenshot = await page.locator('[data-fragment="2"] [data-text]').screenshot()
  const bluePixels = await countBluePixels(page, screenshot.toString('base64'))
  assert(bluePixels > 0, 'The browser painted the default keyword color')
  await page.waitForTimeout(100)
  const afterIdle = await read(page)
  assert.equal(afterIdle.source.sourceRequests, 1)
  assert.equal(afterIdle.source.requestedBytes, 65_536)
  return { ...result, bluePixels }
}

function countBluePixels(page: Page, png: string): Promise<number> {
  return page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    if (!context) throw new Error('Missing screenshot canvas')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    let count = 0
    for (let index = 0; index < data.length; index += 4) {
      const [red, green, blue] = [data[index]!, data[index + 1]!, data[index + 2]!]
      if (blue > red + 40 && blue > green + 40) count++
    }
    return count
  }, png)
}

async function longScroll(page: Page, tileBytes: number) {
  const samples = []
  for (let index = 0; index < 40; index++) {
    await page.evaluate((byte) => __pagedCode.showByte(byte), (1_000 + 37 * index) * tileBytes)
    const sample = await colored(page, await read(page))
    assert(sample.cacheEntries <= 32)
    assert(sample.retainedTextUnits <= 262_144)
    assert(sample.retainedTokens <= 24_576)
    samples.push(sample)
  }
  return {
    windows: samples.length,
    maximumEntries: Math.max(...samples.map((sample) => sample.cacheEntries)),
    maximumTextUnits: Math.max(...samples.map((sample) => sample.retainedTextUnits)),
    maximumTokenBufferBytes: Math.max(...samples.map((sample) => sample.tokenBufferBytes)),
    maximumRenderSpans: Math.max(...samples.map((sample) => sample.retainedRenderSpans)),
  }
}

async function visibleRangeCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    Array.from(CSS.highlights.values()).reduce((count, group) => count + group.size, 0),
  )
}

async function assertBlock(page: Page, block: number): Promise<void> {
  const title = `export const page = "${String(block).padStart(8, '0')}";`
  assert((await page.locator(rows).allTextContents()).includes(title))
}
