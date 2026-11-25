import { afterEach, expect, it, vi } from 'vitest'
import { Language, Parser, type Tree } from 'web-tree-sitter'
import parserWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import { DocumentWorkerReader } from '@singapore-editor/core/internal/document-worker'
import {
  toEditorTokenStore,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
} from '@singapore-editor/core/syntax'
import { resolveTreeSitterLanguageContribution } from '../src'
import { createTreeSitterInput } from '../src/treeSitter/source'
import { __treeSitterWorkerInternalsForTests } from '../src/treeSitter/treeSitter.worker'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import { disposeTreeSources } from './factories/source'

// A range longer than this many units runs in slices inside the worker; a shorter one is one query.
const SLICE_UNITS = 8_192

const clients = new Set<TreeSitterWorkerClient>()
afterEach(async () => {
  vi.unstubAllGlobals()
  disposeTreeDocuments()
  disposeTreeSources()
  for (const client of clients) await client.dispose()
  clients.clear()
})

function open(backend: TreeSitterWorkerClient, documentId: string, text: string) {
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  return createTreeDocument({
    documentId,
    languageId: 'typescript',
    languageResolver: registry,
    backend,
    syntaxMode: 'range',
    text,
  })
}

function worker(): TreeSitterWorkerClient {
  const backend = new TreeSitterWorkerClient()
  clients.add(backend)
  return backend
}

// Constructs that are long enough to cross a slice boundary wherever it falls: block comments,
// template literals and a class body, between regexes, documentation comments and plain statements.
function source(blocks: number): string {
  const parts: string[] = []
  for (let index = 0; index < blocks; index++) {
    parts.push(
      `/**\n * Widget ${index}. See {@link build_${index}}.\n * @param value the ${'long '.repeat(index % 40)}input\n */`,
      `export class Widget_${index}<T extends object> {`,
      `  static readonly pattern = /^item-(\\d+)\\.(ts|tsx)$/u`,
      `  private readonly names = new Map<string, T>([${'["a", null as never], '.repeat(index % 25)}])`,
      `  describe(value: T): string {`,
      `    return \`widget ${index}: \${JSON.stringify(value)}${' and more text'.repeat(index % 60)}\``,
      `  }`,
      `  /* ${'a block comment that runs on '.repeat(index % 50)} */`,
      `  build_${index}(input: readonly number[] = [1, 2, 3]): { total: number; label?: string } {`,
      `    const total = input.reduce((sum, item) => (item > 0 ? sum + item : sum), 0)`,
      `    if (total > ${index}) return { total, label: 'large' }`,
      `    return { total }`,
      `  }`,
      `}`,
      ``,
    )
  }
  return parts.join('\n')
}

type Paint = readonly string[]

function painted(result: EditorSyntaxResult, range: EditorSyntaxRange): Paint {
  const paint: string[] = Array.from({ length: range.endIndex - range.startIndex }, () => '')
  for (const token of toEditorTokenStore(result.tokens).toTokens()) {
    const style = JSON.stringify(token.style)
    const from = Math.max(token.start, range.startIndex)
    const to = Math.min(token.end, range.endIndex)
    for (let index = from; index < to; index++) paint[index - range.startIndex] = style
  }
  return paint
}

const touches = (
  item: { readonly startIndex: number; readonly endIndex: number },
  range: EditorSyntaxRange,
): boolean => item.startIndex < range.endIndex && item.endIndex > range.startIndex

// Order among equal spans depends on which layer reported first; the set is what is compared.
const listed = (items: readonly object[]): string[] =>
  items.map((item) => JSON.stringify(item)).toSorted()

it('colors a long range exactly as the same text asked for in short windows', async () => {
  const text = source(200)
  expect(text.length).toBeGreaterThan(30 * SLICE_UNITS)
  const doc = open(worker(), 'range-slices', text)
  await doc.run()
  const whole = { startIndex: 0, endIndex: text.length }
  // Longer than a slice, so the worker runs it in slices and pauses between them.
  const long = await doc.runtime.queryRange(whole)
  expect(long.projection.analysis?.kind).toBe('full')
  const longPaint = painted(long, whole)
  expect(longPaint.filter(Boolean).length).toBeGreaterThan(text.length / 4)
  expect(long.injections.length).toBeGreaterThan(100)

  let compared = 0
  // Windows of an odd length, so their edges fall elsewhere than the slice boundaries do.
  for (let start = 0; start < text.length; start += 7_001) {
    const window = { startIndex: start, endIndex: Math.min(text.length, start + 7_001) }
    const short = await doc.runtime.queryRange(window)
    expect(painted(short, window)).toEqual(longPaint.slice(window.startIndex, window.endIndex))
    expect(listed(short.folds)).toEqual(listed(long.folds.filter((fold) => touches(fold, window))))
    expect(listed(short.errors)).toEqual(
      listed(long.errors.filter((error) => touches(error, window))),
    )
    compared += 1
  }
  expect(compared).toBeGreaterThan(30)

  // Bracket depth counts from the start of the asked range, so only a window with the same start
  // has the same depths.
  const first = { startIndex: 0, endIndex: 7_001 }
  const short = await doc.runtime.queryRange(first)
  expect(short.brackets).toEqual(long.brackets.filter((bracket) => bracket.index < first.endIndex))
  expect(short.brackets.length).toBeGreaterThan(100)
}, 120_000)

it('answers another document while a long range query is still running', async () => {
  const backend = worker()
  const text = source(400)
  const large = open(backend, 'range-slices-large', text)
  await large.run()
  // Complete the analysis first, so the long query below is one request against the full tree.
  await large.runtime.queryRange({ startIndex: text.length - 64, endIndex: text.length })
  expect(large.runtime.getResult().projection.analysis?.kind).toBe('full')

  const order: string[] = []
  const long = large.runtime
    .queryRange({ startIndex: 0, endIndex: text.length })
    .then(() => order.push('long range'))
  // Asked after the long range, with nothing cancelled: it can only answer first if the worker
  // returns to its message loop while the long range is still running.
  const small = open(backend, 'range-slices-small', 'const answer: number = 42\n')
  const answered = small
    .run()
    .then(() => small.runtime.queryRange({ startIndex: 0, endIndex: 26 }))
    .then((result) => {
      order.push('other document')
      return result
    })

  const result = await answered
  await long
  expect(result.projection.analysis?.kind).toBe('full')
  expect(toEditorTokenStore(result.tokens).length).toBeGreaterThan(3)
  expect(order).toEqual(['other document', 'long range'])
}, 120_000)

it('stops a long range query when its document closes on a page without shared memory', async () => {
  // What a page that is not cross-origin isolated has: no cancellation flag reaches the worker.
  vi.stubGlobal('SharedArrayBuffer', undefined)
  const backend = worker()
  const answers: (string | undefined)[] = []
  let runtimeSessionId = ''
  const query = backend.queryRange.bind(backend)
  backend.queryRange = async (payload, signal) => {
    runtimeSessionId = payload.runtimeSessionId
    const result = await query(payload, signal)
    answers.push(result?.analysis?.kind)
    return result
  }
  const text = source(400)
  const large = open(backend, 'range-slices-closing', text)
  await large.run()
  await large.runtime.queryRange({ startIndex: text.length - 64, endIndex: text.length })
  expect(large.runtime.getResult().projection.analysis?.kind).toBe('full')
  answers.length = 0

  // Asked without an abort signal, so nothing on the page settles it early: only the worker
  // hearing of the close can stop it.
  const long = large.runtime.queryRange({ startIndex: 0, endIndex: text.length })
  // The request is posted a few microtasks on, when the worker is known to be ready. The close
  // follows it, and reaches the worker while the query is running.
  await new Promise((resolve) => setTimeout(resolve, 0))
  backend.disposeDocument(runtimeSessionId)
  await long

  expect(answers).toEqual(['cancelled'])
}, 120_000)

const typescript = async () => {
  await Parser.init({ locateFile: () => parserWasmUrl })
  const descriptor = await resolveTreeSitterLanguageContribution(
    TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((language) => language.id === 'typescript')!,
  )
  return { descriptor, language: await Language.load(descriptor.wasmUrl) }
}

const { collectFolds, flattenLayerSlices, rangeSlices, sortFolds } =
  __treeSitterWorkerInternalsForTests
type SliceLayer = Parameters<typeof flattenLayerSlices>[0]
type SliceRuntime = Parameters<typeof flattenLayerSlices>[1]
type SliceResult = Parameters<typeof flattenLayerSlices>[2]

const rootLayer = (tree: Tree): SliceLayer =>
  ({
    id: 'root',
    key: 'root',
    kind: 'root',
    parentId: null,
    parentLanguageId: null,
    languageId: 'typescript',
    depth: 0,
    tree,
    ranges: [],
  }) as unknown as SliceLayer

const emptyResult = (): SliceResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  degraded: [],
  tokens: [],
})

const context = () => ({ startedAt: performance.now(), budgetMs: 60_000, flag: null })

it('lists folds on the same lines in one order, sliced or whole', async () => {
  const { descriptor, language } = await typescript()
  const parser = new Parser()
  parser.setLanguage(language)
  // The call starts in the first slice and the function it is given in the second; both folds
  // span lines 0 to 1.
  const text = 'const A = caller(' + ' '.repeat(SLICE_UNITS) + 'function () {\n}, marker);'
  const tree = parser.parse(text)!
  const runtime = {
    descriptor: {
      ...descriptor,
      foldQuerySource:
        '(call_expression arguments: (arguments (identifier))) @fold (function_expression) @fold',
    },
    language,
    parser,
    highlightQuery: null,
    foldQuery: null,
    injectionQuery: null,
    mergeUnitQuery: null,
  } as SliceRuntime
  const layer = rootLayer(tree)
  const range = { startIndex: 0, endIndex: text.length }
  try {
    const slices = rangeSlices(layer, range)
    const sliced = emptyResult()
    await flattenLayerSlices(layer, runtime, sliced, context(), {
      options: { range, includeHighlights: false, includeCaptures: false },
      pacing: { isCurrent: () => true, resumedAt: performance.now() },
      slices,
    })
    const whole = sortFolds(collectFolds(tree, runtime, context(), range))

    expect(slices.length).toBeGreaterThan(1)
    expect(whole.map((fold) => fold.type)).toEqual(['call_expression', 'function_expression'])
    expect(sortFolds(sliced.folds)).toEqual(whole)
  } finally {
    runtime.foldQuery?.delete()
    tree.delete()
    parser.delete()
  }
}, 60_000)

it('reads a token that is longer than many slices once, not once per slice', async () => {
  const { descriptor, language } = await typescript()
  const parser = new Parser()
  parser.setLanguage(language)
  // The shipped highlight query matches an upper-case identifier against a pattern, which reads
  // the whole identifier.
  const text = 'const ' + 'A'.repeat(2_000_000) + ' = 1;\n'
  let unitsRead = 0
  const tree = parser.parse((index: number, _position?: unknown, endIndex?: number) => {
    if (index >= text.length) return undefined
    const chunk = text.slice(index, Math.min(text.length, endIndex ?? index + 65_536))
    unitsRead += chunk.length
    return chunk
  })!
  const runtime = {
    descriptor,
    language,
    parser,
    highlightQuery: null,
    foldQuery: null,
    injectionQuery: null,
    mergeUnitQuery: null,
  } as SliceRuntime
  const layer = rootLayer(tree)
  const range = { startIndex: 0, endIndex: text.length }
  try {
    const slices = rangeSlices(layer, range)
    const sliced = emptyResult()
    unitsRead = 0
    await flattenLayerSlices(layer, runtime, sliced, context(), {
      options: { range, includeHighlights: true, includeCaptures: true },
      pacing: { isCurrent: () => true, resumedAt: performance.now() },
      slices,
    })

    expect(
      sliced.captures.some((capture) => capture.endIndex - capture.startIndex === 2_000_000),
    ).toBe(true)
    // Reading it in every 8,192-unit slice it spans would be 245 reads, 490 million units.
    expect(unitsRead).toBeLessThan(4 * text.length)
  } finally {
    runtime.highlightQuery?.delete()
    runtime.foldQuery?.delete()
    tree.delete()
    parser.delete()
  }
}, 120_000)

it('yields nested worker slices as macrotasks without calling setTimeout', async () => {
  const { yieldWorker } = __treeSitterWorkerInternalsForTests
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
  try {
    let settled = false
    const first = yieldWorker().then(() => {
      settled = true
    })
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve()
    expect(settled).toBe(false)
    await first
    expect(settled).toBe(true)

    for (let slice = 0; slice < 20; slice += 1) {
      await yieldWorker()
    }
    expect(timeoutSpy).not.toHaveBeenCalled()
  } finally {
    timeoutSpy.mockRestore()
  }
})

it('preempts a long background range query when an urgent edit arrives on the same document', async () => {
  vi.stubGlobal('SharedArrayBuffer', undefined)
  const backend = worker()
  const queryAnswers: (string | undefined)[] = []
  const query = backend.queryRange.bind(backend)
  backend.queryRange = async (payload, signal) => {
    const result = await query(payload, signal)
    queryAnswers.push(result?.analysis?.kind)
    return result
  }
  const text = source(400)
  const doc = open(backend, 'range-slices-edit-preempt', text)
  await doc.run()
  await doc.runtime.queryRange({ startIndex: text.length - 64, endIndex: text.length })
  expect(doc.runtime.getResult().projection.analysis?.kind).toBe('full')
  queryAnswers.length = 0

  // Start a full-document background range query without an AbortSignal, then queue the edit
  // immediately in the same turn so it arrives at the worker behind the query's first slice.
  const longQuery = doc.runtime.queryRange({ startIndex: 0, endIndex: text.length })
  const edited = await doc.edit([{ from: 0, to: 0, text: '/* urgent */ ' }])
  await longQuery

  expect(edited.projection.analysis?.kind).toBe('full')
  expect(queryAnswers).toEqual(['cancelled'])
}, 120_000)

it('parses a non-markdown document once on open without scheduling an idle double-reparse', async () => {
  const { disposeDocument, parseFullDocument, registerLanguages } =
    __treeSitterWorkerInternalsForTests
  const { descriptor, language } = await typescript()
  const noInjections = { ...descriptor, injectionQuerySource: '' }
  registerLanguages([noInjections])
  const parser = new Parser()
  parser.setLanguage(language)
  let parseCalls = 0
  const originalParse = parser.parse.bind(parser)
  parser.parse = ((...args: Parameters<Parser['parse']>) => {
    parseCalls += 1
    return originalParse(...args)
  }) as Parser['parse']

  const runtime = {
    descriptor: noInjections,
    language,
    parser,
    highlightQuery: null,
    foldQuery: null,
    injectionQuery: null,
    mergeUnitQuery: null,
  } as Parameters<typeof parseFullDocument>[1]

  const runtimeSessionId = 'single-parse-open-typescript'
  const text = source(10)
  const reader = new DocumentWorkerReader()
  const identity = {
    documentId: runtimeSessionId,
    documentGeneration: 1,
    endpointGeneration: 1,
    registrationId: 1,
  }
  const point = { segment: runtimeSessionId, revision: 0, textVersion: 0 }
  reader.apply({ kind: 'register', identity })
  reader.apply({
    kind: 'reset',
    identity,
    base: null,
    target: point,
    chunks: [text],
    lineEnding: '\n',
    byteOrderMark: '',
    containsUnusualLineTerminators: false,
  })
  const input = createTreeSitterInput(reader.acquire({ identity, point })!)

  try {
    await parseFullDocument(
      {
        type: 'parse',
        documentId: runtimeSessionId,
        runtimeSessionId,
        languageId: 'typescript',
        snapshotVersion: 1,
        readOnly: false,
        includeHighlights: true,
        generation: 1,
        source: { identity, point, readId: runtimeSessionId },
      },
      runtime,
      input,
      context(),
    )
    // Wait long enough for any deferred setTimeout(0) idle reparse to have fired.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(parseCalls).toBe(1)
  } finally {
    disposeDocument(runtimeSessionId)
    input.dispose()
    reader.dispose()
    parser.delete()
  }
}, 60_000)
