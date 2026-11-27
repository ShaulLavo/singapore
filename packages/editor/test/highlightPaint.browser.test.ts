import { afterEach, assert, expect, it, vi } from 'vitest'
import { commands } from 'vitest/browser'
import { createInlineMap } from '../src/inlineMap'
import { createPieceTableSnapshot } from '../src/public/document'
import {
  createDomRangeForChunkRange,
  createStaticRangeForChunkRange,
} from '../src/virtualization/virtualizedTextViewGeometry'
import { Editor } from '../src/editor/Editor'
import { init, MarkdownDocument } from 'tree-sitter-md'
import { markdownInlineReplacements } from '../../markdown/src/replacements'
import { decodePaintSnapshot, mountPaintSnapshot } from '../src/paint'
import '../../markdown/src/style.css'
import { VirtualizedTextView } from '../src/virtualization'
import { createPaintSnapshotPlugin } from '../src/paintSnapshotPlugin'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofHighlightPaintScreenshot: (hostId: string, label?: string) => Promise<string>
  }
}

const mounted: { host: HTMLElement; view: VirtualizedTextView }[] = []
afterEach(() => {
  for (const { host, view } of mounted.splice(0)) {
    view.dispose()
    host.remove()
  }
})

it('keeps syntax red beneath a colorless wash in every engine', async () => {
  const { host, view } = mount()
  const control = await pixels(host.id)
  expect(redInk(control)).toBeGreaterThan(20)
  view.setRangeHighlight('paint-wash', [{ start: 0, end: 12 }], { backgroundColor: '#333333' })
  const painted = await pixels(host.id)
  expect(redInk(painted)).toBeGreaterThan(20)
})

it('fades each token in its own hue', async () => {
  const { host, view } = mount()
  view.setRangeHighlight('fade', [{ start: 0, end: 12 }], { overlay: { dim: 0.5 } })
  const painted = await pixels(host.id)
  expect(redInk(painted)).toBe(0)
  expect(
    ink(painted, (red, green, blue) => red > 70 && red < 150 && green < 20 && blue < 20),
  ).toBeGreaterThan(20)
})

it('keeps a plain-text overlay range after an atomic text update', async () => {
  const { host, view } = mount()
  view.setTokens([])
  view.setRangeHighlight('spelling', [{ start: 4, end: 9 }], {
    overlay: { textDecoration: 'underline wavy blue' },
  })
  await pixels(host.id)
  view.runAtomicRender(() => {
    view.setText('NMMMMMMMMMMM')
    view.setRangeHighlight('spelling', [{ start: 4, end: 9 }], {
      overlay: { textDecoration: 'underline wavy blue' },
    })
  })
  await pixels(host.id)
  const ranges = [...CSS.highlights]
    .filter(([name]) => name.includes('-overlay-base-'))
    .flatMap(([, highlight]) =>
      Array.from(highlight, (range) => [range.startOffset, range.endOffset]),
    )
  expect(ranges).toEqual([[4, 9]])
})

it('strikes syntax with a line in the same explicit hue', async () => {
  const { host, view } = mount()
  const control = await pixels(host.id)
  view.setRangeHighlight('strike', [{ start: 0, end: 12 }], {
    overlay: { textDecoration: 'line-through' },
  })
  const painted = await pixels(host.id)
  expect(redInk(painted)).toBeGreaterThan(redInk(control) + 20)
  expect(ink(painted, (red, green, blue) => red > 180 && green > 180 && blue > 180)).toBe(0)
})

it('fades untokenized foreground and preserves higher-priority colors', async () => {
  const { host, view } = mount()
  view.setTokens([])
  view.setRangeHighlight('fade', [{ start: 0, end: 12 }], { overlay: { dim: 0.5 } })
  const base = await pixels(host.id)
  expect(
    ink(
      base,
      (red, green, blue) =>
        red > 70 && red < 150 && Math.abs(red - green) < 3 && Math.abs(red - blue) < 3,
    ),
  ).toBeGreaterThan(20)
  view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  view.setRangeHighlight('semantic', [{ start: 0, end: 12 }], { color: '#00ff00', zIndex: 2 })
  const semantic = await pixels(host.id)
  expect(redInk(semantic)).toBe(0)
  expect(
    ink(semantic, (red, green, blue) => red < 20 && green > 70 && green < 150 && blue < 20),
  ).toBeGreaterThan(20)
  view.setRangeHighlight('find', [{ start: 0, end: 12 }], {
    color: '#0000ff',
    zIndex: 6,
    dimmable: false,
  })
  expect(
    ink(await pixels(host.id), (red, green, blue) => red < 20 && green < 20 && blue > 180),
  ).toBeGreaterThan(20)
})

function mount() {
  const host = document.createElement('div')
  host.id = `paint-${mounted.length}`
  host.style.cssText = 'width:480px;height:80px;background:black;color:white;font:24px monospace'
  host.style.setProperty('--editor-background', '#000000')
  host.style.setProperty('--editor-foreground', '#ffffff')
  document.body.append(host)
  const view = new VirtualizedTextView(host, { rowHeight: 32, overscan: 0 })
  // The fades below are measured against black, which the view would otherwise paint white.
  view.setTheme({ type: 'dark', backgroundColor: '#000000', foregroundColor: '#ffffff' })
  view.setText('MMMMMMMMMMMM')
  view.setScrollMetrics(0, 80, 480)
  view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  mounted.push({ host, view })
  return { host, view }
}

async function pixels(hostId: string, label?: string): Promise<ImageData> {
  const screenshot = await commands.proofHighlightPaintScreenshot(hostId, label)
  const bytes = Uint8Array.from(atob(screenshot), (character) => character.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  assert(context)
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function redInk({ data }: ImageData): number {
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index]! > 150 && data[index + 1]! < 100 && data[index + 2]! < 100) count++
  }
  return count
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

it('keeps an equal-priority range color above twins after a token refresh', async () => {
  const { host, view } = mount()
  view.setRangeHighlight('color', [{ start: 0, end: 12 }], { color: '#00ff00' })
  view.setRangeHighlight('fade', [{ start: 0, end: 6 }], { overlay: { dim: 0.5 } })
  view.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
  const painted = await pixels(host.id)
  expect(redInk(painted)).toBe(0)
  expect(ink(painted, (red, green, blue) => red < 20 && green > 70 && blue < 20)).toBeGreaterThan(
    20,
  )
})

it('refreshes only the revealed editor ranges and preserves shared syntax groups', () => {
  const peer = mount()
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:80px;visibility:hidden'
  document.body.append(host)
  const editor = new Editor(host, { presentationReady: false })
  try {
    editor.setText('MMMMMMMMMMMM')
    editor.setTokens([{ start: 0, end: 12, style: { color: '#ff0000' } }])
    const entry = [...CSS.highlights].find(([, group]) =>
      [...group].some((range) => host.contains(range.startContainer)),
    )!
    expect(entry).toBeDefined()
    const [name, group] = entry
    const ranges = [...group]
    const owned = ranges.filter((range) => host.contains(range.startContainer))
    const peerRanges = ranges.filter((range) => peer.host.contains(range.startContainer))
    expect(owned.length).toBeGreaterThan(0)
    expect(peerRanges.length).toBeGreaterThan(0)
    const removed = vi.spyOn(group, 'delete')
    host.style.visibility = 'visible'
    editor.setPresentationReady(true)
    expect(removed.mock.calls.map(([range]) => range)).toEqual(
      CSS.supports('-webkit-nbsp-mode', 'space') ? owned : [],
    )
    expect(CSS.highlights.get(name)).toBe(group)
    expect(new Set(group)).toEqual(new Set(ranges))
    removed.mockClear()
    editor.setPresentationReady(true)
    expect(removed).not.toHaveBeenCalled()
    editor.setPresentationReady(false)
    editor.setPresentationReady(true)
    expect(removed.mock.calls.map(([range]) => range)).toEqual(
      CSS.supports('-webkit-nbsp-mode', 'space') ? owned : [],
    )
    editor.dispose()
    expect([...group]).toEqual(peerRanges)
    removed.mockClear()
    editor.setPresentationReady(false)
    editor.setPresentationReady(true)
    expect(removed).not.toHaveBeenCalled()
    removed.mockRestore()
  } finally {
    editor.dispose()
    host.remove()
  }
})

it('limits native presentation invalidation to the engine capability that needs it', async () => {
  const host = document.createElement('div')
  host.style.cssText = 'width:1280px;height:600px;visibility:hidden'
  document.body.append(host)
  const editor = new Editor(host, { presentationReady: false, lineHeight: 18 })
  try {
    editor.setText(('x '.repeat(100) + '\n').repeat(50_000))
    const styles = [{ color: '#ff0000' }, { color: '#0000ff' }]
    editor.setTokens(
      Array.from({ length: 40_000 }, (_, index) => {
        const start = Math.floor(index / 100) * 201 + (index % 100) * 2
        return { start, end: start + 1, style: styles[index % 2]! }
      }),
    )
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const entries = [...CSS.highlights].filter(([, group]) =>
      [...group].some((range) => host.contains(range.startContainer)),
    )
    const count = entries.reduce(
      (sum, [, group]) =>
        sum + [...group].filter((range) => host.contains(range.startContainer)).length,
      0,
    )
    expect(count).toBeGreaterThan(1_000)
    host.style.visibility = 'visible'
    const samples: number[] = []
    for (let index = 0; index < 10; index++) {
      editor.setPresentationReady(false)
      const start = performance.now()
      editor.setPresentationReady(true)
      samples.push(performance.now() - start)
    }
    console.info(
      'presentation membership cost',
      JSON.stringify({
        count,
        samples,
        nativeCapability: CSS.supports('-webkit-nbsp-mode', 'space'),
        touchCallout: CSS.supports('-webkit-touch-callout', 'none'),
        nbspMode: CSS.supports('-webkit-nbsp-mode', 'space'),
      }),
    )
    const removed = entries.map(([, group]) => vi.spyOn(group, 'delete'))
    try {
      editor.setPresentationReady(false)
      editor.setPresentationReady(true)
      expect(removed.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(
        CSS.supports('-webkit-nbsp-mode', 'space') ? count : 0,
      )
    } finally {
      for (const spy of removed) spy.mockRestore()
    }
  } finally {
    editor.dispose()
    host.remove()
  }
})

it.for(['light', 'dark'] as const)(
  'keeps plain text beside a Markdown link in foreground in %s',
  async (appearance) => {
    await init()
    const source = '[MMMM](https://example.com) MMMM\nlast'
    const parser = new MarkdownDocument()
    parser.setText(source)
    const host = document.createElement('div')
    host.id = `link-boundary-${appearance}`
    host.style.cssText = 'width:390px;height:100px;position:relative'
    host.style.setProperty('--editor-link-color', '#ff0000')
    document.body.append(host)
    const foreground = appearance === 'dark' ? '#ffffff' : '#000000'
    const editor = new Editor(host, {
      plugins: [createPaintSnapshotPlugin()],
      scrollMode: 'content',
      cursorLineHighlight: { rowBackground: false, gutterNumber: false, gutterBackground: false },
      fontSize: 24,
      lineHeight: 32,
      theme: {
        type: appearance,
        foregroundColor: foreground,
        backgroundColor: appearance === 'dark' ? '#000000' : '#ffffff',
      },
    })
    const target = document.createElement('div')
    target.id = `${host.id}-static`
    target.style.cssText = 'width:390px;position:relative'
    document.body.append(target)
    let restored: ReturnType<typeof mountPaintSnapshot> = null
    try {
      editor.setText(source)
      editor.setSelection(source.length)
      editor.setInlineReplacementProvider((context) =>
        markdownInlineReplacements(context.textSnapshot, parser.decorations(0, source.length)),
      )
      editor.setTokens([{ start: 0, end: source.indexOf(')') + 1, style: { color: '#ff0000' } }])
      await expect.poll(() => host.querySelector('a')?.textContent).toBe('MMMM')
      const row = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
      const plain = row.lastChild as Text
      expect(plain.data).toBe(' MMMM')
      const bounds = document.createRange()
      bounds.selectNodeContents(plain)
      const left = Math.ceil(bounds.getBoundingClientRect().left - row.getBoundingClientRect().left)
      const live = await pixels(host.id, `${appearance}-live`)
      expect(redInkAfter(live, left)).toBe(0)
      expect(redInk(live)).toBeGreaterThan(0)
      const saved = editor.captureSnapshot({ scope: 'document' })
      expect(saved.status, JSON.stringify(saved)).toBe('ready')
      assert(saved.status === 'ready')
      restored = mountPaintSnapshot(target, decodePaintSnapshot(saved.paint)!, { width: 390 })
      expect(restored).toBeTruthy()
      const snapshot = await pixels(target.id, `${appearance}-static`)
      expect(redInkAfter(snapshot, left)).toBe(0)
      expect(Array.from(snapshot.data)).toEqual(Array.from(live.data))
      const ranges = [...CSS.highlights].flatMap(([, group]) =>
        [...group].filter((range) => host.contains(range.startContainer)),
      )
      expect(ranges.length).toBeGreaterThan(0)
      for (const range of ranges) {
        expect(range.endContainer === plain && range.endOffset === 0).toBe(false)
        if (range.startContainer.nodeType !== Node.TEXT_NODE) continue
        expect(range.startOffset).toBeLessThan((range.startContainer as Text).length)
      }
    } finally {
      restored?.dispose()
      editor.dispose()
      parser.dispose()
      host.remove()
      target.remove()
    }
  },
)

function redInkAfter(image: ImageData, left: number): number {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext('2d')!
  context.putImageData(image, 0, 0)
  return redInk(context.getImageData(left, 0, image.width - left, image.height))
}

it.each([
  [
    'Range',
    (...args: Parameters<typeof createStaticRangeForChunkRange>) =>
      createDomRangeForChunkRange(...args, 'highlight'),
  ],
  ['StaticRange', createStaticRangeForChunkRange],
] as const)(
  'bounds native ranges by their first and last covered text nodes (%s)',
  (_name, createRange) => {
    const { host, view } = mount()
    view.setTokens([])
    view.setText('AbbC')
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot('AbbC'), [
        {
          id: 'link',
          startIndex: 1,
          endIndex: 3,
          text: 'B',
          render(container) {
            const anchor = document.createElement('a')
            anchor.textContent = 'B'
            container.append(anchor)
          },
        },
      ]),
    )
    const row = view.getState().mountedRows[0]!
    const chunk = row.chunks[0]!
    expect(createRange(document, row, chunk, 1, 1)).toBeNull()
    const first = host.querySelector('[data-editor-virtual-row="0"]')!
    const nodes = document.createTreeWalker(first, NodeFilter.SHOW_TEXT)
    const covered: Text[] = []
    while (nodes.nextNode()) covered.push(nodes.currentNode as Text)
    expect(covered.map((node) => node.data)).toEqual(['A', 'B', 'C'])
    for (const [start, end, node] of [
      [0, 1, covered[0]!],
      [1, 3, covered[1]!],
      [3, 4, covered[2]!],
    ] as const) {
      const range = createRange(document, row, chunk, start, end)!
      expect(range.startContainer).toBe(node)
      expect(range.startOffset).toBe(0)
      expect(range.endContainer).toBe(node)
      expect(range.endOffset).toBe(1)
    }
  },
)

it.each([5, 7])(
  'paints the whole atomic widget selection through source offset %s',
  async (end) => {
    const { host, view } = mount()
    const source = 'A@foo Z'
    view.setTokens([])
    host.style.setProperty('--editor-selection-background', '#ff0000')
    view.setText(source)
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot(source), [
        {
          id: 'chip',
          startIndex: 1,
          endIndex: 5,
          text: '@foo',
          atomic: true,
          reveal: 'never',
          render(container) {
            container.style.cssText = 'width:120px;padding:0 10px;box-sizing:content-box'
            container.textContent = 'W'
          },
        },
      ]),
    )
    view.setSelection(1, end)
    const row = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
    const widget = row.querySelector<HTMLElement>('[data-editor-inline-widget]')!
    const box = widget.getBoundingClientRect()
    expect(box.width).toBe(140)
    const painted = await pixels(host.id, `atomic-selection-${end}`)
    const rectangles = row.querySelectorAll<HTMLElement>('.editor-virtualized-selection-range')
    expect(rectangles.length).toBe(1)
    const selection = rectangles[0]!.getBoundingClientRect()
    expect(selection.left).toBeCloseTo(box.left, 0)
    expect(selection.right).toBeGreaterThanOrEqual(box.right - 0.5)
    if (end > 5) {
      const nodes = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      let suffixText = nodes.nextNode()
      while (suffixText && !suffixText.textContent?.endsWith('Z')) suffixText = nodes.nextNode()
      assert(suffixText)
      const suffix = document.createRange()
      suffix.selectNodeContents(suffixText)
      expect(selection.right).toBeCloseTo(suffix.getBoundingClientRect().right, 0)
    }
    const left = Math.ceil(box.left - row.getBoundingClientRect().left) + 1
    const right = Math.floor(box.right - row.getBoundingClientRect().left) - 1
    for (let x = left; x < right; x++) {
      const offset = (29 * painted.width + x) * 4
      expect(painted.data[offset]).toBe(255)
      expect(painted.data[offset + 1]).toBe(0)
      expect(painted.data[offset + 2]).toBe(0)
    }
    expect(
      ink(painted, (red, green, blue) => red > 180 && green > 180 && blue > 180),
    ).toBeGreaterThan(15)
  },
)

function nearRgb(
  red: number,
  green: number,
  blue: number,
  target: readonly [number, number, number],
  tolerance = 8,
): boolean {
  return (
    Math.abs(red - target[0]) <= tolerance &&
    Math.abs(green - target[1]) <= tolerance &&
    Math.abs(blue - target[2]) <= tolerance
  )
}

const OPAQUE_SELECTION_THEMES = [
  {
    appearance: 'dark' as const,
    background: '#000000',
    foreground: '#ffffff',
    selection: '#1f3b5c',
    selectionRgb: [31, 59, 92] as const,
    inactiveSelection: '#3a3d41',
    inactiveSelectionRgb: [58, 61, 65] as const,
    whitespaceColor: '#00ff00',
    matchesForeground: (red: number, green: number, blue: number) =>
      red > 180 && green > 180 && blue > 180,
    matchesWhitespace: (red: number, green: number, blue: number) =>
      green > 140 && green > red + 50 && green > blue + 35,
  },
  {
    appearance: 'light' as const,
    background: '#ffffff',
    foreground: '#000000',
    selection: '#cfe0ff',
    selectionRgb: [207, 224, 255] as const,
    inactiveSelection: '#e5e7eb',
    inactiveSelectionRgb: [229, 231, 235] as const,
    whitespaceColor: '#00aa00',
    matchesForeground: (red: number, green: number, blue: number) =>
      red < 80 && green < 80 && blue < 80,
    matchesWhitespace: (red: number, green: number, blue: number) =>
      green > red + 25 && green > blue + 25,
  },
] as const

it.for(OPAQUE_SELECTION_THEMES)(
  'paints opaque selectionColor behind code text, syntax tokens, and hidden whitespace in $appearance theme',
  async (spec) => {
    const host = document.createElement('div')
    host.id = `opaque-selection-${spec.appearance}`
    host.style.cssText = 'width:480px;height:80px;display:flex'
    document.body.append(host)
    const editor = new Editor(host, {
      cursorLineHighlight: { rowBackground: false, gutterNumber: false, gutterBackground: false },
      fontSize: 24,
      hiddenCharacters: 'show-on-selection',
      lineHeight: 32,
      theme: {
        type: spec.appearance,
        backgroundColor: spec.background,
        foregroundColor: spec.foreground,
        selectionColor: spec.selection,
        inactiveSelectionColor: spec.inactiveSelection,
      },
    })
    try {
      const editorRoot = host.querySelector<HTMLElement>('.editor-virtualized')
      assert(editorRoot)
      editorRoot.style.setProperty('--editor-hidden-character-foreground', spec.whitespaceColor)
      const source = 'MMMM NNNN'
      editor.setText(source)
      editor.setTokens([{ start: 0, end: 4, style: { color: '#ff0000' } }])
      editor.focus()
      editor.setSelection(0, source.length)
      await new Promise((resolve) => requestAnimationFrame(resolve))

      const active = await pixels(host.id)
      expect(
        ink(active, (red, green, blue) => nearRgb(red, green, blue, spec.selectionRgb)),
      ).toBeGreaterThan(200)
      expect(redInk(active)).toBeGreaterThan(20)
      expect(ink(active, spec.matchesForeground)).toBeGreaterThan(20)
      expect(ink(active, spec.matchesWhitespace)).toBeGreaterThan(0)

      const focused = document.activeElement
      if (focused instanceof HTMLElement) focused.blur()
      await new Promise((resolve) => requestAnimationFrame(resolve))

      const inactive = await pixels(host.id)
      expect(
        ink(inactive, (red, green, blue) => nearRgb(red, green, blue, spec.inactiveSelectionRgb)),
      ).toBeGreaterThan(200)
      expect(redInk(inactive)).toBeGreaterThan(20)
      expect(ink(inactive, spec.matchesForeground)).toBeGreaterThan(20)
    } finally {
      editor.dispose()
      host.remove()
    }
  },
)

it('layers opaque selection above row backgrounds and behind search highlights, carets, and trailers in content mode', async () => {
  const host = document.createElement('div')
  host.id = 'opaque-selection-layers'
  host.style.cssText = 'width:480px;height:80px;background:black;color:white;font:24px monospace'
  host.style.setProperty('--editor-merge-current-header-background', '#442222')
  host.style.setProperty('--editor-merge-description-foreground', '#00ffff')
  document.body.append(host)
  const view = new VirtualizedTextView(host, {
    rowHeight: 32,
    overscan: 0,
    scrollMode: 'content',
    rowPositioning: 'top',
  })
  mounted.push({ host, view })
  view.setTheme({
    type: 'dark',
    backgroundColor: '#000000',
    foregroundColor: '#ffffff',
    selectionColor: '#1f3b5c',
    caretColor: '#00ff00',
  })
  view.setText('MMMM NNNN')
  view.setRowDecorations(new Map([[0, { className: 'editor-merge-conflict-current-header' }]]))
  view.setScrollMetrics(0, 80, 480)
  view.setTokens([{ start: 0, end: 4, style: { color: '#ff0000' } }])
  view.setRangeHighlight('find-match', [{ start: 5, end: 9 }], { backgroundColor: '#ff00ff' })
  const caretLayer = host.querySelector<HTMLElement>('.editor-virtualized-caret-layer')
  assert(caretLayer)
  // Prevent the 500ms blink timer from hiding the caret if a screenshot stalls.
  caretLayer.style.opacity = '1'
  view.focusInput()
  view.setSelection(9, 0)
  await new Promise((resolve) => requestAnimationFrame(resolve))

  const painted = await pixels(host.id)
  // Row background paints on the unselected right half; selection paints above it.
  expect(
    ink(painted, (red, green, blue) => nearRgb(red, green, blue, [68, 34, 34])),
  ).toBeGreaterThan(200)
  expect(
    ink(painted, (red, green, blue) => nearRgb(red, green, blue, [31, 59, 92])),
  ).toBeGreaterThan(100)
  // Search/match CSS Highlight background paints above selection.
  expect(ink(painted, (red, green, blue) => red > 180 && green < 80 && blue > 180)).toBeGreaterThan(
    50,
  )
  // Syntax token and plain text glyphs paint above selection and search highlight.
  expect(redInk(painted)).toBeGreaterThan(20)
  expect(
    ink(painted, (red, green, blue) => red > 180 && green > 180 && blue > 180),
  ).toBeGreaterThan(20)
  // Caret at the reversed selection head paints above the opaque selection.
  expect(ink(painted, (red, green, blue) => red < 80 && green > 180 && blue < 80)).toBeGreaterThan(
    10,
  )
  // Merge-conflict ::after trailer paints above the row background.
  expect(ink(painted, (red, green, blue) => red < 80 && green > 180 && blue > 180)).toBeGreaterThan(
    20,
  )
})
