import { createEditorHighlighterOperation } from '../src/editor/syntaxOperations'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Editor } from '../src/editor/Editor'
import { createVisibleEditor } from './factories/visibleEditor'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'
import type { EditorPlugin } from '../src/plugins'
import { EditorTokenStore } from '../src/syntax/tokenStore'
import type { VirtualizedTextView } from '../src/virtualization/virtualizedTextView'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'

/**
 * Token ranges arrive in buffer offsets while replaced rows render display text. The chunk reuse
 * path used to store `startOffset + text.length` as the chunk's buffer end, which clipped every
 * token to the display length before the boundary math mapped it — heading colors stopped short by
 * exactly the hidden marker width.
 */

const TEXT = '## Summary\nplain\n'
const TOKEN_STYLE = { color: '#ff0000' }
const HEADING_TOKENS = [{ start: 0, end: 10, style: TOKEN_STYLE }]

let tokens: typeof HEADING_TOKENS = HEADING_TOKENS

const highlightsMap = new Map<string, Set<AbstractRange>>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: Set<AbstractRange>) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<AbstractRange> {}

describe('token painting over inline replacements', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    tokens = HEADING_TOKENS
    highlightsMap.clear()
    // @ts-expect-error happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = createVisibleEditor(container, { plugins: [highlighterPlugin()] })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
  })

  it('paints the full display text when the token covers the buffer line', async () => {
    await openWithHeadingReplacement()

    const summary = paintedRanges().find((range) => range.text === 'Summary')
    expect(summary).toBeDefined()
    expect([summary!.start, summary!.end]).toEqual([0, 7])
  })

  it('mirrors replacement kinds onto the row element as classes', async () => {
    await openWithHeadingReplacement()

    const row = container.querySelector('.editor-inline-heading-marker-2')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('Summary')
  })

  it('drops the kind classes when the replacements go away', async () => {
    await openWithHeadingReplacement()
    expect(container.querySelector('.editor-inline-heading-marker-2')).not.toBeNull()

    editor.setInlineReplacementProvider(null)
    await flush()

    expect(container.querySelector('.editor-inline-heading-marker-2')).toBeNull()
  })

  it('renders phantom text at a point the document never gained', async () => {
    editor.openDocument({ documentId: 'x.md', languageId: 'markdown', text: TEXT })
    await flush()
    editor.setInlineReplacementProvider(() => [
      { id: 'hint', startIndex: 3, endIndex: 3, text: 'name:', insertion: true },
    ])
    await flush()

    const rows = [...container.querySelectorAll('.editor-virtualized-row')]
    expect(rows.map((row) => row.textContent)).toContain('## name:Summary')
    expect(editor.materializeFullText()).toBe(TEXT)
  })

  it('boxes a run carrying a class so it can be styled apart from the text', async () => {
    await openWithPhantomHint({ className: 'editor-inlay-hint' })

    const boxed = container.querySelector('.editor-inlay-hint')
    expect(boxed?.textContent).toBe('name:')
    expect(boxed?.parentElement?.textContent).toBe('## name:Summary')
  })

  it('leaves a run unboxed when it asks for no class of its own', async () => {
    await openWithPhantomHint({})

    const row = container.querySelector('.editor-virtualized-row')
    expect(row?.textContent).toBe('## name:Summary')
    expect(row?.querySelector('[data-editor-inline-run]')).toBeNull()
  })

  it('keeps a token meeting a run at its point clear of the run', async () => {
    tokens = [
      { start: 0, end: 3, style: TOKEN_STYLE },
      { start: 3, end: 10, style: { color: '#00ff00' } },
    ]
    await openWithPhantomHint({})

    const painted = paintedRanges().map((range) => [range.start, range.end, range.text])
    expect(painted).toContainEqual([0, 3, '## name:Summary'])
    expect(painted).toContainEqual([8, 15, '## name:Summary'])
  })

  async function openWithPhantomHint(styling: { className?: string }): Promise<void> {
    editor.openDocument({ documentId: 'x.md', languageId: 'markdown', text: TEXT })
    await flush()
    editor.setInlineReplacementProvider(() => [
      { id: 'hint', startIndex: 3, endIndex: 3, text: 'name:', insertion: true, ...styling },
    ])
    await flush()
  }

  async function openWithHeadingReplacement(): Promise<void> {
    editor.openDocument({ documentId: 'x.md', languageId: 'markdown', text: TEXT })
    await flush()
    editor.setInlineReplacementProvider(() => [
      {
        id: 'h',
        startIndex: 0,
        endIndex: 3,
        text: '',
        kind: 'heading-marker-2',
        groupId: 'h',
      },
    ])
    await flush()
  }
})

describe.each(['css-highlight', 'spans'] as const)(
  'row-scoped inline-reveal invalidation (%s painter)',
  (tokenPainting) => {
    let container: HTMLElement
    let editor: Editor

    beforeEach(() => {
      highlightsMap.clear()
      // @ts-expect-error happy-dom has no Highlight constructor
      globalThis.Highlight = MockHighlight
      setHighlightRegistry(mockRegistry)
      resetEditorInstanceCount()
      container = document.createElement('div')
      document.body.appendChild(container)
      editor = createVisibleEditor(container, { tokenPainting })
    })

    afterEach(() => {
      editor.dispose()
      container.remove()
      setHighlightRegistry(undefined)
    })

    it('invalidates only display rows whose reveal state changed when moving the caret', async () => {
      const lines = [
        '## Heading',
        'plain one',
        'a **bold** b',
        'plain two',
        'c **other** d',
        'plain three',
      ]
      const text = lines.join('\n')
      editor.setText(text)
      // Tokenize every line so every mounted row holds painted token state.
      const lineTokens = []
      let offset = 0
      for (const line of lines) {
        lineTokens.push({ start: offset, end: offset + line.length, style: TOKEN_STYLE })
        offset += line.length + 1
      }
      editor.setTokens(lineTokens)

      const boldRowStart = lines.slice(0, 2).join('\n').length + 1
      const otherRowStart = lines.slice(0, 4).join('\n').length + 1
      editor.setInlineReplacementProvider(() => [
        {
          id: 'h0',
          startIndex: 0,
          endIndex: 3,
          text: '',
          kind: 'heading-marker-2',
          groupId: 'h0',
        },
        {
          id: 'b1-open',
          startIndex: boldRowStart + 2,
          endIndex: boldRowStart + 4,
          text: '',
          kind: 'marker',
          groupId: 'bold-1',
        },
        {
          id: 'b1-close',
          startIndex: boldRowStart + 8,
          endIndex: boldRowStart + 10,
          text: '',
          kind: 'marker',
          groupId: 'bold-1',
        },
        {
          id: 'b2-open',
          startIndex: otherRowStart + 2,
          endIndex: otherRowStart + 4,
          text: '',
          kind: 'marker',
          groupId: 'bold-2',
        },
        {
          id: 'b2-close',
          startIndex: otherRowStart + 9,
          endIndex: otherRowStart + 11,
          text: '',
          kind: 'marker',
          groupId: 'bold-2',
        },
      ])
      await flush()

      // Start on plain row 1 (outside every reveal range).
      const plainRow1Start = lines[0]!.length + 1
      editor.setSelection(plainRow1Start, plainRow1Start)

      const viewWrapper = Reflect.get(editor, 'view') as VirtualizedTextView
      const viewInternal = Reflect.get(viewWrapper, 'view') as VirtualizedTextViewInternal
      expect(viewInternal.tokenPainter.kind).toBe(tokenPainting)
      expect(viewInternal.rowElements.size).toBe(lines.length)

      // Capture untouched span node references for the 'spans' painter.
      const untouchedRow0 = viewInternal.rowElements.get(0)!
      const untouchedRow4 = viewInternal.rowElements.get(4)!
      const untouchedSpan0 = untouchedRow0.element.querySelector('.editor-token')
      const untouchedSpan4 = untouchedRow4.element.querySelector('.editor-token')
      if (tokenPainting === 'spans') {
        expect(untouchedSpan0).not.toBeNull()
        expect(untouchedSpan4).not.toBeNull()
      }

      const clearRowSpy = vi.spyOn(viewInternal.tokenPainter, 'clearRow')
      const clearRowsSpy = vi.spyOn(viewInternal.tokenPainter, 'clearRows')
      const paintRowSpy = vi.spyOn(viewInternal.tokenPainter, 'paintRow')

      // Enter **bold** on row 2: only row 2 should be cleared and repainted.
      editor.setSelection(boldRowStart + 5, boldRowStart + 5)

      expect(clearRowsSpy).not.toHaveBeenCalled()
      expect(new Set(clearRowSpy.mock.calls.map(([slotId]) => slotId))).toEqual(
        new Set([viewInternal.rowElements.get(2)!.tokenHighlightSlotId]),
      )
      expect(paintRowSpy.mock.calls.map(([row]) => row.index)).toEqual([2])
      expect(viewInternal.rowElements.get(2)!.text).toBe('a **bold** b')
      expect(viewInternal.rowElements.get(0)!.text).toBe('Heading')
      expect(viewInternal.rowElements.get(4)!.text).toBe('c other d')
      if (tokenPainting === 'spans') {
        expect(untouchedRow0.element.querySelector('.editor-token')).toBe(untouchedSpan0)
        expect(untouchedRow4.element.querySelector('.editor-token')).toBe(untouchedSpan4)
      }

      clearRowSpy.mockClear()
      paintRowSpy.mockClear()

      // Move caret within the same revealed **bold** span: zero rows should be invalidated.
      editor.setSelection(boldRowStart + 6, boldRowStart + 6)
      expect(clearRowSpy).not.toHaveBeenCalled()
      expect(paintRowSpy).not.toHaveBeenCalled()

      // Leave **bold** back to plain row 1: only row 2 should be cleared and repainted.
      editor.setSelection(plainRow1Start, plainRow1Start)
      expect(clearRowsSpy).not.toHaveBeenCalled()
      expect(new Set(clearRowSpy.mock.calls.map(([slotId]) => slotId))).toEqual(
        new Set([viewInternal.rowElements.get(2)!.tokenHighlightSlotId]),
      )
      expect(paintRowSpy.mock.calls.map(([row]) => row.index)).toEqual([2])
      expect(viewInternal.rowElements.get(2)!.text).toBe('a bold b')
    })
  },
)

function paintedRanges(): readonly { start: number; end: number; text: string | null }[] {
  const ranges = []
  for (const highlight of highlightsMap.values()) {
    for (const range of highlight) {
      ranges.push({
        start: range.startOffset,
        end: range.endOffset,
        text: range.startContainer.textContent,
      })
    }
  }
  return ranges
}

function highlighterPlugin(): EditorPlugin {
  return {
    name: 'test.highlighter',
    activate: (context) =>
      context.registerHighlighter({
        operation: createEditorHighlighterOperation(() => ({
          analyze: async () => ({ tokens: EditorTokenStore.fromTokens(tokens) }),
          dispose: () => undefined,
        })),
      }),
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 180))
  await Promise.resolve()
  await Promise.resolve()
}
