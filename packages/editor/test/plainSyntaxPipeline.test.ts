import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Editor } from '../src/editor'
import { EditorSyntaxController } from '../src/editor/syntaxController'
import { EditorPlainSyntax, editorDocumentAnalysisRuntime } from '../src/editor/syntaxPipeline'
import type { EditorInitialPaintEvent, EditorPlugin } from '../src/plugins'
import { setHighlightRegistry } from '../src/public/testing'
import { EditorTokenStore } from '../src/syntax'
import { createVisibleEditor } from './factories/visibleEditor'

// What providers install lives on the global object; each test starts from a page that has none.
const RUNTIME_KEYS = [Symbol.for('@singapore-editor/core/syntax-runtime')]

const editors: Editor[] = []

beforeEach(() => {
  for (const key of RUNTIME_KEYS) Reflect.deleteProperty(globalThis, key)
  vi.useFakeTimers()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  setHighlightRegistry(new Map())
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
  for (const key of RUNTIME_KEYS) Reflect.deleteProperty(globalThis, key)
  document.body.replaceChildren()
  setHighlightRegistry(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(options: Parameters<typeof createVisibleEditor>[1] = {}): Editor {
  const container = document.createElement('div')
  document.body.append(container)
  const editor = createVisibleEditor(container, options)
  editors.push(editor)
  return editor
}

const syntaxOf = (editor: Editor): unknown => Reflect.get(editor, 'syntax')

const STRING = { color: 'var(--editor-syntax-string)' }

/**
 * A highlighter that colors the first `length` characters, built only when a test asks for it:
 * through the helper providers use, or straight from the operation class.
 */
async function highlighterPlugin(
  length: number,
  from: 'helpers' | 'classes' = 'helpers',
): Promise<EditorPlugin> {
  const { createEditorHighlighterOperation } =
    from === 'helpers'
      ? await import('../src/editor/syntaxOperations')
      : await import('../src/editor/operationDefinitions')
  const operation = createEditorHighlighterOperation(() => ({
    analyze: () =>
      Promise.resolve({
        tokens: EditorTokenStore.fromTokens([{ start: 0, end: length, style: STRING }]),
      }),
    dispose() {},
  }))
  return { activate: (context) => [context.registerHighlighter({ operation })] }
}

test('an editor given only text runs without the syntax controller or document analysis', async () => {
  const events: EditorInitialPaintEvent[] = []
  const editor = mount({ onInitialPaint: (event) => events.push(event) })
  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(EditorPlainSyntax)
  expect(editorDocumentAnalysisRuntime()).toBeNull()
  expect(editor['syntaxStatus']).toBe('plain')
  expect(
    events.map((event) => [event.phase, 'status' in event ? event.status : undefined]),
  ).toEqual([
    ['text', undefined],
    ['highlight-settled', 'plain'],
  ])
})

test('tokens a host sets on a plain editor paint and follow edits', async () => {
  const editor = mount()
  editor.setText('const value = 1\n')
  editor.setTokens([{ start: 0, end: 5, style: STRING }])

  expect(syntaxOf(editor)).toBeInstanceOf(EditorPlainSyntax)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])
  expect(editor['view']['view'].tokens.toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])

  editor.edit([{ from: 0, to: 0, text: '  ' }])
  await vi.advanceTimersByTimeAsync(200)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 2, end: 7, style: STRING }])
})

test('a highlighter added to a plain editor takes the document over and paints it', async () => {
  const events: EditorInitialPaintEvent[] = []
  const editor = mount({ onInitialPaint: (event) => events.push(event) })
  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)
  expect(syntaxOf(editor)).toBeInstanceOf(EditorPlainSyntax)

  editor.addPlugin(await highlighterPlugin(5))
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(EditorSyntaxController)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])
  expect(editor['syntax'].initialHighlightStatus).toBe('painted')
  // The text paint was already announced by the plain pipeline and is not announced again.
  expect(events.filter((event) => event.phase === 'text')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ phase: 'highlight-settled', status: 'painted' })
})

test('a highlighter built without the helpers gets the full controller once it loads', async () => {
  const editor = mount({ plugins: [await highlighterPlugin(4, 'classes')] })
  editor.setText('const value = 1\n')
  expect(syntaxOf(editor)).toBeInstanceOf(EditorPlainSyntax)

  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(EditorSyntaxController)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 4, style: STRING }])
})

test('an editor constructed with a highlighter starts on the full controller', async () => {
  const editor = mount({ plugins: [await highlighterPlugin(3)] })
  expect(syntaxOf(editor)).toBeInstanceOf(EditorSyntaxController)

  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 3, style: STRING }])
})
