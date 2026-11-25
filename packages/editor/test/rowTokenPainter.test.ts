import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { setHighlightRegistry } from '../src/editor/runtime'
import { createVisibleEditor } from './factories/visibleEditor'
import { createInlineMap } from '../src/inlineMap'
import { createPieceTableSnapshot } from '../src/public/document'
import { VirtualizedTextView } from '../src/virtualization'
import type { HighlightRegistry } from '../src/virtualization/virtualizedTextViewTypes'

class MockHighlight extends Set<AbstractRange> {
  priority = 0
}

function createMockRegistry(): {
  registry: HighlightRegistry
  map: Map<string, MockHighlight>
} {
  const map = new Map<string, MockHighlight>()
  const registry: HighlightRegistry = {
    set(name, highlight) {
      map.set(name, highlight as unknown as MockHighlight)
    },
    delete(name) {
      return map.delete(name)
    },
    entries() {
      return map.entries() as unknown as IterableIterator<[string, Highlight]>
    },
  }
  return { registry, map }
}

const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight
const createdViews: VirtualizedTextView[] = []
const createdEditors: Editor[] = []
const createdHosts: HTMLElement[] = []

function mountHost(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  createdHosts.push(host)
  return host
}

function createView(
  options: ConstructorParameters<typeof VirtualizedTextView>[1] = {},
): VirtualizedTextView {
  const host = mountHost()
  const view = new VirtualizedTextView(host, {
    rowHeight: 20,
    overscan: 0,
    ...options,
  })
  createdViews.push(view)
  return view
}

beforeEach(() => {
  ;(globalThis as { Highlight?: unknown }).Highlight = MockHighlight
})

afterEach(() => {
  for (const editor of createdEditors.splice(0)) editor.dispose()
  for (const view of createdViews.splice(0)) view.dispose()
  for (const host of createdHosts.splice(0)) host.remove()
  setHighlightRegistry(undefined)
  ;(globalThis as { Highlight?: unknown }).Highlight = originalHighlight
})

describe('RowTokenPainter seam & spans painter', () => {
  it('defaults to css-highlight in virtualized auto mode and falls back to spans when Highlight API is absent', () => {
    const { registry, map } = createMockRegistry()
    const virtualized = createView({ highlightRegistry: registry })
    virtualized.setText('const x = 1')
    virtualized.setScrollMetrics(0, 100, 400)
    virtualized.setTokens([{ start: 0, end: 5, style: { color: '#ff0000' } }])

    expect(virtualized.getActiveTokenPainting()).toBe('css-highlight')
    expect(virtualized.scrollElement.dataset.editorTokenPainting).toBe('css-highlight')
    expect(map.size).toBe(1)
    expect(virtualized.scrollElement.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(
      0,
    )

    // Missing Highlight constructor even with a registry falls back cleanly to spans without throwing.
    ;(globalThis as { Highlight?: unknown }).Highlight = undefined
    const noHighlight = createView({ highlightRegistry: registry })
    noHighlight.setText('const x = 1')
    noHighlight.setScrollMetrics(0, 100, 400)
    expect(() => {
      noHighlight.setTokens([{ start: 0, end: 5, style: { color: '#ff0000' } }])
      noHighlight.setRangeHighlight('find', [{ start: 6, end: 7 }], {
        backgroundColor: '#ffff00',
      })
      noHighlight.setRangeHighlight('dim', [{ start: 6, end: 11 }], {
        overlay: { dim: 0.5, textDecoration: 'underline wavy blue' },
      })
    }).not.toThrow()

    expect(noHighlight.getActiveTokenPainting()).toBe('spans')
    expect(noHighlight.scrollElement.dataset.editorTokenPainting).toBe('spans')
    const spans = noHighlight.scrollElement.querySelectorAll('span[class^="editor-token-"]')
    expect(spans.length).toBeGreaterThanOrEqual(2)
    expect(spans[0]!.textContent).toBe('const')
  })

  it('auto-switches large static views to spans with hysteresis and keeps small static views on css-highlight', () => {
    const { registry } = createMockRegistry()
    const view = createView({ highlightRegistry: registry, scrollMode: 'static' })
    const makeLines = (count: number) => {
      const lines = Array.from({ length: count }, (_, i) => `const v${i} = ${i};`)
      const text = lines.join('\n')
      const tokens: { start: number; end: number; style: { color: string } }[] = []
      let offset = 0
      for (const line of lines) {
        tokens.push({ start: offset, end: offset + 5, style: { color: '#0000ff' } })
        offset += line.length + 1
      }
      return { text, tokens }
    }

    const small = makeLines(20)
    view.setText(small.text)
    view.setScrollMetrics(0, 400, 600)
    view.setTokens(small.tokens)
    expect(view.getActiveTokenPainting()).toBe('css-highlight')

    const large = makeLines(220)
    view.setText(large.text)
    view.setTokens(large.tokens)
    expect(view.getActiveTokenPainting()).toBe('spans')
    expect(view.scrollElement.dataset.editorTokenPainting).toBe('spans')
    expect(view.scrollElement.querySelectorAll('span[class^="editor-token-"]').length).toBe(220)

    // Within hysteresis band (170 rows: between 140 exit and 200 enter) stays on spans.
    const mid = makeLines(170)
    view.setText(mid.text)
    view.setTokens(mid.tokens)
    expect(view.getActiveTokenPainting()).toBe('spans')

    // Below exit threshold (100 rows <= 140) returns to css-highlight and unwraps all spans.
    const backToSmall = makeLines(100)
    view.setText(backToSmall.text)
    view.setTokens(backToSmall.tokens)
    expect(view.getActiveTokenPainting()).toBe('css-highlight')
    expect(view.scrollElement.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(0)
  })

  it('emits bare Text nodes for unstyled runs, coalesces adjacent same-paint tokens, and avoids inline styles', () => {
    const view = createView({ tokenPainting: 'spans' })
    view.setText('const  let x = 1')
    view.setScrollMetrics(0, 100, 400)
    view.setTokens([
      // Adjacent whitespace-separated tokens with same effective paint color (fontStyle ignored).
      { start: 0, end: 5, style: { color: '#0000ff', fontWeight: 'bold' } },
      { start: 7, end: 10, style: { color: '#0000ff', fontStyle: 'italic' } },
      // Font-only token with no color/background/decoration emits bare text (no span).
      { start: 11, end: 12, style: { fontStyle: 'italic' } },
      { start: 15, end: 16, style: { color: '#098658' } },
    ])

    const row = view.getState().mountedRows[0]!
    const children = [...row.element.childNodes]
    // Expect: <span "const  let">, #text(" x = "), <span "1">
    expect(children).toHaveLength(3)
    expect(children[0]!.nodeType).toBe(Node.ELEMENT_NODE)
    expect((children[0] as HTMLElement).tagName).toBe('SPAN')
    expect((children[0] as HTMLElement).getAttribute('style')).toBeNull()
    expect(children[0]!.textContent).toBe('const  let')
    expect(children[1]!.nodeType).toBe(Node.TEXT_NODE)
    expect(children[1]!.textContent).toBe(' x = ')
    expect(children[2]!.nodeType).toBe(Node.ELEMENT_NODE)
    expect(children[2]!.textContent).toBe('1')
    expect((children[2] as HTMLElement).getAttribute('style')).toBeNull()

    // Plain row with zero tokens stays a single bare Text node.
    view.setTokens([])
    expect(row.element.childNodes).toHaveLength(1)
    expect(row.element.firstChild!.nodeType).toBe(Node.TEXT_NODE)
    expect(row.element.textContent).toBe('const  let x = 1')
  })

  it('repaints recycled rows even when the new line has identical length and local token intervals', () => {
    const view = createView({ tokenPainting: 'spans' })
    const lines = Array.from({ length: 40 }, (_, i) => `const x${String(i).padStart(2, '0')} = 1`)
    const text = lines.join('\n')
    const tokens: { start: number; end: number; style: { color: string } }[] = []
    let offset = 0
    for (const line of lines) {
      tokens.push({ start: offset, end: offset + 5, style: { color: '#0000ff' } })
      offset += line.length + 1
    }
    view.setText(text)
    view.setScrollMetrics(0, 100, 400)
    view.setTokens(tokens)

    // Scroll down by 3 rows so leaving rows are recycled in the SAME render pass.
    view.setScrollMetrics(60, 100, 400)
    const mounted = view.getState().mountedRows
    expect(mounted.length).toBeGreaterThan(0)
    for (const row of mounted) {
      const span = row.element.querySelector('span[class^="editor-token-"]')
      expect(span, `row ${row.index} should have token span after recycle`).not.toBeNull()
      expect(span!.textContent).toBe('const')
    }
  })

  it('resolves overlapping tokens deterministically via endpoint sweep and coalesces identical runs', () => {
    const view = createView({ tokenPainting: 'spans' })
    view.setText('abcdef')
    view.setScrollMetrics(0, 100, 400)
    view.setTokens([
      { start: 0, end: 6, style: { color: '#111111', backgroundColor: '#eeeeee' } },
      { start: 2, end: 4, style: { color: '#ff0000' } },
    ])

    const row = view.getState().mountedRows[0]!
    const spans = [...row.element.querySelectorAll<HTMLElement>('span[class^="editor-token-"]')]
    expect(spans.map((s) => s.textContent)).toEqual(['ab', 'cd', 'ef'])
    expect(spans[0]!.className).toBe(spans[2]!.className)
    expect(spans[1]!.className).not.toBe(spans[0]!.className)
  })

  it('preserves untouched rows on same-line edits and maps DOM boundaries accurately across spans', () => {
    const view = createView({ tokenPainting: 'spans' })
    view.setText('const a = 1\nconst b = 2')
    view.setScrollMetrics(0, 100, 400)
    view.setTokens([
      { start: 0, end: 5, style: { color: '#0000ff' } },
      { start: 12, end: 17, style: { color: '#0000ff' } },
    ])

    const row1SpanBefore = view
      .getState()
      .mountedRows[1]!.element.querySelector('span[class^="editor-token-"]')
    expect(row1SpanBefore).not.toBeNull()

    // Edit line 0 in place: insert 'x' at offset 7 ('const ax = 1')
    view.applyEdit({ from: 7, to: 7, text: 'x' }, 'const ax = 1\nconst b = 2')
    view.setTokens([
      { start: 0, end: 5, style: { color: '#0000ff' } },
      { start: 13, end: 18, style: { color: '#0000ff' } },
    ])

    const [row0, row1] = view.getState().mountedRows
    expect(row0!.element.textContent).toBe('const ax = 1')
    // Non-edited row 1 keeps its exact DOM span node!
    expect(row1!.element.querySelector('span[class^="editor-token-"]')).toBe(row1SpanBefore)

    // Verify DOM boundary <-> offset round-trip on bare text, inside span, and at element boundary after span.
    const row0Span = row0!.element.querySelector('span[class^="editor-token-"]')!
    expect(view.textOffsetFromDomBoundary(row0Span.firstChild!, 2)).toBe(2)
    expect(view.textOffsetFromDomBoundary(row0Span, row0Span.childNodes.length)).toBe(5)
    expect(view.textOffsetFromDomBoundary(row0!.element, 1)).toBe(5)

    const range = view.createRange(2, 9)!
    expect(range.toString()).toBe('nst ax ')
  })

  it('re-binds range highlights after async token painting mutates row DOM in spans mode', () => {
    const { registry, map } = createMockRegistry()
    const view = createView({ highlightRegistry: registry, tokenPainting: 'spans' })
    view.setText('const value = 42')
    view.setScrollMetrics(0, 100, 400)

    view.setRangeHighlight('find', [{ start: 6, end: 11 }], { backgroundColor: '#ffff00' })
    const findGroup = map.get('find')!
    const beforeRange = [...findGroup][0]!
    expect(beforeRange.startContainer.isConnected).toBe(true)

    // Async tokens arrive and split row DOM into spans.
    view.setTokens([
      { start: 0, end: 5, style: { color: '#0000ff' } },
      { start: 6, end: 11, style: { color: '#001080' } },
    ])

    const afterRange = [...findGroup][0]!
    expect(afterRange).not.toBe(beforeRange)
    expect(afterRange.startContainer.isConnected).toBe(true)
    expect(afterRange.startContainer.textContent).toBe('value')
    expect(afterRange.startOffset).toBe(0)
    expect(afterRange.endOffset).toBe(5)
  })

  it('preserves native DOM selections (forward, backward, cross-boundary, and widget-internal) across async token paint and mode switches', () => {
    const { registry } = createMockRegistry()
    const heading = document.createElement('h2')
    heading.textContent = 'Heading'
    document.body.appendChild(heading)
    createdHosts.push(heading)

    const view = createView({ highlightRegistry: registry, tokenPainting: 'spans' })
    view.setText('const alpha = 1')
    view.setScrollMetrics(0, 100, 400)

    const sel = window.getSelection()!
    // Backward selection inside row before tokens arrive.
    const initialText = view.getState().mountedRows[0]!.textNode
    sel.setBaseAndExtent(initialText, 11, initialText, 6)

    view.setTokens([
      { start: 0, end: 5, style: { color: '#0000ff' } },
      { start: 6, end: 11, style: { color: '#001080' } },
    ])
    expect(view.textOffsetFromDomBoundary(sel.anchorNode!, sel.anchorOffset)).toBe(11)
    expect(view.textOffsetFromDomBoundary(sel.focusNode!, sel.focusOffset)).toBe(6)

    // Cross-boundary page selection (heading -> middle of token span) survives switch to css-highlight!
    sel.setBaseAndExtent(heading.firstChild!, 2, sel.focusNode!, sel.focusOffset)
    view.setTokenPainting('css-highlight')
    expect(sel.anchorNode).toBe(heading.firstChild)
    expect(sel.anchorOffset).toBe(2)
    expect(view.textOffsetFromDomBoundary(sel.focusNode!, sel.focusOffset)).toBe(6)

    // Partial selection inside an inline widget <a> stays intact (not collapsed to widget start).
    view.setTokenPainting('spans')
    view.setText('A[LINK]B')
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot('A[LINK]B'), [
        {
          id: 'link',
          startIndex: 1,
          endIndex: 7,
          text: 'LINK',
          render(container) {
            const a = document.createElement('a')
            a.textContent = 'LINK'
            container.append(a)
          },
        },
      ]),
    )
    const linkText = view.scrollElement.querySelector('a')!.firstChild!
    sel.setBaseAndExtent(linkText, 1, linkText, 3)
    view.setTokens([{ start: 1, end: 7, style: { color: '#ff0000' } }])
    expect(sel.anchorNode).toBe(linkText)
    expect(sel.anchorOffset).toBe(1)
    expect(sel.focusNode).toBe(linkText)
    expect(sel.focusOffset).toBe(3)
    sel.removeAllRanges()
  })

  it('handles chunked long lines, BiDi 50-unit splits, control characters, and widget data-editor-token cleanup', () => {
    const { registry, map } = createMockRegistry()
    const view = createView({
      highlightRegistry: registry,
      tokenPainting: 'spans',
      longLineChunkThreshold: 100,
      longLineChunkSize: 60,
    })

    // Chunked long line
    const longLine = 'a'.repeat(140)
    view.setText(longLine)
    view.setScrollMetrics(0, 100, 400)
    view.setTokens([
      { start: 10, end: 30, style: { color: '#ff0000' } },
      { start: 70, end: 90, style: { color: '#00ff00' } },
    ])
    const chunkedRow = view.getState().mountedRows[0]!
    expect(chunkedRow.textRenderMode).toBe('chunked')
    expect(
      chunkedRow.element.querySelectorAll('span[class^="editor-token-"]').length,
    ).toBeGreaterThanOrEqual(1)

    // BiDi row > 50 code units preserves <= 50-unit Text nodes inside token spans.
    const bidi = 'א'.repeat(120)
    view.setText(bidi)
    view.setTokens([{ start: 0, end: 120, style: { color: '#ff0000' } }])
    const bidiRow = view.getState().mountedRows[0]!
    for (const part of bidiRow.chunks[0]!.parts) {
      if (part.kind === 'text') expect(part.node.length).toBeLessThanOrEqual(50)
    }

    // Control char (C1, U+0085) + inline widget tagging and clean removal on switch to css-highlight.
    view.setText('A\u0085B')
    view.setTokens([{ start: 0, end: 3, style: { color: '#ff0000' } }])
    const control = view.scrollElement.querySelector<HTMLElement>(
      '.editor-virtualized-control-character',
    )!
    expect(control.dataset.editorToken).toBeDefined()

    view.setTokenPainting('css-highlight')
    expect(control.dataset.editorToken).toBeUndefined()
    expect(map.size).toBe(1)
  })

  it('switches dynamically via Editor.setTokenPainting without leaking highlights or spans', () => {
    const { registry, map } = createMockRegistry()
    setHighlightRegistry(registry)
    const host = mountHost()
    const editor = createVisibleEditor(host, { tokenPainting: 'spans' })
    createdEditors.push(editor)

    editor.setText('const value = 42')
    editor.setTokens([{ start: 0, end: 5, style: { color: '#0000ff' } }])

    const scrollEl = host.querySelector<HTMLElement>('[data-editor-token-painting]')!
    expect(scrollEl.dataset.editorTokenPainting).toBe('spans')
    expect(map.size).toBe(0)
    expect(host.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(1)

    editor.setTokenPainting('css-highlight')
    expect(scrollEl.dataset.editorTokenPainting).toBe('css-highlight')
    expect(map.size).toBe(1)
    expect(host.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(0)

    editor.setTokenPainting('spans')
    expect(scrollEl.dataset.editorTokenPainting).toBe('spans')
    expect(map.size).toBe(0)
    expect(host.querySelectorAll('span[class^="editor-token-"]')).toHaveLength(1)
  })
})
