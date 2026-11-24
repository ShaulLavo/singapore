import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorDocumentAnalysis } from '../src/editor/documentAnalysis'
import { createEditorTextBuffer, createEditorBufferSession } from '../src/documentSession'
import { EditorSyntaxController } from '../src/editor/syntaxController'
import { EditorPluginHost } from '../src/plugins'
import {
  createEmptySyntaxResult,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
} from '../src/syntax/session'
import { EditorTokenStore } from '../src/syntax/tokenStore'
import { createEmptySyntaxRuntime, createSyntaxPlugin } from './factories/syntaxRuntime'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

const TEXT = 'const answer = 42\n'.repeat(2_000)
const VISIBLE = { startIndex: 0, endIndex: 20_540 }

/**
 * A new document has no colors, and the visible range the editor asks for reaches far past the
 * rows on screen so that scrolling stays colored. The first answer is for those rows alone.
 */
describe('the first highlight of a document', () => {
  it('asks for the rows on screen first, then for the visible range around them', async () => {
    const rows = { startIndex: 0, endIndex: 540 }
    const fixture = controller(rows)

    fixture.syntax.refresh(1, null, { delayMs: 0 })
    await vi.waitFor(() => expect(fixture.asked).toEqual([rows]))
    expect(fixture.adopted).toEqual([])

    fixture.answer(0, colored(1))
    await vi.waitFor(() => expect(fixture.asked).toEqual([rows, VISIBLE]))

    // Colors are on screen from the first answer. The document's highlight is not settled by it:
    // the answer that covers the visible range is still on its way, and so are the folds.
    expect(fixture.adopted).toEqual([1])
    expect(fixture.syntax.initialHighlightStatus).toBe('loading')
    expect(fixture.syntax.status).toBe('loading')
    expect(fixture.folds).toEqual([])

    fixture.answer(1, { ...colored(3), folds: [fold()] })
    await vi.waitFor(() => expect(fixture.folds).toEqual([1]))

    expect(fixture.syntax.initialHighlightStatus).toBe('painted')
    expect(fixture.syntax.status).toBe('ready')
    expect(fixture.asked).toEqual([rows, VISIBLE])
  })

  it('paints once and asks for the visible range once when a newer request takes over', async () => {
    const rows = { startIndex: 0, endIndex: 540 }
    const fixture = controller(rows)

    fixture.syntax.refresh(1, null, { delayMs: 0 })
    await vi.waitFor(() => expect(fixture.asked).toEqual([rows]))
    // A newer request for the same text while the first one's rows are still on their way. It
    // joins the rows already asked for instead of asking again.
    fixture.syntax.refresh(1, null, { delayMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.asked).toEqual([rows])

    fixture.answer(0, colored(1))
    await vi.waitFor(() => expect(fixture.asked).toEqual([rows, VISIBLE]))

    // One paint and one request for the range around the rows: the superseded request stopped
    // when its rows arrived and left both to the one that replaced it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.adopted).toEqual([1])
    expect(fixture.asked).toEqual([rows, VISIBLE])
  })

  it('asks once when the rows on screen are nearly the whole visible range', async () => {
    const fixture = controller({ startIndex: 0, endIndex: VISIBLE.endIndex - 500 })

    fixture.syntax.refresh(1, null, { delayMs: 0 })
    await vi.waitFor(() => expect(fixture.asked).toEqual([VISIBLE]))
    fixture.answer(0, { ...colored(3), folds: [fold()] })
    await vi.waitFor(() => expect(fixture.folds).toEqual([1]))

    expect(fixture.asked).toEqual([VISIBLE])
  })
})

function colored(tokens: number): EditorSyntaxResult {
  return {
    ...createEmptySyntaxResult(),
    tokens: EditorTokenStore.fromTokens(
      Array.from({ length: tokens }, (_, index) => ({
        start: index * 18,
        end: index * 18 + 5,
        style: { color: '#c00' },
      })),
    ),
  }
}

function fold(): EditorSyntaxResult['folds'][number] {
  return {
    startIndex: 0,
    endIndex: 36,
    startLine: 0,
    endLine: 2,
    type: 'block',
    languageId: 'typescript',
  }
}

function controller(mountedRows: EditorSyntaxRange) {
  const buffer = createEditorTextBuffer(TEXT)
  const session = createEditorBufferSession(buffer)
  const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'first-rows' })
  const asked: EditorSyntaxRange[] = []
  const answers: Array<(result: EditorSyntaxResult) => void> = []
  const adopted: number[] = []
  const folds: number[] = []
  const pluginHost = new EditorPluginHost([
    createSyntaxPlugin(() => ({
      ...createEmptySyntaxRuntime(),
      foldingSupport: 'supported',
      queryRange: (range) => {
        asked.push(range)
        return new Promise<EditorSyntaxResult>((resolve) => answers.push(resolve))
      },
    })),
  ])
  const syntax = new EditorSyntaxController({
    pluginHost,
    getDocumentVersion: () => 1,
    getDocumentId: () => 'first-rows',
    getTextVersion: () => 0,
    getCurrentSessionDocumentId: () => 'first-rows',
    getLanguageId: () => 'typescript',
    getSession: () => session,
    getVisibleSyntaxRange: () => VISIBLE,
    getMountedSyntaxRange: () => mountedRows,
    adoptTokens: (tokens) => adopted.push(tokens.length),
    clearSyntaxFolds: () => undefined,
    setSyntaxFolds: (next) => folds.push(next.length),
    notifyChange: () => undefined,
    notifyViewUpdate: () => undefined,
    notifyThemeChanged: () => undefined,
  })
  syntax.startDocument({
    analysis,
    documentId: 'first-rows',
    languageId: 'typescript',
    snapshot: session.getSnapshot(),
    textSnapshot: session.getTextSnapshot(),
  })
  disposers.push(() => {
    syntax.dispose()
    pluginHost.dispose()
    analysis.dispose()
  })
  return {
    syntax,
    asked,
    adopted,
    folds,
    answer: (index: number, result: EditorSyntaxResult) => answers[index]!(result),
  }
}
