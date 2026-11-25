import { createEmptySyntaxRuntime } from './factories/syntaxRuntime'
import {
  createEditorStructuralOperation,
  createEditorHighlighterOperation,
} from '../src/editor/syntaxOperations'
import { describe, expect, it, vi } from 'vitest'
import {
  commitPreparedDocumentTransaction,
  createEditorBufferSession,
  createEditorTextBuffer,
  prepareDocumentTransaction,
  type EditorTextBuffer,
} from '../src/documentSession'
import {
  createEditorDocumentAnalysis,
  retainedSyntaxCanWarm,
  type EditorDocumentAnalysis,
} from '../src/editor/documentAnalysis'
import { EditorSyntaxController } from '../src/editor/syntaxController'
import { EditorPluginHost } from '../src/plugins'
import {
  createEmptySyntaxResult,
  type BracketInfo,
  type EditorSyntaxProvider,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
} from '../src/syntax/session'
import { EditorTokenStore } from '../src/syntax/tokenStore'
import { projectTokensThroughEdit } from '../src/editor/tokenProjection'
import type { DocumentRead } from '../src/editor/documentDelivery'
import { createEditorPreparedDocument } from '../src/editor/preparedDocument'
import type { EditorHighlighterProvider } from '../src/syntax/highlighter'
import type { TextEdit } from '../src/tokens'

describe('syntax refresh after an edit', () => {
  it('dispatches the visible range immediately at 0 ms when idle and coalesces bursts behind an active flight', async () => {
    vi.useFakeTimers()
    const buffer = createEditorTextBuffer('x\n'.repeat(50_000))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'edit-refresh' })
    const asked: string[] = []
    const pendingParses: Array<() => void> = []
    let holdAnalyze = false
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        analyze: async () => {
          if (!holdAnalyze) return createEmptySyntaxResult()
          await new Promise<void>((resolve) => {
            pendingParses.push(resolve)
          })
          return createEmptySyntaxResult()
        },
        queryRange: async (range: EditorSyntaxRange) => {
          asked.push(`${range.startIndex}-${range.endIndex}`)
          return createEmptySyntaxResult({ requestedRanges: [range] })
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 512 })
    const edit = (text: string) => {
      const change = createEditorBufferSession(buffer).applyEdits([{ from: 0, to: 0, text }])
      view.syntax.acceptChange(change)
      view.syntax.refresh(1, change)
    }
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.advanceTimersByTimeAsync(200)
      // The last range asked for lies off screen, as warming leaves it.
      view.syntax.prefetchVisibleRange(1, { startIndex: 60_000, endIndex: 61_000 }, { delayMs: 0 })
      await vi.advanceTimersByTimeAsync(200)
      expect(asked.at(-1)).toBe('60000-61000')

      // Idle edits dispatch immediately at 0 ms (no artificial debounce gap).
      asked.length = 0
      edit('a')
      await vi.advanceTimersByTimeAsync(5)
      expect(asked[0]).toBe('0-512')

      asked.length = 0
      edit('b')
      await vi.advanceTimersByTimeAsync(5)
      expect(asked[0]).toBe('0-512')

      // While a flight is in progress, rapid edits coalesce into a single trailing flight.
      asked.length = 0
      holdAnalyze = true
      edit('c')
      await vi.advanceTimersByTimeAsync(5)
      expect(pendingParses).toHaveLength(1)
      expect(asked).toEqual([])

      edit('d')
      edit('e')
      edit('f')
      await vi.advanceTimersByTimeAsync(50)
      expect(asked).toEqual([])

      holdAnalyze = false
      while (pendingParses.length > 0) pendingParses.shift()!()
      await vi.advanceTimersByTimeAsync(10)
      expect(asked).toEqual(['0-512'])
    } finally {
      view.dispose()
      analysis.dispose()
      vi.useRealTimers()
    }
  })

  it('recovers readiness when a logical-only synchronize aborts an in-flight edit query', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(200))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'logical-sync-recovery' })
    let holdFirstEditQuery = true
    let rangeCalls = 0
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async (range: EditorSyntaxRange, signal?: AbortSignal) => {
          rangeCalls += 1
          if (rangeCalls === 2 && holdFirstEditQuery) {
            holdFirstEditQuery = false
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted by synchronize', 'AbortError')),
                { once: true },
              )
            })
          }
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            tokens: EditorTokenStore.fromTokens([
              { start: range.startIndex, end: range.startIndex + 1, style: { color: 'green' } },
            ]),
          }
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 120 })
    const session = createEditorBufferSession(buffer)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

      // Start an edit whose range query stays in flight.
      const editChange = session.applyEdits([{ from: 0, to: 0, text: 'a' }])
      view.syntax.acceptChange(editChange)
      view.syntax.refresh(1, editChange)
      await vi.waitFor(() => expect(rangeCalls).toBe(2))
      expect(view.syntax.status).toBe('loading')

      // Commit a logical-only synchronize while the edit range query is pending; this advances
      // the buffer sync point and aborts the retained pending query without changing text.
      const firstChar = buffer.getTextSnapshot().readRange(0, 1)
      const committed = commitPreparedDocumentTransaction(
        { buffer, sourceView: null },
        prepareDocumentTransaction(buffer, [{ from: 0, to: 1, text: firstChar }], 1, null),
        { history: { kind: 'external-barrier', groupId: 'scope' } },
      )
      expect(committed.status).toBe('logical-only')
      if (committed.status !== 'logical-only') throw new Error('expected logical-only commit')
      view.syntax.acceptChange(committed.change)
      view.syntax.refresh(1, committed.change)

      // Controller must recover to `ready` on its own without requiring another edit or scroll.
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      expect(rangeCalls).toBeGreaterThanOrEqual(3)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('recovers across more than four consecutive logical-only synchronizations without exhausting retry budget', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(200))
    const analysis = createEditorDocumentAnalysis({
      buffer,
      documentId: 'many-logical-syncs',
    })
    let holdNextQuery = false
    let rangeCalls = 0
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async (range: EditorSyntaxRange, signal?: AbortSignal) => {
          rangeCalls += 1
          if (holdNextQuery) {
            holdNextQuery = false
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted by synchronize', 'AbortError')),
                { once: true },
              )
            })
          }
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            tokens: EditorTokenStore.fromTokens([
              { start: range.startIndex, end: range.startIndex + 1, style: { color: 'green' } },
            ]),
          }
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 120 })
    const session = createEditorBufferSession(buffer)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

      // Start an edit query, then interrupt recovery 6 consecutive times with logical-only
      // synchronizations (exceeding MAX_EXTERNAL_ABORT_RECOVERIES = 4); each advances the
      // retained parseId so the final recovery still settles to `ready`.
      holdNextQuery = true
      const editChange = session.applyEdits([{ from: 0, to: 0, text: 'a' }])
      view.syntax.acceptChange(editChange)
      view.syntax.refresh(1, editChange)
      await vi.waitFor(() => expect(rangeCalls).toBe(2))

      const firstChar = buffer.getTextSnapshot().readRange(0, 1)
      for (let i = 0; i < 6; i += 1) {
        holdNextQuery = i < 5
        const callsBefore = rangeCalls
        const committed = commitPreparedDocumentTransaction(
          { buffer, sourceView: null },
          prepareDocumentTransaction(buffer, [{ from: 0, to: 1, text: firstChar }], 1, null),
          { history: { kind: 'external-barrier', groupId: 'scope' } },
        )
        expect(committed.status).toBe('logical-only')
        if (committed.status !== 'logical-only') throw new Error('expected logical-only')
        view.syntax.acceptChange(committed.change)
        view.syntax.refresh(1, committed.change)
        await vi.waitFor(() => expect(rangeCalls).toBeGreaterThan(callsBefore))
      }

      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('settles out of loading when repeated external AbortErrors exhaust the retry budget on the same retained state', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(200))
    const analysis = createEditorDocumentAnalysis({
      buffer,
      documentId: 'exhausted-abort-budget',
    })
    let rangeCalls = 0
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async () => {
          rangeCalls += 1
          throw new DOMException('repeated external abort', 'AbortError')
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 120 })
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).not.toBe('loading'))
      expect(rangeCalls).toBeLessThanOrEqual(6)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('recovers readiness when logical-only synchronize advances parseId after reply arrival but before paint-gate drain', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const originalRaf = globalThis.requestAnimationFrame
    const originalCancelRaf = globalThis.cancelAnimationFrame
    const originalDocument = globalThis.document
    const listeners = new Map<string, Set<() => void>>()
    let visibilityState: 'visible' | 'hidden' = 'visible'
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
      },
      removeEventListener: (event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener)
      },
    })
    const buffer = createEditorTextBuffer('x\n'.repeat(200))
    const analysis = createEditorDocumentAnalysis({
      buffer,
      documentId: 'logical-sync-before-drain',
    })
    let rangeCalls = 0
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async (range: EditorSyntaxRange) => {
          rangeCalls += 1
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            tokens: EditorTokenStore.fromTokens([
              { start: range.startIndex, end: range.startIndex + 1, style: { color: 'green' } },
            ]),
          }
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 120 })
    const session = createEditorBufferSession(buffer)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

      // Edit replies while the keystroke paint gate is still armed (rAF has not fired yet).
      const editChange = session.applyEdits([{ from: 0, to: 0, text: 'a' }])
      view.syntax.acceptChange(editChange)
      view.syntax.refresh(1, editChange)
      await vi.waitFor(() => expect(rangeCalls).toBe(2))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(view.syntax.status).toBe('loading')

      // Advance retained parseId via logical-only synchronize BEFORE the paint gate drains.
      const firstChar = buffer.getTextSnapshot().readRange(0, 1)
      const committed = commitPreparedDocumentTransaction(
        { buffer, sourceView: null },
        prepareDocumentTransaction(buffer, [{ from: 0, to: 1, text: firstChar }], 1, null),
        { history: { kind: 'external-barrier', groupId: 'scope' } },
      )
      expect(committed.status).toBe('logical-only')
      if (committed.status !== 'logical-only') throw new Error('expected logical-only')
      view.syntax.acceptChange(committed.change)
      view.syntax.refresh(1, committed.change)
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Drain the paint gate via visibilitychange: stale parseId must trigger recovery to ready.
      visibilityState = 'hidden'
      for (const listener of listeners.get('visibilitychange') ?? []) listener()
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      expect(rangeCalls).toBeGreaterThanOrEqual(3)
    } finally {
      view.dispose()
      analysis.dispose()
      vi.stubGlobal('requestAnimationFrame', originalRaf)
      vi.stubGlobal('cancelAnimationFrame', originalCancelRaf)
      vi.stubGlobal('document', originalDocument)
    }
  })

  it('starts a fresh range query instead of rejoining a stuck range query on explicit refresh', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(200))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'explicit-replace-stuck' })
    let rangeCalls = 0
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async (range: EditorSyntaxRange) => {
          rangeCalls += 1
          if (rangeCalls === 1) {
            // Never resolves — simulates a stuck range query whose base parse is already ready.
            return await new Promise<EditorSyntaxResult>(() => undefined)
          }
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            tokens: EditorTokenStore.fromTokens([
              { start: range.startIndex, end: range.startIndex + 1, style: { color: 'blue' } },
            ]),
          }
        },
      })),
    } satisfies EditorSyntaxProvider
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 120 })
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(rangeCalls).toBe(1))
      expect(view.syntax.status).toBe('loading')

      // Explicit refresh with replacePending must bypass the stuck orphaned range query.
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      expect(rangeCalls).toBe(2)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })
})

describe('syntax range contributor lifetime', () => {
  it.each(['disjoint', 'overlap'] as const)(
    'bounds forty %s publications through the public controller lifecycle',
    async (mode) => {
      const buffer = createEditorTextBuffer('x\n'.repeat(50_000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: mode })
      const ranges = vi.fn(async (range: EditorSyntaxRange) => {
        const startIndex = mode === 'overlap' && range.startIndex > 1000 ? 50_000 : range.startIndex
        const endIndex = mode === 'overlap' && range.startIndex > 1000 ? 51_024 : range.endIndex
        return {
          ...createEmptySyntaxResult({ requestedRanges: [range] }),
          records: { languageId: 'typescript', data: new Uint32Array(256) },
          tokens: EditorTokenStore.fromTokens(
            Array.from({ length: 128 }, (_, index) => ({
              start: range.startIndex + index * 2,
              end: range.startIndex + index * 2 + 1,
              style: { color: 'fixture' },
            })),
          ),
          folds: [
            {
              startIndex,
              endIndex,
              startLine: Math.floor(startIndex / 2),
              endLine: Math.floor(endIndex / 2) - 1,
              type: 'scope',
            },
          ],
        }
      })
      const create = vi.fn(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: ranges,
      }))
      const provider = {
        operation: createEditorStructuralOperation(create),
      } satisfies EditorSyntaxProvider
      const left = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 512 })
      const right = createView(buffer, analysis, provider, { startIndex: 1024, endIndex: 1536 })
      try {
        left.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(left.syntax.tokens.length).toBe(128))
        for (let step = 0; step < 40; step++) {
          const range =
            mode === 'overlap'
              ? { startIndex: 50_000 - step, endIndex: 51_024 + step }
              : { startIndex: (step + 1) * 1024, endIndex: (step + 1) * 1024 + 512 }
          right.setRange(range)
          right.syntax.refresh(1, null, { delayMs: 0 })
          await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(step + 2))
          await vi.waitFor(() => expect(right.syntax.tokens.length).toBe(128))
          expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBeLessThanOrEqual(2)
          expect(
            EditorTokenStore.inspectRetention([right.syntax.tokens, right.syntax.copyTokens])
              .backingBytes,
          ).toBeLessThanOrEqual(4096)
          expect(right.folds()).toBe(1)
        }
        expect(create).toHaveBeenCalledTimes(1)
        const before = right.adoptions()
        right.publish()
        right.publish()
        expect(right.adoptions()).toBe(before)
      } finally {
        left.dispose()
        right.dispose()
        analysis.dispose()
      }
    },
  )

  it('keeps explicitly installed tokens and their accepted copy authority', () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(100))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'manual' })
    const provider = {
      operation: createEditorStructuralOperation(() => createEmptySyntaxRuntime()),
    }
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
    try {
      const tokens = EditorTokenStore.fromTokens([
        { start: 100, end: 110, style: { color: 'manual' } },
      ])
      view.syntax.setTokens(tokens)
      view.publish()
      expect(view.syntax.tokens).toBe(tokens)
      expect(view.syntax.copyTokens).toBe(tokens)
      expect(
        EditorTokenStore.inspectRetention([view.syntax.tokens, view.syntax.copyTokens])
          .backingBytes,
      ).toBe(12)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('keeps full highlighter state and its authoritative copy store', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(100))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'full-highlighter' })
    const tokens = EditorTokenStore.fromTokens([{ start: 100, end: 110, style: { color: 'full' } }])
    const refresh = async () => ({ tokens })
    const highlighter = {
      operation: createEditorHighlighterOperation(() => ({
        analyze: refresh,
        dispose: () => undefined,
      })),
    }
    const ranges = vi.fn(async (range: EditorSyntaxRange) =>
      createEmptySyntaxResult({ requestedRanges: [range] }),
    )
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        queryRange: ranges,
      })),
    }
    const view = createView(
      buffer,
      analysis,
      provider,
      { startIndex: 0, endIndex: 20 },
      highlighter,
    )
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens).toBe(tokens))
      view.publish()
      expect(view.syntax.tokens).toBe(tokens)
      expect(view.syntax.copyTokens).toBe(tokens)
      for (let step = 0; step < 40; step++) {
        view.setRange({ startIndex: 0, endIndex: 21 + step })
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(step + 2))
        expect(view.syntax.tokens).toBe(tokens)
        expect(view.syntax.copyTokens).toBe(tokens)
        expect(
          analysis.inspectRetention().entries.find((entry) => entry.family === 'structural')!
            .cachedRangeCount,
        ).toBeLessThanOrEqual(1)
      }
      expect(
        analysis.inspectRetention().entries.find((entry) => entry.family === 'highlighter')!
          .leaseCount,
      ).toBe(1)
      expect(
        EditorTokenStore.inspectRetention([view.syntax.tokens, view.syntax.copyTokens])
          .backingBytes,
      ).toBe(12)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('preserves manual tokens carried through a partial structural update and scroll', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(100))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'mixed-origin' })
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        queryRange: async (range: EditorSyntaxRange) =>
          createEmptySyntaxResult({ requestedRanges: [range] }),
      })),
    }
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
    try {
      const manual = EditorTokenStore.fromTokens([
        { start: 100, end: 110, style: { color: 'manual' } },
      ])
      view.syntax.setTokens(manual)
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      expect(view.syntax.copyTokens).toBe(manual)
      view.setRange({ startIndex: 20, endIndex: 40 })
      expect(view.syntax.tokens.toTokens()).toEqual([
        { start: 100, end: 110, style: { color: 'manual' } },
      ])
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('keeps neighbouring range answers after a newer analysis replaces the painted ones', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'replaced-preview' })
    // Every answer reports the same wide fold, as a bounded-slice answer does, so no answer keeps a
    // fold of its own once a neighbour arrives.
    let answers = 0
    const ranges = vi.fn(async (range: EditorSyntaxRange) => {
      // A request loop would never end; stop answering so it fails on the call list below.
      answers++
      if (answers > 20) return new Promise<never>(() => undefined)
      return {
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        records: { languageId: 'typescript', data: new Uint32Array(16) },
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: 'range' } },
        ]),
        folds: [
          { startIndex: 0, endIndex: 400, startLine: 0, endLine: 199, type: 'scope' as const },
        ],
      }
    })
    let analyzed: DocumentRead | null = null
    let publish: ((read: DocumentRead, result: EditorSyntaxResult) => void) | null = null
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        analyze: async (read: DocumentRead) => {
          analyzed = read
          return createEmptySyntaxResult()
        },
        subscribeResults: (listener: (read: DocumentRead, result: EditorSyntaxResult) => void) => {
          publish = listener
          return () => undefined
        },
        queryRange: ranges,
      })),
    }
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      await vi.waitFor(() => expect(analyzed).not.toBeNull())
      // The complete analysis publishes while the earlier answer's tokens are painted.
      publish!(analyzed!, createEmptySyntaxResult())
      await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      for (const endIndex of [40, 60, 80]) {
        view.setRange({ startIndex: 0, endIndex })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() =>
          expect(view.syntax.tokens.toTokens()).toContainEqual({
            start: endIndex - 20,
            end: endIndex - 19,
            style: { color: 'range' },
          }),
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ranges.mock.calls.map(([range]) => [range.startIndex, range.endIndex])).toEqual([
        [0, 20],
        [0, 20],
        [20, 40],
        [40, 60],
        [60, 80],
      ])
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it.each([
    ['a single-line edit', '!'],
    ['a multi-line edit', '!\n'],
  ] as const)('keeps neighbouring range answers after %s', async (_name, text) => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'edited-ranges' })
    // Every answer reports the same wide fold, so no answer keeps a fold of its own.
    let answers = 0
    const ranges = vi.fn(async (range: EditorSyntaxRange) => {
      // A request loop would never end; stop answering so it fails on the call list below.
      answers++
      if (answers > 20) return new Promise<never>(() => undefined)
      return {
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        records: { languageId: 'typescript', data: new Uint32Array(16) },
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: 'range' } },
        ]),
        folds: [
          { startIndex: 0, endIndex: 400, startLine: 0, endLine: 199, type: 'scope' as const },
        ],
      }
    })
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: ranges,
      })),
    }
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      // Typing, as the editor applies it: the change, then the tokens projected through it.
      const previous = buffer.getTextSnapshot()
      const edit = { from: 5, to: 5, text }
      const change = createEditorBufferSession(buffer).applyEdits([edit])
      view.syntax.acceptChange(change)
      view.syntax.setTokens(projectTokensThroughEdit(view.syntax.tokens, edit, previous), false)
      view.syntax.refresh(1, change, { delayMs: 0 })
      await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(2))
      for (const endIndex of [40, 60, 80]) {
        view.setRange({ startIndex: 0, endIndex })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() =>
          expect(view.syntax.tokens.toTokens().some((token) => token.start >= endIndex - 20)).toBe(
            true,
          ),
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      const afterEdit = ranges.mock.calls
        .slice(2)
        .map(([range]) => `${range.startIndex}-${range.endIndex}`)
      expect(afterEdit).toHaveLength(3)
      expect(new Set(afterEdit).size).toBe(3)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('asks for each neighbouring range once after two line-breaking edits before the parser answers', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'two-edits' })
    const answers = rangeAnswers('shared')
    const view = createView(buffer, analysis, structuralProvider(answers.query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      typeText(view, buffer, { from: 5, to: 5, text: '!\n' })
      const change = typeText(view, buffer, { from: 9, to: 9, text: '!\n' })
      view.syntax.refresh(1, change, { delayMs: 0 })
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(2))
      await growFrame(view, [40, 60, 80])
      expect(answers.calls().slice(1)).toEqual([
        [0, 20],
        [20, 40],
        [40, 60],
        [60, 80],
      ])
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('asks for each range once when no answer covers the frame after a newer analysis', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'moving-frame' })
    const answers = rangeAnswers('shared')
    const replaced = replaceableAnalysis(answers.query)
    const view = createView(buffer, analysis, replaced.provider, firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      await replaced.analyzed()
      // The frame grows while the new analysis's first answer is on its way, so that answer
      // covers only part of it, and so does every answer after it.
      const releaseRefresh = answers.hold()
      replaced.publishComplete()
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(2))
      const releaseAnswer = answers.hold()
      view.setRange({ startIndex: 0, endIndex: 40 })
      releaseRefresh()
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(3))
      view.setRange({ startIndex: 0, endIndex: 60 })
      releaseAnswer()
      await vi.waitFor(() => expect(view.syntax.tokens.toTokens()).toContainEqual(rangeToken(40)))
      await growFrame(view, [80])
      expect(answers.calls()).toEqual([
        [0, 20],
        [0, 20],
        [20, 40],
        [40, 60],
        [60, 80],
      ])
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('asks for each neighbouring fold range once beside a separate highlighter', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'highlighter-folds' })
    const tokens = EditorTokenStore.fromTokens([{ start: 0, end: 1, style: { color: 'full' } }])
    const highlighter = {
      operation: createEditorHighlighterOperation(() => ({
        analyze: async () => ({ tokens }),
        dispose: () => undefined,
      })),
    }
    const answers = rangeAnswers('shared')
    const view = createView(
      buffer,
      analysis,
      structuralProvider(answers.query),
      firstFrame,
      highlighter,
    )
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens).toBe(tokens))
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(1))
      for (const [step, endIndex] of [40, 60, 80].entries()) {
        view.setRange({ startIndex: 0, endIndex })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(step + 2))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(answers.calls()).toEqual([
        [0, 20],
        [20, 40],
        [40, 60],
        [60, 80],
      ])
      expect(view.syntax.tokens).toBe(tokens)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it.each(['late', 'failed'] as const)(
    'ignores a replaced look-ahead that lands %s over a ready viewport',
    async (outcome) => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: `replaced-${outcome}` })
      const colored = (range: EditorSyntaxRange, color: string) => ({
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        tokens: EditorTokenStore.fromTokens([{ start: 120, end: 121, style: { color } }]),
      })
      const held = Promise.withResolvers<void>()
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        // The first look-ahead is held, then answers red or fails; everything else answers green.
        if (range.startIndex === 0 && range.endIndex === 250) {
          await held.promise
          if (outcome === 'failed') throw new Error('look-ahead failed')
          return colored(range, 'red')
        }
        return colored(range, 'green')
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 100,
        endIndex: 160,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 250 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        // A newer, overlapping window replaces it.
        view.syntax.prefetchVisibleRange(1, { startIndex: 50, endIndex: 300 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
        held.resolve()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.initialHighlightStatus).not.toBe('error')
        expect(view.syntax.tokens.toTokens()).toContainEqual({
          start: 120,
          end: 121,
          style: { color: 'green' },
        })
      } finally {
        view.dispose()
        analysis.dispose()
      }
    },
  )

  it('keeps the tokens of an answer that stays cached through a newer analysis', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'cached-colors' })
    // The frame the view moves to still shows the end of the earlier answer, so it stays cached.
    const answers = rangeAnswers('own')
    const replaced = replaceableAnalysis(answers.query)
    const view = createView(buffer, analysis, replaced.provider, firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      await replaced.analyzed()
      // The new analysis answers a frame after the view has moved on from it, then answers the
      // frame the view moved to in full.
      const releaseRefresh = answers.hold()
      replaced.publishComplete()
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(2))
      const releaseAnswer = answers.hold()
      const left = { startIndex: 0, endIndex: 30 }
      view.setRange(left)
      releaseRefresh()
      await vi.waitFor(() => expect(answers.query).toHaveBeenCalledTimes(3))
      view.setRange({ startIndex: 25, endIndex: 50 })
      releaseAnswer()
      await vi.waitFor(() => expect(view.syntax.tokens.toTokens()).toContainEqual(rangeToken(30)))
      view.setRange({ startIndex: 20, endIndex: 30 })
      view.syntax.refreshVisibleRange(1, { delayMs: 0 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Still answered, so not asked for again, and still colored.
      expect(answers.calls()).toEqual([
        [0, 20],
        [0, 20],
        [20, 30],
        [30, 50],
      ])
      expect(view.syntax.tokens.toTokens()).toContainEqual(rangeToken(20))
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it.each([
    ['a single-line edit', '!'],
    ['a multi-line edit', '!\n'],
  ] as const)('keeps tokens a host installs with %s through later answers', async (_name, text) => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'host-edit-tokens' })
    const answers = rangeAnswers('shared')
    const view = createView(buffer, analysis, structuralProvider(answers.query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      // Editor.applyEdit(edit, tokens): the edit with its projection, then the host's tokens.
      const change = typeText(view, buffer, { from: 5, to: 5, text })
      view.syntax.setTokens(EditorTokenStore.fromTokens([hostToken]))
      view.syntax.refresh(1, change, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.toTokens()).toContainEqual(rangeToken(0)))
      await moveFrame(view, [20, 40, 60])
      expect(view.syntax.tokens.toTokens()).toContainEqual(hostToken)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('keeps a host store installed in place of an edit projection', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'host-store' })
    const answers = rangeAnswers('shared')
    const view = createView(buffer, analysis, structuralProvider(answers.query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      // The host's store arrives where the projection of the painted tokens would have.
      const change = createEditorBufferSession(buffer).applyEdits([{ from: 5, to: 5, text: '!' }])
      view.syntax.acceptChange(change)
      view.syntax.setTokens(EditorTokenStore.fromTokens([hostToken]))
      view.syntax.refresh(1, change, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.toTokens()).toContainEqual(rangeToken(0)))
      await moveFrame(view, [20, 40, 60])
      // The store was never the range answers', so dropping their answers removes nothing of it.
      expect(view.syntax.tokens.toTokens()).toContainEqual(hostToken)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('keeps whole-document colors prepared by a provider that cannot answer ranges', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(50_000))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'prepared-full' })
    const farToken = rangeToken(80_000)
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        analyze: async () => ({
          ...createEmptySyntaxResult(),
          tokens: EditorTokenStore.fromTokens([rangeToken(0), farToken]),
        }),
      })),
    }
    const prepared = createEditorPreparedDocument({
      analysis,
      buffer,
      documentId: 'prepared-full',
      languageId: 'typescript',
      configuredTabSize: 4,
      tabSizePolicy: 'fixed',
      documentConfigurationTag: [],
    })
    const document = {
      analysis,
      documentId: 'prepared-full',
      languageId: 'typescript',
      snapshot: buffer.getSnapshot(),
      textSnapshot: buffer.getTextSnapshot(),
    }
    const view = createView(buffer, analysis, provider, firstFrame)
    try {
      const stage = await prepared.startStage({
        family: 'structural',
        provider,
        configuration: { includeCaptures: false, includeHighlights: true, syntaxMode: 'range' },
        configurationTag: [],
        range: firstFrame,
        abortSignal: new AbortController().signal,
      })
      expect(stage).toBe('ready')
      const transfer = view.syntax.borrowPreparedDocument(document, prepared, {
        configuredTabSize: 4,
        tabSizePolicy: 'fixed',
        documentConfigurationTag: [],
        highlighterConfigurationTag: [],
        structuralConfigurationTag: [],
      })
      view.syntax.startDocument(document, transfer)
      expect(view.syntax.stagePreparedReadyTokens(transfer).toTokens()).toContainEqual(farToken)
      view.syntax.adoptPreparedReadyResults(transfer)
      // Nothing could paint the far token again, so it has to survive the frames before it.
      view.setRange({ startIndex: 79_990, endIndex: 80_010 })
      view.syntax.refreshVisibleRange(1, { delayMs: 0 })
      expect(view.syntax.tokens.toTokens()).toContainEqual(farToken)
    } finally {
      view.dispose()
      prepared.dispose()
      analysis.dispose()
    }
  })

  it('asks the new parse for a frame shown again while its first answer was on the way', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'returned-frame' })
    const away = { startIndex: 60, endIndex: 80 }
    const gate = Promise.withResolvers<void>()
    // Each answer's token is colored by the parse that produced it. The fold every answer reports
    // crosses both frames, so the first frame's answer stays cached while the view is away.
    let parse = 'before'
    const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
      if (parse === 'after' && range.startIndex === away.startIndex) await gate.promise
      return {
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: parse } },
        ]),
        folds: [{ startIndex: 0, endIndex: 400, startLine: 0, endLine: 199, type: 'scope' }],
      }
    })
    const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
      parse = 'after'
      const change = typeText(view, buffer, { from: 5, to: 5, text: 'x' })
      view.setRange(away)
      view.syntax.refresh(1, change, { delayMs: 0 })
      await vi.waitFor(() =>
        expect(query.mock.calls.some(([range]) => range.startIndex === away.startIndex)).toBe(true),
      )
      // Back on the first frame, the answer carried through the edit repaints it for now.
      view.setRange(firstFrame)
      view.syntax.refreshVisibleRange(1, { delayMs: 0 })
      gate.resolve()
      await vi.waitFor(() =>
        expect(view.syntax.tokens.toTokens()).toContainEqual({
          start: 0,
          end: 1,
          style: { color: 'after' },
        }),
      )
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
    } finally {
      gate.resolve()
      view.dispose()
      analysis.dispose()
    }
  })

  it('keeps an actual crossing fold contributor when its query lies outside the new frame', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'crossing' })
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        foldingSupport: 'supported' as const,
        queryRange: async (range: EditorSyntaxRange) => ({
          ...createEmptySyntaxResult({ requestedRanges: [range] }),
          records: { languageId: 'typescript', data: new Uint32Array(256) },
          tokens: EditorTokenStore.fromTokens([{ start: 0, end: 1, style: { color: 'crossing' } }]),
          folds: [{ startIndex: 0, endIndex: 300, startLine: 0, endLine: 149, type: 'scope' }],
        }),
      })),
    }
    const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 100 })
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.folds()).toBe(1))
      view.setRange({ startIndex: 200, endIndex: 250 })
      expect(view.folds()).toBe(1)
      expect(view.syntax.tokens.toTokens()).toEqual([
        { start: 0, end: 1, style: { color: 'crossing' } },
      ])
      expect(view.syntax.copyTokens.toTokens()).toEqual(view.syntax.tokens.toTokens())
      expect(analysis.inspectRetention().entries[0]).toMatchObject({
        cachedRangeCount: 1,
        syntaxRecordBackingBytes: 1024,
      })
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('ends optional warming after pruning and blocks repeated warming of the same source', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(250_000))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'warm-stop' })
    const ranges = vi.fn((range: EditorSyntaxRange) =>
      Promise.resolve({
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: 'warm' } },
        ]),
      }),
    )
    const provider = {
      operation: createEditorStructuralOperation(() => ({
        ...createEmptySyntaxRuntime(),
        queryRange: ranges,
      })),
    }
    const frame = { startIndex: 0, endIndex: 512 }
    const view = createView(buffer, analysis, provider, frame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      // The first off-screen warm tile is pruned immediately without overwriting accepted copyTokens,
      // and retires warming on the same source.
      await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(2))
      await vi.waitFor(() =>
        expect(retainedSyntaxCanWarm(Reflect.get(view.syntax, 'retainedSyntax'))).toBe(false),
      )
      expect(Reflect.get(view.syntax, 'pendingWarm')).toBeNull()
      expect(Reflect.get(view.syntax, 'stoppedWarm')).toBeNull()
      expect(view.syntax.copyTokens.startAt(0)).toBe(0)
      expect(view.syntax.tokens.toTokens().map((token) => token.start)).toEqual([0])
      expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBe(1)
      expect(view.syntax.renderDataReady).toBe(true)

      const copy = view.syntax.copyTokens
      const adoptions = view.adoptions()
      for (let step = 0; step < 40; step++)
        view.syntax.warmSyntaxAroundRange(1, frame, { delayMs: 0 })
      await new Promise((resolve) => setTimeout(resolve, 180))
      expect(ranges.mock.calls.map(([range]) => range)).toEqual([
        frame,
        { startIndex: 120_000, endIndex: 240_000 },
      ])
      expect(view.syntax.copyTokens).toBe(copy)
      expect(view.adoptions()).toBe(adoptions)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it.each(['clear', 'replace', 'dispose', 'configuration', 'text-change'] as const)(
    'retires outgoing view warming through %s with canonical analysis',
    async (boundary) => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250_000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: boundary })
      const provider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          queryRange: async (range: EditorSyntaxRange) => ({
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            tokens: EditorTokenStore.fromTokens([
              { start: range.startIndex, end: range.startIndex + 1, style: { color: 'warm' } },
            ]),
          }),
        })),
      }
      const view = createView(
        buffer,
        analysis,
        provider,
        { startIndex: 0, endIndex: 512 },
        undefined,
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        const outgoing = Reflect.get(view.syntax, 'retainedSyntax')
        await vi.waitFor(() => expect(retainedSyntaxCanWarm(outgoing)).toBe(false))
        expect(view.syntax.copyTokens.startAt(0)).toBe(0)
        if (boundary === 'clear') view.syntax.clearDocument()
        if (boundary === 'dispose') view.syntax.dispose()
        if (boundary === 'configuration') view.syntax.reloadSyntaxSession()
        if (boundary === 'replace') {
          const session = createEditorBufferSession(buffer)
          view.syntax.startDocument({
            analysis,
            documentId: 'replacement',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          })
        }
        if (boundary === 'text-change') {
          const change = createEditorBufferSession(buffer).applyText('!')
          view.syntax.acceptChange(change)
        }
        expect(Reflect.get(view.syntax, 'stoppedWarm')).toBeNull()
        if (boundary === 'text-change') {
          expect(Reflect.get(view.syntax, 'retainedSyntax')).toBe(outgoing)
          expect(retainedSyntaxCanWarm(outgoing)).toBe(true)
        } else {
          expect(Reflect.get(view.syntax, 'retainedSyntax')).not.toBe(outgoing)
          expect(retainedSyntaxCanWarm(outgoing)).toBe(false)
        }
      } finally {
        view.dispose()
        analysis.dispose()
      }
    },
  )
})

const firstFrame: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }

const hostToken = { start: 300, end: 310, style: { color: 'host' } }

const rangeToken = (startIndex: number) => ({
  start: startIndex,
  end: startIndex + 1,
  style: { color: 'range' },
})

/**
 * Range answers with one token at the start of the range. `shared` answers all report the same
 * wide fold, as bounded-slice answers do, so none keeps a fold of its own once a neighbour
 * arrives. `own` answers each report a fold nobody else does.
 */
function rangeAnswers(folds: 'shared' | 'own') {
  let answered = 0
  let held: Promise<void> | null = null
  const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
    // A request loop would never end; stop answering so it fails on the call list.
    answered++
    if (answered > 20) return new Promise<never>(() => undefined)
    await held
    const startIndex = folds === 'shared' ? 0 : range.startIndex
    return {
      ...createEmptySyntaxResult({ requestedRanges: [range] }),
      records: { languageId: 'typescript', data: new Uint32Array(16) },
      tokens: EditorTokenStore.fromTokens([rangeToken(range.startIndex)]),
      folds: [
        {
          startIndex,
          endIndex: startIndex + 400,
          startLine: startIndex / 2,
          endLine: startIndex / 2 + 199,
          type: 'scope',
        },
      ],
    }
  })
  return {
    query,
    calls: () => query.mock.calls.map(([range]) => [range.startIndex, range.endIndex]),
    /** Keeps the answers asked for from now on waiting until the returned function is called. */
    hold: () => {
      const gate = Promise.withResolvers<void>()
      held = gate.promise
      return () => {
        if (held === gate.promise) held = null
        gate.resolve()
      }
    },
  }
}

type RangeQuery = (range: EditorSyntaxRange) => Promise<EditorSyntaxResult>

function structuralProvider(queryRange: RangeQuery): EditorSyntaxProvider {
  return {
    operation: createEditorStructuralOperation(() => ({
      ...createEmptySyntaxRuntime(),
      foldingSupport: 'supported' as const,
      queryRange,
    })),
  }
}

/** A provider whose complete analysis can publish over the answers already painted. */
function replaceableAnalysis(queryRange: RangeQuery) {
  let analyzed: DocumentRead | null = null
  let publish: ((read: DocumentRead, result: EditorSyntaxResult) => void) | null = null
  const provider: EditorSyntaxProvider = {
    operation: createEditorStructuralOperation(() => ({
      ...createEmptySyntaxRuntime(),
      foldingSupport: 'supported' as const,
      analyze: async (read: DocumentRead) => {
        analyzed = read
        return createEmptySyntaxResult()
      },
      subscribeResults: (listener: (read: DocumentRead, result: EditorSyntaxResult) => void) => {
        publish = listener
        return () => undefined
      },
      queryRange,
    })),
  }
  return {
    provider,
    analyzed: () => vi.waitFor(() => expect(analyzed).not.toBeNull()),
    publishComplete: () => publish!(analyzed!, createEmptySyntaxResult()),
  }
}

type SyntaxView = ReturnType<typeof createView>

/** Typing, as the editor applies it: the change, then the painted tokens moved through it. */
function typeText(view: SyntaxView, buffer: EditorTextBuffer, edit: TextEdit) {
  const previous = buffer.getTextSnapshot()
  const change = createEditorBufferSession(buffer).applyEdits([edit])
  view.syntax.acceptChange(change)
  view.syntax.setTokens(projectTokensThroughEdit(view.syntax.tokens, edit, previous), false)
  return change
}

/** Grows the frame from the document start, one more range beside the last at each step. */
async function growFrame(view: SyntaxView, ends: readonly number[]) {
  for (const endIndex of ends) {
    view.setRange({ startIndex: 0, endIndex })
    view.syntax.refreshVisibleRange(1, { delayMs: 0 })
    await vi.waitFor(() =>
      expect(view.syntax.tokens.toTokens().some((token) => token.start >= endIndex - 20)).toBe(
        true,
      ),
    )
  }
  // A request loop keeps asking; give it time to show on the call list.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Moves the frame to each range in turn and waits for an answer to paint inside it. */
async function moveFrame(view: SyntaxView, starts: readonly number[]) {
  for (const startIndex of starts) {
    const endIndex = startIndex + 20
    view.setRange({ startIndex, endIndex })
    view.syntax.refreshVisibleRange(1, { delayMs: 0 })
    await vi.waitFor(() =>
      expect(
        view.syntax.tokens
          .toTokens()
          .some(
            (token) =>
              token.style.color === 'range' && startIndex <= token.start && token.start < endIndex,
          ),
      ).toBe(true),
    )
  }
}

function createView(
  buffer: EditorTextBuffer,
  analysis: EditorDocumentAnalysis,
  provider: EditorSyntaxProvider,
  initialRange: EditorSyntaxRange,
  highlighter?: EditorHighlighterProvider,
) {
  const session = createEditorBufferSession(buffer)
  const pluginHost = new EditorPluginHost([
    {
      activate: (context) => {
        const syntax = context.registerSyntaxProvider(provider)
        return highlighter ? [syntax, context.registerHighlighter(highlighter)] : syntax
      },
    },
  ])
  let range = initialRange
  let adoptions = 0
  let folds = 0
  const publish = () =>
    syntax.setDisplayDemand({ kind: 'frame', snapshot: buffer.getTextSnapshot(), ranges: [range] })
  const syntax = new EditorSyntaxController({
    pluginHost,
    getSession: () => session,
    getDocumentVersion: () => 1,
    getTextVersion: () => 0,
    getDocumentId: () => 'retention.ts',
    getCurrentSessionDocumentId: () => 'retention.ts',
    getLanguageId: () => 'typescript',
    getVisibleSyntaxRange: () => range,
    adoptTokens: () => {
      adoptions++
      publish()
    },
    setSyntaxFolds: (next) => {
      folds = next.length
    },
    clearSyntaxFolds: () => {
      folds = 0
    },
    notifyViewUpdate: publish,
    notifyChange: () => undefined,
    notifyThemeChanged: () => undefined,
  })
  syntax.startDocument({
    analysis,
    documentId: 'retention.ts',
    languageId: 'typescript',
    snapshot: session.getSnapshot(),
    textSnapshot: session.getTextSnapshot(),
  })
  publish()
  return {
    syntax,
    publish,
    setRange: (next: EditorSyntaxRange) => {
      range = next
      publish()
    },
    adoptions: () => adoptions,
    folds: () => folds,
    dispose: () => {
      syntax.dispose()
      pluginHost.dispose()
    },
  }
}

describe('syntax state around optional range answers', () => {
  // The document's brackets: an answer reports the ones inside the range it was asked for.
  const documentBrackets: readonly BracketInfo[] = [
    { index: 2, char: '(', depth: 1 },
    { index: 42, char: ')', depth: 0 },
  ]
  const green = (start: number) => ({ start, end: start + 1, style: { color: 'green' } })
  const answer = (
    range: EditorSyntaxRange,
    extra: Partial<EditorSyntaxResult> = {},
  ): EditorSyntaxResult => ({
    ...createEmptySyntaxResult({ requestedRanges: [range] }),
    tokens: EditorTokenStore.fromTokens([green(range.startIndex)]),
    brackets: documentBrackets.filter(
      (bracket) => range.startIndex <= bracket.index && bracket.index < range.endIndex,
    ),
    ...extra,
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  it.each([
    ['a look-ahead', 250],
    ['a background tile', 70_000],
  ] as const)('keeps syntax ready when %s fails', async (_name, lines) => {
    const buffer = createEditorTextBuffer('x\n'.repeat(lines))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'optional-failure' })
    const query = vi.fn(async (range: EditorSyntaxRange) => {
      if (range.endIndex - range.startIndex > 60) throw new Error('optional request failed')
      return answer(range)
    })
    const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      // A large document warms a tile on its own; a small one is asked for a look-ahead.
      if (lines < 1000)
        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 300 }, { delayMs: 0 })
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
      await settle()
      expect(view.syntax.status).toBe('ready')
      expect(view.syntax.initialHighlightStatus).toBe('painted')
      expect(view.syntax.brackets.map((bracket) => bracket.index)).toEqual([2])
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })

  it('does not keep off-screen answers for folds that span the frame', async () => {
    const buffer = createEditorTextBuffer('x\n'.repeat(2500))
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'spanning-folds' })
    let fold = 0
    // Every answer reports its own fold over the whole frame, as no real one does.
    const query = vi.fn(async (range: EditorSyntaxRange) =>
      answer(range, {
        folds: [
          { startIndex: 0, endIndex: 4000 + fold++, startLine: 0, endLine: 2000, type: 'scope' },
        ],
      }),
    )
    const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
    try {
      view.syntax.refresh(1, null, { delayMs: 0 })
      await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      for (let step = 0; step < 40; step++) {
        const range = { startIndex: 1000 + step * 50, endIndex: 1040 + step * 50 }
        view.syntax.prefetchVisibleRange(1, range, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(step + 2))
      }
      await settle()
      view.publish()
      // Only the frame's own answer is retained; off-screen look-aheads do not hijack copy ownership.
      expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBe(1)
    } finally {
      view.dispose()
      analysis.dispose()
    }
  })
})
