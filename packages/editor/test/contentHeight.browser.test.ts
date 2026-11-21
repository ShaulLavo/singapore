import { afterEach, expect, it } from 'vitest'
import { commands, userEvent } from 'vitest/browser'
import { Editor } from '../src/editor/Editor'
import { createDocumentSession, createPieceTableSnapshot } from '../src/public/document'
import { createInlineMap } from '../src/inlineMap'
import { createEditorFindPlugin } from '../../find/src/plugin'
import '../src/style.css'
import { glyphAdvancesFor } from '../src/virtualization/glyphAdvances'
import type { EditorViewportSnapshot } from '../src/plugins'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofContentLayoutScreenshot: (width: number) => Promise<string>
  }
}

const fontUrl = new URL('./fixtures/fonts/jetbrains-mono.woff2', import.meta.url).href
const fallbackFontUrl = new URL('./fixtures/fonts/source-serif-4.woff2', import.meta.url).href

const mounted: { editor: Editor; host: HTMLElement; parent: HTMLElement }[] = []

afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.dispose()
    parent.remove()
  }
  window.scrollTo(0, 0)
})

function mount(
  width = 390,
  options: Pick<
    import('../src/editor/types').EditorOptions,
    'height' | 'maxHeight' | 'scrollMode'
  > = { height: 'content' },
) {
  const parent = document.createElement('div')
  parent.id = 'content-height-proof'
  parent.style.cssText = 'height:240px;overflow:auto'
  const before = document.createElement('div')
  before.style.height = '360px'
  const host = document.createElement('div')
  host.style.width = `${width}px`
  const after = document.createElement('div')
  after.style.height = '360px'
  parent.append(before, host, after)
  document.body.append(parent)
  const editor = new Editor(host, {
    ...options,
    wordWrap: true,
    lineHeight: 20,
    fontSize: 14,
    fontFamily: 'monospace',
    plugins: [createEditorFindPlugin()],
  })
  mounted.push({ editor, host, parent })
  parent.scrollTop = before.offsetHeight
  return { editor, host, parent }
}

const frames = async () => {
  for (let index = 0; index < 3; index++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}
const scroller = (host: HTMLElement) => host.querySelector<HTMLElement>('.editor-virtualized')!
const row = (host: HTMLElement, index: number) =>
  host.querySelector<HTMLElement>(`[data-editor-virtual-row="${index}"]`)!

it.each([
  ['nearest', 80],
  ['center', 40],
] as const)('reveals a distant row with %s alignment inside a nested clip', async (block, top) => {
  const { editor, host, parent } = mount()
  const clip = document.createElement('div')
  clip.style.cssText = 'height:100px;overflow:clip'
  parent.before(clip)
  clip.append(parent)
  mounted[mounted.length - 1]!.parent = clip
  const nativeOffsets: number[] = []
  editor.onDidScroll(({ top }) => nativeOffsets.push(top))
  editor.setText('row\n'.repeat(12_000))
  parent.scrollTop = 360
  await expect.poll(() => row(host, 0)?.textContent).toBe('row')
  expect(row(host, 1000)).toBeNull()

  editor.setSelection(4000, 4000, { reveal: true, revealBlock: block })
  await expect
    .poll(() => row(host, 1000)?.getBoundingClientRect().top)
    .toBeCloseTo(clip.getBoundingClientRect().top + top, 0)
  expect(editor.getScrollPosition().top).toBe(0)
  expect(nativeOffsets).toEqual([])
})

it('respects scroll padding when revealing a distant page row', async () => {
  const { editor, host, parent } = mount()
  parent.style.scrollPaddingBottom = '60px'
  editor.setText('row\n'.repeat(300))
  await expect.poll(() => row(host, 0)?.textContent).toBe('row')
  expect(row(host, 100)).toBeNull()

  editor.setSelection(400, 400, { reveal: true, revealBlock: 'end' })

  await expect
    .poll(() => row(host, 100)?.getBoundingClientRect().bottom)
    .toBeCloseTo(parent.getBoundingClientRect().bottom - 60, 0)
})

it('reports the clipped row window and releases its rows when scrolled offscreen', async () => {
  const { editor, host, parent } = mount()
  const clip = document.createElement('div')
  clip.style.cssText = 'height:120px;overflow:clip'
  parent.before(clip)
  clip.append(parent)
  mounted[mounted.length - 1]!.parent = clip
  let viewport: EditorViewportSnapshot | undefined
  editor.addPlugin({
    name: 'page-viewport-proof',
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot) => {
            viewport = snapshot.viewport
          },
          updateViewport: (snapshot) => {
            viewport = snapshot
          },
          dispose() {},
        }),
      }),
  })
  editor.setText('row\n'.repeat(12_000))
  parent.scrollTop = 360 + 800
  await expect.poll(() => viewport?.visibleRange).toEqual({ start: 40, end: 46 })
  expect(viewport?.scrollTop).toBe(800)
  expect(viewport?.clientHeight).toBe(120)
  expect(scroller(host).scrollTop).toBe(0)
  expect(row(host, 42)).not.toBeNull()
  expect(row(host, 0)).toBeNull()

  clip.style.height = '160px'
  await expect.poll(() => viewport?.visibleRange).toEqual({ start: 40, end: 48 })

  parent.scrollTop = 0
  await expect.poll(() => host.querySelectorAll('[data-editor-virtual-row]').length).toBe(0)
  expect(host.getBoundingClientRect().height).toBe(editor.getContentHeight())

  parent.scrollTop = 360 + 28_000
  await expect.poll(() => viewport?.visibleRange).toEqual({ start: 1400, end: 1408 })
  expect(row(host, 1400)).not.toBeNull()
})

it('grows to the configured height, scrolls through a large paste and shrinks again', async () => {
  const { editor, host } = mount(390, { height: 'content', maxHeight: 120 })
  editor.setText('first\nsecond')
  await frames()
  expect(scroller(host).clientHeight).toBe(40)

  const text = 'row\n'.repeat(12_000) + 'last'
  editor.setText(text)
  await frames()
  expect(scroller(host).clientHeight).toBe(120)
  expect(scroller(host).scrollHeight).toBeGreaterThan(120)
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(30)
  editor.setSelection(text.length)
  await frames()
  expect(row(host, 12_000)?.textContent).toBe('last')

  editor.setText('short')
  await frames()
  expect(scroller(host).clientHeight).toBe(20)
  expect(scroller(host).scrollTop).toBe(0)
})

it('lets explicit height override the old alias and maps the old static editor to container', async () => {
  const { editor, host } = mount(390, { height: 'container', scrollMode: 'content' })
  host.style.height = '100px'
  editor.setText('row\n'.repeat(200))
  await frames()
  expect(scroller(host).dataset.editorScrollMode).toBe('virtualized')
  editor.setScrollMode('static')
  expect(scroller(host).dataset.editorScrollMode).toBe('virtualized')
  editor.setHeight('content', 80)
  await frames()
  expect(scroller(host).clientHeight).toBe(80)
  editor.setScrollMode('content')
  expect(scroller(host).dataset.editorScrollMode).toBe('content')
})

it.each([390, 752])(
  'sizes the plain-text editor in normal flow at %s px and reveals outside it',
  async (width) => {
    const { editor, host, parent } = mount(width)
    const text = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')
    editor.setText(text)
    await frames()
    expect(host.getBoundingClientRect().height).toBe(editor.getContentHeight())
    expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(80)
    expect(getComputedStyle(scroller(host)).overflowY).toBe('visible')
    expect(getComputedStyle(scroller(host)).overflowX).toBe('visible')
    const readingScrollports = [...host.querySelectorAll<HTMLElement>('*')].filter((element) => {
      if (element.matches('textarea, input')) return false
      const style = getComputedStyle(element)
      return (
        ['auto', 'scroll'].includes(style.overflowX) || ['auto', 'scroll'].includes(style.overflowY)
      )
    })
    expect(
      readingScrollports.filter(
        (element) =>
          element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth,
      ),
    ).toEqual([])
    expect(scroller(host).scrollHeight).toBe(scroller(host).clientHeight)
    parent.scrollTop = 360
    if ('proofContentLayoutScreenshot' in commands)
      console.info('Content layout evidence', await commands.proofContentLayoutScreenshot(width))
    editor.setSelection(text.length, text.length, { reveal: true })
    await frames()
    expect(parent.scrollTop).toBeGreaterThan(360)
    expect(editor.getScrollPosition()).toEqual({ top: 0, left: 0 })
    expect(row(host, 79).getBoundingClientRect().bottom).toBeLessThanOrEqual(
      parent.getBoundingClientRect().bottom + 1,
    )
    editor.setSelection(0, 0, { reveal: true, revealBlock: 'center' })
    await frames()
    expect(row(host, 0).getBoundingClientRect().top).toBeGreaterThanOrEqual(
      parent.getBoundingClientRect().top,
    )
    expect(parent.scrollTop).toBeLessThanOrEqual(360)
  },
)

it('publishes changed height after edits, width and font changes without a resize loop', async () => {
  const { editor, host } = mount()
  const heights: number[] = []
  const listener = editor.onDidChangeContentHeight((height) => heights.push(height))
  editor.setText('alpha beta gamma delta '.repeat(40))
  await frames()
  const first = editor.getContentHeight()
  expect(host.getBoundingClientRect().height).toBe(first)
  host.style.width = '180px'
  await frames()
  expect(editor.getContentHeight()).toBeGreaterThan(first)
  editor.setFontSize(20)
  await frames()
  expect(host.getBoundingClientRect().height).toBe(editor.getContentHeight())
  editor.setText('short\ntext')
  await frames()
  expect(host.getBoundingClientRect().height).toBe(40)
  const settled = heights.length
  await frames()
  expect(heights).toHaveLength(settled)
  expect(settled).toBeLessThan(15)
  listener.dispose()
  editor.dispose()
  host.style.width = '300px'
  await frames()
  expect(heights).toHaveLength(settled)
  expect(host.children).toHaveLength(0)
})

it('uses the same content extent with a document session and switches scroll modes', async () => {
  const { editor, host } = mount()
  const session = createDocumentSession('line\n'.repeat(40))
  editor.attachSession(session)
  await frames()
  expect(host.getBoundingClientRect().height).toBe(820)
  editor.setScrollMode('virtualized')
  host.style.height = '100px'
  await frames()
  expect(getComputedStyle(scroller(host)).overflowY).toBe('auto')
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(41)
  host.style.height = ''
  editor.setScrollMode('content')
  await frames()
  expect(host.getBoundingClientRect().height).toBe(820)
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(41)
  session.applyEdits([{ from: 0, to: 0, text: 'new line\n' }])
  await frames()
  expect(host.getBoundingClientRect().height).toBe(840)
  editor.dispose()
})

it.each(['cold', 'prefetched'] as const)(
  'updates the content extent when a bundled font loads after mount with %s bytes',
  async (cache) => {
    const family = `Content Height ${cache}`
    const fallbackFamily = `Content Height Fallback ${cache}`
    const fallback = new FontFace(fallbackFamily, `url(${fallbackFontUrl})`)
    let face: FontFace | undefined
    await fallback.load()
    document.fonts.add(fallback)
    const { editor, host, parent } = mount(180)
    const probe = document.createElement('span')
    try {
      // Downloading bytes cannot activate the target face before the baseline is measured.
      const prefetched =
        cache === 'prefetched'
          ? await fetch(fontUrl, { cache: 'no-store' }).then((response) => response.arrayBuffer())
          : undefined
      editor.setFontFamily(`"${family}", "${fallbackFamily}"`)
      editor.setText('W'.repeat(400))
      probe.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;visibility:hidden'
      probe.textContent = 'W'
      scroller(host).append(probe)
      await frames()
      const before = editor.getContentHeight()
      const beforeAdvance = probe.getBoundingClientRect().width
      const beforeCachedAdvance = glyphAdvancesFor(scroller(host))!.advance(87)
      const bytes: ArrayBuffer =
        prefetched ??
        (await fetch(fontUrl, { cache: 'no-store' }).then((response) => response.arrayBuffer()))
      face = new FontFace(family, bytes)
      document.fonts.add(await face.load())
      await expect.poll(() => probe.getBoundingClientRect().width).toBeLessThan(beforeAdvance - 1)
      const loadedAdvance = probe.getBoundingClientRect().width
      await expect
        .poll(() => glyphAdvancesFor(scroller(host))!.advance(87))
        .toBeLessThan(beforeCachedAdvance - 1)
      expect(beforeAdvance - loadedAdvance).toBeGreaterThan(1)
      await expect
        .poll(() => glyphAdvancesFor(scroller(host))!.advance(87))
        .toBeCloseTo(loadedAdvance, 1)
      await expect.poll(() => editor.getContentHeight()).toBeLessThan(before)
      expect(host.getBoundingClientRect().height).toBe(editor.getContentHeight())
      console.info('Controlled late font metrics', {
        cache,
        beforeAdvance,
        beforeCachedAdvance,
        loadedAdvance,
        before,
        after: editor.getContentHeight(),
      })
      parent.scrollTop = 360
      if ('proofContentLayoutScreenshot' in commands)
        console.info('Late font content evidence', await commands.proofContentLayoutScreenshot(180))
    } finally {
      editor.dispose()
      probe.remove()
      if (face) document.fonts.delete(face)
      document.fonts.delete(fallback)
    }
  },
)

it.each(['text', 'atomic'] as const)(
  'publishes $0 syntax replacement extent and restores the source extent',
  async (wrap) => {
    const { editor, host } = mount(180)
    const text = 'source'
    editor.setText(text)
    await frames()
    expect(editor.getContentHeight()).toBe(20)
    editor.setInlineMap(
      createInlineMap(createPieceTableSnapshot(text), [
        {
          id: 'syntax-preview',
          startIndex: 0,
          endIndex: text.length,
          text: 'rendered preview words '.repeat(30),
          reveal: 'never',
          ...(wrap === 'text' ? { wrap } : {}),
        },
      ]),
    )
    await frames()
    if (wrap === 'text') {
      expect(editor.getContentHeight()).toBeGreaterThan(20)
      expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeGreaterThan(1)
    } else {
      expect(editor.getContentHeight()).toBe(20)
      expect(host.querySelectorAll('[data-editor-virtual-row]')).toHaveLength(1)
    }
    expect(host.getBoundingClientRect().height).toBe(editor.getContentHeight())
    editor.setInlineMap(null)
    await frames()
    expect(host.getBoundingClientRect().height).toBe(20)
  },
)

it('find results and heading jumps reveal through the outside scroller', async () => {
  const { editor, host, parent } = mount()
  const text = 'first heading\n' + 'body\n'.repeat(80) + 'needle heading'
  editor.setText(text)
  await frames()
  editor.openFind()
  const input = host.querySelector<HTMLInputElement>(
    '.editor-find-input:not(.editor-find-input-standalone)',
  )!
  input.value = 'needle'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  editor.findNext()
  await frames()
  expect(parent.scrollTop).toBeGreaterThan(360)
  expect(editor.getScrollPosition().top).toBe(0)
  editor.closeFind()
  editor.jumpTo(0)
  await frames()
  expect(row(host, 0).getBoundingClientRect().top).toBeGreaterThanOrEqual(
    parent.getBoundingClientRect().top,
  )
  expect(parent.scrollTop).toBeLessThanOrEqual(360)
})

it('changes to content height for a document past the old row limit', async () => {
  const { editor, host } = mount(390, { height: 'container' })
  host.style.height = '240px'
  editor.setText('row\n'.repeat(12_000) + 'last')
  await frames()

  host.style.height = ''
  editor.setHeight('content')
  await frames()
  expect(editor.getContentHeight()).toBe(240_020)
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(50)
  editor.jumpTo(editor.getTextSnapshot().length)
  await frames()
  expect(row(host, 12_000)?.textContent).toBe('last')
})

it('reaches the last row after capping the page editor at the native height limit', async () => {
  const { editor, host, parent } = mount()
  editor.setWordWrap(false)
  editor.setLineHeight(120)
  const count = 150_000
  const text = 'row\n'.repeat(count) + 'tail'
  editor.setText(text)
  await expect.poll(() => host.getBoundingClientRect().height).toBeGreaterThan(0)
  expect(editor.getContentHeight()).toBe((count + 1) * 120)
  expect(parent.scrollHeight).toBeLessThanOrEqual(16_001_000)

  editor.setSelection(text.length, text.length, { reveal: true, revealBlock: 'center' })
  await expect.poll(() => row(host, count)?.textContent).toBe('tail')
  const tail = row(host, count).getBoundingClientRect()
  const clip = parent.getBoundingClientRect()
  expect(tail.top).toBeGreaterThanOrEqual(clip.top - 1)
  expect(tail.bottom).toBeLessThanOrEqual(clip.bottom + 1)
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(50)
  expect(parent.scrollHeight).toBeLessThanOrEqual(16_001_000)
})

it('reveals caret and heading offsets through document scrolling', async () => {
  const { editor, host, parent } = mount()
  parent.style.cssText = 'overflow:visible'
  const text = 'heading\n' + 'body\n'.repeat(100)
  editor.setText(text)
  await frames()
  editor.setSelection(text.length, text.length, { reveal: true })
  await frames()
  expect(window.scrollY).toBeGreaterThan(0)
  expect(row(host, 101).getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1)
  expect(editor.getScrollPosition()).toEqual({ top: 0, left: 0 })
  editor.jumpTo(0)
  await frames()
  expect(row(host, 0).getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
  window.scrollTo(0, 0)
})

it('keeps unwrapped rows complete and reveals horizontally outside the editor', async () => {
  const { editor, host, parent } = mount(180)
  parent.style.width = '180px'
  editor.setWordWrap(false)
  const text = 'W'.repeat(200)
  editor.setText(text)
  parent.scrollTop = 360
  await frames()
  await expect.poll(() => row(host, 0)?.textContent).toBe(text)
  expect(parent.scrollWidth).toBeGreaterThan(parent.clientWidth)
  editor.setSelection(text.length, text.length, { reveal: true })
  await frames()
  expect(parent.scrollLeft).toBeGreaterThan(0)
  expect(editor.getScrollPosition()).toEqual({ top: 0, left: 0 })
})

function mountUnwrapped() {
  const parent = document.createElement('div')
  parent.style.cssText = 'height:240px;width:390px;overflow:auto'
  const host = document.createElement('div')
  parent.append(host)
  document.body.append(parent)
  const editor = new Editor(host, {
    scrollMode: 'content',
    wordWrap: false,
    lineHeight: 20,
    fontSize: 14,
    fontFamily: 'monospace',
  })
  mounted.push({ editor, host, parent })
  return { editor, host, parent }
}
it('review: outside horizontal scrolling keeps tail text hit-testable', async () => {
  const { editor, host } = mountUnwrapped()
  const text = 'W'.repeat(200)
  editor.setText(text)
  await frames()
  editor.setSelection(text.length, text.length, { reveal: true })
  await frames()
  const row = host.querySelector('[data-editor-virtual-row="0"]')!
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && node.textContent !== text) node = walker.nextNode()
  expect(node).not.toBeNull()
  const range = document.createRange()
  range.setStart(node!, 198)
  range.setEnd(node!, 199)
  const rect = range.getBoundingClientRect()
  const x = (rect.left + rect.right) / 2
  const y = (rect.top + rect.bottom) / 2
  const offset = editor.textOffsetFromPoint(x, y)
  expect(offset).toBeGreaterThanOrEqual(198)
  expect(offset).toBeLessThanOrEqual(199)
  expect(editor.rowAtPoint(x, y)?.region).toBe('text')
  expect(editor.rowAtPoint(x, y + 50)).toBeNull()
  await userEvent.click(row, {
    position: { x: x - row.getBoundingClientRect().left, y: y - row.getBoundingClientRect().top },
    force: true,
  })
  expect(editor.getSelections()[0]?.headOffset).toBe(offset)
  const earlier = document.createRange()
  earlier.setStart(node!, 194)
  earlier.setEnd(node!, 195)
  const earlierRect = earlier.getBoundingClientRect()
  await userEvent.click(row, {
    position: {
      x: (earlierRect.left + earlierRect.right) / 2 - row.getBoundingClientRect().left,
      y: y - row.getBoundingClientRect().top,
    },
    modifiers: ['Shift'],
    force: true,
  })
  expect(editor.getSelections()[0]?.anchorOffset).toBe(offset)
  expect(editor.getSelections()[0]?.headOffset).toBeGreaterThanOrEqual(194)
  expect(editor.getSelections()[0]?.headOffset).toBeLessThanOrEqual(195)
})
it('review: page down uses outside reading viewport', async () => {
  const { editor } = mountUnwrapped()
  const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
  editor.setText(text)
  await frames()
  editor.setSelection(0, 0)
  editor.dispatchCommand('cursorPageDown')
  await frames()
  expect(editor.getSelections()[0].headOffset).toBeLessThan(text.indexOf('line 20'))
  expect(editor.getSelections()[0].headOffset).toBeGreaterThan(0)
})

it('edits a shared session past the old display row limit', async () => {
  const { editor, host } = mountUnwrapped()
  const session = createDocumentSession('row\n'.repeat(10_000))
  editor.attachSession(session)
  await frames()
  session.applyEdits([{ from: 0, to: 0, text: 'first\n' }])
  await frames()

  expect(session.getTextSnapshot().readRange(0, 5)).toBe('first')
  expect(row(host, 0)?.textContent).toBe('first')
  expect(host.querySelectorAll('[data-editor-virtual-row]').length).toBeLessThan(50)
  expect(editor.getContentHeight()).toBe(200_040)
})

it.each(['cursorPageDown', 'cursorPageUp', 'selectPageDown', 'selectPageUp'] as const)(
  'uses the clipped outside viewport for %s',
  async (command) => {
    const { editor, parent } = mountUnwrapped()
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
    editor.setText(text)
    await frames()
    const upwards = command.endsWith('Up')
    const start = upwards ? text.indexOf('line 30') : 0
    editor.setSelection(start, start, { reveal: true })
    await frames()
    editor.dispatchCommand(command)
    await frames()
    const selection = editor.getSelections()[0]!
    const expected = text.indexOf(upwards ? 'line 19' : 'line 11')
    expect(selection.headOffset).toBe(expected)
    expect(selection.anchorOffset).toBe(command.startsWith('select') ? start : expected)
    expect(parent.scrollTop).toBeGreaterThanOrEqual(0)
  },
)

it('uses the window viewport for page movement in document flow', async () => {
  const { editor, parent } = mountUnwrapped()
  parent.style.height = 'auto'
  parent.style.overflow = 'visible'
  editor.setText(Array.from({ length: 100 }, () => 'x').join('\n'))
  await frames()
  editor.setSelection(0, 0)
  editor.dispatchCommand('cursorPageDown')
  const expectedRows = Math.max(1, Math.floor(window.innerHeight / 20) - 1)
  expect(editor.getSelections()[0]?.headOffset).toBe(expectedRows * 2)
})
