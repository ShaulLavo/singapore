import { describe, expect, it, vi } from 'vitest'
import {
  createEditorBufferSession,
  createEditorTextBuffer,
  type EditorTextBuffer,
} from '../src/documentSession'
import {
  createEditorDocumentAnalysis,
  retainedSyntaxCanWarm,
  type EditorDocumentAnalysis,
} from '../src/editor/documentAnalysis'
import { EditorSyntaxController } from '../src/editor/syntaxController'
import { createEditorStructuralOperation } from '../src/editor/syntaxOperations'
import { projectTokensThroughEdit } from '../src/editor/tokenProjection'
import { EditorPluginHost } from '../src/plugins'
import type { EditorHighlighterProvider } from '../src/syntax/highlighter'
import {
  createEmptySyntaxResult,
  type EditorSyntaxCapture,
  type EditorSyntaxInjection,
  type EditorSyntaxProvider,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
  type FoldRange,
} from '../src/syntax/session'
import { EditorTokenStore } from '../src/syntax/tokenStore'
import type { TextEdit } from '../src/tokens'
import { createEmptySyntaxRuntime } from './factories/syntaxRuntime'

const firstFrame: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }

const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function answerFor(
  range: EditorSyntaxRange,
  extra: Partial<EditorSyntaxResult> = {},
): EditorSyntaxResult {
  return {
    ...createEmptySyntaxResult({ requestedRanges: [range] }),
    tokens: EditorTokenStore.fromTokens([
      { start: range.startIndex, end: range.startIndex + 1, style: { color: 'green' } },
    ]),
    brackets: [{ index: range.startIndex + 2, char: '(', depth: 1 }],
    ...extra,
  }
}

function structuralProvider(
  queryRange: (range: EditorSyntaxRange) => Promise<EditorSyntaxResult>,
  overrides: Partial<ReturnType<typeof createEmptySyntaxRuntime>> = {},
): EditorSyntaxProvider {
  return {
    operation: createEditorStructuralOperation(() => ({
      ...createEmptySyntaxRuntime(),
      foldingSupport: 'supported' as const,
      queryRange,
      ...overrides,
    })),
  }
}

function createView(
  buffer: EditorTextBuffer,
  analysis: EditorDocumentAnalysis,
  provider: EditorSyntaxProvider,
  initialRange: EditorSyntaxRange,
  options: {
    readonly highlighter?: EditorHighlighterProvider
    readonly mountedRange?: () => EditorSyntaxRange | null
    readonly needsCaptures?: boolean
  } = {},
) {
  const session = createEditorBufferSession(buffer)
  const pluginHost = new EditorPluginHost([
    {
      activate: (context) => {
        const syntax = context.registerSyntaxProvider(provider)
        return options.highlighter
          ? [syntax, context.registerHighlighter(options.highlighter)]
          : syntax
      },
    },
  ])
  let range = initialRange
  let folds: readonly FoldRange[] = []
  let captures: readonly EditorSyntaxCapture[] = []
  let records: EditorSyntaxResult['records'] = undefined
  let textVersion = 0
  const publish = () =>
    syntax.setDisplayDemand({ kind: 'frame', snapshot: buffer.getTextSnapshot(), ranges: [range] })
  const syntax = new EditorSyntaxController({
    pluginHost,
    getSession: () => session,
    getDocumentVersion: () => 1,
    getTextVersion: () => textVersion,
    getDocumentId: () => 'readiness.ts',
    getCurrentSessionDocumentId: () => 'readiness.ts',
    getLanguageId: () => 'typescript',
    getVisibleSyntaxRange: () => range,
    getMountedSyntaxRange: options.mountedRange,
    adoptTokens: () => publish(),
    setSyntaxFolds: (next) => {
      folds = next
    },
    clearSyntaxFolds: () => {
      folds = []
    },
    setSyntaxCaptures: (nextCaptures, nextRecords) => {
      captures = nextCaptures
      records = nextRecords
    },
    needsSyntaxCaptures: () => options.needsCaptures ?? false,
    notifyViewUpdate: publish,
    notifyChange: () => undefined,
    notifyThemeChanged: () => undefined,
  })
  syntax.startDocument({
    analysis,
    documentId: 'readiness.ts',
    languageId: 'typescript',
    snapshot: session.getSnapshot(),
    textSnapshot: session.getTextSnapshot(),
  })
  publish()
  return {
    syntax,
    session,
    publish,
    setRange: (next: EditorSyntaxRange) => {
      range = next
      publish()
    },
    bumpTextVersion: () => {
      textVersion += 1
    },
    folds: () => folds,
    captures: () => captures,
    records: () => records,
    dispose: () => {
      syntax.dispose()
      pluginHost.dispose()
    },
  }
}

function typeText(view: ReturnType<typeof createView>, buffer: EditorTextBuffer, edit: TextEdit) {
  const previous = buffer.getTextSnapshot()
  const change = createEditorBufferSession(buffer).applyEdits([edit])
  view.bumpTextVersion()
  view.syntax.acceptChange(change)
  view.syntax.setTokens(projectTokensThroughEdit(view.syntax.tokens, edit, previous), false)
  return change
}

describe('viewport syntax readiness state machine (#169)', () => {
  describe('F1 — atomic scope composition across strips', () => {
    it('composes brackets, folds, and injections across partially covered viewport strips', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f1' })
      const injectionA: EditorSyntaxInjection = {
        parentLanguageId: 'typescript',
        languageId: 'jsdoc',
        startIndex: 4,
        endIndex: 10,
      }
      const injectionB: EditorSyntaxInjection = {
        parentLanguageId: 'typescript',
        languageId: 'regex',
        startIndex: 44,
        endIndex: 50,
      }
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          injections: range.startIndex === 0 ? [injectionA] : [injectionB],
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 40,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2])

        view.setRange({ startIndex: 20, endIndex: 60 })
        expect(view.syntax.status).toBe('loading')
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2, 42])
        expect(view.syntax.injections).toEqual([injectionA, injectionB])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('marks composed viewport degraded when any covering strip is degraded', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f1-degraded' })
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          degraded:
            range.startIndex >= 40
              ? { kind: 'optional-phase-failed', phase: 'folds', message: 'degraded strip' }
              : null,
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 40,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        expect(view.syntax.status).toBe('degraded')
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2, 42])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('requests a single authoritative viewport query for records-bearing providers on overlapping scroll', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f1-records' })
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 40,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(Array.from(view.records()?.data ?? [])).toEqual([0, 40])

        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        expect(query.mock.calls.at(-1)?.[0]).toEqual({ startIndex: 20, endIndex: 60 })
        expect(Array.from(view.records()?.data ?? [])).toEqual([20, 60])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('F2a & F2b — late look-ahead isolation and boundary splitting', () => {
    it('does not let a late look-ahead overwrite accepted viewport tokens or copy store, while splitting boundary tokens', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f2a' })
      const gate = Promise.withResolvers<void>()
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.endIndex - range.startIndex > 60) {
          await gate.promise
          return answerFor(range, {
            tokens: EditorTokenStore.fromTokens([
              { start: 30, end: 31, style: { color: 'red' } },
              { start: 45, end: 55, style: { color: 'blue' } },
            ]),
          })
        }
        return answerFor(range, {
          tokens: EditorTokenStore.fromTokens([
            { start: 30, end: 31, style: { color: 'green' } },
            { start: 45, end: 50, style: { color: 'green' } },
          ]),
        })
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 20,
        endIndex: 50,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 200 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        gate.resolve()
        await settle()

        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.tokens.toTokens()).toContainEqual({
          start: 30,
          end: 31,
          style: { color: 'green' },
        })
        expect(view.syntax.tokens.toTokens()).toContainEqual({
          start: 45,
          end: 50,
          style: { color: 'green' },
        })
        expect(view.syntax.tokens.toTokens()).toContainEqual({
          start: 50,
          end: 55,
          style: { color: 'blue' },
        })
        expect(view.syntax.copyTokens.toTokens()).toContainEqual({
          start: 30,
          end: 31,
          style: { color: 'green' },
        })
        expect(view.syntax.copyTokens.toTokens().some((t) => t.style.color === 'red')).toBe(false)
      } finally {
        gate.resolve()
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('F3 — terminal outcomes for unavailable and cancelled viewports', () => {
    it('settles to degraded on range-unavailable instead of staying loading forever, and recovers on scroll', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3' })
      let unavailable = false
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        unavailable
          ? createEmptySyntaxResult({
              requestedRanges: [range],
              degraded: { kind: 'range-unavailable', message: 'test' },
            })
          : answerFor(range),
      )
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        unavailable = true
        view.setRange({ startIndex: 300, endIndex: 340 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        await settle(80)

        expect(view.syntax.status).toBe('degraded')
        expect(view.syntax.renderDataReady).toBe(true)
        expect(query).toHaveBeenCalledTimes(2)
        expect(view.syntax.brackets).toEqual([])

        // Scrolling elsewhere retries and recovers cleanly.
        unavailable = false
        view.setRange({ startIndex: 100, endIndex: 140 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([102])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('settles empty [0, 0) viewport on range-unavailable without looping', async () => {
      const buffer = createEditorTextBuffer('')
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-empty' })
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        createEmptySyntaxResult({
          requestedRanges: [range],
          degraded: { kind: 'range-unavailable', message: 'empty unavailable' },
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 0,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        await settle(80)
        expect(view.syntax.initialHighlightStatus).toBe('degraded')
        expect(view.syntax.renderDataReady).toBe(true)
        expect(query).toHaveBeenCalledTimes(1)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('does not downgrade accepted coverage when a held visible query fails after prefetch covered the viewport', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-prefetch-wins' })
      const heldPrefetch = Promise.withResolvers<EditorSyntaxResult>()
      const heldVisible = Promise.withResolvers<EditorSyntaxResult>()
      const query = vi.fn((range: EditorSyntaxRange) => {
        if (range.startIndex === 280 && range.endIndex === 360) return heldPrefetch.promise
        if (range.startIndex === 300 && range.endIndex === 340) return heldVisible.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Start a prefetch covering [280, 360], then scroll into [300, 340] while it is in flight.
        view.syntax.prefetchVisibleRange(1, { startIndex: 280, endIndex: 360 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))

        view.setRange({ startIndex: 300, endIndex: 340 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
        expect(view.syntax.status).toBe('loading')

        // Prefetch lands first and settles the viewport to ready.
        heldPrefetch.resolve(
          answerFor(
            { startIndex: 280, endIndex: 360 },
            { brackets: [{ index: 310, char: '{', depth: 0 }] },
          ),
        )
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([310])

        // The late held visible query returns range-unavailable: must NOT downgrade ready viewport.
        heldVisible.resolve(
          createEmptySyntaxResult({
            requestedRanges: [{ startIndex: 300, endIndex: 340 }],
            degraded: { kind: 'range-unavailable', message: 'late' },
          }),
        )
        await settle(60)
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([310])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('settles failed authoritative Markdown records query cleanly without looping', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-records-fail' })
      let failAuth = false
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (failAuth) {
          return createEmptySyntaxResult({
            requestedRanges: [range],
            degraded: { kind: 'range-unavailable', message: 'records unavailable' },
          })
        }
        return answerFor(range, {
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        })
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 40,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        failAuth = true
        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        await settle(80)
        expect(query).toHaveBeenCalledTimes(2)
        expect(view.syntax.renderDataReady).toBe(true)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('F4 — bracket & injection freshness on edit', () => {
    it('immediately clears brackets and injections on acceptChange while reanalysis is held', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f4' })
      let hold = false
      const injection: EditorSyntaxInjection = {
        parentLanguageId: 'typescript',
        languageId: 'jsdoc',
        startIndex: 4,
        endIndex: 10,
      }
      const query = vi.fn((range: EditorSyntaxRange) =>
        hold
          ? new Promise<EditorSyntaxResult>(() => undefined)
          : Promise.resolve(answerFor(range, { injections: [injection] })),
      )
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2])
        expect(view.syntax.injections).toEqual([injection])

        hold = true
        const change = typeText(view, buffer, { from: 0, to: 0, text: 'z' })
        // Synchronously cleared before any async tick!
        expect(view.syntax.brackets).toEqual([])
        expect(view.syntax.injections).toEqual([])
        expect(view.syntax.status).toBe('loading')

        view.syntax.refresh(1, change, { delayMs: 0 })
        await settle(60)
        expect(view.syntax.brackets).toEqual([])
        expect(view.syntax.injections).toEqual([])
        expect(view.syntax.status).toBe('loading')
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('F5 — bounded retention, warm copy isolation, and token-only bootstrap', () => {
    it('does not let an off-screen warm answer overwrite viewport copyTokens', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250_000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-warm-copy' })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 512,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.copyTokens.startAt(0)).toBe(0)

        await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2))
        await settle(80)

        // Viewport copy tokens must remain intact (not replaced by warm tile [120_000, 240_000]).
        expect(view.syntax.copyTokens.startAt(0)).toBe(0)
        expect(retainedSyntaxCanWarm(Reflect.get(view.syntax, 'retainedSyntax'))).toBe(false)
        expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBe(1)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('bounds 40 overlapping and 40 staggered look-ahead answers cleanly', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(2500))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-prefetch-bound' })
      let foldId = 0
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          folds: [
            {
              startIndex: 0,
              endIndex: 4000 + foldId++,
              startLine: 0,
              endLine: 2000,
              type: 'scope',
            },
          ],
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 100,
        endIndex: 140,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        // 40 look-ahead answers each overlapping 1 char of the viewport with distinct folds.
        for (let step = 0; step < 40; step++) {
          const range = { startIndex: 139, endIndex: 200 + step * 50 }
          view.syntax.prefetchVisibleRange(1, range, { delayMs: 0 })
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(step + 2))
        }
        await settle()
        view.publish()
        expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBeLessThanOrEqual(2)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('never reports ready on a token-only partial bootstrap answer', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-bootstrap' })
      const query = vi.fn(async (range: EditorSyntaxRange) => ({
        ...createEmptySyntaxResult({ requestedRanges: [range] }),
        tokens: EditorTokenStore.fromTokens([
          { start: range.startIndex, end: range.startIndex + 1, style: { color: 'green' } },
        ]),
        projection: {
          ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
          analysis: { kind: 'partial' as const, coveredRange: { startIndex: 0, endIndex: 100 } },
        },
      }))
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
        await settle()
        expect(view.syntax.status).toBe('loading')
        expect(view.syntax.brackets).toEqual([])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('bounds 40 staggered, 40 disjoint, and complete-to-partial prefetch sequences without losing settled viewport strips', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(2500))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-prefetch-sequences' })
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.startIndex >= 900) {
          return {
            ...answerFor(range),
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: {
                kind: 'partial' as const,
                coveredRange: { startIndex: 0, endIndex: 1500 },
              },
            },
          }
        }
        return answerFor(range)
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 50,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // 40 staggered [0, 101)..[0, 140) prefetches.
        for (let step = 0; step < 40; step++) {
          view.syntax.prefetchVisibleRange(
            1,
            { startIndex: 0, endIndex: 101 + step },
            { delayMs: 0 },
          )
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(step + 2))
        }
        await settle()
        view.publish()
        expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBeLessThanOrEqual(2)

        // 40 disjoint off-screen [200, 210).. prefetches.
        const beforeDisjoint = query.mock.calls.length
        for (let step = 0; step < 40; step++) {
          view.syntax.prefetchVisibleRange(
            1,
            { startIndex: 200 + step * 10, endIndex: 205 + step * 10 },
            { delayMs: 0 },
          )
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(beforeDisjoint + step + 1))
        }
        await settle()
        view.publish()
        expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBeLessThanOrEqual(2)

        // Complete prefetch followed by disjoint partial prefetch.
        const beforePartial = query.mock.calls.length
        view.syntax.prefetchVisibleRange(1, { startIndex: 950, endIndex: 990 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(beforePartial + 1))
        await settle()
        view.publish()
        expect(analysis.inspectRetention().entries[0]!.cachedRangeCount).toBeLessThanOrEqual(2)
        // Settled viewport strip [0, 50) remains intact.
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.copyTokens.startAt(0)).toBe(0)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('promotes warm tile copy eligibility when scrolled onto it', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250_000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-warm-promote' })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      // Create a view without frame display-demand trimming so the warm tile remains cached.
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(structuralProvider(query)) },
      ])
      let range: EditorSyntaxRange = { startIndex: 0, endIndex: 512 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getDocumentId: () => 'warm-promote.ts',
        getCurrentSessionDocumentId: () => 'warm-promote.ts',
        getLanguageId: () => 'typescript',
        getVisibleSyntaxRange: () => range,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      syntax.startDocument({
        analysis,
        documentId: 'warm-promote.ts',
        languageId: 'typescript',
        snapshot: session.getSnapshot(),
        textSnapshot: session.getTextSnapshot(),
      })
      try {
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        // Wait for the first warm tile [120_000, 240_000) to arrive.
        await vi.waitFor(() =>
          expect(query.mock.calls.some(([r]) => r.startIndex === 120_000)).toBe(true),
        )
        await settle()
        // Warm tile must NOT have entered copyTokens while off-screen.
        expect(syntax.copyTokens.toTokens().some((t) => t.start === 120_000)).toBe(false)

        // Scroll onto [120_000, 120_512): cache hit promotes copy eligibility without re-querying!
        const callsBeforeScroll = query.mock.calls.length
        range = { startIndex: 120_000, endIndex: 120_512 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        expect(syntax.status).toBe('ready')
        expect(query.mock.calls.length).toBe(callsBeforeScroll)
        expect(syntax.copyTokens.toTokens().some((t) => t.start === 120_000)).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('does not report ready or settle initialHighlightStatus on firstRows paint', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(10_000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f5-first-rows' })
      const heldVisible = Promise.withResolvers<EditorSyntaxResult>()
      const query = vi.fn((range: EditorSyntaxRange) => {
        if (range.endIndex === 10_000) return heldVisible.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 0, endIndex: 10_000 },
        { mountedRange: () => ({ startIndex: 0, endIndex: 200 }) },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        // firstRows [0, 200) lands and paints tokens while full visible [0, 10_000) is still held.
        await vi.waitFor(() => expect(view.syntax.tokens.length).toBeGreaterThan(0))
        expect(view.syntax.status).toBe('loading')
        expect(view.syntax.initialHighlightStatus).toBe('loading')
        expect(Reflect.get(view.syntax, 'rangeCopyOwner')).not.toBeNull()

        heldVisible.resolve(answerFor({ startIndex: 0, endIndex: 10_000 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.initialHighlightStatus).toBe('painted')
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('Additional state-machine edge cases (superseded islands, retries, terminal failures, F4 guards)', () => {
    it('prevents superseded middle-island brackets, folds, and injections from leaking into composed scope', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f1-island-leak' })
      const heldPrefetch = Promise.withResolvers<EditorSyntaxResult>()
      const heldMiddle = Promise.withResolvers<EditorSyntaxResult>()
      const query = vi.fn((range: EditorSyntaxRange) => {
        if (range.startIndex === 0 && range.endIndex === 100) return heldPrefetch.promise
        if (range.startIndex === 30 && range.endIndex === 70) return heldMiddle.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 200,
        endIndex: 220,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Start a wide look-ahead [0, 100) (held), then move viewport to [20, 80) and ask for [30, 70).
        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))

        view.setRange({ startIndex: 20, endIndex: 80 })
        view.syntax.refreshVisibleRange(1, { range: { startIndex: 30, endIndex: 70 }, delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))

        // Wide [0, 100) lands first with a bracket, fold, and CSS injection inside [30, 70).
        heldPrefetch.resolve(
          answerFor(
            { startIndex: 0, endIndex: 100 },
            {
              brackets: [
                { index: 10, char: '{', depth: 1 },
                { index: 50, char: '{', depth: 1 },
                { index: 90, char: '}', depth: 1 },
              ],
              folds: [
                { startIndex: 5, endIndex: 20, startLine: 2, endLine: 10, type: 'outer' },
                { startIndex: 35, endIndex: 65, startLine: 17, endLine: 32, type: 'stale-island' },
              ],
              injections: [
                { parentLanguageId: 'html', languageId: 'css', startIndex: 40, endIndex: 60 },
                { parentLanguageId: 'html', languageId: 'js', startIndex: 80, endIndex: 95 },
              ],
            },
          ),
        )
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Authoritative visible [30, 70) lands second, superseding the middle island of [0, 100)
        // while [0, 30) and [70, 100) remain owned and intersect viewport [20, 80)!
        heldMiddle.resolve(
          answerFor(
            { startIndex: 30, endIndex: 70 },
            {
              brackets: [{ index: 55, char: '[', depth: 1 }],
              folds: [
                { startIndex: 40, endIndex: 60, startLine: 20, endLine: 30, type: 'fresh-island' },
              ],
              injections: [],
            },
          ),
        )
        await vi.waitFor(() =>
          expect(view.syntax.brackets.map((b) => b.index)).toEqual([10, 55, 90]),
        )

        // Move viewport to [0, 100): composed from [0, 30) + [30, 70) + [70, 100) with ZERO island leak!
        view.setRange({ startIndex: 0, endIndex: 100 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([10, 55, 90])
        expect(view.folds().map((f) => f.type)).toEqual(['outer', 'fresh-island'])
        expect(view.syntax.injections.map((inj) => inj.languageId)).toEqual(['js'])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('waits for second missing strip before settling degraded when first strip is range-unavailable', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-two-strips' })
      const heldRight = Promise.withResolvers<EditorSyntaxResult>()
      const query = vi.fn((range: EditorSyntaxRange) => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return Promise.resolve(
            createEmptySyntaxResult({
              requestedRanges: [range],
              degraded: { kind: 'range-unavailable', message: 'left unavailable' },
            }),
          )
        }
        if (range.startIndex === 60 && range.endIndex === 80) return heldRight.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 20,
        endIndex: 60,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Expand viewport on BOTH sides so [0, 20) and [60, 80) are missing.
        view.setRange({ startIndex: 0, endIndex: 80 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        // [0, 20) returns range-unavailable immediately, triggering query for [60, 80) while staying loading!
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
        expect(view.syntax.status).toBe('loading')

        heldRight.resolve(answerFor({ startIndex: 60, endIndex: 80 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.syntax.renderDataReady).toBe(true)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('recovers via explicit refresh() on the same text after base budget cancellation and after thrown base failure', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-base-retry' })
      let attempt = 0
      const provider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => {
            attempt += 1
            if (attempt === 1) {
              return {
                ...createEmptySyntaxResult(),
                projection: {
                  ...createEmptySyntaxResult().projection,
                  analysis: {
                    kind: 'cancelled' as const,
                    coveredRange: { startIndex: 0, endIndex: 0 },
                    reason: 'budget' as const,
                    elapsedMs: 25_000,
                    budgetMs: 20_000,
                  },
                },
              }
            }
            if (attempt === 2) throw new Error('transient parse error')
            return createEmptySyntaxResult()
          },
          queryRange: async (range: EditorSyntaxRange) => answerFor(range),
        })),
      }
      const view = createView(buffer, analysis, provider, firstFrame)
      try {
        // Attempt 1: budget-cancelled base settles to degraded without hanging.
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.syntax.renderDataReady).toBe(true)

        // Explicit retry on same text -> attempt 2 throws -> transitions to error.
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('error'))
        expect(view.syntax.fallbackFoldReason).toBe('structural-error')

        // Explicit retry on same text -> attempt 3 succeeds -> transitions to ready!
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(attempt).toBe(3)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('settles terminal partial background failure directly from base without looping', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f3-terminal-partial' })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult({
              degraded: { kind: 'request-failed', message: 'worker crashed in background' },
            }),
            projection: {
              ...createEmptySyntaxResult().projection,
              analysis: {
                kind: 'partial' as const,
                coveredRange: { startIndex: 0, endIndex: 50 },
              },
            },
          }),
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        await settle(80)
        expect(view.syntax.renderDataReady).toBe(true)
        expect(query).not.toHaveBeenCalled()
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('drops late pre-edit replies and rejections via the 4-tuple stale guard', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f4-stale-guard' })
      const heldPreEdit = Promise.withResolvers<EditorSyntaxResult>()
      let call = 0
      const query = vi.fn((range: EditorSyntaxRange) => {
        call += 1
        if (call === 2) return heldPreEdit.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Start a pre-edit visible query on a new range, then edit before it settles.
        view.setRange({ startIndex: 40, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(call).toBe(2))

        const change = typeText(view, buffer, { from: 0, to: 0, text: 'z' })
        expect(view.syntax.status).toBe('loading')

        // Reject the pre-edit promise after the edit: must NOT transition post-edit state to error!
        heldPreEdit.reject(new Error('pre-edit boom'))
        await settle(60)
        expect(view.syntax.status).toBe('loading')

        // Post-edit refresh succeeds cleanly.
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('ignores optional look-ahead rejection while a required viewport request is held', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(250))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'f2b-optional-reject' })
      const heldPrefetch = Promise.withResolvers<EditorSyntaxResult>()
      const heldVisible = Promise.withResolvers<EditorSyntaxResult>()
      const query = vi.fn((range: EditorSyntaxRange) => {
        if (range.startIndex === 100 && range.endIndex === 140) return heldPrefetch.promise
        if (range.startIndex === 200 && range.endIndex === 240) return heldVisible.promise
        return Promise.resolve(answerFor(range))
      })
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        view.syntax.prefetchVisibleRange(1, { startIndex: 100, endIndex: 140 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))

        view.setRange({ startIndex: 200, endIndex: 240 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))

        heldPrefetch.reject(new Error('optional look-ahead failed'))
        await settle(60)
        expect(view.syntax.status).toBe('loading')

        heldVisible.resolve(answerFor({ startIndex: 200, endIndex: 240 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })

  describe('Item 7 — sound incremental range cache promotion across edits', () => {
    it('promotes surviving cached ranges across multi-edit and multi-step R0 -> R1 -> R2 edits without calling queryRange', async () => {
      const initialText = `${'a\n'.repeat(20)}${'b\n'.repeat(100)}`
      const buffer = createEditorTextBuffer(initialText)
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'item7-promote' })
      let snapshotVersion = 0
      const baseAnalyze = vi.fn(async (read: { readonly text: { readonly length: number } }) => {
        const previousVersion = snapshotVersion
        snapshotVersion += 1
        const base = createEmptySyntaxResult({
          snapshot: {
            documentId: 'item7-promote',
            length: read.text.length,
            version: snapshotVersion,
          },
        })
        if (previousVersion === 0) return base
        // Edit happened near offset 0..20; invalidation covers only [0, 30).
        return {
          ...base,
          projection: {
            ...base.projection,
            invalidation: {
              baseSnapshotVersion: previousVersion,
              snapshotVersion,
              ranges: [{ startIndex: 0, endIndex: 30 }],
            },
          },
        }
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        const snap = buffer.getTextSnapshot()
        const foldStart = range.startIndex + 4
        const foldEnd = range.startIndex + 10
        return answerFor(range, {
          brackets: [{ index: range.startIndex + 2, char: '{', depth: 1 }],
          folds: [
            {
              startIndex: foldStart,
              endIndex: foldEnd,
              startLine: snap.lineAt(foldStart),
              endLine: snap.lineAt(foldEnd),
              type: 'block',
            },
          ],
          tokens: EditorTokenStore.fromTokens([
            {
              start: range.startIndex + 1,
              end: range.startIndex + 3,
              style: { color: 'promoted' },
            },
          ]),
        })
      })
      const provider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: baseAnalyze,
          queryRange: query,
        })),
      }
      // Viewport is far from the edits at offsets [100, 140).
      const view = createView(buffer, analysis, provider, { startIndex: 100, endIndex: 140 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(query).toHaveBeenCalledTimes(1)
        const initialLine = view.folds()[0]!.startLine

        // Step 1 (R0 -> R1): simultaneous multi-edit batch before offset 100 adding 2 newlines (+4 chars).
        const edits1: TextEdit[] = [
          { from: 0, to: 0, text: 'x\n' },
          { from: 4, to: 4, text: 'y\n' },
        ]
        const change1 = createEditorBufferSession(buffer).applyEdits(edits1)
        view.syntax.acceptChange(change1)
        // Step 2 (R1 -> R2): another line-breaking edit before the view even refreshes!
        const edits2: TextEdit[] = [{ from: 2, to: 2, text: 'z\n' }]
        const change2 = createEditorBufferSession(buffer).applyEdits(edits2)
        view.syntax.acceptChange(change2)

        // Move viewport to match shifted coordinates (+6 chars total, +3 lines).
        view.setRange({ startIndex: 106, endIndex: 146 })
        view.syntax.refresh(1, change2, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // ZERO additional queryRange IPC calls!
        expect(query).toHaveBeenCalledTimes(1)
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([108])
        expect(view.syntax.tokens.toTokens()).toEqual([
          { start: 107, end: 109, style: { color: 'promoted' } },
        ])
        expect(view.folds()[0]!.startIndex).toBe(110)
        expect(view.folds()[0]!.endIndex).toBe(116)
        expect(view.folds()[0]!.startLine).toBe(initialLine + 3)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('invalidates and re-queries when an edit touches a boundary-crossing token outside the range', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'item7-crossing-token' })
      let snapshotVersion = 0
      const querySpy = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          // Token starts at 90 (outside [100, 140), crossing into it!).
          tokens: EditorTokenStore.fromTokens([
            { start: 90, end: 110, style: { color: 'multiline' } },
          ]),
        }),
      )
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async (read) => {
            const previousVersion = snapshotVersion
            snapshotVersion += 1
            const base = createEmptySyntaxResult({
              snapshot: {
                documentId: 'item7-crossing-token',
                length: read.text.length,
                version: snapshotVersion,
              },
            })
            if (previousVersion === 0) return base
            return {
              ...base,
              projection: {
                ...base.projection,
                invalidation: {
                  baseSnapshotVersion: previousVersion,
                  snapshotVersion,
                  ranges: [{ startIndex: 80, endIndex: 92 }],
                },
              },
            }
          },
          queryRange: querySpy,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 100, endIndex: 140 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(querySpy).toHaveBeenCalledTimes(1)

        // Edit at offset 91 touches the boundary-crossing token [90, 110) even though it's before range start 100!
        const change = createEditorBufferSession(buffer).applyEdits([
          { from: 91, to: 91, text: '!' },
        ])
        view.syntax.acceptChange(change)
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(querySpy).toHaveBeenCalledTimes(2)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })
  })
})
