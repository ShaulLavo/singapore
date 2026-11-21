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
  assert.equal(await page.getByRole('button', { name: 'Go to byte' }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: 'End', exact: true }).isDisabled(), true)
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

  const beforeWarm = await open(page, { prewarmed: true })
  const warm = await colored(page, beforeWarm)
  assert.deepEqual(beforeWarm.reads, beforeCold.reads)
  const distantBlock = 500_000
  const { tileBytes, fixtureBytes, replacementBlock } = await page.evaluate(() => ({
    tileBytes: __pagedCode.tileBytes,
    fixtureBytes: __pagedCode.fixtureBytes,
    replacementBlock: __pagedCode.replacementBlock,
  }))
  const distantByte = distantBlock * tileBytes
  const beforeJumpColor = await jumpTo(page, distantByte)
  assert.equal(beforeJumpColor.source.totals.byteLength, undefined)
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

  const rapid = await verifyRapidJump(page, tileBytes, replacementBlock)
  const closedHighlighted = await closeSyntaxView(page, 'highlighted')
  const failedJump = await verifyFailedJump(page, fixtureBytes + tileBytes)
  await holdNextReply(page)
  const pending = await jumpTo(page, distantByte)
  await waitForHeldReply(page)
  assert.equal(pending.syntax.status.kind, 'pending')
  const closedPending = await closeSyntaxView(page, 'pending')

  await colored(page, await open(page, { prewarmed: true }))
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
    fixtureBytes,
    cold,
    warm,
    theme,
    forward,
    back: back.syntax,
    normalScroll,
    distant,
    latest: rapid.latest,
    distinctLayouts: rapid.distinctLayouts,
    failedJump,
    closedHighlighted,
    closedPending,
    retained,
    plain,
    giant: { units: giantUnits, ...giant },
  }
}

async function jumpTo(page: Page, byte: number): Promise<Snapshot> {
  await page.getByRole('spinbutton', { name: 'Byte offset' }).fill(String(byte))
  await page.getByRole('button', { name: 'Go to byte' }).click()
  await page.locator(`${firstRow}[data-byte="${byte}"]`).waitFor()
  return read(page)
}

async function holdNextReply(page: Page): Promise<void> {
  await page.evaluate(() => __pagedSliceReplies.holdNext())
}

async function waitForHeldReply(page: Page): Promise<void> {
  await page.waitForFunction(() => __pagedSliceReplies.status())
  assert.equal(await page.evaluate(() => __pagedSliceReplies.status()), 'highlighted')
}

async function verifyRapidJump(page: Page, tileBytes: number, replacementBlock: number) {
  const oldByte = 120_000 * tileBytes
  const newByte = replacementBlock * tileBytes
  await colored(page, await jumpTo(page, oldByte))
  const oldLayout = await paintedRanges(page)
  await colored(page, await jumpTo(page, newByte))
  const expected = await paintedRanges(page)
  const oldRow = oldLayout.filter((range) => range.row === 3)
  const newRow = expected.filter((range) => range.row === 3)
  assert(oldRow.some((range) => range.text === 'const'))
  assert(newRow.some((range) => range.text === 'function'))
  assert.notDeepEqual(
    oldRow.map(({ from, to }) => [from, to]),
    newRow.map(({ from, to }) => [from, to]),
  )

  await colored(page, await open(page, { prewarmed: true }))
  await holdNextReply(page)
  const oldWindow = await jumpTo(page, oldByte)
  await waitForHeldReply(page)
  assert.equal(oldWindow.syntax.status.kind, 'pending')
  const current = await jumpTo(page, newByte)
  assert.equal(current.syntax.status.kind, 'pending')
  assert.deepEqual(await paintedRanges(page), [])
  await page.evaluate(() => {
    __pagedSliceReplies.release()
    __pagedSliceReplies.holdNext()
  })
  await waitForHeldReply(page)
  assert.equal((await read(page)).syntax.status.kind, 'pending')
  assert.deepEqual(await paintedRanges(page), [])
  await page.evaluate(() => __pagedSliceReplies.release())

  const latest = await colored(page, current)
  await assertBlock(page, replacementBlock)
  assert.deepEqual(await paintedRanges(page), expected)
  return { latest, distinctLayouts: { before: oldRow, current: newRow } }
}

async function verifyFailedJump(page: Page, outside: number) {
  await holdNextReply(page)
  const before = await open(page, { prewarmed: true })
  await waitForHeldReply(page)
  const original = await page.locator(rows).first().elementHandle()
  try {
    await page.getByRole('spinbutton', { name: 'Byte offset' }).fill(String(outside))
    await page.getByRole('button', { name: 'Go to byte' }).click()
    await page.getByRole('status').filter({ hasText: 'outside the file' }).waitFor()
    assert(
      await original.evaluate((node, selector) => node === document.querySelector(selector), rows),
    )
    const failed = await read(page)
    assert(failed.source.sourceRequests > before.source.sourceRequests)
    assert.equal(failed.syntax.status.kind, 'pending')
    await page.evaluate(() => __pagedSliceReplies.release())
    const recovered = await colored(page, failed)
    assert(
      await original.evaluate((node, selector) => node === document.querySelector(selector), rows),
    )
    assert(
      (await paintedRanges(page)).some((range) => range.row === 0 && range.text === '/* Paged 🦊'),
    )
    return { mountedTextRetained: true, status: recovered.status }
  } finally {
    await original.dispose()
  }
}

async function paintedRanges(page: Page) {
  return page.evaluate((selector) => {
    const textNodes = Array.from(
      document.querySelectorAll(selector),
      (element) => element.firstChild,
    )
    const results = []
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('paged-syntax-')) continue
      for (const range of highlight) results.push(readRange(name, range))
    }
    return results.sort(
      (left, right) => left.row - right.row || left.from - right.from || left.to - right.to,
    )

    function readRange(name: string, range: AbstractRange) {
      const { startContainer: node, endContainer, startOffset: from, endOffset: to } = range
      if (
        !(range instanceof Range) ||
        !(node instanceof Text) ||
        !node.isConnected ||
        !node.parentElement ||
        node !== endContainer
      )
        throw new Error('A syntax range points outside the current mounted text')
      const row = textNodes.indexOf(node)
      if (row === -1) throw new Error('A syntax range points outside the current mounted text')
      const text = range.toString()
      if (!text || text !== node.data.slice(from, to))
        throw new Error('A syntax range changed its text')
      return {
        row,
        from,
        to,
        text,
        color: getComputedStyle(node.parentElement, `::highlight(${name})`).color,
      }
    }
  }, rows)
}

async function closeSyntaxView(page: Page, phase: 'highlighted' | 'pending') {
  assert.equal((await read(page)).syntax.status.kind, phase)
  const before = await syntaxResources(page)
  assert(before.styles > 0)
  if (phase === 'highlighted') assert(before.highlights > 0)
  await page.getByRole('button', { name: 'Close file' }).click()
  if (phase === 'pending') await page.evaluate(() => __pagedSliceReplies.release())
  assert.equal(await page.evaluate(() => __pagedCode.inspect()), null)
  assert.equal(await page.locator(rows).count(), 0)
  assert.deepEqual(await syntaxResources(page), { highlights: 0, styles: 0 })
  return before
}

function syntaxResources(page: Page) {
  return page.evaluate(() => ({
    highlights: Array.from(CSS.highlights.keys()).filter((name) => name.startsWith('paged-syntax-'))
      .length,
    styles: Array.from(document.querySelectorAll('style')).filter((style) =>
      Array.from(style.sheet?.cssRules ?? []).some((rule) =>
        rule.cssText.includes('::highlight(paged-syntax-'),
      ),
    ).length,
  }))
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
