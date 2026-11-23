import { styleForTreeSitterCapture } from '@singapore-editor/core/syntax'
import { afterEach, expect, it } from 'vitest'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import {
  TSX_TREE_SITTER_LANGUAGE,
  TYPESCRIPT_TREE_SITTER_LANGUAGE,
} from '../../tree-sitter-languages/src/index'
import {
  createTreeSitterSliceHighlighter,
  createTreeSitterLanguageRegistry,
  createTreeSitterWorkerOwner,
  resolveTreeSitterLanguageContribution,
  type TreeSitterHighlightedSlice,
  type TreeSitterHighlightSlice,
  type TreeSitterSliceHighlighter,
  type TreeSitterSliceHighlighterOptions,
} from '../src'
import type { TreeSitterWorkerRequest } from '../src/treeSitter/types'
import { treeSitterBackendForOwner } from '../src/treeSitter/workerClient'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import sliceHighlighterSource from '../src/sliceHighlighting.ts?raw'

const highlighters = new Set<TreeSitterSliceHighlighter>()
const owners = new Set<ReturnType<typeof createTreeSitterWorkerOwner>>()

afterEach(async () => {
  disposeTreeDocuments()
  await Promise.all(Array.from(highlighters, (highlighter) => highlighter.dispose()))
  await Promise.all(Array.from(owners, (owner) => owner.dispose()))
  highlighters.clear()
  owners.clear()
})

it('warms and highlights only the supplied slice with UTF-16 offsets over exact CRLF text', async () => {
  const { workerOwner, requests } = recordWorker()
  const highlighter = createHighlighter({ workerOwner })
  await highlighter.prewarm()
  expect(requests.map(({ payload }) => payload.type)).toEqual(['init', 'prepareSliceLanguage'])

  const text = '/* 🦊\r\n      note */\r\nconst name = `é${1}`;\r\nconst next = '
  const part = slice(text)
  const answer = await highlighted(highlighter, part)
  expect(answer).toMatchObject({ quality: 'known-start', endsAtSourceEnd: false })
  expect(answer.tokens.toTokens()).toContainEqual({
    start: 0,
    end: text.indexOf('*/') + 2,
    style: styleForTreeSitterCapture('comment'),
  })
  expect(answer.tokens.toTokens().some(({ start, end }) => text.slice(start, end) === '${')).toBe(
    true,
  )
  expect(answer.tokens.toTokens().every(({ start, end }) => start >= 0 && end <= text.length)).toBe(
    true,
  )
  expect(
    requests.flatMap(({ payload }) => (payload.type === 'highlightSlice' ? [payload.text] : [])),
  ).toEqual([text])
  expect(
    requests.some(({ payload }) => ['source', 'parse', 'queryRange'].includes(payload.type)),
  ).toBe(false)
  expect(await workerOwner.inspectRetention()).toMatchObject({
    treeCount: 0,
    snapshotCount: 0,
    source: { readCount: 0, pinCount: 0, sourceUnits: 0 },
  })
})

it('marks distant TSX and a fragment inside a comment as provisional', async () => {
  const highlighter = createHighlighter({ language: TSX_TREE_SITTER_LANGUAGE })
  const text = 'const Item = <Widget value={`x${1}`} />'
  const cold = await highlighted(highlighter, slice(text, { startsAtSourceStart: false }))
  expect(cold).toMatchObject({ quality: 'provisional', endsAtSourceEnd: false })
  expect(cold.tokens.toTokens().some(({ start, end }) => text.slice(start, end) === 'Widget')).toBe(
    true,
  )

  const middle = 'const partial = 1'
  const withPrefix = await highlighted(highlighter, slice(`/*\r\n${middle}\r\n*/`))
  expect(withPrefix.tokens.styleAt(0)).toEqual(styleForTreeSitterCapture('comment'))
  const withoutPrefix = await highlighted(
    highlighter,
    slice(middle, {
      startsAtSourceStart: false,
      location: '250:267',
    }),
  )
  expect(withoutPrefix.quality).toBe('provisional')
  expect(withoutPrefix.tokens.styleAt(0)).toEqual(styleForTreeSitterCapture('keyword.declaration'))
})

it('colors a 128-row window of real TypeScript with the shipped query', async () => {
  const highlighter = createHighlighter()
  await highlighter.prewarm()
  const rows = sliceHighlighterSource.split('\n').slice(0, 128)
  expect(rows).toHaveLength(128)
  const text = rows.join('\n')
  const result = await highlighted(highlighter, slice(text))
  expect(result.tokens.length).toBeGreaterThan(200)
  expect(
    result.tokens.toTokens().some(({ start, end }) => text.slice(start, end) === 'import'),
  ).toBe(true)
})

it('rejects unbounded query predicates and caps reads during supported predicate evaluation', async () => {
  const { workerOwner, requests } = recordWorker()
  const descriptor = await resolveTreeSitterLanguageContribution(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  const unsafe = createHighlighter({
    workerOwner,
    language: {
      ...descriptor,
      highlightQuerySource: '((identifier) @variable (#match? @variable "^(a+)+$"))',
    },
  })
  expect(await unsafe.highlight(slice('const word = 1'))).toEqual({
    kind: 'plain',
    reason: 'unsupported-query',
  })
  expect(requests.map(({ payload }) => payload.type)).toEqual(['init', 'prepareSliceLanguage'])

  const bounded = createHighlighter({
    workerOwner,
    language: {
      ...descriptor,
      highlightQuerySource: '((identifier) @variable (#match? @variable "^[a-z]"))',
    },
  })
  const longIdentifier = 'z'.repeat(1025)
  expect(await bounded.highlight(slice(`const ${longIdentifier} = 1`))).toEqual({
    kind: 'plain',
    reason: 'over-budget',
  })
  const normal = await highlighted(bounded, slice('const value = 1'))
  expect(normal.tokens.length).toBe(1)
})

it('keeps bounded rules after a bare CR comment and skips the unsupported pattern', async () => {
  const descriptor = await resolveTreeSitterLanguageContribution(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  const highlighter = createHighlighter({
    language: {
      ...descriptor,
      highlightQuerySource:
        '; An ordinary comment\r"\n((identifier) @variable (#match? @variable "^("))\n"const" @keyword',
    },
  })
  const result = await highlighted(highlighter, slice('const answer = 42'))
  expect(result.tokens.toTokens()).toEqual([
    { start: 0, end: 5, style: styleForTreeSitterCapture('keyword') },
  ])
})

it.each([
  ['python', 'def greet():\n    return "hello"\n', 'def'],
  ['rust', 'fn greet() -> i32 { 42 }', 'fn'],
  ['java', 'class Example { public int answer() { return 42; } }', 'class'],
  ['php', '<?php function greet() { return "hello"; }', 'function'],
  ['svelte', '<span>Hello</span>', 'span'],
  ['sql', 'SELECT id FROM users; -- comment', 'SELECT'],
])(
  'colors a simple %s slice using the supported rules of its shipped query',
  async (id, text, keyword) => {
    const language = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find(
      (contribution) => contribution.id === id,
    )
    if (!language) throw new Error(`Missing shipped language ${id}`)
    const result = await highlighted(createHighlighter({ language }), slice(text))
    const keywordStart = text.indexOf(keyword)
    expect(
      result.tokens
        .toTokens()
        .some(({ start, end }) => start <= keywordStart && end >= keywordStart + keyword.length),
    ).toBe(true)
  },
)

it('retries the same grammar on the same owner after a transient 503', async () => {
  const workerOwner = createTreeSitterWorkerOwner({
    workerFactory: () =>
      new Worker(new URL('./fixtures/sliceRetry.worker.ts', import.meta.url), { type: 'module' }),
  })
  owners.add(workerOwner)
  const descriptor = await resolveTreeSitterLanguageContribution(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  const wasmUrl = new URL(descriptor.wasmUrl, location.href)
  wasmUrl.hash = 'slice-retry-fixture'
  const highlighter = createHighlighter({
    workerOwner,
    language: { ...descriptor, wasmUrl: wasmUrl.href },
  })
  const input = slice('const recover = 1')
  expect(await highlighter.highlight(input)).toEqual({ kind: 'plain', reason: 'unavailable' })
  expect(await workerOwner.inspectRetention()).toMatchObject({
    shared: { sliceLanguageCount: 0, sliceGrammarCount: 0 },
  })
  await highlighted(highlighter, input)
  expect(workerOwner.inspect()).toMatchObject({ lifecycle: 'ready', workerGeneration: 1 })
  expect(await workerOwner.inspectRetention()).toMatchObject({
    shared: { sliceLanguageCount: 1, sliceGrammarCount: 1 },
  })
})

it('checks exact text, location, source, revision, and context before reusing cached colors', async () => {
  const highlighter = createHighlighter()
  const first = slice('const x = 1')
  const answer = await highlighted(highlighter, first)
  expect(highlighter.lookup(first)).toBe(answer)
  expect(await highlighter.highlight(first)).toBe(answer)
  const sameLength = { ...first, text: 'return true' }
  const moved = { ...first, location: '555:566' }
  const end = { ...first, endsAtSourceEnd: true }
  const provisional = { ...first, startsAtSourceStart: false }
  for (const other of [sameLength, moved, end, provisional]) {
    expect(highlighter.lookup(other)).toBeNull()
    expect(await highlighted(highlighter, other)).not.toBe(answer)
  }
  const next = { ...first, revision: 'revision-2' }
  expect(await highlighted(highlighter, next)).not.toBe(answer)
  expect(highlighter.lookup(first)).toBeNull()
  expect(highlighter.inspect()).toMatchObject({ cacheHits: 1, cacheEntries: 1 })
  const sameRevisionOtherSource = { ...next, sourceId: 'other-file' }
  expect(await highlighted(highlighter, sameRevisionOtherSource)).not.toBe(answer)
  expect(highlighter.lookup(next)).toBeNull()
})

it('coalesces superseded work and ignores old revisions after a request reaches a real worker', async () => {
  const { workerOwner, requests, holdNextSlice } = recordWorker()
  const highlighter = createHighlighter({ workerOwner })
  await highlighter.prewarm()
  const first = slice('const first = 1')
  const held = holdNextSlice()
  const obsolete = highlighter.highlight(first)
  const send = await held
  const queued = highlighter.highlight(slice('const queued = 2', { location: '16:32' }))
  const last = slice('const last = 3', { revision: 'revision-2' })
  const latest = highlighter.highlight(last)
  expect(await obsolete).toEqual({ kind: 'plain', reason: 'superseded' })
  expect(await queued).toEqual({ kind: 'plain', reason: 'superseded' })
  expect(requests.filter(({ payload }) => payload.type === 'highlightSlice')).toHaveLength(1)
  expect(highlighter.inspect()).toMatchObject({
    inFlightTextUnits: first.text.length,
    queuedTextUnits: last.text.length,
  })
  send()

  expect(await latest).toMatchObject({ kind: 'highlighted' })
  expect(highlighter.lookup(first)).toBeNull()
  expect(highlighter.lookup(last)).toBe(await latest)
  expect(requests.filter(({ payload }) => payload.type === 'highlightSlice')).toHaveLength(2)
})

it('isolates a conflicting slice query from a live resident session on the same worker', async () => {
  const { workerOwner } = recordWorker()
  const text = 'const x = 1;\nconst y = 2;'
  const registry = createTreeSitterLanguageRegistry()
  registry.registerLanguage(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  const resident = createTreeDocument({
    documentId: 'resident.ts',
    languageId: 'typescript',
    text,
    languageResolver: registry,
    backend: treeSitterBackendForOwner(workerOwner),
  })
  await resident.run()
  const first = await resident.runtime.queryRange({ startIndex: 0, endIndex: 12 })
  expect(first.captures.some((capture) => capture.captureName === 'keyword.declaration')).toBe(true)
  const before = await workerOwner.inspectRetention()
  expect(before?.treeCount).toBeGreaterThan(0)

  const descriptor = await resolveTreeSitterLanguageContribution(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  const highlighter = createHighlighter({
    workerOwner,
    language: { ...descriptor, highlightQuerySource: '(identifier) @comment' },
  })
  await highlighter.prewarm()
  const input = slice('const x = 1')
  const colors = await highlighted(highlighter, input)
  expect(colors.tokens.toTokens()).toEqual([
    { start: 6, end: 7, style: styleForTreeSitterCapture('comment') },
  ])
  expect(await workerOwner.inspectRetention()).toMatchObject({
    treeCount: before?.treeCount,
    shared: { sliceLanguageCount: 1 },
  })
  const second = await resident.runtime.queryRange({ startIndex: 13, endIndex: text.length })
  expect(second.captures.some((capture) => capture.captureName === 'keyword.declaration')).toBe(
    true,
  )

  await highlighter.dispose()
  expect(await workerOwner.inspectRetention()).toMatchObject({
    treeCount: before?.treeCount,
    shared: { sliceLanguageCount: 0 },
  })
  await resident.edit([{ from: 6, to: 7, text: 'renamed' }])
  const updated = await resident.runtime.queryRange({ startIndex: 0, endIndex: 18 })
  expect(updated.captures.some((capture) => capture.captureName === 'keyword.declaration')).toBe(
    true,
  )
})

it('shares a pending grammar load without dispatching text from disposed views', async () => {
  const { workerOwner, requests, holdNext } = recordWorker()
  const held = holdNext('prepareSliceLanguage')
  const first = createHighlighter({ workerOwner })
  const firstResult = first.highlight(slice('const old = 1'))
  const send = await held
  await first.dispose()
  expect(await firstResult).toEqual({ kind: 'plain', reason: 'disposed' })
  for (let index = 0; index < 8; index++) {
    const closed = createHighlighter({ workerOwner })
    void closed.prewarm()
    const work = closed.highlight(slice('const closed = 2'))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await closed.dispose()
    expect(await work).toEqual({ kind: 'plain', reason: 'disposed' })
    expect(closed.inspect()).toMatchObject({
      inFlightTextUnits: 0,
      queuedTextUnits: 0,
      retainedTextUnits: 0,
    })
  }
  const survivor = createHighlighter({ workerOwner })
  const answer = survivor.highlight(slice('const survivor = 3'))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(first.inspect()).toMatchObject({
    inFlightTextUnits: 0,
    queuedTextUnits: 0,
    retainedTextUnits: 0,
  })
  expect(requests.map(({ payload }) => payload.type)).toEqual(['init', 'prepareSliceLanguage'])
  send()
  expect(await answer).toMatchObject({ kind: 'highlighted' })
  expect(requests.map(({ payload }) => payload.type)).toEqual([
    'init',
    'prepareSliceLanguage',
    'highlightSlice',
  ])
  await survivor.dispose()
  expect(await workerOwner.inspectRetention()).toMatchObject({
    shared: { sliceLanguageCount: 0, sliceGrammarCount: 1 },
  })
})

it('evicts a long scroll by text and token limits and preserves a shared worker on disposal', async () => {
  const { workerOwner } = recordWorker()
  const highlighter = createHighlighter({
    workerOwner,
    limits: { cacheEntries: 4, cacheTextUnits: 55, cacheTokens: 9 },
  })
  const first = slice('const first = 1')
  await highlighted(highlighter, first)
  for (let index = 0; index < 24; index++) {
    await highlighted(highlighter, slice(`const value = ${index}`, { location: String(index) }))
    const stats = highlighter.inspect()
    expect(stats.cacheEntries).toBeLessThanOrEqual(4)
    expect(stats.retainedTextUnits).toBeLessThanOrEqual(55)
    expect(stats.retainedTokens).toBeLessThanOrEqual(9)
    expect(stats.tokenBufferBytes).toBeLessThanOrEqual(108)
  }
  expect(highlighter.lookup(first)).toBeNull()
  const otherView = createHighlighter({ workerOwner })
  await highlighted(otherView, first)
  expect(await workerOwner.inspectRetention()).toMatchObject({
    shared: { sliceLanguageCount: 1, sliceGrammarCount: 1 },
  })
  await highlighter.dispose()
  expect(highlighter.inspect()).toMatchObject({
    cacheEntries: 0,
    retainedTextUnits: 0,
    retainedTokens: 0,
  })
  expect(await highlighter.highlight(first)).toEqual({ kind: 'plain', reason: 'disposed' })
  expect(workerOwner.inspect()).toMatchObject({ lifecycle: 'ready', workerGeneration: 1 })
  await highlighted(otherView, slice('const second = 2'))
  expect(await workerOwner.inspectRetention()).toMatchObject({
    treeCount: 0,
    snapshotCount: 0,
    shared: { sliceLanguageCount: 1 },
  })
})

it('releases queued work on disposal and gives plain text for missing grammar or exceeded bounds', async () => {
  const { workerOwner, holdNextSlice } = recordWorker()
  const highlighter = createHighlighter({ workerOwner })
  await highlighter.prewarm()
  const held = holdNextSlice()
  const active = highlighter.highlight(slice('const active = 1'))
  const send = await held
  const queued = highlighter.highlight(slice('const queued = 2', { location: '2' }))
  await highlighter.dispose()
  expect(await active).toEqual({ kind: 'plain', reason: 'superseded' })
  expect(await queued).toEqual({ kind: 'plain', reason: 'disposed' })
  send()
  await workerOwner.awaitIdleFence()
  expect(highlighter.inspect()).toMatchObject({
    inFlightTextUnits: 0,
    queuedTextUnits: 0,
    cacheEntries: 0,
  })

  const unknown = createHighlighter({ language: null })
  expect(await unknown.highlight(slice('let x'))).toEqual({
    kind: 'plain',
    reason: 'unsupported-language',
  })
  const broken = createHighlighter({
    workerOwner,
    language: {
      id: 'broken',
      wasmUrl: 'data:application/wasm;base64,AA==',
      highlightQuerySource: '(identifier) @variable',
    },
  })
  expect(await broken.highlight(slice('let x'))).toEqual({ kind: 'plain', reason: 'unavailable' })
  const capped = createHighlighter({ workerOwner, limits: { maxTextUnits: 12 } })
  expect(await capped.highlight(slice('x'.repeat(13)))).toEqual({
    kind: 'plain',
    reason: 'over-budget',
  })
  const dense = createHighlighter({ workerOwner })
  expect(await dense.highlight(slice('const a=1;'.repeat(1_600)))).toEqual({
    kind: 'plain',
    reason: 'over-budget',
  })
  await highlighted(dense, slice('const next = 2'))
})

function createHighlighter(
  options: TreeSitterSliceHighlighterOptions = {},
): TreeSitterSliceHighlighter {
  const highlighter = createTreeSitterSliceHighlighter({
    language: TYPESCRIPT_TREE_SITTER_LANGUAGE,
    ...options,
  })
  highlighters.add(highlighter)
  return highlighter
}

function slice(
  text: string,
  options: Partial<TreeSitterHighlightSlice> = {},
): TreeSitterHighlightSlice {
  return {
    text,
    sourceId: 'fixture.ts',
    revision: 'revision-1',
    location: `0:${text.length}`,
    startsAtSourceStart: true,
    endsAtSourceEnd: false,
    ...options,
  }
}

async function highlighted(
  highlighter: TreeSitterSliceHighlighter,
  input: TreeSitterHighlightSlice,
): Promise<TreeSitterHighlightedSlice> {
  const result = await highlighter.highlight(input)
  if (result.kind !== 'highlighted') throw new Error(`Missing colors: ${result.reason}`)
  return result
}

function recordWorker() {
  const requests: TreeSitterWorkerRequest[] = []
  let held: {
    type: TreeSitterWorkerRequest['payload']['type']
    resolve(send: () => void): void
  } | null = null
  const workerOwner = createTreeSitterWorkerOwner({
    workerFactory: () => {
      const worker = new Worker(
        new URL('../src/treeSitter/treeSitter.worker.ts', import.meta.url),
        { type: 'module' },
      )
      const postMessage = worker.postMessage.bind(worker)
      worker.postMessage = (request: TreeSitterWorkerRequest): void => {
        requests.push(request)
        if (request.payload.type !== held?.type) {
          postMessage(request)
          return
        }
        const { resolve } = held
        held = null
        resolve(() => postMessage(request))
      }
      return worker
    },
  })
  owners.add(workerOwner)
  const holdNext = (type: TreeSitterWorkerRequest['payload']['type']) =>
    new Promise<() => void>((resolve) => {
      held = { type, resolve }
    })
  return {
    workerOwner,
    requests,
    holdNext,
    holdNextSlice: () => holdNext('highlightSlice'),
  }
}
