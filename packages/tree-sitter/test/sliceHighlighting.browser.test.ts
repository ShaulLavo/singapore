import { styleForTreeSitterCapture } from '@singapore-editor/core/syntax'
import { afterEach, expect, it } from 'vitest'
import {
  TSX_TREE_SITTER_LANGUAGE,
  TYPESCRIPT_TREE_SITTER_LANGUAGE,
} from '../../tree-sitter-languages/src/index'
import {
  createTreeSitterSliceHighlighter,
  createTreeSitterWorkerOwner,
  resolveTreeSitterLanguageContribution,
  type TreeSitterHighlightedSlice,
  type TreeSitterHighlightSlice,
  type TreeSitterSliceHighlighter,
  type TreeSitterSliceHighlighterOptions,
} from '../src'
import type { TreeSitterWorkerRequest } from '../src/treeSitter/types'
import { treeSitterBackendForOwner } from '../src/treeSitter/workerClient'

const highlighters = new Set<TreeSitterSliceHighlighter>()
const owners = new Set<ReturnType<typeof createTreeSitterWorkerOwner>>()

afterEach(async () => {
  await Promise.all(Array.from(highlighters, (highlighter) => highlighter.dispose()))
  await Promise.all(Array.from(owners, (owner) => owner.dispose()))
  highlighters.clear()
  owners.clear()
})

it('warms and highlights only the supplied slice with UTF-16 offsets over exact CRLF text', async () => {
  const { workerOwner, requests } = recordWorker()
  const highlighter = createHighlighter({ workerOwner })
  await highlighter.prewarm()
  expect(requests.map(({ payload }) => payload.type)).toEqual([
    'init',
    'registerLanguages',
    'warmLanguages',
  ])

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

it('checks the worker registration before using a changed query for the same language id', async () => {
  const { workerOwner, holdNextSlice } = recordWorker()
  const highlighter = createHighlighter({ workerOwner })
  await highlighter.prewarm()
  const held = holdNextSlice()
  const input = slice('const x = 1')
  const beforeChange = highlighter.highlight(input)
  const send = await held
  const descriptor = await resolveTreeSitterLanguageContribution(TYPESCRIPT_TREE_SITTER_LANGUAGE)
  await treeSitterBackendForOwner(workerOwner).registerLanguages([
    { ...descriptor, highlightQuerySource: '(identifier) @comment' },
  ])
  send()
  expect(await beforeChange).toEqual({ kind: 'plain', reason: 'unavailable' })
  expect(highlighter.lookup(input)).toBeNull()
  const original = await highlighted(highlighter, input)
  expect(original.tokens.styleAt(0)).toEqual(styleForTreeSitterCapture('keyword.declaration'))
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
  await highlighter.dispose()
  expect(highlighter.inspect()).toMatchObject({
    cacheEntries: 0,
    retainedTextUnits: 0,
    retainedTokens: 0,
  })
  expect(await highlighter.highlight(first)).toEqual({ kind: 'plain', reason: 'disposed' })
  expect(workerOwner.inspect()).toMatchObject({ lifecycle: 'ready', workerGeneration: 1 })
  const otherView = createHighlighter({ workerOwner })
  await highlighted(otherView, first)
  expect(workerOwner.inspect()).toMatchObject({ lifecycle: 'ready', workerGeneration: 1 })
  expect(await workerOwner.inspectRetention()).toMatchObject({ treeCount: 0, snapshotCount: 0 })
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
  expect(await dense.highlight(slice('const a=1;'.repeat(5_000)))).toEqual({
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
  let receiveHeldSlice: ((send: () => void) => void) | null = null
  const workerOwner = createTreeSitterWorkerOwner({
    workerFactory: () => {
      const worker = new Worker(
        new URL('../src/treeSitter/treeSitter.worker.ts', import.meta.url),
        { type: 'module' },
      )
      const postMessage = worker.postMessage.bind(worker)
      worker.postMessage = (request: TreeSitterWorkerRequest): void => {
        requests.push(request)
        if (request.payload.type !== 'highlightSlice' || !receiveHeldSlice) {
          postMessage(request)
          return
        }
        const resolve = receiveHeldSlice
        receiveHeldSlice = null
        resolve(() => postMessage(request))
      }
      return worker
    },
  })
  owners.add(workerOwner)
  return {
    workerOwner,
    requests,
    holdNextSlice: () =>
      new Promise<() => void>((resolve) => {
        receiveHeldSlice = resolve
      }),
  }
}
