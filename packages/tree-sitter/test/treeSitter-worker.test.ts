import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Node, Query, Range as TreeSitterRange, Tree } from 'web-tree-sitter'

import {
  DocumentWorkerReader,
  type DocumentWorkerReadReference,
} from '@singapore-editor/core/internal/document-worker'
import { createTreeSitterInput, readTreeSitterInputRange } from '../src/treeSitter/source.ts'
import { __treeSitterWorkerInternalsForTests } from '../src/treeSitter/treeSitter.worker.ts'

const {
  applyTextEdit,
  applyTextEdits,
  appendItems,
  collectBracket,
  collectCaptures,
  collectError,
  collectTreeData,
  rangeSpan,
  readTreeSitterPieceTableInput,
  replaceCachedDocument,
  reusableParsedDocument,
  disposeDocument,
} = __treeSitterWorkerInternalsForTests

describe('tree-sitter worker internals', () => {
  it('retains phase timings when a stale request cancels', async () => {
    const result = await __treeSitterWorkerInternalsForTests.runCancellableRequest(
      {
        type: 'parse',
        documentId: 'worker-fixture',
        runtimeSessionId: 'superseded-fixture',
        languageId: 'typescript',
        snapshotVersion: 1,
        generation: 1,
        includeHighlights: false,
        source: messageSource,
      },
      async (context) => {
        context.measurements?.set('parseRoot', 12)
        context.counts?.set('parseSlices', 2)
        __treeSitterWorkerInternalsForTests.assertNotCancelled(context)
        return undefined
      },
    )
    expect(result).toMatchObject({
      status: 'cancelled',
      analysis: { kind: 'cancelled', reason: 'superseded' },
      timings: [{ name: 'treeSitter.parseRoot', durationMs: 12 }],
      statistics: { parseSlices: 2 },
    })
  })

  it('reports an exhausted work budget as a structured outcome', () => {
    const result = __treeSitterWorkerInternalsForTests.cancellationAnalysis({
      startedAt: performance.now() - 21_000,
      budgetMs: 20_000,
      flag: null,
      measurements: new Map([['parseRoot', 19_000]]),
    })
    expect(result).toMatchObject({
      kind: 'cancelled',
      reason: 'budget',
      budgetMs: 20_000,
      timings: [{ name: 'treeSitter.parseRoot', durationMs: 19_000 }],
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(21_000)
  })

  it('applies text edits by replacing the old range', () => {
    expect(applyTextEdit('const a = 1;', 6, 7, 'answer')).toBe('const answer = 1;')
    expect(applyTextEdit('abcdef', 2, 4, '')).toBe('abef')
    expect(applyTextEdit('abef', 2, 2, 'cd')).toBe('abcdef')
  })

  it('applies batch text edits from the original offsets', () => {
    expect(
      applyTextEdits('ab\ncd', [
        { from: 0, to: 1, text: 'x' },
        { from: 3, to: 5, text: 'yz' },
      ]),
    ).toBe('xb\nyz')
  })

  it('reads parser input through the ordinary bounded reader', () => {
    const input = inputFromText('a😀\ntail')
    expect(readTreeSitterPieceTableInput(input, 0)).toBe('a😀\ntail')
    expect(readTreeSitterPieceTableInput(input, 4)).toBe('tail')
    expect(readTreeSitterPieceTableInput(input, input.length)).toBeUndefined()
    expect(readTreeSitterInputRange(input, 1, input.length)).toBe('😀\ntail')
  })

  it('caps parser input reads to fit the web-tree-sitter UTF-16 callback buffer', () => {
    const input = inputFromText('a'.repeat(10_000))
    expect(readTreeSitterPieceTableInput(input, 0)).toHaveLength(4096)
    expect(readTreeSitterPieceTableInput(input, 4096)).toHaveLength(4096)
    expect(readTreeSitterPieceTableInput(input, 8192)).toHaveLength(1808)
  })

  it('reads an empty ordinary source', () => {
    expect(readTreeSitterPieceTableInput(inputFromText(''), 0)).toBeUndefined()
  })

  it('tracks bracket depth while walking open and close nodes', () => {
    const stack: { char: string; index: number }[] = []

    expect(collectBracket(node('(', 0), stack)).toEqual({ index: 0, char: '(', depth: 1 })
    expect(collectBracket(node('{', 1), stack)).toEqual({ index: 1, char: '{', depth: 2 })
    expect(collectBracket(node('}', 2), stack)).toEqual({ index: 2, char: '}', depth: 2 })
    expect(collectBracket(node(')', 3), stack)).toEqual({ index: 3, char: ')', depth: 1 })
    expect(stack).toEqual([])
  })

  it('reports tree-sitter error and missing nodes', () => {
    expect(collectError(node('ERROR', 4, 9, { isError: true }))).toEqual({
      startIndex: 4,
      endIndex: 9,
      isMissing: false,
      message: 'ERROR',
    })

    expect(collectError(node('identifier', 10, 10, { isMissing: true }))).toEqual({
      startIndex: 10,
      endIndex: 10,
      isMissing: true,
      message: 'identifier',
    })

    expect(collectError(node('identifier', 0, 10))).toBeNull()
  })

  it.each([
    ['identifier', false, false],
    ['(', false, true],
    [')', false, true],
    ['ERROR', false, true],
    ['identifier', true, true],
  ] as const)(
    'reads cursor diagnostics once and delays offsets for %s',
    (type, missing, needsStart) => {
      const reads = { type: 0, isMissing: 0, startIndex: 0, endIndex: 0 }
      const root = node(type, 4, 9, { isMissing: missing })
      for (const [field, value] of Object.entries({
        type,
        isMissing: missing,
        startIndex: 4,
        endIndex: 9,
      })) {
        Object.defineProperty(root, field, {
          get: () => {
            reads[field as keyof typeof reads]++
            return value
          },
        })
      }
      const result = collectTreeData(fakeTree(root))
      const isError = type === 'ERROR' || missing
      expect(result.errors).toEqual(
        isError ? [{ startIndex: 4, endIndex: 9, isMissing: missing, message: type }] : [],
      )
      expect(result.brackets).toEqual(
        type === '(' || type === ')' ? [{ index: 4, char: type, depth: 1 }] : [],
      )
      expect(reads).toEqual({
        type: 1,
        isMissing: 1,
        startIndex: needsStart ? 1 : 0,
        endIndex: isError ? 1 : 0,
      })
    },
  )

  it.each([undefined, { startIndex: 0, endIndex: 100 }])(
    'keeps brackets and skips missing-node checks on an error-free tree for range %j',
    (range) => {
      const children = [node('(', 1), node('identifier', 2, 3), node(')', 4)]
      const root = Object.assign(node('program', 0, 100), { children })
      let missingReads = 0
      for (const current of [root].concat(children)) {
        Object.defineProperty(current, 'isMissing', {
          get: () => {
            missingReads++
            return false
          },
        })
      }
      expect(collectTreeData(fakeTree(root, false), range)).toEqual({
        brackets: [
          { index: 1, char: '(', depth: 1 },
          { index: 4, char: ')', depth: 1 },
        ],
        errors: [],
      })
      expect(missingReads).toBe(0)
    },
  )

  it('walks deeply nested trees without recursive stack overflow', () => {
    const root = nestedNode(12_000)

    expect(collectTreeData(fakeTree(root)).errors).toHaveLength(1)
  })

  it('keeps nested diagnostics and bracket depths inside a middle range', () => {
    const nested = Object.assign(node('block', 20, 40), {
      children: [
        node('{', 21),
        node('ERROR', 26, 27, { isError: true }),
        node('}', 28),
        node('ERROR', 31, 32, { isError: true }),
      ],
    })
    const root = Object.assign(node('document', 0, 100), {
      children: [node('ERROR', 1, 2, { isError: true }), nested, node('identifier', 50, 60)],
    })

    expect(collectTreeData(fakeTree(root), { startIndex: 20, endIndex: 30 })).toEqual({
      brackets: [
        { index: 21, char: '{', depth: 1 },
        { index: 28, char: '}', depth: 1 },
      ],
      errors: [{ startIndex: 26, endIndex: 27, isMissing: false, message: 'ERROR' }],
    })
  })

  it('stops a range walk before the trailing document siblings', () => {
    let trailingReads = 0
    const trailing = node('ERROR', 20, 100, { isError: true })
    Object.defineProperty(trailing, 'endIndex', {
      get() {
        trailingReads += 1
        return 100
      },
    })
    const root = Object.assign(node('document', 0, 100), {
      children: [node('ERROR', 1, 2, { isError: true }), node('identifier', 10, 11), trailing],
    })

    const result = collectTreeData(fakeTree(root), { startIndex: 0, endIndex: 10 })

    expect(result.errors).toEqual([
      { startIndex: 1, endIndex: 2, isMissing: false, message: 'ERROR' },
    ])
    expect(trailingReads).toBe(0)
  })

  it('returns empty diagnostics when tree-sitter provides no tree cursor', () => {
    expect(collectTreeData(null)).toEqual({ brackets: [], errors: [] })
    expect(collectTreeData({ walk: () => null } as unknown as Tree)).toEqual({
      brackets: [],
      errors: [],
    })
  })

  it('appends large worker result arrays without spreading call arguments', () => {
    const items = Array.from({ length: 200_000 }, (_, index) => index)
    const target: number[] = []

    appendItems(target, items)

    expect(target).toHaveLength(items.length)
    expect(target.at(-1)).toBe(199_999)
  })

  it('spans large injection range arrays without spreading call arguments', () => {
    const ranges = Array.from({ length: 200_000 }, (_, index) =>
      treeSitterRange(index * 2, index * 2 + 1),
    )

    expect(rangeSpan(ranges)).toEqual({ startIndex: 0, endIndex: 399_999 })
  })

  it('queries visible range highlights in UTF-16 code units', () => {
    const highlightedNode = node('identifier', 75, 82)
    const query = {
      matches: () => [],
      captures: (_root: Node, options?: NonNullable<Parameters<Query['captures']>[1]>) => {
        expect(options?.startIndex).toBe(70)
        expect(options?.endIndex).toBe(90)
        return [{ name: 'variable', node: highlightedNode }]
      },
    } as unknown as Query
    const runtime = highlightedRuntime(query)
    const context = cancellationContext()

    expect(
      collectCaptures(fakeTree(node('program', 0, 100)), runtime, context, {
        startIndex: 70,
        endIndex: 90,
      }),
    ).toEqual([
      {
        startIndex: 75,
        endIndex: 82,
        captureName: 'variable',
        languageId: 'typescript',
      },
    ])
  })

  it('keeps iterator order within a span, first name wins, and drops captures outside the range', () => {
    const captures = [
      { name: 'function', node: node('identifier', 75, 82) },
      { name: 'before', node: node('string', 10, 70) },
      { name: 'variable', node: node('identifier', 75, 82) },
      { name: 'type', node: node('type_identifier', 72, 74) },
      { name: 'function', node: node('identifier', 75, 82) },
      { name: 'after', node: node('string', 90, 95) },
      { name: 'empty', node: node('string', 80, 80) },
    ]
    const query = { captures: () => captures.slice() } as unknown as Query
    const context = { ...cancellationContext(), counts: new Map<string, number>() }
    expect(
      collectCaptures(fakeTree(node('program', 0, 100)), highlightedRuntime(query), context, {
        startIndex: 70,
        endIndex: 90,
      }),
    ).toEqual([
      { startIndex: 72, endIndex: 74, captureName: 'type', languageId: 'typescript' },
      { startIndex: 75, endIndex: 82, captureName: 'function', languageId: 'typescript' },
      { startIndex: 75, endIndex: 82, captureName: 'variable', languageId: 'typescript' },
    ])
    expect(context.counts.get('rawCaptures')).toBe(7)
    expect(context.counts.get('uniqueCaptures')).toBe(3)
  })

  it('groups full captures by span and preserves first-capture precedence within equal spans', () => {
    const ranges = [
      { name: 'variable', startIndex: 75, endIndex: 82, patternIndex: 0 },
      { name: 'function', startIndex: 5, endIndex: 10, patternIndex: 1 },
      { name: 'variable', startIndex: 75, endIndex: 82, patternIndex: 2 },
      { name: 'function', startIndex: 75, endIndex: 82, patternIndex: 3 },
      { name: 'empty', startIndex: 3, endIndex: 3, patternIndex: 4 },
      { name: 'variable', startIndex: 5, endIndex: 10, patternIndex: 5 },
      { name: 'variable', startIndex: 75, endIndex: 83, patternIndex: 6 },
      { name: 'variable', startIndex: 75, endIndex: 82, patternIndex: 7 },
      { name: 'inverted', startIndex: 6, endIndex: 4, patternIndex: 8 },
    ]
    const query = { captureRanges: () => ranges.slice() } as unknown as Query
    const context = { ...cancellationContext(), counts: new Map<string, number>() }
    expect(
      collectCaptures(fakeTree(node('program', 0, 100)), highlightedRuntime(query), context),
    ).toEqual([
      { startIndex: 5, endIndex: 10, captureName: 'function', languageId: 'typescript' },
      { startIndex: 5, endIndex: 10, captureName: 'variable', languageId: 'typescript' },
      { startIndex: 75, endIndex: 82, captureName: 'variable', languageId: 'typescript' },
      { startIndex: 75, endIndex: 82, captureName: 'function', languageId: 'typescript' },
      { startIndex: 75, endIndex: 83, captureName: 'variable', languageId: 'typescript' },
    ])
    expect(context.counts.get('rawCaptures')).toBe(9)
    expect(context.counts.get('uniqueCaptures')).toBe(5)
    expect(ranges.map((capture) => capture.patternIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('deduplicates full captures independently for each language and query invocation', () => {
    const query = {
      captureRanges: () => [
        { name: 'string', startIndex: 5, endIndex: 10, patternIndex: 0 },
        { name: 'string', startIndex: 5, endIndex: 10, patternIndex: 1 },
      ],
    } as unknown as Query
    const tree = fakeTree(node('program', 0, 100))
    for (const languageId of ['typescript', 'javascript'] as const) {
      const base = highlightedRuntime(query)
      const runtime = { ...base, descriptor: { ...base.descriptor, id: languageId } }
      for (let repetition = 0; repetition < 2; repetition++) {
        expect(collectCaptures(tree, runtime, cancellationContext())).toEqual([
          { startIndex: 5, endIndex: 10, captureName: 'string', languageId },
        ])
      }
    }
  })

  it('returns no full captures when every span is empty or inverted', () => {
    const query = {
      captureRanges: () => [
        { name: 'string', startIndex: 5, endIndex: 5, patternIndex: 0 },
        { name: 'string', startIndex: 10, endIndex: 5, patternIndex: 1 },
      ],
    } as unknown as Query
    const context = { ...cancellationContext(), counts: new Map<string, number>() }
    expect(
      collectCaptures(fakeTree(node('program', 0, 100)), highlightedRuntime(query), context),
    ).toEqual([])
    expect(context.counts.get('rawCaptures')).toBe(2)
    expect(context.counts.get('uniqueCaptures')).toBe(0)
  })

  it('skips highlights when tree-sitter provides null trees or capture nodes', () => {
    const query = {
      captureRanges: () => [],
      captures: () => [{ name: 'variable', node: null }],
    } as unknown as Query
    const runtime = highlightedRuntime(query)
    const context = cancellationContext()

    expect(collectCaptures(null, runtime, context)).toEqual([])
    expect(collectCaptures(fakeTree(node('program', 0, 100)), runtime, context)).toEqual([])
    expect(
      collectCaptures(fakeTree(node('program', 0, 100)), runtime, context, {
        startIndex: 0,
        endIndex: 100,
      }),
    ).toEqual([])
  })
})

describe('range queries that run in slices', () => {
  const { collectFolds, flattenLayerSlices, rangeSlices } = __treeSitterWorkerInternalsForTests
  type SliceLayer = Parameters<typeof flattenLayerSlices>[0]
  type SliceResult = Parameters<typeof flattenLayerSlices>[2]
  type QueryRange = { readonly startIndex: number; readonly endIndex: number }

  const LENGTH = 40_000
  // Starts inside the first identifier and ends inside the last statement, so both ends cut a node.
  const range = { startIndex: 50, endIndex: LENGTH - 30 }
  // Pauses before every slice: the clock never says "not yet".
  const alwaysDue = (isCurrent: () => boolean = () => true) => ({
    isCurrent,
    get resumedAt() {
      return Number.NEGATIVE_INFINITY
    },
    set resumedAt(_value: number) {},
  })

  const positioned = (current: TestNode): TestNode =>
    Object.assign(current, {
      startPosition: { row: Math.floor(current.startIndex / 40), column: 0 },
      endPosition: { row: Math.floor(current.endIndex / 40), column: 0 },
    })

  // Statements of 100 units, each `(` identifier `)`. A comment and a string cross the first two
  // slice boundaries (8,192 and 16,384), and one block wraps every statement.
  const fixture = () => {
    const statements: TestNode[] = []
    const identifiers: TestNode[] = []
    for (let start = 0; start < LENGTH; start += 100) {
      const identifier = node('identifier', start + 2, start + 90)
      identifiers.push(identifier)
      statements.push(
        positioned(
          Object.assign(node('statement', start, start + 100), {
            children: [node('(', start), identifier, node(')', start + 95)],
          }),
        ),
      )
    }
    const crossing = [node('comment', 8_100, 8_300), node('string', 16_301, 16_499)]
    const block = positioned(Object.assign(node('block', 0, LENGTH), { children: statements }))
    const root = Object.assign(node('program', 0, LENGTH), { children: [block] })
    const captured = identifiers.concat(crossing)
    const asked: string[] = []
    // Like tree-sitter, answers with every node of a match that touches the range, including
    // nodes of that match outside it.
    const near = (current: TestNode, asks: QueryRange): boolean =>
      current.startIndex < asks.endIndex + 150 && current.endIndex > asks.startIndex - 150
    const highlight = {
      captures: (_root: Node, asks: QueryRange) => {
        asked.push(`highlight:${asks.startIndex}`)
        return captured
          .filter((current) => near(current, asks))
          .map((current) => ({ name: current.type, node: current }))
      },
      captureRanges: (_root: Node, asks: QueryRange) => {
        asked.push(`highlight:${asks.startIndex}`)
        return captured
          .filter((current) => near(current, asks))
          .map(({ type, startIndex, endIndex }) => ({ name: type, startIndex, endIndex }))
      },
    } as unknown as Query
    const fold = {
      matches: (_root: Node, asks: QueryRange) =>
        [block]
          .concat(statements)
          .filter((current) => near(current, asks))
          .map((current) => ({ captures: [{ name: 'fold', node: current }] })),
    } as unknown as Query
    const base = highlightedRuntime(highlight)
    const runtime = {
      ...base,
      descriptor: { ...base.descriptor, foldQuerySource: '(block) @fold' },
      foldQuery: fold,
    } as unknown as Parameters<typeof collectFolds>[1]
    const tree = fakeTree(root)
    const layer = {
      id: 'root',
      key: 'root',
      kind: 'root',
      parentId: null,
      parentLanguageId: null,
      languageId: 'typescript',
      depth: 0,
      tree,
      ranges: [treeSitterRange(0, LENGTH)],
    } as SliceLayer
    return { asked, layer, runtime, tree }
  }

  const emptyResult = (): SliceResult => ({
    captures: [],
    folds: [],
    brackets: [],
    errors: [],
    injections: [],
    degraded: [],
    tokens: [],
  })

  const bySpan = <T extends QueryRange>(items: readonly T[]): T[] =>
    items.toSorted((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)

  const options = { range, includeHighlights: true, includeCaptures: true }

  it('reports exactly what one query over the whole range reports', async () => {
    const { layer, runtime, tree } = fixture()
    const slices = rangeSlices(layer, range)
    const sliced = emptyResult()

    await flattenLayerSlices(layer, runtime, sliced, cancellationContext(), {
      options,
      pacing: alwaysDue(),
      slices,
    })

    expect(slices.length).toBeGreaterThan(3)
    const whole = cancellationContext()
    const captures = collectCaptures(tree, runtime, whole, range)
    expect(captures.length).toBeGreaterThan(300)
    expect(bySpan(sliced.captures)).toEqual(bySpan(captures))
    expect(bySpan(sliced.folds)).toEqual(bySpan(collectFolds(tree, runtime, whole, range)))
    expect({ brackets: sliced.brackets, errors: sliced.errors }).toEqual(
      collectTreeData(tree, range),
    )
  })

  it('returns to the event loop between slices', async () => {
    const { asked, layer, runtime } = fixture()
    const slices = rangeSlices(layer, range)
    let finished = false
    const flatten = flattenLayerSlices(layer, runtime, emptyResult(), cancellationContext(), {
      options,
      pacing: alwaysDue(),
      slices,
    }).then(() => {
      finished = true
    })

    // Microtasks alone cannot carry it past a pause: each pause waits for a task of its own, which
    // is where a message queued behind the query gets its turn.
    await settleMicrotasks()
    expect(finished).toBe(false)
    expect(asked).toEqual([])

    await flatten
    expect(asked).toHaveLength(slices.length)
  })

  it('stops without touching the tree again once its snapshot was released', async () => {
    const { asked, layer, runtime } = fixture()
    let current = true
    const flatten = flattenLayerSlices(layer, runtime, emptyResult(), cancellationContext(), {
      options,
      pacing: alwaysDue(() => current),
      slices: rangeSlices(layer, range),
    })
    // Released while the query is paused for the first time, before any slice has been asked.
    current = false

    await expect(flatten).rejects.toThrow('Tree-sitter request cancelled')
    expect(asked).toEqual([])
  })

  it('never ends a slice inside a token, so one long token is matched by one slice', async () => {
    // `const NAME = 1` where the name alone is longer than twelve slices.
    const name = node('identifier', 6, 100_006)
    const root = Object.assign(node('program', 0, 100_020), {
      children: [node('const', 0, 5), name, node('=', 100_007), node('number', 100_009)],
    })
    const reported: number[] = []
    const highlight = {
      captures: (_root: Node, asks: QueryRange) => {
        if (name.startIndex >= asks.endIndex || name.endIndex <= asks.startIndex) return []
        reported.push(asks.startIndex)
        return [{ name: 'constant', node: name }]
      },
      captureRanges: (_root: Node, asks: QueryRange) => {
        if (name.startIndex >= asks.endIndex || name.endIndex <= asks.startIndex) return []
        reported.push(asks.startIndex)
        return [{ name: 'constant', startIndex: name.startIndex, endIndex: name.endIndex }]
      },
    } as unknown as Query
    const tree = fakeTree(root)
    const layer = {
      id: 'root',
      key: 'root',
      kind: 'root',
      parentId: null,
      parentLanguageId: null,
      languageId: 'typescript',
      depth: 0,
      tree,
      ranges: [treeSitterRange(0, 100_020)],
    } as SliceLayer
    const whole = { startIndex: 0, endIndex: 100_020 }
    const slices = rangeSlices(layer, whole)
    const sliced = emptyResult()

    await flattenLayerSlices(
      layer,
      highlightedRuntime(highlight) as unknown as Parameters<typeof collectFolds>[1],
      sliced,
      cancellationContext(),
      { options: { ...options, range: whole }, pacing: alwaysDue(), slices },
    )

    // The first slice runs to the end of the name instead of stopping 8,192 units in, and the
    // slices still cover the whole range without a gap.
    expect(slices[0]).toEqual({ startIndex: 0, endIndex: 100_006 })
    expect(slices.at(-1)!.endIndex).toBe(100_020)
    for (const [index, slice] of slices.entries())
      expect(slice.startIndex).toBe(index === 0 ? 0 : slices[index - 1]!.endIndex)
    // Each time a slice reports the name, the query has run its predicates over all of its text.
    expect(reported).toEqual([0])
    expect(sliced.captures).toEqual([
      { startIndex: 6, endIndex: 100_006, captureName: 'constant', languageId: 'typescript' },
    ])
  })
})

const sourceCleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of sourceCleanup.splice(0)) dispose()
})
const messageSource: DocumentWorkerReadReference = {
  identity: {
    documentId: 'worker-fixture',
    documentGeneration: 1,
    endpointGeneration: 1,
    registrationId: 1,
  },
  point: { segment: 'worker-fixture', revision: 0, textVersion: 0 },
  readId: 'worker-fixture',
}
/** Runs every microtask that is pending or queued by one, without letting a task in. */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 1_000; turn++) await Promise.resolve()
}

function inputFromText(text: string) {
  const reader = new DocumentWorkerReader()
  const { identity, point } = messageSource
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
  const loan = reader.acquire({ identity, point })!
  const input = createTreeSitterInput(loan)
  sourceCleanup.push(() => {
    input.dispose()
    reader.dispose()
  })
  return input
}

type TestNode = Node & {
  readonly children: readonly TestNode[]
}

function node(
  type: string,
  startIndex: number,
  endIndex = startIndex + 1,
  flags: Partial<Pick<Node, 'isError' | 'isMissing'>> = {},
): TestNode {
  return {
    children: [],
    type,
    startIndex,
    endIndex,
    isError: flags.isError ?? false,
    isMissing: flags.isMissing ?? false,
  } as unknown as TestNode
}

function nestedNode(depth: number): TestNode {
  let current = node('ERROR', depth, depth + 1, { isError: true })
  for (let index = depth - 1; index >= 0; index -= 1) {
    current = {
      ...node('node', index, depth + 1),
      children: [current],
    } as unknown as TestNode
  }

  return current
}

function fakeTree(root: TestNode, hasError = true): Tree {
  Object.defineProperty(root, 'hasError', { value: hasError, configurable: true })
  Object.defineProperty(root, 'descendantForIndex', {
    value: (index: number) => smallestNodeAt(root, index),
    configurable: true,
  })
  return {
    rootNode: root,
    walk: () => new FakeTreeCursor(root),
  } as unknown as Tree
}

/** The smallest node that contains `index`, as `Node.descendantForIndex` answers. */
function smallestNodeAt(root: TestNode, index: number) {
  let current = root
  for (;;) {
    const child = current.children.find(
      (candidate) => candidate.startIndex <= index && candidate.endIndex > index,
    )
    if (!child) break
    current = child
  }
  return {
    startIndex: current.startIndex,
    endIndex: current.endIndex,
    childCount: current.children.length,
  }
}

function highlightedRuntime(query: Query): Parameters<typeof collectCaptures>[1] {
  return {
    descriptor: {
      id: 'typescript',
      extensions: [],
      aliases: [],
      wasmUrl: 'test.wasm',
      highlightQuerySource: '(identifier) @variable',
    },
    language: {},
    parser: {},
    highlightQuery: query,
    foldQuery: null,
    injectionQuery: null,
  } as unknown as Parameters<typeof collectCaptures>[1]
}

function cancellationContext(): Parameters<typeof collectCaptures>[2] {
  return {
    startedAt: globalThis.performance?.now() ?? Date.now(),
    budgetMs: 1_000,
    flag: null,
  }
}

function treeSitterRange(startIndex: number, endIndex: number): TreeSitterRange {
  return {
    endIndex,
    endPosition: { column: endIndex, row: 0 },
    startIndex,
    startPosition: { column: startIndex, row: 0 },
  }
}

class FakeTreeCursor {
  private readonly path: { node: TestNode; siblings: readonly TestNode[]; index: number }[]

  public constructor(root: TestNode) {
    this.path = [{ node: root, siblings: [root], index: 0 }]
  }

  public get nodeType(): string {
    return this.current.node.type
  }

  public get nodeIsMissing(): boolean {
    return this.current.node.isMissing
  }

  public get startIndex(): number {
    return this.current.node.startIndex
  }

  public get endIndex(): number {
    return this.current.node.endIndex
  }

  public gotoFirstChild(): boolean {
    const children = this.current.node.children
    if (children.length === 0) return false

    this.path.push({ node: children[0]!, siblings: children, index: 0 })
    return true
  }

  public gotoNextSibling(): boolean {
    const current = this.current
    const index = current.index + 1
    const node = current.siblings[index]
    if (!node) return false

    this.path[this.path.length - 1] = { node, siblings: current.siblings, index }
    return true
  }

  public gotoParent(): boolean {
    if (this.path.length <= 1) return false

    this.path.pop()
    return true
  }

  public delete(): void {
    this.path.length = 0
  }

  private get current(): { node: TestNode; siblings: readonly TestNode[]; index: number } {
    const current = this.path[this.path.length - 1]
    if (!current) throw new Error('Cursor is disposed')
    return current
  }
}

describe('parse document reuse', () => {
  type WorkerParsedDocument = Parameters<typeof replaceCachedDocument>[1]
  type WorkerParseRequest = Parameters<typeof reusableParsedDocument>[0]

  const fakeParsedDocument = (
    length: number,
    deleted: string[],
    readOnly = false,
  ): WorkerParsedDocument => ({
    readOnly,
    snapshotVersion: 1,
    languageId: 'typescript',
    source: inputFromText('x'.repeat(length)),
    layers: [
      {
        id: 'root',
        key: 'root',
        kind: 'root',
        parentId: null,
        parentLanguageId: null,
        languageId: 'typescript',
        depth: 0,
        ranges: [],
        tree: { delete: () => deleted.push('root') } as unknown as Tree,
      },
    ],
    degraded: [],
    missingLanguages: [],
    size: length,
    lastUsed: 0,
  })

  const parseRequest = (
    runtimeSessionId: string,
    snapshotVersion: number,
    readOnly?: boolean,
  ): WorkerParseRequest => ({
    type: 'parse',
    documentId: 'doc',
    runtimeSessionId,
    languageId: 'typescript',
    snapshotVersion,
    readOnly,
    includeHighlights: false,
    generation: 1,
    source: messageSource,
  })

  const sourceOfLength = (length: number) => inputFromText('x'.repeat(length))

  it.each([
    { cachedReadOnly: false, requestedReadOnly: undefined },
    { cachedReadOnly: false, requestedReadOnly: false },
    { cachedReadOnly: false, requestedReadOnly: true },
    { cachedReadOnly: true, requestedReadOnly: true },
  ])('reuses an identical version with compatible intent: %j', async (intent) => {
    const runtimeSessionId = 'runtime-reuse'
    const deleted: string[] = []
    const document = fakeParsedDocument(10, deleted, intent.cachedReadOnly)
    replaceCachedDocument(runtimeSessionId, document)

    expect(
      await reusableParsedDocument(
        parseRequest(runtimeSessionId, 1, intent.requestedReadOnly),
        sourceOfLength(10),
        {
          startedAt: 0,
          budgetMs: Infinity,
          flag: null,
        },
      ),
    ).toBe(document)
    expect(document.readOnly).toBe(intent.cachedReadOnly)
    expect(deleted).toEqual([])
    disposeDocument(runtimeSessionId)
  })

  it.each([undefined, false])(
    'retires an immutable snapshot before mutable promotion: readOnly=%s',
    async (readOnly) => {
      const runtimeSessionId = 'runtime-promotion'
      const deleted: string[] = []
      replaceCachedDocument(runtimeSessionId, fakeParsedDocument(10, deleted, true))

      expect(
        await reusableParsedDocument(
          parseRequest(runtimeSessionId, 1, readOnly),
          sourceOfLength(10),
          {
            startedAt: 0,
            budgetMs: Infinity,
            flag: null,
          },
        ),
      ).toBeNull()
      expect(deleted).toEqual(['root'])
      disposeDocument(runtimeSessionId)
      expect(deleted).toEqual(['root'])
    },
  )

  it('waits for a round without a new request before it frees a closed document', async () => {
    const { waitForQuiet } = __treeSitterWorkerInternalsForTests
    // A document opened in place of the closed one sends three requests, one per round.
    let received = 0
    let rounds = 0
    const round = async () => {
      rounds += 1
      if (rounds <= 3) received += 1
    }

    await waitForQuiet(() => received, round, 100)

    expect(rounds).toBe(4)
  })

  it('frees a closed document after a bounded wait when requests never stop', async () => {
    const { waitForQuiet } = __treeSitterWorkerInternalsForTests
    let received = 0
    let rounds = 0

    await waitForQuiet(
      () => received,
      async () => {
        rounds += 1
        received += 1
      },
      7,
    )

    expect(rounds).toBe(7)
  })

  it('forgets a closed document at once and frees its trees after the wait', async () => {
    const runtimeSessionId = 'runtime-release'
    const freed: string[] = []
    const document = fakeParsedDocument(10, freed)
    const injected = Array.from({ length: 4 }, (_, index) => ({
      ...document.layers[0]!,
      id: `injection-${index}`,
      kind: 'injection' as const,
      tree: { delete: () => freed.push(`injection-${index}`) } as unknown as Tree,
    }))
    replaceCachedDocument(runtimeSessionId, {
      ...document,
      layers: document.layers.concat(injected),
    })

    const released = __treeSitterWorkerInternalsForTests.releaseDocument(runtimeSessionId)
    // Nothing is freed in the request's own turn: whatever is queued behind it goes first. The
    // document is gone for every request from this moment on.
    await settleMicrotasks()
    expect(freed).toEqual([])
    expect(
      await reusableParsedDocument(parseRequest(runtimeSessionId, 1), sourceOfLength(10), {
        startedAt: 0,
        budgetMs: Infinity,
        flag: null,
      }),
    ).toBeNull()

    await released
    expect(freed).toEqual(['root', 'injection-0', 'injection-1', 'injection-2', 'injection-3'])
  })

  it('drops the same-version snapshot before reparsing when content length differs', async () => {
    const runtimeSessionId = 'runtime-length-mismatch'
    const deleted: string[] = []
    replaceCachedDocument(runtimeSessionId, fakeParsedDocument(10, deleted))

    expect(
      await reusableParsedDocument(parseRequest(runtimeSessionId, 1), sourceOfLength(12), {
        startedAt: 0,
        budgetMs: Infinity,
        flag: null,
      }),
    ).toBeNull()
    expect(deleted).toEqual(['root'])
    expect(
      await reusableParsedDocument(parseRequest(runtimeSessionId, 1), sourceOfLength(12), {
        startedAt: 0,
        budgetMs: Infinity,
        flag: null,
      }),
    ).toBeNull()
    expect(deleted).toEqual(['root'])
    disposeDocument(runtimeSessionId)
  })

  it('does not reuse across snapshot versions', async () => {
    const runtimeSessionId = 'runtime-version-mismatch'
    const deleted: string[] = []
    const document = fakeParsedDocument(10, deleted)
    replaceCachedDocument(runtimeSessionId, document)

    expect(
      await reusableParsedDocument(parseRequest(runtimeSessionId, 2), sourceOfLength(10), {
        startedAt: 0,
        budgetMs: Infinity,
        flag: null,
      }),
    ).toBeNull()
    expect(deleted).toEqual([])
    disposeDocument(runtimeSessionId)
  })

  it('yields worker macrotasks via MessageChannel without using setTimeout(0)', async () => {
    const { yieldWorker } = __treeSitterWorkerInternalsForTests
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const order: string[] = []
    try {
      const channel = new MessageChannel()
      const interleaved = new Promise<void>((resolve) => {
        channel.port1.onmessage = () => {
          order.push('interleaved')
          channel.port1.close()
          channel.port2.close()
          resolve()
        }
      })

      const yielded = yieldWorker().then(() => order.push('yield-1'))
      channel.port2.postMessage(null)
      await Promise.all([yielded, interleaved])
      expect(order).toEqual(['yield-1', 'interleaved'])

      for (let i = 0; i < 20; i += 1) {
        await yieldWorker()
      }
      expect(timeoutSpy).not.toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
