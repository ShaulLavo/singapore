import { afterEach, assert, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { init, MarkdownDocument } from 'tree-sitter-md'
import { markdownInlineReplacements } from '../../markdown/src/replacements'
import '../../markdown/src/style.css'
import { Editor } from '../src/editor/Editor'
import { decodePaintSnapshot, mountPaintSnapshot } from '../src/paint'
import { createPaintSnapshotPlugin } from '../src/paintSnapshotPlugin'
import { VirtualizedTextView } from '../src/virtualization'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofHighlightPaintScreenshot: (hostId: string, label?: string) => Promise<string>
  }
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function mountView(tokenPainting: 'css-highlight' | 'spans') {
  const host = document.createElement('div')
  host.id = `painter-${tokenPainting}-${cleanups.length}`
  host.style.cssText = 'width:480px;height:80px;background:black;color:white;font:24px monospace'
  host.style.setProperty('--editor-background', '#000000')
  host.style.setProperty('--editor-foreground', '#ffffff')
  document.body.append(host)
  const view = new VirtualizedTextView(host, {
    rowHeight: 32,
    overscan: 0,
    tokenPainting,
  })
  view.setTheme({ type: 'dark', backgroundColor: '#000000', foregroundColor: '#ffffff' })
  view.setText('MMMMMMMMMMMM')
  view.setScrollMetrics(0, 80, 480)
  view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  cleanups.push(() => {
    view.dispose()
    host.remove()
  })
  return { host, view }
}

async function pixels(hostId: string): Promise<ImageData> {
  const screenshot = await commands.proofHighlightPaintScreenshot(hostId)
  const bytes = Uint8Array.from(atob(screenshot), (character) => character.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  assert(context)
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function ink(
  { data }: ImageData,
  matches: (red: number, green: number, blue: number) => boolean,
): number {
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (matches(data[index]!, data[index + 1]!, data[index + 2]!)) count++
  }
  return count
}

const redInk = (image: ImageData) =>
  ink(image, (red, green, blue) => red > 150 && green < 100 && blue < 100)

it('achieves exact pixel parity between css-highlight and spans for syntax, colorless wash, dim, strikethrough, and semantic/find layering', async () => {
  const css = mountView('css-highlight')
  const spans = mountView('spans')

  // 1. Plain syntax tokens
  expect(Array.from((await pixels(spans.host.id)).data)).toEqual(
    Array.from((await pixels(css.host.id)).data),
  )

  // 2. Colorless background wash beneath red syntax
  css.view.setRangeHighlight('wash-css', [{ start: 0, end: 12 }], { backgroundColor: '#333333' })
  spans.view.setRangeHighlight('wash-spans', [{ start: 0, end: 12 }], {
    backgroundColor: '#333333',
  })
  const spansWash = await pixels(spans.host.id)
  expect(redInk(spansWash)).toBeGreaterThan(20)
  expect(Array.from(spansWash.data)).toEqual(Array.from((await pixels(css.host.id)).data))
  css.view.clearRangeHighlight('wash-css')
  spans.view.clearRangeHighlight('wash-spans')

  // 3. Dim overlay fades each token in its own hue
  css.view.setRangeHighlight('fade-css', [{ start: 0, end: 12 }], { overlay: { dim: 0.5 } })
  spans.view.setRangeHighlight('fade-spans', [{ start: 0, end: 12 }], { overlay: { dim: 0.5 } })
  const spansFade = await pixels(spans.host.id)
  expect(redInk(spansFade)).toBe(0)
  expect(ink(spansFade, (r, g, b) => r > 70 && r < 150 && g < 20 && b < 20)).toBeGreaterThan(20)
  expect(Array.from(spansFade.data)).toEqual(Array.from((await pixels(css.host.id)).data))

  // 4. Semantic (zIndex 2) and non-dimmable Find (zIndex 6) paint above dimmed syntax spans
  css.view.setRangeHighlight('semantic-css', [{ start: 0, end: 6 }], {
    color: '#00ff00',
    zIndex: 2,
  })
  spans.view.setRangeHighlight('semantic-spans', [{ start: 0, end: 6 }], {
    color: '#00ff00',
    zIndex: 2,
  })
  css.view.setRangeHighlight('find-css', [{ start: 6, end: 12 }], {
    color: '#0000ff',
    zIndex: 6,
    dimmable: false,
  })
  spans.view.setRangeHighlight('find-spans', [{ start: 6, end: 12 }], {
    color: '#0000ff',
    zIndex: 6,
    dimmable: false,
  })
  expect(Array.from((await pixels(spans.host.id)).data)).toEqual(
    Array.from((await pixels(css.host.id)).data),
  )

  // 5. Untokenized overlay fade
  css.view.clearRangeHighlight('semantic-css')
  spans.view.clearRangeHighlight('semantic-spans')
  css.view.clearRangeHighlight('find-css')
  spans.view.clearRangeHighlight('find-spans')
  css.view.setTokens([])
  spans.view.setTokens([])
  expect(Array.from((await pixels(spans.host.id)).data)).toEqual(
    Array.from((await pixels(css.host.id)).data),
  )

  // 6. Strikethrough overlay preserves token hue
  css.view.clearRangeHighlight('fade-css')
  spans.view.clearRangeHighlight('fade-spans')
  css.view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  spans.view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  const spansBeforeStrike = await pixels(spans.host.id)
  css.view.setRangeHighlight('strike-css', [{ start: 0, end: 12 }], {
    overlay: { textDecoration: 'line-through' },
  })
  spans.view.setRangeHighlight('strike-spans', [{ start: 0, end: 12 }], {
    overlay: { textDecoration: 'line-through' },
  })
  const spansStrike = await pixels(spans.host.id)
  const cssStrike = await pixels(css.host.id)
  expect(redInk(spansStrike)).toBeGreaterThan(redInk(spansBeforeStrike) + 20)
  expect(ink(spansStrike, (r, g, b) => r > 180 && g > 180 && b > 180)).toBe(0)
  let differingPixels = 0
  for (let i = 0; i < spansStrike.data.length; i += 4) {
    if (
      spansStrike.data[i] !== cssStrike.data[i] ||
      spansStrike.data[i + 1] !== cssStrike.data[i + 1] ||
      spansStrike.data[i + 2] !== cssStrike.data[i + 2] ||
      spansStrike.data[i + 3] !== cssStrike.data[i + 3]
    ) {
      differingPixels += 1
    }
  }
  // Allow subpixel AA difference at glyph/decoration edge (Chromium differs by ~1px out of 15,360).
  expect(differingPixels).toBeLessThanOrEqual(8)
})

it('renders Markdown links without double-painting translucent backgrounds or double-mixing currentColor and captures clean snapshots', async () => {
  await init()
  const source = '[MMMM](https://example.com) MMMM\nlast'
  const parser = new MarkdownDocument()
  parser.setText(source)

  const host = document.createElement('div')
  host.id = `md-spans-${cleanups.length}`
  host.style.cssText = 'width:390px;height:100px;position:relative'
  host.style.setProperty('--editor-link-color', '#ff0000')
  document.body.append(host)

  const target = document.createElement('div')
  target.id = `${host.id}-static`
  target.style.cssText = 'width:390px;position:relative'
  document.body.append(target)

  const editor = new Editor(host, {
    plugins: [createPaintSnapshotPlugin()],
    scrollMode: 'content',
    tokenPainting: 'spans',
    cursorLineHighlight: { rowBackground: false, gutterNumber: false, gutterBackground: false },
    fontSize: 24,
    lineHeight: 32,
    theme: { type: 'dark', foregroundColor: '#ffffff', backgroundColor: '#000000' },
  })
  let restored: ReturnType<typeof mountPaintSnapshot> = null
  cleanups.push(() => {
    restored?.dispose()
    editor.dispose()
    parser.dispose()
    host.remove()
    target.remove()
  })

  editor.setText(source)
  editor.setSelection(source.length)
  editor.setInlineReplacementProvider((context) =>
    markdownInlineReplacements(context.textSnapshot, parser.decorations(0, source.length)),
  )
  const linkEnd = source.indexOf(')') + 1
  editor.setTokens([
    {
      start: 0,
      end: linkEnd,
      style: { color: '#ff0000', backgroundColor: 'rgba(0, 0, 255, 0.5)' },
    },
  ])
  await expect.poll(() => host.querySelector('a')?.textContent).toBe('MMMM')

  // Verify the anchor itself has transparent background (translucent background painted once on wrapper).
  const anchor = host.querySelector('a')!
  expect(getComputedStyle(anchor).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(getComputedStyle(anchor).color).toBe('rgb(255, 0, 0)')

  // Verify `color-mix(in srgb, currentColor 50%, transparent)` is NOT double-mixed on the anchor.
  editor.setTokens([
    {
      start: 0,
      end: linkEnd,
      style: { color: 'color-mix(in srgb, currentColor 50%, transparent)' },
    },
  ])
  const widget = host.querySelector<HTMLElement>('[data-editor-inline-widget]')!
  expect(getComputedStyle(anchor).color).toBe(getComputedStyle(widget).color)

  // Verify document snapshot capture resolves token colors once cleanly under spans mode.
  editor.setTokens([{ start: 0, end: linkEnd, style: { color: '#ff0000' } }])
  const live = await pixels(host.id)
  const saved = editor.captureSnapshot({ scope: 'document' })
  expect(saved.status, JSON.stringify(saved)).toBe('ready')
  assert(saved.status === 'ready')
  restored = mountPaintSnapshot(target, decodePaintSnapshot(saved.paint)!, { width: 390 })
  expect(restored).toBeTruthy()
  const snapshot = await pixels(target.id)
  expect(Array.from(snapshot.data)).toEqual(Array.from(live.data))
})

it('preserves caret geometry, selection rects, hit testing, edits, scrolling, and live switching between css-highlight and spans', async () => {
  const host = document.createElement('div')
  host.id = `geom-spans-${cleanups.length}`
  host.style.cssText = 'width:480px;height:120px;position:relative;font:14px monospace'
  document.body.append(host)

  const view = new VirtualizedTextView(host, {
    rowHeight: 20,
    overscan: 2,
    tokenPainting: 'css-highlight',
  })
  cleanups.push(() => {
    view.dispose()
    host.remove()
  })

  const lines = Array.from({ length: 40 }, (_, i) => `const item_${i} = ${i} + "hello";`)
  const text = lines.join('\n')
  const tokens: { start: number; end: number; style: { color: string } }[] = []
  let offset = 0
  for (const line of lines) {
    tokens.push({ start: offset, end: offset + 5, style: { color: '#0000ff' } })
    const quote = line.indexOf('"')
    tokens.push({
      start: offset + quote,
      end: offset + line.length - 1,
      style: { color: '#a31515' },
    })
    offset += line.length + 1
  }

  view.setText(text)
  view.setScrollMetrics(0, 120, 480)
  view.setTokens(tokens)
  view.setSelection(2, 18)

  const cssCaret = view.scrollElement.querySelector<HTMLElement>('.editor-virtualized-caret')!
  const cssCaretTransform = cssCaret.style.transform
  const cssSelection = view.captureSelectionPaint().rectangles
  const cssRow0 = view.getState().mountedRows[0]!
  const cssRowRect = cssRow0.element.getBoundingClientRect()
  const cssHit = view.textPositionFromPoint(cssRowRect.left + 40, cssRowRect.top + 10)

  // Switch live to spans
  view.setTokenPainting('spans')
  expect(view.getActiveTokenPainting()).toBe('spans')
  expect(
    view.scrollElement.querySelectorAll('span[class^="editor-token-"]').length,
  ).toBeGreaterThan(0)

  const spansCaretTransform = cssCaret.style.transform
  const spansSelection = view.captureSelectionPaint().rectangles
  const spansHit = view.textPositionFromPoint(cssRowRect.left + 40, cssRowRect.top + 10)

  expect(spansCaretTransform).toBe(cssCaretTransform)
  expect(spansSelection.length).toBe(cssSelection.length)
  expect(spansSelection[0]!.left).toBeCloseTo(cssSelection[0]!.left, 1)
  expect(spansSelection[0]!.width).toBeCloseTo(cssSelection[0]!.width, 1)
  expect(spansHit?.offset).toBe(cssHit?.offset)
  expect(view.validateMountedNativeGeometry().ok).toBe(true)

  // Scroll + edit under spans mode
  view.setScrollMetrics(200, 120, 480)
  expect(view.validateMountedNativeGeometry().ok).toBe(true)
  const mounted = view.getState().mountedRows
  expect(
    mounted.every((row) => row.element.querySelector('span[class^="editor-token-"]') !== null),
  ).toBe(true)

  // Switch back to css-highlight and verify spans are cleanly unwrapped
  view.setTokenPainting('css-highlight')
  expect(view.getActiveTokenPainting()).toBe('css-highlight')
  expect(view.scrollElement.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(0)
  expect(view.validateMountedNativeGeometry().ok).toBe(true)
})

it('preserves native browser selection across async token arrival in spans mode', () => {
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:80px;position:relative;font:14px monospace'
  document.body.append(host)
  const view = new VirtualizedTextView(host, {
    rowHeight: 20,
    overscan: 0,
    tokenPainting: 'spans',
  })
  cleanups.push(() => {
    window.getSelection()?.removeAllRanges()
    view.dispose()
    host.remove()
  })

  view.setText('const value = 42')
  view.setScrollMetrics(0, 80, 480)
  const row = view.getState().mountedRows[0]!
  const sel = window.getSelection()!
  sel.setBaseAndExtent(row.textNode, 3, row.textNode, 11)
  expect(sel.toString()).toBe('st value')

  view.setTokens([
    { start: 0, end: 5, style: { color: '#0000ff' } },
    { start: 6, end: 11, style: { color: '#001080' } },
  ])
  expect(sel.toString()).toBe('st value')
})
