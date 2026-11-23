import { afterEach, expect, it } from 'vitest'
import {
  toEditorTokenStore,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
} from '@singapore-editor/core/syntax'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import { disposeTreeSources } from './factories/source'

// A range longer than this many units runs in slices inside the worker; a shorter one is one query.
const SLICE_UNITS = 8_192

const clients = new Set<TreeSitterWorkerClient>()
afterEach(async () => {
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
