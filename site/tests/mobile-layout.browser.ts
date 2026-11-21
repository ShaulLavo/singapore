import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webkit, type Browser, type Locator } from 'playwright'
import { hasChromium, startPreview, type Preview } from './preview'

const evidence = join(
  tmpdir(),
  'singapore-mobile-evidence',
  new Date().toISOString().replaceAll(':', '-'),
)
for (const engine of ['chromium', 'webkit'] as const) {
  describe.skipIf(!hasChromium() || (engine === 'webkit' && !existsSync(webkit.executablePath())))(
    `${engine} resized examples (requires built site and installed browser)`,
    () => {
      let preview: Preview
      let browser: Browser
      beforeAll(async () => {
        await mkdir(evidence, { recursive: true })
        console.log(`Singapore mobile evidence: ${evidence}`)
        preview = await startPreview()
        browser = engine === 'chromium' ? preview.browser : await webkit.launch()
      })
      afterAll(async () => {
        if (engine === 'webkit') await browser?.close()
        await preview?.stop()
      })
      test('a large paste switches the example to bounded internal scrolling', async () => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
        try {
          const page = await context.newPage()
          await page.goto(`${preview.base}/docs/start-here/quick-start/`)
          const example = page.locator('[data-example]').first()
          await example.getByRole('button', { name: /Edit/ }).click()
          await expect.poll(() => example.getAttribute('data-example-live')).toBe('')
          const editor = example.locator('.example-prepared .editor-virtualized')
          expect(await editor.getAttribute('data-editor-scroll-mode')).toBe('content')

          await page.keyboard.insertText('const value = 1\n'.repeat(6_000))
          await expect
            .poll(() => editor.getAttribute('data-editor-scroll-mode'))
            .toBe('virtualized')
          const metrics = await editor.evaluate((element) => ({
            scrolls: element.scrollHeight > element.clientHeight,
            rows: element.querySelectorAll('[data-editor-virtual-row]').length,
          }))
          expect(metrics.scrolls).toBe(true)
          expect(metrics.rows).toBeGreaterThan(0)
          expect(metrics.rows).toBeLessThan(200)
        } finally {
          await context.close()
        }
      })
      test.each(['/', '/docs/start-here/playground/'])(
        'resizing %s preserves the frame and live wrapping',
        async (path) => {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            reducedMotion: 'reduce',
          })
          try {
            const page = await context.newPage()
            await page.goto(`${preview.base}${path}`)
            await page.evaluate(() => document.fonts.ready)
            const example = page.locator('[data-example]').first()
            const label = `${engine}-${path === '/' ? 'home' : 'playground'}`
            await expect
              .poll(() => example.getAttribute('data-example-ready'), { timeout: 20000 })
              .toBe('')
            expect(
              await example.locator('.example-prepared .editor-virtualized-metric-probe').count(),
            ).toBeGreaterThan(0)
            await page.locator('site-search button, button.search-open').first().click()
            await page.locator('dialog[open]').waitFor()
            for (const viewport of [
              { width: 320, height: 844 },
              { width: 844, height: 390 },
              { width: 320, height: 390 },
            ]) {
              await page.setViewportSize(viewport)
              await page.evaluate(() => document.fonts.ready)
              const hiddenGeometry = await page.evaluate((width) => {
                const frames = document.querySelectorAll<HTMLElement>('.example-stage')
                const overflowing = Array.from(frames).flatMap((frame) => {
                  const bounds = frame.getBoundingClientRect()
                  const fits = (rect: DOMRect) =>
                    rect.left >= Math.max(0, bounds.left) &&
                    rect.right <= Math.min(width, bounds.right)
                  return Array.from(frame.querySelectorAll('*'))
                    .filter((element) => {
                      const rect = element.getBoundingClientRect()
                      return rect.width > 0 && rect.height > 0 && !fits(rect)
                    })
                    .filter((element) => {
                      // Hidden editors and probes count; only an actual clip contains their bounds.
                      for (
                        let parent = element.parentElement;
                        parent && parent !== frame.parentElement;
                        parent = parent.parentElement
                      ) {
                        const overflow = getComputedStyle(parent).overflowX
                        if (
                          ['auto', 'scroll', 'hidden', 'clip'].includes(overflow) &&
                          fits(parent.getBoundingClientRect())
                        )
                          return false
                      }
                      return true
                    })
                    .map((element) => ({
                      class: element.className.toString(),
                      left: element.getBoundingClientRect().left,
                      right: element.getBoundingClientRect().right,
                    }))
                })
                return {
                  width: innerWidth,
                  document: document.scrollingElement!.scrollWidth,
                  overflowing,
                }
              }, viewport.width)
              expect(await example.getAttribute('data-example-live')).toBeNull()
              expect(
                await example
                  .locator('.example-prepared')
                  .evaluate((element) => getComputedStyle(element).visibility),
              ).toBe('hidden')
              await writeFile(
                join(evidence, `${label}-${viewport.width}x${viewport.height}-prepared.json`),
                JSON.stringify(hiddenGeometry, null, 2),
              )
              expect(hiddenGeometry).toEqual({
                width: viewport.width,
                document: viewport.width,
                overflowing: [],
              })
            }
            await page.keyboard.press('Escape')
            const staticRows = await example
              .locator('.example-static [data-editor-document-paint]:visible')
              .locator('[data-editor-document-paint-row]')
              .allTextContents()
            expect(staticRows.length).toBeGreaterThan(0)
            // The stage's background spans the figure; the paint keeps its captured width.
            const staticWidth = await example
              .locator('.example-static')
              .evaluate((element) => element.clientWidth)
            await example.getByRole('button', { name: /Edit/ }).click()
            await expect.poll(() => example.getAttribute('data-example-live')).toBe('')
            await expectExampleWrapping(
              example.locator('.example-prepared .editor-virtualized'),
              staticRows,
            )
            await page.screenshot({ path: join(evidence, `${label}.png`), fullPage: true })
            const geometry = await example.evaluate((element) => {
              const frame = element.querySelector<HTMLElement>('.example-prepared')!
              const editor = element.querySelector<HTMLElement>('.editor-virtualized')!
              const extent = element.querySelector<HTMLElement>('.editor-virtualized-extent')!
              return {
                frame: frame.clientWidth,
                editor: editor.clientWidth,
                content: editor.scrollWidth,
                extent: extent.getBoundingClientRect().width,
                height: editor.clientHeight,
                contentHeight: editor.scrollHeight,
              }
            })
            await writeFile(
              join(evidence, `${label}.json`),
              JSON.stringify({ staticWidth, staticRows, geometry }, null, 2),
            )
            expect(geometry).toEqual({
              frame: staticWidth,
              editor: staticWidth,
              content: staticWidth,
              extent: staticWidth,
              height: geometry.contentHeight,
              contentHeight: geometry.contentHeight,
            })
          } finally {
            await context.close()
          }
        },
      )
    },
  )
}

async function expectExampleWrapping(editor: Locator, expected: readonly string[]): Promise<void> {
  const rows = editor.locator('[data-editor-virtual-row]')
  const step = await editor.evaluate((element) => {
    const rowHeight = Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--editor-row-height'),
    )
    return Math.max(1, Math.floor(window.innerHeight / rowHeight / 2))
  })
  for (let first = 0; first < expected.length; first += step) {
    await editor.evaluate((element, index) => {
      const rowHeight = Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--editor-row-height'),
      )
      const top = element.getBoundingClientRect().top + window.scrollY + index * rowHeight
      window.scrollTo({ top, behavior: 'instant' })
    }, first)
    const band = expected.slice(first, first + step)
    await expect
      .poll(async () => {
        const mounted = await rows.evaluateAll((elements) =>
          Array.from(elements, (element): [number, string | null] => [
            Number(element.getAttribute('data-editor-virtual-row')),
            element.textContent,
          ]),
        )
        const byIndex = new Map(mounted)
        return band.map((_, offset) => byIndex.get(first + offset))
      })
      .toEqual(band)
  }
}
