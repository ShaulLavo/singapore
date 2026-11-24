import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Editor } from '../src/editor'
import type { EditorDocumentContributions } from '../src/editor/documentAnalysis'
import type {
  EditorInitialPaintEvent,
  EditorLogEvent,
  EditorPlugin,
  EditorViewContributionContext,
} from '../src/plugins'

// Each test loads its own copy of the package, so no copy starts with the syntax controller that
// another test's helpers installed. Two loads in one test are two copies of the package on a page.
async function loadPackage() {
  vi.resetModules()
  const [factories, testing, pipeline, controller, helpers, classes, session, tokens] =
    await Promise.all([
      import('./factories/visibleEditor'),
      import('../src/public/testing'),
      import('../src/editor/syntaxPipeline'),
      import('../src/editor/syntaxController'),
      import('../src/editor/syntaxOperations'),
      import('../src/editor/operationDefinitions'),
      import('../src/documentSession'),
      import('../src/syntax/tokenStore'),
    ])
  testing.setHighlightRegistry(new Map())
  cleanups.push(() => testing.setHighlightRegistry(undefined))
  const STRING = { color: 'var(--editor-syntax-string)' }

  /** A highlighter that colors the first `length` characters, built the way `from` says. */
  const highlighterPlugin = (length: number, from: 'helpers' | 'classes' = 'helpers') => {
    const create =
      from === 'helpers'
        ? helpers.createEditorHighlighterOperation
        : classes.createEditorHighlighterOperation
    const operation = create(() => ({
      analyze: () =>
        Promise.resolve({
          tokens: tokens.EditorTokenStore.fromTokens([{ start: 0, end: length, style: STRING }]),
        }),
      dispose() {},
    }))
    const plugin: EditorPlugin = {
      activate: (context) => [context.registerHighlighter({ operation })],
    }
    return plugin
  }

  const mount = (options: Parameters<typeof factories.createVisibleEditor>[1] = {}): Editor => {
    const container = document.createElement('div')
    document.body.append(container)
    const editor = factories.createVisibleEditor(container, options)
    cleanups.push(() => editor.dispose())
    return editor
  }

  return { pipeline, controller, session, highlighterPlugin, mount, STRING }
}

const cleanups: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const syntaxOf = (editor: Editor): unknown => Reflect.get(editor, 'syntax')

const paintPhases = (events: readonly EditorInitialPaintEvent[]) =>
  events.map((event) => [event.phase, 'status' in event ? event.status : undefined])

/** A plugin whose view contribution hands back its context, for the document receiver. */
function viewContextPlugin(contexts: EditorViewContributionContext[]): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: (view) => {
          contexts.push(view)
          return { update: () => {}, dispose: () => {} }
        },
      }),
  }
}

test('an editor given only text runs without the syntax controller', async () => {
  const { mount, pipeline } = await loadPackage()
  const events: EditorInitialPaintEvent[] = []
  const editor = mount({ onInitialPaint: (event) => events.push(event) })
  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(pipeline.EditorPlainSyntax)
  expect(editor['syntaxStatus']).toBe('plain')
  expect(paintPhases(events)).toEqual([
    ['text', undefined],
    ['highlight-settled', 'plain'],
  ])
})

test('tokens a host sets on a plain editor paint and follow edits', async () => {
  const { mount, pipeline, STRING } = await loadPackage()
  const editor = mount()
  editor.setText('const value = 1\n')
  editor.setTokens([{ start: 0, end: 5, style: STRING }])

  expect(syntaxOf(editor)).toBeInstanceOf(pipeline.EditorPlainSyntax)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])
  expect(editor['view']['view'].tokens.toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])

  editor.edit([{ from: 0, to: 0, text: '  ' }])
  await vi.advanceTimersByTimeAsync(200)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 2, end: 7, style: STRING }])
})

test('a highlighter added to a plain editor takes the document over and paints it', async () => {
  const { mount, controller, highlighterPlugin, STRING } = await loadPackage()
  const events: EditorInitialPaintEvent[] = []
  const editor = mount({ onInitialPaint: (event) => events.push(event) })
  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)

  editor.addPlugin(highlighterPlugin(5))
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(controller.EditorSyntaxController)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 5, style: STRING }])
  expect(editor['syntax'].initialHighlightStatus).toBe('painted')
  // The plain pipeline already announced the text paint, and it is not announced again.
  expect(events.filter((event) => event.phase === 'text')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ phase: 'highlight-settled', status: 'painted' })
})

test('a highlighter added while the text paint is announced settles once, as painted', async () => {
  const { mount, controller, highlighterPlugin } = await loadPackage()
  const events: EditorInitialPaintEvent[] = []
  const statuses: string[] = []
  const editor: Editor = mount({
    onInitialPaint: (event) => {
      events.push(event)
      statuses.push(editor['syntax'].initialHighlightStatus)
      // Built here, so the editor is still on the plain pipeline when the text paint is announced.
      if (event.phase === 'text') editor.addPlugin(highlighterPlugin(5))
    },
  })
  editor.setText('const value = 1\n')
  expect(syntaxOf(editor)).toBeInstanceOf(controller.EditorSyntaxController)
  await vi.advanceTimersByTimeAsync(200)

  expect(paintPhases(events)).toEqual([
    ['text', undefined],
    ['highlight-settled', 'painted'],
  ])
  expect(statuses.at(-1)).toBe('painted')
})

test('a highlighter built from the operation classes alone is refused with a clear error', async () => {
  const { mount, pipeline, highlighterPlugin } = await loadPackage()
  const logged: EditorLogEvent[] = []
  const editor = mount({
    plugins: [{ activate: (context) => context.registerLogger((event) => logged.push(event)) }],
  })
  editor.setText('const value = 1\n')
  editor.addPlugin(highlighterPlugin(4, 'classes'))
  await vi.advanceTimersByTimeAsync(200)

  const failure = logged.find((event) => event.action === 'editor.plugin.activation_failed')
  expect(failure?.error?.message).toMatch(/createEditorHighlighterOperation/)
  expect(editor['pluginHost'].hasHighlighterProviders()).toBe(false)
  expect(syntaxOf(editor)).toBeInstanceOf(pipeline.EditorPlainSyntax)
})

test('a plain document has a live contribution receiver that outlives a highlighting peer', async () => {
  const { mount, session, highlighterPlugin } = await loadPackage()
  const buffer = session.createEditorTextBuffer('shared text')
  const plainContexts: EditorViewContributionContext[] = []
  const plain = mount({ plugins: [viewContextPlugin(plainContexts)] })
  plain.attachSession(session.createEditorBufferSession(buffer))
  const plainReceiver = plainContexts[0]!.getDocumentContributions()
  expect(plainReceiver).not.toBeNull()

  const peerContexts: EditorViewContributionContext[] = []
  const peer = mount({ plugins: [highlighterPlugin(3), viewContextPlugin(peerContexts)] })
  peer.attachSession(session.createEditorBufferSession(buffer))
  await vi.advanceTimersByTimeAsync(200)
  const shared: EditorDocumentContributions | null = peerContexts[0]!.getDocumentContributions()
  expect(shared).toBe(plainReceiver)
  peer.dispose()

  expect(plainContexts[0]!.getDocumentContributions()).toBe(shared)
  const owner = shared!.pin()
  expect(owner).not.toBeNull()
  owner?.dispose()
})

test('a provider from one copy of the package does not disturb another copy', async () => {
  const first = await loadPackage()
  first.highlighterPlugin(2)
  const second = await loadPackage()
  const editor = second.mount({ plugins: [second.highlighterPlugin(3)] })
  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)

  expect(syntaxOf(editor)).toBeInstanceOf(second.controller.EditorSyntaxController)
  expect(editor['syntax'].initialHighlightStatus).toBe('painted')
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 3, style: second.STRING }])
})

test('an editor constructed with a highlighter starts on the full controller', async () => {
  const { mount, controller, highlighterPlugin, STRING } = await loadPackage()
  const editor = mount({ plugins: [highlighterPlugin(3)] })
  expect(syntaxOf(editor)).toBeInstanceOf(controller.EditorSyntaxController)

  editor.setText('const value = 1\n')
  await vi.advanceTimersByTimeAsync(200)
  expect(editor['tokens'].toTokens()).toEqual([{ start: 0, end: 3, style: STRING }])
})
