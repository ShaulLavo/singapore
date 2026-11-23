import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorBufferSession, createEditorTextBuffer } from '../src/documentSession'
import type { Editor } from '../src/editor'
import { createEditorDocumentAnalysis } from '../src/editor/documentAnalysis'
import type { EditorSyntaxController } from '../src/editor/syntaxController'
import { createEmptySyntaxResult, type EditorSyntaxRange } from '../src/syntax/session'
import { EditorTokenStore } from '../src/syntax/tokenStore'
import { VirtualizedTextView } from '../src/virtualization'
import { createEmptySyntaxRuntime, createSyntaxPlugin } from './factories/syntaxRuntime'
import { createVisibleEditor } from './factories/visibleEditor'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

describe('range colors through an edit', () => {
  it.each([
    ['a typed character', 'x'],
    ['a line break', '\n'],
  ] as const)('removes them once the view leaves after %s', async (_name, text) => {
    const buffer = createEditorTextBuffer(`${'x'.repeat(99)}\n`.repeat(12_000))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'edited.ts' })
    cleanups.push(() => analysis.dispose())
    // Once the edit is made the provider stops answering, so the only colors are the ones the
    // editor moved through the edit.
    let answering = true
    const queryRange = vi.fn((range: EditorSyntaxRange) => {
      if (!answering) return new Promise<never>(() => undefined)
      return Promise.resolve({
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: 'range' } },
        ]),
      })
    })
    const plugin = createSyntaxPlugin(() => ({ ...createEmptySyntaxRuntime(), queryRange }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    cleanups.push(() => host.remove())
    const editor = createVisibleEditor(host, { plugins: [plugin] })
    cleanups.push(() => editor.dispose())
    const view = textView(editor)
    view.setScrollMetrics(0, 72, 400)
    editor.attachSession(createEditorBufferSession(buffer), {
      analysis,
      documentId: 'edited.ts',
      languageId: 'typescript',
    })
    await vi.waitFor(() => expect(tokens(editor).length).toBeGreaterThan(0))

    answering = false
    editor.edit({ from: 50, to: 50, text })
    expect(tokens(editor).length).toBeGreaterThan(0)
    view.setScrollMetrics(view.getState().totalHeight - 72, 72, 400)
    expect(view.getState().mountedRows[0]!.startOffset).toBeGreaterThan(1_000_000)

    await vi.waitFor(() => expect(tokens(editor).toTokens()).toEqual([]))
  })
})

function textView(editor: Editor): VirtualizedTextView {
  const view: unknown = Reflect.get(editor, 'view')
  if (!(view instanceof VirtualizedTextView))
    throw new TypeError('Expected the real Editor text view')
  return view
}

function tokens(editor: Editor): EditorTokenStore {
  const syntax: EditorSyntaxController = Reflect.get(editor, 'syntax')
  return syntax.tokens
}
