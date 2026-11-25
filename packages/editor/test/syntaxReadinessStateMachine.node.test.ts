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
import { compactSyntaxRangeTokens } from '../src/editor/syntaxRangeProjection'
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
    readonly onInitialPaint?: (event: { readonly phase: string; readonly status?: string }) => void
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
    onInitialPaint: options.onInitialPaint,
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
        // Publish intermediate R1 parse on the shared analysis BEFORE R2 arrives so TWO distinct
        // incremental steps (R0 -> R1 and R1 -> R2) are genuinely recorded and replayed!
        const probe = analysis.borrowStructural({
          languageId: 'typescript',
          includeHighlights: true,
          includeCaptures: false,
          syntaxMode: 'range',
          provider,
          configurationTag: [],
        })
        expect(probe).not.toBeNull()
        await probe!.refreshBase()
        expect(snapshotVersion).toBe(2)

        // Step 2 (R1 -> R2): another line-breaking edit before the view refreshes!
        const edits2: TextEdit[] = [{ from: 2, to: 2, text: 'z\n' }]
        const change2 = createEditorBufferSession(buffer).applyEdits(edits2)
        view.syntax.acceptChange(change2)

        // Move viewport to match shifted coordinates (+6 chars total, +3 lines).
        view.setRange({ startIndex: 106, endIndex: 146 })
        view.syntax.refresh(1, change2, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        probe!.dispose()

        // Both incremental steps published (v1 -> v2 -> v3), with ZERO additional queryRange calls!
        expect(snapshotVersion).toBe(3)
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

  describe('PR review regressions (edge cases & invariants)', () => {
    it('issues authoritative Markdown records query when prefetch bridges a multi-strip viewport', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(40))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'md-bridge' })
      const queried: EditorSyntaxRange[] = []
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        queried.push(range)
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

        // Case A: prefetch [0, 100) bridges [0, 40) and [40, 100). Scroll to [20, 60) ->
        // refreshVisibleRange must NOT get stuck in loading; it settles with authoritative records!
        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(queried.length).toBe(2))
        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(queried).toContainEqual({ startIndex: 20, endIndex: 60 })
        expect(view.records()?.data).toEqual(new Uint32Array([20, 60]))

        // Case B: disjoint prefetch [100, 160) -> scroll to [80, 120) spanning [0, 100) & [100, 160)
        // must issue a fresh authoritative provider query for [80, 120)!
        view.syntax.prefetchVisibleRange(1, { startIndex: 100, endIndex: 160 }, { delayMs: 0 })
        await vi.waitFor(() => expect(queried.length).toBe(4))
        view.setRange({ startIndex: 80, endIndex: 120 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(queried).toContainEqual({ startIndex: 80, endIndex: 120 })
        expect(view.records()?.data).toEqual(new Uint32Array([80, 120]))
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('keeps settled viewport ready when held base viewport query rejects after prefetch settles it', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(3000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'held-base-reject' })
      let rejectHeldVisible: ((err: Error) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        // firstRows [0, 20) resolves quickly; full visible [0, 5000) is held; prefetch settles [20, 5000)!
        if (range.endIndex === 20) return answerFor(range)
        if (range.startIndex === 0 && range.endIndex === 5000) {
          return new Promise<EditorSyntaxResult>((_resolve, reject) => {
            rejectHeldVisible = reject
          })
        }
        return answerFor(range)
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 0, endIndex: 5000 },
        { mountedRange: () => ({ startIndex: 0, endIndex: 20 }) },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(rejectHeldVisible).not.toBeNull())

        // Viewport moves onto [20, 5000) and prefetch settles it while base [0, 5000) query is still held.
        view.setRange({ startIndex: 20, endIndex: 5000 })
        view.syntax.prefetchVisibleRange(1, { startIndex: 20, endIndex: 6000 }, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Now reject the held base viewport query -> must NOT turn ready viewport into error!
        rejectHeldVisible!(new Error('late timeout'))
        await settle()
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.initialHighlightStatus).toBe('painted')
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('does not cache terminal partial range answers across explicit refresh recovery', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'terminal-partial-retry',
      })
      let healthy = false
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (!healthy) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'request-failed', message: 'bg failed' },
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          }
        }
        return answerFor(range)
      })
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(query).toHaveBeenCalledTimes(1)

        // Provider recovers; explicit refresh must re-query and NOT replay cached terminal partial.
        healthy = true
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(query).toHaveBeenCalledTimes(2)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('publishes newly intersecting folds when scrolling inside a fragmented single owner and honors viewport readiness with fallback folds', async () => {
      // Part A: visible [0, 5), then prefetch [0, 40) owns [5, 40) (fragmented single owner!).
      // Scrolling [5, 25) -> [10, 27) within that fragmented owner must publish newly intersecting foldB!
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'fragmented-scroll' })
      const foldA: FoldRange = {
        startIndex: 10,
        endIndex: 15,
        startLine: 5,
        endLine: 7,
        type: 'block',
      }
      const foldB: FoldRange = {
        startIndex: 25,
        endIndex: 28,
        startLine: 12,
        endLine: 14,
        type: 'block',
      }
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.startIndex === 0 && range.endIndex === 40) {
          return answerFor(range, { folds: [foldA, foldB] })
        }
        return answerFor(range, { folds: [] })
      })
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 5,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        view.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 40 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        // Scroll onto [5, 25) owned solely by the fragmented [0, 40) entry -> only foldA intersects.
        view.setRange({ startIndex: 5, endIndex: 25 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        expect(view.syntax.status).toBe('ready')
        expect(view.folds().map((f) => f.startIndex)).toEqual([10])

        // Scroll from [5, 25) to [10, 27) within the same fragmented owner -> foldB [25, 28) now intersects!
        view.setRange({ startIndex: 10, endIndex: 27 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        expect(view.folds().map((f) => f.startIndex)).toEqual([10, 25])
      } finally {
        view.dispose()
        analysis.dispose()
      }

      // Part B: provider with foldingSupport: 'unsupported' (usesFallbackFolds === true) must still
      // report 'loading' and renderDataReady === false after jumping to an uncached viewport.
      const analysis2 = createEditorDocumentAnalysis({
        buffer,
        documentId: 'fallback-fold-readiness',
      })
      let resolveJump: ((r: EditorSyntaxResult) => void) | null = null
      const query2 = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.startIndex >= 100) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveJump = resolve
          })
        }
        return answerFor(range)
      })
      const view2 = createView(
        buffer,
        analysis2,
        structuralProvider(query2, { foldingSupport: 'unsupported' }),
        firstFrame,
      )
      try {
        view2.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view2.syntax.status).toBe('ready'))
        expect(view2.syntax.usesFallbackFolds).toBe(true)

        view2.setRange({ startIndex: 100, endIndex: 120 })
        expect(view2.syntax.status).toBe('loading')
        expect(view2.syntax.renderDataReady).toBe(false)

        view2.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveJump).not.toBeNull())
        resolveJump!(answerFor({ startIndex: 100, endIndex: 120 }))
        await vi.waitFor(() => expect(view2.syntax.status).toBe('ready'))
        expect(view2.syntax.renderDataReady).toBe(true)
      } finally {
        view2.dispose()
        analysis2.dispose()
      }
    })

    it('does not let an off-screen partial prefetch settle initialHighlightStatus', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(3000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'partial-prefetch-init' })
      let resolveVisible: ((r: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.endIndex === 20) return answerFor(range)
        if (range.startIndex === 0 && range.endIndex === 5000) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveVisible = resolve
          })
        }
        return {
          ...answerFor(range),
          projection: {
            ...answerFor(range).projection,
            analysis: { kind: 'partial' as const, coveredRange: range },
          },
        }
      })
      const events: string[] = []
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 0, endIndex: 5000 },
        {
          mountedRange: () => ({ startIndex: 0, endIndex: 20 }),
          onInitialPaint: (event) => {
            if (event.phase === 'highlight-settled' && event.status) events.push(event.status)
          },
        },
      )
      try {
        view.syntax.notifyBaseTextPainted()
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveVisible).not.toBeNull())
        expect(view.syntax.initialHighlightStatus).toBe('loading')

        // Off-screen partial prefetch lands while visible query is still held.
        view.syntax.prefetchVisibleRange(1, { startIndex: 5200, endIndex: 5600 }, { delayMs: 0 })
        await settle()
        expect(view.syntax.initialHighlightStatus).toBe('loading')
        expect(events).toEqual([])

        resolveVisible!(answerFor({ startIndex: 0, endIndex: 5000 }))
        await vi.waitFor(() => expect(view.syntax.initialHighlightStatus).toBe('painted'))
        expect(events).toEqual(['painted'])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('preserves token ownership across fragmented edit promotion, exact cache lookup, and host setTokens', async () => {
      // 6A: Fragmented single-entry edit promotion clips to tokenOwnedRanges (no discarded prefetch resurrection).
      const buffer = createEditorTextBuffer('a\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'frag-promote' })
      let snapshotVersion = 0
      let call = 0
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        call += 1
        if (call === 1) {
          // Visible [100, 140) with green token at [102, 105).
          return answerFor(range, {
            tokens: EditorTokenStore.fromTokens([
              { start: 102, end: 105, style: { color: 'green' } },
            ]),
          })
        }
        // Prefetch [80, 180) returns BAD red token inside protected [100, 140) + blue token at [150, 155).
        return answerFor(range, {
          tokens: EditorTokenStore.fromTokens([
            { start: 102, end: 105, style: { color: 'bad-red' } },
            { start: 150, end: 155, style: { color: 'blue' } },
          ]),
        })
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async (read) => {
            const prev = snapshotVersion
            snapshotVersion += 1
            const base = createEmptySyntaxResult({
              snapshot: {
                documentId: 'frag-promote',
                length: read.text.length,
                version: snapshotVersion,
              },
            })
            if (prev === 0) return base
            return {
              ...base,
              projection: {
                ...base.projection,
                invalidation: {
                  baseSnapshotVersion: prev,
                  snapshotVersion,
                  ranges: [{ startIndex: 0, endIndex: 5 }],
                },
              },
            }
          },
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 100, endIndex: 140 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Prefetch [80, 180) gets fragmented around protected [100, 140): owns [80, 100) and [140, 180).
        view.syntax.prefetchVisibleRange(1, { startIndex: 80, endIndex: 180 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        // Move viewport to [145, 175) so [100, 140) is trimmed, leaving ONLY the fragmented [80, 180) entry!
        view.setRange({ startIndex: 145, endIndex: 175 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await settle()

        // Edit at offset 0 -> promotes the single fragmented [80, 180) entry!
        const change = createEditorBufferSession(buffer).applyEdits([{ from: 0, to: 0, text: 'z' }])
        view.syntax.acceptChange(change)
        view.setRange({ startIndex: 146, endIndex: 176 })
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Discarded bad-red token at [103, 106) MUST NOT reappear in tokens or copyTokens!
        expect(view.syntax.tokens.toTokens().some((t) => t.style.color === 'bad-red')).toBe(false)
        expect(view.syntax.copyTokens.toTokens().some((t) => t.style.color === 'bad-red')).toBe(
          false,
        )
      } finally {
        view.dispose()
        analysis.dispose()
      }

      // 6B: Retained cache prefers exact complete match [0, 40) over wider prefetch [0, 100).
      const analysis2 = createEditorDocumentAnalysis({ buffer, documentId: 'exact-beats-wide' })
      const query2 = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.endIndex === 40) {
          return answerFor(range, {
            tokens: EditorTokenStore.fromTokens([{ start: 5, end: 10, style: { color: 'exact' } }]),
          })
        }
        return answerFor(range, {
          tokens: EditorTokenStore.fromTokens([
            { start: 5, end: 10, style: { color: 'wide-prefetch' } },
          ]),
        })
      })
      const view2 = createView(buffer, analysis2, structuralProvider(query2), {
        startIndex: 0,
        endIndex: 40,
      })
      try {
        view2.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view2.syntax.status).toBe('ready'))
        view2.syntax.prefetchVisibleRange(1, { startIndex: 0, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query2).toHaveBeenCalledTimes(2))
        await settle()

        // Explicit refresh must read exact [0, 40) ('exact'), NOT wider [0, 100) ('wide-prefetch').
        view2.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view2.syntax.status).toBe('ready'))
        expect(view2.syntax.tokens.toTokens().some((t) => t.style.color === 'exact')).toBe(true)
        expect(view2.syntax.tokens.toTokens().some((t) => t.style.color === 'wide-prefetch')).toBe(
          false,
        )
      } finally {
        view2.dispose()
        analysis2.dispose()
      }

      // 6C: Visible admission preserves host-installed setTokens external copy ownership.
      const analysis3 = createEditorDocumentAnalysis({ buffer, documentId: 'host-copy-owner' })
      const query3 = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          tokens: EditorTokenStore.fromTokens([{ start: 1, end: 4, style: { color: 'syntax' } }]),
        }),
      )
      const view3 = createView(buffer, analysis3, structuralProvider(query3), firstFrame)
      try {
        const hostTokens = EditorTokenStore.fromTokens([
          { start: 0, end: 10, style: { color: 'host-owned' } },
        ])
        view3.syntax.setTokens(hostTokens)
        view3.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view3.syntax.status).toBe('ready'))
        expect(view3.syntax.copyTokens).toBe(hostTokens)
      } finally {
        view3.dispose()
        analysis3.dispose()
      }
    })

    it('keeps token palette bounded across prefetch evictions and clips tokens on compaction', async () => {
      // 7B: Direct compaction clipping check: retaining [45, 50) from token [45, 55) returns [45, 50).
      const store = EditorTokenStore.fromTokens([
        { start: 45, end: 55, style: { color: 'split' } },
        { start: 60, end: 70, style: { color: 'dropped' } },
      ])
      const compacted = compactSyntaxRangeTokens(store, [{ startIndex: 45, endIndex: 50 }])
      expect(compacted.toTokens()).toEqual([{ start: 45, end: 50, style: { color: 'split' } }])
      expect(compacted.styles).toHaveLength(1)

      // 7A: 40 prefetch evictions with fresh identical style objects keep palette bounded!
      const buffer = createEditorTextBuffer('x\n'.repeat(2000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'bounded-palette' })
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, {
          tokens: EditorTokenStore.fromTokens([
            { start: range.startIndex, end: range.startIndex + 2, style: { color: 'same-blue' } },
          ]),
        }),
      )
      const view = createView(buffer, analysis, structuralProvider(query), firstFrame)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        for (let step = 1; step <= 40; step += 1) {
          const startIndex = 100 + step * 30
          view.syntax.prefetchVisibleRange(
            1,
            { startIndex, endIndex: startIndex + 20 },
            { delayMs: 0 },
          )
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1 + step))
        }
        await settle()
        expect(view.syntax.tokens.styles.length).toBeLessThanOrEqual(2)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it.each(['rejection', 'range-unavailable'] as const)(
      'requests the moved viewport when an obsolete initial query settles via %s',
      async (mode) => {
        const buffer = createEditorTextBuffer('x\n'.repeat(200))
        const analysis = createEditorDocumentAnalysis({ buffer, documentId: `obsolete-${mode}` })
        let settleInitial: {
          resolve: (r: EditorSyntaxResult) => void
          reject: (e: Error) => void
        } | null = null
        const queried: EditorSyntaxRange[] = []
        const query = vi.fn(async (range: EditorSyntaxRange) => {
          queried.push(range)
          if (range.startIndex === 0 && range.endIndex === 20) {
            return new Promise<EditorSyntaxResult>((resolve, reject) => {
              settleInitial = { resolve, reject }
            })
          }
          return answerFor(range)
        })
        const view = createView(buffer, analysis, structuralProvider(query), {
          startIndex: 0,
          endIndex: 20,
        })
        try {
          view.syntax.refresh(1, null, { delayMs: 0 })
          await vi.waitFor(() => expect(settleInitial).not.toBeNull())

          // Move viewport to [60, 80) while initial parse/query is still loading.
          view.setRange({ startIndex: 60, endIndex: 80 })
          view.syntax.refreshVisibleRange(1, { delayMs: 0 })

          if (mode === 'rejection') {
            settleInitial!.reject(new Error('old viewport failed'))
          } else {
            settleInitial!.resolve({
              ...createEmptySyntaxResult({ requestedRanges: [{ startIndex: 0, endIndex: 20 }] }),
              degraded: { kind: 'range-unavailable', message: 'gone' },
            })
          }

          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
          expect(queried).toContainEqual({ startIndex: 60, endIndex: 80 })
        } finally {
          view.dispose()
          analysis.dispose()
        }
      },
    )

    it('settles initialHighlightStatus and renderDataReady independently of host copy ownership on complete, empty-host, and partial answers', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(100))

      // Part A: complete viewport answer directly from initialHighlightStatus === 'loading' with host tokens.
      const analysisA = createEditorDocumentAnalysis({ buffer, documentId: 'host-copy-complete' })
      const viewA = createView(
        buffer,
        analysisA,
        structuralProvider(async (range) =>
          answerFor(range, {
            tokens: EditorTokenStore.fromTokens([
              { start: 1, end: 4, style: { color: 'complete' } },
            ]),
          }),
        ),
        firstFrame,
      )
      try {
        const hostTokens = EditorTokenStore.fromTokens([
          { start: 0, end: 10, style: { color: 'host-copy' } },
        ])
        viewA.syntax.setTokens(hostTokens)
        expect(viewA.syntax.initialHighlightStatus).toBe('loading')
        viewA.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(viewA.syntax.status).toBe('ready'))
        expect(viewA.syntax.initialHighlightStatus).toBe('painted')
        expect(viewA.syntax.renderDataReady).toBe(true)
        expect(viewA.syntax.copyTokens).toBe(hostTokens)
      } finally {
        viewA.dispose()
        analysisA.dispose()
      }

      // Part B: explicitly empty host copy store keeps ownership (does not alias empty range store singleton).
      const analysisB = createEditorDocumentAnalysis({ buffer, documentId: 'host-copy-empty' })
      const viewB = createView(
        buffer,
        analysisB,
        structuralProvider(async (range) =>
          answerFor(range, {
            tokens: EditorTokenStore.fromTokens([{ start: 1, end: 4, style: { color: 'range' } }]),
          }),
        ),
        firstFrame,
      )
      try {
        viewB.syntax.setTokens(EditorTokenStore.empty())
        viewB.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(viewB.syntax.status).toBe('ready'))
        expect(viewB.syntax.initialHighlightStatus).toBe('painted')
        expect(viewB.syntax.renderDataReady).toBe(true)
        expect(viewB.syntax.copyTokens.length).toBe(0)
      } finally {
        viewB.dispose()
        analysisB.dispose()
      }

      // Part C: required non-terminal partial settles initialHighlightStatus without replacing host copyTokens.
      const analysisC = createEditorDocumentAnalysis({ buffer, documentId: 'host-copy-partial' })
      const viewC = createView(
        buffer,
        analysisC,
        structuralProvider(async (range) => ({
          ...answerFor(range, {
            tokens: EditorTokenStore.fromTokens([
              { start: 1, end: 4, style: { color: 'partial' } },
            ]),
          }),
          projection: {
            ...answerFor(range).projection,
            analysis: { kind: 'partial', coveredRange: range },
          },
        })),
        firstFrame,
      )
      try {
        const hostTokens = EditorTokenStore.fromTokens([
          { start: 0, end: 10, style: { color: 'host-copy' } },
        ])
        viewC.syntax.setTokens(hostTokens)
        viewC.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(viewC.syntax.initialHighlightStatus).toBe('painted'))
        expect(viewC.syntax.copyTokens).toBe(hostTokens)
      } finally {
        viewC.dispose()
        analysisC.dispose()
      }
    })

    it('never caches terminal partials via protectContributor and allows explicit refresh retry after a degraded prepared attachment', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'prepared-retry' })
      let healthy = false
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (!healthy) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'request-failed', message: 'degraded' },
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          }
        }
        return answerFor(range)
      })
      const provider = structuralProvider(query)
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      const preparedResult = await retained.queryRange(firstFrame)

      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getDocumentId: () => 'prepared-retry.ts',
        getCurrentSessionDocumentId: () => 'prepared-retry.ts',
        getLanguageId: () => 'typescript',
        getVisibleSyntaxRange: () => firstFrame,
        adoptTokens: () =>
          syntax.setDisplayDemand({
            kind: 'frame',
            snapshot: buffer.getTextSnapshot(),
            ranges: [firstFrame],
          }),
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () =>
          syntax.setDisplayDemand({
            kind: 'frame',
            snapshot: buffer.getTextSnapshot(),
            ranges: [firstFrame],
          }),
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: 'rt-retry',
          provider,
          configurationTag: [],
          session: retained,
          range: firstFrame,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(preparedResult),
          readyResult: preparedResult,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-retry.ts',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        syntax.setDisplayDemand({
          kind: 'frame',
          snapshot: buffer.getTextSnapshot(),
          ranges: [firstFrame],
        })
        expect(syntax.status).toBe('degraded')
        // protectContributor must NOT reinsert the terminal partial into the shared range cache!
        expect(analysis.inspectRetention().entries[0]?.cachedRangeCount).toBe(0)

        // Provider recovers -> explicit refresh must NOT be suppressed by #preparedStructuralContentVersion!
        healthy = true
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(query).toHaveBeenCalledTimes(2)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('keeps a prepared full-document-only provider ready across scrolling', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'prepared-full-only' })
      const fullResult = createEmptySyntaxResult({ requestedRanges: [firstFrame] })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => fullResult,
          // No queryRange: full-document-only provider!
        })),
      }
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      const readyResult = await retained.refresh(buffer.getTextSnapshot())
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let viewport: EditorSyntaxRange = firstFrame
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getDocumentId: () => 'prepared-full-only.ts',
        getCurrentSessionDocumentId: () => 'prepared-full-only.ts',
        getLanguageId: () => 'typescript',
        getVisibleSyntaxRange: () => viewport,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: 'rt-full',
          provider,
          configurationTag: [],
          session: retained,
          range: firstFrame,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(readyResult),
          readyResult,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-full-only.ts',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.status).toBe('ready')

        // Scrolling far away must stay 'ready' (full-document mode, NOT range mode!).
        viewport = { startIndex: 200, endIndex: 240 }
        expect(syntax.status).toBe('ready')
        expect(syntax.renderDataReady).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('does not publish a late off-screen prefetch as a full-document result if canQueryRange turns false mid-flight', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'late-prefetch-cap' })
      let allowRange = true
      let releasePrefetch: ((r: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.startIndex === 60) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            releasePrefetch = resolve
          })
        }
        return answerFor(range, { brackets: [{ index: 2, char: '(', depth: 1 }] })
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query, { canQueryRange: () => allowRange }),
        firstFrame,
      )
      try {
        const hostTokens = EditorTokenStore.fromTokens([
          { start: 0, end: 5, style: { color: 'host' } },
        ])
        view.syntax.setTokens(hostTokens)
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2])

        view.syntax.prefetchVisibleRange(1, { startIndex: 60, endIndex: 80 }, { delayMs: 0 })
        await vi.waitFor(() => expect(releasePrefetch).not.toBeNull())

        allowRange = false
        releasePrefetch!(
          answerFor(
            { startIndex: 60, endIndex: 80 },
            { brackets: [{ index: 62, char: ')', depth: 0 }] },
          ),
        )
        await settle()
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([2])
        expect(view.syntax.copyTokens).toBe(hostTokens)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('retries a full-document-only provider whose prepared result was complete but degraded on explicit refresh', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'full-degraded-retry' })
      let healthy = false
      const analyze = vi.fn(async (): Promise<EditorSyntaxResult> => {
        if (!healthy) {
          return {
            ...createEmptySyntaxResult(),
            degraded: { kind: 'request-failed', message: 'transient' },
          }
        }
        return createEmptySyntaxResult()
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze,
        })),
      }
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      const degradedResult = await retained.refresh(buffer.getTextSnapshot())
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getDocumentId: () => 'full-degraded-retry.ts',
        getCurrentSessionDocumentId: () => 'full-degraded-retry.ts',
        getLanguageId: () => 'typescript',
        getVisibleSyntaxRange: () => firstFrame,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: 'rt-full-degraded',
          provider,
          configurationTag: [],
          session: retained,
          range: firstFrame,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(degradedResult),
          readyResult: degradedResult,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'full-degraded-retry.ts',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.status).toBe('degraded')
        expect(analyze).toHaveBeenCalledTimes(1)

        healthy = true
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(analyze).toHaveBeenCalledTimes(2)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('settles from the base result when range capability turns false while firstRows is in flight', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(3000))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'lose-range-mid-first' })
      let allowRange = true
      let resolveFirstRows: ((r: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange) => {
        if (range.endIndex === 20) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveFirstRows = resolve
          })
        }
        return answerFor(range)
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query, { canQueryRange: () => allowRange }),
        { startIndex: 0, endIndex: 5000 },
        { mountedRange: () => ({ startIndex: 0, endIndex: 20 }) },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveFirstRows).not.toBeNull())

        allowRange = false
        resolveFirstRows!(answerFor({ startIndex: 0, endIndex: 20 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.initialHighlightStatus).toBe('painted')
        expect(view.syntax.renderDataReady).toBe(true)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('drops degraded ranges from the view cache on explicit retry even while viewing another healthy range', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'prune-degraded-retry' })
      let bHealthy = false
      const rangeA: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      const rangeB: EditorSyntaxRange = { startIndex: 100, endIndex: 120 }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 100 && !bHealthy) {
          return answerFor(range, {
            degraded: { kind: 'request-failed', message: 'degraded-B' },
          })
        }
        return answerFor(range)
      })
      const view = createView(buffer, analysis, structuralProvider(query), rangeA)
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Load degraded range B as prefetch while on A, then verify B is degraded before retry.
        view.syntax.prefetchVisibleRange(1, rangeB, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        // Provider recovers; explicit retry on A must prune degraded B from both shared and view cache.
        bHealthy = true
        view.syntax.refresh(1, null, { delayMs: 0 })
        await settle()

        // Scroll to B -> must freshly query B and settle 'ready' (NOT replay degraded B!).
        view.setRange(rangeB)
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(
          query.mock.calls.filter(([r]) => r.startIndex === 100).length,
        ).toBeGreaterThanOrEqual(2)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('settles to degraded when an authoritative Markdown records query over covered strips returns a terminal partial', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(40))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'md-terminal-partial' })
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 20 && range.endIndex === 60) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'request-failed', message: 'records-failed' },
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          }
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

        view.syntax.prefetchVisibleRange(1, { startIndex: 40, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))

        // Scroll to [20, 60) covered by [0, 40) U [40, 100) -> authoritative query returns terminal partial -> settles degraded!
        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.syntax.renderDataReady).toBe(true)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('does not mark an unqueried Markdown viewport degraded when an older overlapping query returns a terminal partial', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(20))
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'md-old-overlap-fail' })
      let resolveHeld: ((result: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 10 && range.endIndex === 30) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveHeld = resolve
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
        endIndex: 20,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Scroll to [10, 30) and hold the authoritative Markdown query in flight.
        view.setRange({ startIndex: 10, endIndex: 30 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveHeld).not.toBeNull())

        // Scroll further to [15, 35) before the held [10, 30) query fails with a terminal partial.
        view.setRange({ startIndex: 15, endIndex: 35 })
        resolveHeld!({
          ...createEmptySyntaxResult({ requestedRanges: [{ startIndex: 10, endIndex: 30 }] }),
          degraded: { kind: 'request-failed', message: 'stale-records-failed' },
          projection: {
            ...createEmptySyntaxResult({ requestedRanges: [{ startIndex: 10, endIndex: 30 }] })
              .projection,
            analysis: { kind: 'partial', coveredRange: { startIndex: 10, endIndex: 30 } },
          },
        })

        // [15, 35) was never queried by [10, 30); controller must query [15, 35) and settle ready.
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(query.mock.calls.some(([r]) => r.startIndex === 15 && r.endIndex === 35)).toBe(true)
        expect(view.records()?.data).toEqual(new Uint32Array([15, 35]))
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('clears degraded ranges from the shared cache on explicit retry of a healthy prepared view', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(200))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-shared-degraded-retry',
      })
      let bHealthy = false
      const rangeA: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      const rangeB: EditorSyntaxRange = { startIndex: 100, endIndex: 120 }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 100 && !bHealthy) {
          return answerFor(range, {
            degraded: { kind: 'request-failed', message: 'shared-degraded-B' },
          })
        }
        return answerFor(range)
      })
      const provider = structuralProvider(query)

      // Prepare range A and adopt it in prepared view A.
      const retainedA = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retainedA.refreshBase()
      const readyA = await retainedA.queryRange(rangeA)

      const sessionA = createEditorBufferSession(buffer)
      const pluginHostA = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRangeA = rangeA
      const syntaxA = new EditorSyntaxController({
        pluginHost: pluginHostA,
        getSession: () => sessionA,
        getDocumentId: () => 'prepared-shared-degraded-retry',
        getCurrentSessionDocumentId: () => 'prepared-shared-degraded-retry',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRangeA,
        getMountedSyntaxRange: () => currentRangeA,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: retainedA.runtimeSessionId,
          provider,
          configurationTag: [],
          session: retainedA,
          range: rangeA,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(readyA),
          readyResult: readyA,
          dispose: () => retainedA.dispose(),
        },
      }
      // Second view B retains degraded range B in the shared StructuralEntry cache.
      const viewB = createView(buffer, analysis, provider, rangeB)
      try {
        syntaxA.startDocument(
          {
            analysis,
            documentId: 'prepared-shared-degraded-retry',
            languageId: 'typescript',
            snapshot: sessionA.getSnapshot(),
            textSnapshot: sessionA.getTextSnapshot(),
          },
          prepared,
        )
        syntaxA.adoptPreparedReadyResults(prepared)
        expect(syntaxA.status).toBe('ready')

        viewB.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(viewB.syntax.status).toBe('degraded'))
        expect(query.mock.calls.filter(([r]) => r.startIndex === 100)).toHaveLength(1)

        // Provider recovers; explicit retry on prepared view A must clear degraded range B from shared cache.
        bHealthy = true
        syntaxA.refresh(1, null, { delayMs: 0 })

        currentRangeA = rangeB
        syntaxA.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntaxA.status).toBe('ready'))
        expect(query.mock.calls.filter(([r]) => r.startIndex === 100)).toHaveLength(2)
      } finally {
        viewB.dispose()
        syntaxA.dispose()
        pluginHostA.dispose()
        analysis.dispose()
      }
    })

    it('preserves parseId on prepared adoption so the first narrow edit promotes adopted and scrolled strips without requerying', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(140))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-first-edit-promote',
      })
      let snapshotVersion = 0
      const baseAnalyze = vi.fn(async (read: { readonly text: { readonly length: number } }) => {
        const previousVersion = snapshotVersion
        snapshotVersion += 1
        const base = createEmptySyntaxResult({
          snapshot: {
            documentId: 'prepared-first-edit-promote',
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
              ranges: [{ startIndex: 95, endIndex: 110 }],
            },
          },
        }
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: baseAnalyze,
          canQueryRange: () => true,
          queryRange: query,
        })),
      }
      const range0: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retained.refreshBase()
      const ready0 = await retained.queryRange(range0)

      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = range0
      let textVersion = 0
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'prepared-first-edit-promote',
        getCurrentSessionDocumentId: () => 'prepared-first-edit-promote',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => textVersion,
        getVisibleSyntaxRange: () => currentRange,
        getMountedSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: retained.runtimeSessionId,
          provider,
          configurationTag: [],
          session: retained,
          range: range0,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(ready0),
          readyResult: ready0,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-first-edit-promote',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.status).toBe('ready')

        // Scroll to [10, 30) -> caches only the uncovered [20, 30) strip.
        currentRange = { startIndex: 10, endIndex: 30 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        const queriesBeforeEdit = query.mock.calls.length
        expect(queriesBeforeEdit).toBe(2)

        // Edit at offset 100 with narrow invalidation [95, 110); both [0, 20) and [20, 30) must promote!
        const editChange = session.applyEdits([{ from: 100, to: 100, text: 'Z' }])
        textVersion += 1
        syntax.acceptChange(editChange)
        syntax.refresh(1, editChange, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))

        expect(baseAnalyze).toHaveBeenCalledTimes(2)
        expect(query.mock.calls.length).toBe(queriesBeforeEdit)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('commits copyTokens and initialHighlightStatus when scrolling into a prefetched Markdown subrange after an authoritative multi-strip failure', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(40))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'md-subrange-copy-promote',
      })
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 20 && range.endIndex === 60) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'request-failed', message: 'records-failed' },
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          }
        }
        return answerFor(range, {
          tokens: EditorTokenStore.fromTokens([
            {
              start: range.startIndex + 8,
              end: range.startIndex + 10,
              style: { color: 'md-tok' },
            },
          ]),
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        })
      })
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 40 }
      let demandRanges: readonly EditorSyntaxRange[] = [
        { startIndex: 0, endIndex: 40 },
        { startIndex: 40, endIndex: 100 },
      ]
      let capturedRecords: EditorSyntaxResult['records'] = undefined
      const getCapturedRecords = () => capturedRecords
      let syntax!: EditorSyntaxController
      const publishDemand = () =>
        syntax.setDisplayDemand({
          kind: 'frame',
          snapshot: buffer.getTextSnapshot(),
          ranges: demandRanges,
        })
      syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'md-subrange-copy-promote',
        getCurrentSessionDocumentId: () => 'md-subrange-copy-promote',
        getLanguageId: () => 'markdown',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => publishDemand(),
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        setSyntaxCaptures: (_captures, nextRecords) => {
          capturedRecords = nextRecords
        },
        notifyViewUpdate: publishDemand,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'md-subrange-copy-promote',
          languageId: 'markdown',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        publishDemand()
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))

        // Retain off-screen prefetch [40, 100) (contains token at 48..50).
        syntax.prefetchVisibleRange(1, { startIndex: 40, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()
        expect(syntax.copyTokens.toTokens().some((t) => t.start === 48 && t.end === 50)).toBe(false)

        // Scroll to [20, 60) -> authoritative records query returns terminal partial -> settles degraded.
        currentRange = { startIndex: 20, endIndex: 60 }
        demandRanges = [{ startIndex: 20, endIndex: 60 }]
        publishDemand()
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('degraded'))
        expect(syntax.initialHighlightStatus).toBe('degraded')

        // Scroll into [45, 55) (wholly covered by prefetched [40, 100)) -> must promote copyTokens and settle painted!
        currentRange = { startIndex: 45, endIndex: 55 }
        demandRanges = [{ startIndex: 45, endIndex: 55 }]
        publishDemand()
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        expect(syntax.status).toBe('ready')
        expect(syntax.initialHighlightStatus).toBe('painted')
        expect(getCapturedRecords()?.data).toEqual(new Uint32Array([40, 100]))
        expect(syntax.copyTokens.toTokens().some((t) => t.start === 48 && t.end === 50)).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('recovers a prepared view on the first explicit refresh after another lease caused the shared base to fail', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-shared-base-failure',
      })
      let mode: 'degraded' | 'throw' | 'healthy' = 'degraded'
      const analyze = vi.fn(async (): Promise<EditorSyntaxResult> => {
        if (mode === 'throw') throw new Error('shared-base-boom')
        if (mode === 'degraded') {
          return {
            ...createEmptySyntaxResult(),
            degraded: { kind: 'request-failed', message: 'initial-degraded' },
          }
        }
        return createEmptySyntaxResult()
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze,
        })),
      }
      const leaseA = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      const degradedResult = await leaseA.refresh(buffer.getTextSnapshot())

      const sessionA = createEditorBufferSession(buffer)
      const pluginHostA = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      const syntaxA = new EditorSyntaxController({
        pluginHost: pluginHostA,
        getSession: () => sessionA,
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getDocumentId: () => 'prepared-shared-base-failure',
        getCurrentSessionDocumentId: () => 'prepared-shared-base-failure',
        getLanguageId: () => 'typescript',
        getVisibleSyntaxRange: () => firstFrame,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: leaseA.runtimeSessionId,
          provider,
          configurationTag: [],
          session: leaseA,
          range: firstFrame,
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(degradedResult),
          readyResult: degradedResult,
          dispose: () => leaseA.dispose(),
        },
      }
      const leaseB = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      try {
        syntaxA.startDocument(
          {
            analysis,
            documentId: 'prepared-shared-base-failure',
            languageId: 'typescript',
            snapshot: sessionA.getSnapshot(),
            textSnapshot: sessionA.getTextSnapshot(),
          },
          prepared,
        )
        syntaxA.adoptPreparedReadyResults(prepared)
        expect(syntaxA.status).toBe('degraded')

        // Lease B forces a retry of the shared base which throws, leaving the shared entry in 'failed'.
        mode = 'throw'
        await expect(leaseB.refreshBase({ forceRetry: true })).rejects.toThrow('shared-base-boom')
        expect(analyze).toHaveBeenCalledTimes(2)

        // Provider recovers; A's VERY FIRST explicit refresh must retry the failed shared base and settle ready!
        mode = 'healthy'
        syntaxA.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntaxA.status).toBe('ready'))
        expect(analyze).toHaveBeenCalledTimes(3)
      } finally {
        leaseB.dispose()
        syntaxA.dispose()
        pluginHostA.dispose()
        analysis.dispose()
      }
    })

    it('queries the new viewport when it moves between promoted fast-path sampling and publication', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(140))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'promoted-viewport-move-race',
      })
      let snapshotVersion = 0
      const baseAnalyze = vi.fn(async (read: { readonly text: { readonly length: number } }) => {
        const previousVersion = snapshotVersion
        snapshotVersion += 1
        const base = createEmptySyntaxResult({
          snapshot: {
            documentId: 'promoted-viewport-move-race',
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
              ranges: [{ startIndex: 95, endIndex: 110 }],
            },
          },
        }
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: baseAnalyze,
          canQueryRange: () => true,
          queryRange: query,
        })),
      }
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      let textVersion = 0
      let movedAfterSample = false
      let syntax!: EditorSyntaxController
      syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'promoted-viewport-move-race',
        getCurrentSessionDocumentId: () => 'promoted-viewport-move-race',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => textVersion,
        getVisibleSyntaxRange: () => {
          const sampled = currentRange
          // Right when `#loadSyntaxResult` samples `[0, 20)` for the promoted fast path after
          // base parse #2, move the viewport in a microtask BEFORE `apply` publishes!
          if (snapshotVersion === 2 && !movedAfterSample) {
            movedAfterSample = true
            queueMicrotask(() => {
              currentRange = { startIndex: 60, endIndex: 80 }
              syntax.refreshVisibleRange(1, { delayMs: 0 })
            })
          }
          return sampled
        },
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'promoted-viewport-move-race',
          languageId: 'typescript',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))

        const change = session.applyEdits([{ from: 100, to: 100, text: 'Z' }])
        textVersion += 1
        syntax.acceptChange(change)
        syntax.refresh(1, change, { delayMs: 0 })

        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(movedAfterSample).toBe(true)
        expect(syntax.renderDataReady).toBe(true)
        expect(query.mock.calls.some(([r]) => r.startIndex === 60 && r.endIndex === 80)).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('keeps a prepared range-mode view in range mode when its first range cancels on budget and recovers on scroll', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(120))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-range-budget-cancel',
      })
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: {
                kind: 'cancelled',
                reason: 'budget',
                coveredRange: { startIndex: 0, endIndex: 0 },
                elapsedMs: 100,
                budgetMs: 50,
              },
            },
          }
        }
        return answerFor(range, {
          brackets: [{ index: range.startIndex + 2, char: '{', depth: 1 }],
        })
      })
      const provider = structuralProvider(query)
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retained.refreshBase()
      const cancelledFirst = await retained.queryRange({ startIndex: 0, endIndex: 20 })

      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'prepared-range-budget-cancel',
        getCurrentSessionDocumentId: () => 'prepared-range-budget-cancel',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: retained.runtimeSessionId,
          provider,
          configurationTag: [],
          session: retained,
          range: { startIndex: 0, endIndex: 20 },
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(cancelledFirst),
          readyResult: cancelledFirst,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-range-budget-cancel',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.status).toBe('degraded')

        // Scroll to [60, 80) -> must query range and recover cleanly to ready with bracket at 62!
        currentRange = { startIndex: 60, endIndex: 80 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(syntax.brackets.map((b) => b.index)).toEqual([62])
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('stays loading in range mode when base finishes with no visible viewport until the first viewport answer settles', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(120))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'range-mode-null-viewport-base',
      })
      let resolveRange: ((result: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(
        async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> =>
          new Promise<EditorSyntaxResult>((resolve) => {
            resolveRange = resolve
            void range
          }),
      )
      const provider = structuralProvider(query)
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange | null = null
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'range-mode-null-viewport-base',
        getCurrentSessionDocumentId: () => 'range-mode-null-viewport-base',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'range-mode-null-viewport-base',
          languageId: 'typescript',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        syntax.refresh(1, null, { delayMs: 0 })
        await settle(80)

        // Base finished while visibleRange was null -> must still be loading (NOT ready!).
        expect(syntax.status).toBe('loading')
        expect(syntax.renderDataReady).toBe(false)

        // Expose viewport [60, 80) and hold its range query -> must stay loading until it resolves.
        currentRange = { startIndex: 60, endIndex: 80 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveRange).not.toBeNull())
        expect(syntax.status).toBe('loading')
        expect(syntax.renderDataReady).toBe(false)

        resolveRange!(
          answerFor(
            { startIndex: 60, endIndex: 80 },
            { brackets: [{ index: 62, char: '{', depth: 1 }] },
          ),
        )
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(syntax.renderDataReady).toBe(true)
        expect(syntax.brackets.map((b) => b.index)).toEqual([62])
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('settles ready in full mode when canQueryRange flips false while the first viewport query is held', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(120))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'lose-range-during-first-viewport',
      })
      let allowRange = true
      let resolveViewport: ((result: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(
        async (_range: EditorSyntaxRange): Promise<EditorSyntaxResult> =>
          new Promise<EditorSyntaxResult>((resolve) => {
            resolveViewport = resolve
          }),
      )
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query, { canQueryRange: () => allowRange }),
        { startIndex: 0, endIndex: 20 },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveViewport).not.toBeNull())

        allowRange = false
        resolveViewport!(answerFor({ startIndex: 0, endIndex: 20 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.renderDataReady).toBe(true)
        expect(view.syntax.initialHighlightStatus).toBe('painted')
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('reclaims range token ownership and bounds painted and copy tokens across 40 prefetches and scrolls after an invalidating edit', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(1000))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'post-edit-token-compaction',
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 20,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.tokens.length).toBe(1)

        // Edit inside [0, 20), projecting tokens through the edit just like Editor does.
        const change = typeText(view, buffer, { from: 5, to: 5, text: '!' })
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.tokens.length).toBe(1)

        // 40 disjoint off-screen prefetches must not grow painted tokens past the retained frame.
        for (let index = 1; index <= 40; index += 1) {
          const startIndex = index * 40
          view.syntax.prefetchVisibleRange(
            1,
            { startIndex, endIndex: startIndex + 20 },
            { delayMs: 0 },
          )
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2 + index))
        }
        await settle()
        expect(view.syntax.tokens.length).toBe(1)
        expect(view.syntax.copyTokens.length).toBe(1)

        // Scrolling through 40 disjoint ranges must compact both painted and copy stores.
        const baseCalls = query.mock.calls.length
        for (let index = 1; index <= 40; index += 1) {
          const startIndex = index * 40
          view.setRange({ startIndex, endIndex: startIndex + 20 })
          view.syntax.refreshVisibleRange(1, { delayMs: 0 })
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(baseCalls + index))
          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        }
        expect(view.syntax.tokens.length).toBe(1)
        expect(view.syntax.copyTokens.length).toBe(1)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('preserves range token compaction across background parse completion after a partial viewport', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(300))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'bg-completion-compaction',
      })
      let producedListener:
        | ((
            read: Parameters<ReturnType<typeof createEmptySyntaxRuntime>['analyze']>[0],
            result: EditorSyntaxResult,
          ) => void)
        | null = null
      let lastRead: Parameters<ReturnType<typeof createEmptySyntaxRuntime>['analyze']>[0] | null =
        null
      let completed = false
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (!completed) {
          return {
            ...answerFor(range),
            projection: {
              ...answerFor(range).projection,
              analysis: {
                kind: 'partial',
                coveredRange: range,
              },
            },
          }
        }
        return answerFor(range)
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async (read) => {
            lastRead = read
            return completed
              ? createEmptySyntaxResult()
              : {
                  ...createEmptySyntaxResult(),
                  projection: {
                    ...createEmptySyntaxResult().projection,
                    analysis: {
                      kind: 'partial',
                      coveredRange: { startIndex: 0, endIndex: 20 },
                    },
                  },
                }
          },
          canQueryRange: () => true,
          queryRange: query,
          subscribeResults: (listener) => {
            producedListener = listener
            return () => {
              producedListener = null
            }
          },
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.tokens.length).toBe(1))
        expect(producedListener).not.toBeNull()
        expect(lastRead).not.toBeNull()

        // Publish background completion and scroll through 5 disjoint viewports.
        completed = true
        producedListener!(lastRead!, createEmptySyntaxResult())
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        for (let index = 1; index <= 5; index += 1) {
          const startIndex = index * 40
          view.setRange({ startIndex, endIndex: startIndex + 20 })
          view.syntax.refreshVisibleRange(1, { delayMs: 0 })
          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        }
        expect(view.syntax.tokens.length).toBe(1)
        expect(view.syntax.copyTokens.length).toBe(1)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('compacts syntax-owned copy tokens across scrolls after an edit with pre-existing host paint', async () => {
      const buffer = createEditorTextBuffer('x\n'.repeat(300))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'host-paint-copy-compaction',
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const view = createView(buffer, analysis, structuralProvider(query), {
        startIndex: 0,
        endIndex: 20,
      })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Install a host token outside the viewport, then edit inside the viewport.
        view.syntax.setTokens(
          EditorTokenStore.fromTokens([{ start: 500, end: 505, style: { color: 'host' } }]),
        )
        const change = typeText(view, buffer, { from: 5, to: 5, text: '!' })
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        for (let index = 1; index <= 5; index += 1) {
          const startIndex = index * 40
          view.setRange({ startIndex, endIndex: startIndex + 20 })
          view.syntax.refreshVisibleRange(1, { delayMs: 0 })
          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        }
        // Host token survives in painted store, while syntax-owned copy store stays compacted to 1 token.
        expect(view.syntax.copyTokens.length).toBe(1)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('ignores a late off-screen prefetch after the controller transitions to full-document mode', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(3000))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'late-prefetch-after-full-fallback',
      })
      let allowRange = true
      let resolveViewport: ((result: EditorSyntaxResult) => void) | null = null
      let resolvePrefetch: ((result: EditorSyntaxResult) => void) | null = null
      const getResolvePrefetch = () => resolvePrefetch
      const baseTokens = EditorTokenStore.fromTokens([
        { start: 0, end: 4, style: { color: 'base' } },
      ])
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return answerFor(range, {
            tokens: EditorTokenStore.fromTokens([{ start: 0, end: 2, style: { color: 'first' } }]),
          })
        }
        if (range.startIndex === 0 && range.endIndex === 5000) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveViewport = resolve
          })
        }
        return new Promise<EditorSyntaxResult>((resolve) => {
          resolvePrefetch = resolve
        })
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult(),
            tokens: baseTokens,
          }),
          canQueryRange: () => allowRange,
          queryRange: query,
        })),
      }
      const view = createView(
        buffer,
        analysis,
        provider,
        { startIndex: 0, endIndex: 5000 },
        { mountedRange: () => ({ startIndex: 0, endIndex: 20 }) },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveViewport).not.toBeNull())

        // Start a prefetch while firstRows has accepted the document in range mode, wait until
        // the prefetch query is actually in flight, then disable range queries and resolve both!
        view.syntax.prefetchVisibleRange(1, { startIndex: 5100, endIndex: 5200 }, { delayMs: 0 })
        await vi.waitFor(() => expect(getResolvePrefetch()).not.toBeNull())
        allowRange = false
        resolveViewport!(answerFor({ startIndex: 0, endIndex: 5000 }))
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.tokens.toTokens()).toEqual([
          { start: 0, end: 4, style: { color: 'base' } },
        ])

        getResolvePrefetch()!(
          answerFor(
            { startIndex: 5100, endIndex: 5200 },
            {
              tokens: EditorTokenStore.fromTokens([
                { start: 5100, end: 5104, style: { color: 'prefetch' } },
              ]),
            },
          ),
        )
        await settle()
        expect(view.syntax.tokens.toTokens()).toEqual([
          { start: 0, end: 4, style: { color: 'base' } },
        ])
        expect(view.syntax.copyTokens.toTokens()).toEqual([
          { start: 0, end: 4, style: { color: 'base' } },
        ])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('uses the retained base result instead of a prepared viewport slice when range queries are disabled before adoption', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(600))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-disable-range-before-adopt',
      })
      let allowRange = true
      const baseResult: EditorSyntaxResult = {
        ...createEmptySyntaxResult(),
        brackets: [{ index: 500, char: '{', depth: 1 }],
      }
      const query = vi.fn(async (range: EditorSyntaxRange) =>
        answerFor(range, { brackets: [{ index: 2, char: '(', depth: 1 }] }),
      )
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => baseResult,
          canQueryRange: () => allowRange,
          queryRange: query,
        })),
      }
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retained.refreshBase()
      const preparedSlice = await retained.queryRange({ startIndex: 0, endIndex: 20 })

      // Disable range queries BEFORE adoption!
      allowRange = false
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 500, endIndex: 520 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'prepared-disable-range-before-adopt',
        getCurrentSessionDocumentId: () => 'prepared-disable-range-before-adopt',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: retained.runtimeSessionId,
          provider,
          configurationTag: [],
          session: retained,
          range: { startIndex: 0, endIndex: 20 },
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(preparedSlice),
          readyResult: preparedSlice,
          dispose: () => retained.dispose(),
        },
      }
      try {
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-disable-range-before-adopt',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.status).toBe('ready')
        expect(syntax.brackets.map((b) => b.index)).toEqual([500])
        currentRange = { startIndex: 500, endIndex: 520 }
        expect(syntax.status).toBe('ready')
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('transitions to full-document mode when scrolling to an uncached viewport after range queries are disabled', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(200))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'disable-range-after-settle-scroll',
      })
      let allowRange = true
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult(),
            brackets: [{ index: 70, char: '{', depth: 1 }],
          }),
          canQueryRange: () => allowRange,
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        allowRange = false
        view.setRange({ startIndex: 60, endIndex: 80 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.renderDataReady).toBe(true)
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([70])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('preserves fresh host paint installed while an incremental narrow-invalidation edit parse is held', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(200))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'promotion-preserves-host-paint',
      })
      let snapshotVersion = 0
      let resolveSecondBase: ((result: EditorSyntaxResult) => void) | null = null
      const baseAnalyze = vi.fn(async (read: { readonly text: { readonly length: number } }) => {
        const previousVersion = snapshotVersion
        snapshotVersion += 1
        const base = createEmptySyntaxResult({
          snapshot: {
            documentId: 'promotion-preserves-host-paint',
            length: read.text.length,
            version: snapshotVersion,
          },
        })
        if (previousVersion === 0) return base
        return new Promise<EditorSyntaxResult>((resolve) => {
          resolveSecondBase = resolve
        }).then(() => ({
          ...base,
          projection: {
            ...base.projection,
            invalidation: {
              baseSnapshotVersion: previousVersion,
              snapshotVersion,
              ranges: [{ startIndex: 95, endIndex: 110 }],
            },
          },
        }))
      })
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: baseAnalyze,
          canQueryRange: () => true,
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        const change = typeText(view, buffer, { from: 100, to: 100, text: 'Z' })
        view.syntax.refresh(1, change, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveSecondBase).not.toBeNull())

        // Install a fresh host token outside [0, 20) while the narrow-invalidation edit parse is held.
        const hostToken = { start: 150, end: 155, style: { color: 'host-fresh' } }
        view.syntax.setTokens(EditorTokenStore.fromTokens([hostToken]))
        resolveSecondBase!(createEmptySyntaxResult())

        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.tokens.toTokens()).toContainEqual(hostToken)
        expect(view.syntax.copyTokens.toTokens()).toContainEqual(hostToken)
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('ignores a late viewport rejection after refresh transitions the controller to full-document mode', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(200))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'late-viewport-rejection-after-full',
      })
      let allowRange = true
      let rejectScroll: ((error: unknown) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 60 && range.endIndex === 80) {
          return new Promise<EditorSyntaxResult>((_resolve, reject) => {
            rejectScroll = reject
          })
        }
        return answerFor(range)
      })
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult(),
            brackets: [{ index: 70, char: '{', depth: 1 }],
          }),
          canQueryRange: () => allowRange,
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Scroll to [60, 80) and hold its range query in flight.
        view.setRange({ startIndex: 60, endIndex: 80 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(rejectScroll).not.toBeNull())

        // Disable range queries and refresh -> full-document mode settles ready with bracket 70.
        allowRange = false
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([70])

        // Reject the held [60, 80) query -> must NOT turn full-mode syntax to 'error' or clear brackets!
        rejectScroll!(new Error('late-range-boom'))
        await settle()
        expect(view.syntax.status).toBe('ready')
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([70])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('falls back to full-document mode when canQueryRange flips false during a delayed refreshVisibleRange', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(200))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'disable-range-before-delayed-dispatch',
      })
      let allowRange = true
      const query = vi.fn(async (range: EditorSyntaxRange) => answerFor(range))
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult(),
            brackets: [{ index: 70, char: '{', depth: 1 }],
          }),
          canQueryRange: () => allowRange,
          queryRange: query,
        })),
      }
      const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Scroll to [60, 80) with default delay, then disable range queries before dispatch fires.
        view.setRange({ startIndex: 60, endIndex: 80 })
        view.syntax.refreshVisibleRange(1)
        allowRange = false

        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.syntax.renderDataReady).toBe(true)
        expect(view.syntax.brackets.map((b) => b.index)).toEqual([70])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it.each(['superseded', 'range-unavailable', 'partial'] as const)(
      'falls back to full-document mode when an in-flight scroll query settles with %s after canQueryRange flips false',
      async (outcome) => {
        const buffer = createEditorTextBuffer('a'.repeat(200))
        const analysis = createEditorDocumentAnalysis({
          buffer,
          documentId: `in-flight-capability-loss-${outcome}`,
        })
        let allowRange = true
        let resolveScroll: ((result: EditorSyntaxResult) => void) | null = null
        const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
          if (range.startIndex === 60 && range.endIndex === 80) {
            return new Promise<EditorSyntaxResult>((resolve) => {
              resolveScroll = resolve
            })
          }
          return answerFor(range)
        })
        const provider: EditorSyntaxProvider = {
          operation: createEditorStructuralOperation(() => ({
            ...createEmptySyntaxRuntime(),
            foldingSupport: 'supported' as const,
            analyze: async () => ({
              ...createEmptySyntaxResult(),
              brackets: [{ index: 70, char: '{', depth: 1 }],
            }),
            canQueryRange: () => allowRange,
            queryRange: query,
          })),
        }
        const view = createView(buffer, analysis, provider, { startIndex: 0, endIndex: 20 })
        try {
          view.syntax.refresh(1, null, { delayMs: 0 })
          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

          view.setRange({ startIndex: 60, endIndex: 80 })
          view.syntax.refreshVisibleRange(1, { delayMs: 0 })
          await vi.waitFor(() => expect(resolveScroll).not.toBeNull())

          allowRange = false
          const scrollRange: EditorSyntaxRange = { startIndex: 60, endIndex: 80 }
          resolveScroll!(
            outcome === 'superseded'
              ? {
                  ...createEmptySyntaxResult({ requestedRanges: [scrollRange] }),
                  projection: {
                    ...createEmptySyntaxResult({ requestedRanges: [scrollRange] }).projection,
                    analysis: {
                      kind: 'cancelled',
                      reason: 'superseded',
                      coveredRange: { startIndex: 0, endIndex: 0 },
                      elapsedMs: 10,
                      budgetMs: 50,
                    },
                  },
                }
              : outcome === 'partial'
                ? {
                    ...answerFor(scrollRange),
                    projection: {
                      ...answerFor(scrollRange).projection,
                      analysis: { kind: 'partial', coveredRange: scrollRange },
                    },
                  }
                : {
                    ...createEmptySyntaxResult({ requestedRanges: [scrollRange] }),
                    degraded: { kind: 'range-unavailable', message: 'range-disabled' },
                  },
          )

          await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
          expect(view.syntax.renderDataReady).toBe(true)
          expect(view.syntax.brackets.map((b) => b.index)).toEqual([70])
        } finally {
          view.dispose()
          analysis.dispose()
        }
      },
    )

    it('keeps display tokens and copyTokens aligned with the full base when staging and adopting a prepared view after range queries are disabled', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(120))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-stage-adopt-full-fallback',
      })
      let allowRange = true
      const redTokens = EditorTokenStore.fromTokens([{ start: 0, end: 4, style: { color: 'red' } }])
      const blueTokens = EditorTokenStore.fromTokens([
        { start: 0, end: 4, style: { color: 'blue' } },
      ])
      const provider: EditorSyntaxProvider = {
        operation: createEditorStructuralOperation(() => ({
          ...createEmptySyntaxRuntime(),
          foldingSupport: 'supported' as const,
          analyze: async () => ({
            ...createEmptySyntaxResult(),
            tokens: blueTokens,
          }),
          canQueryRange: () => allowRange,
          queryRange: async (range: EditorSyntaxRange) => answerFor(range, { tokens: redTokens }),
        })),
      }
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retained.refreshBase()
      const preparedSlice = await retained.queryRange({ startIndex: 0, endIndex: 20 })

      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let paintedTokens: EditorTokenStore = EditorTokenStore.empty()
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'prepared-stage-adopt-full-fallback',
        getCurrentSessionDocumentId: () => 'prepared-stage-adopt-full-fallback',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => ({ startIndex: 0, endIndex: 20 }),
        adoptTokens: (tokens) => {
          paintedTokens = tokens
        },
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: {
          family: 'structural' as const,
          runtimeSessionId: retained.runtimeSessionId,
          provider,
          configurationTag: [],
          session: retained,
          range: { startIndex: 0, endIndex: 20 },
          configuration: {
            includeCaptures: false,
            includeHighlights: true,
            syntaxMode: 'range' as const,
          },
          result: Promise.resolve(preparedSlice),
          readyResult: preparedSlice,
          dispose: () => retained.dispose(),
        },
      }
      try {
        // Case A: range queries disabled before staging and adoption.
        allowRange = false
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-stage-adopt-full-fallback',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        paintedTokens = syntax.stagePreparedReadyTokens(prepared)
        syntax.adoptPreparedReadyResults(prepared)
        expect(syntax.renderDataReady).toBe(true)
        expect(paintedTokens.toTokens()).toEqual([{ start: 0, end: 4, style: { color: 'blue' } }])
        expect(syntax.copyTokens.toTokens()).toEqual([
          { start: 0, end: 4, style: { color: 'blue' } },
        ])

        // Case B: range queries disabled AFTER staging red tokens and BEFORE adoption.
        allowRange = true
        const retainedB = analysis.borrowStructural({
          languageId: 'typescript',
          includeCaptures: false,
          includeHighlights: true,
          syntaxMode: 'range',
          provider,
          configurationTag: [],
        })!
        const preparedB = {
          ...prepared,
          structural: {
            ...prepared.structural,
            runtimeSessionId: retainedB.runtimeSessionId,
            session: retainedB,
            dispose: () => retainedB.dispose(),
          },
        }
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-stage-adopt-full-fallback',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          preparedB,
        )
        paintedTokens = syntax.stagePreparedReadyTokens(preparedB)
        expect(paintedTokens.toTokens()).toEqual([{ start: 0, end: 4, style: { color: 'red' } }])
        allowRange = false
        syntax.adoptPreparedReadyResults(preparedB)
        expect(syntax.renderDataReady).toBe(true)
        expect(paintedTokens.toTokens()).toEqual([{ start: 0, end: 4, style: { color: 'blue' } }])
        expect(syntax.copyTokens.toTokens()).toEqual([
          { start: 0, end: 4, style: { color: 'blue' } },
        ])
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('clears stale folds and captures when returning to a range-unavailable viewport after visiting a ready range', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'return-to-unavailable-clears-scope',
      })
      const foldAtStart: FoldRange = {
        startIndex: 1,
        endIndex: 19,
        startLine: 0,
        endLine: 9,
        type: 'block',
      }
      const captureAtStart: EditorSyntaxCapture = {
        startIndex: 1,
        endIndex: 19,
        captureName: 'function',
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 30 && range.endIndex === 60) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'range-unavailable', message: 'unavailable-30-60' },
          }
        }
        if (range.startIndex === 0 && range.endIndex === 30) {
          return answerFor(range, {
            folds: [foldAtStart],
            captures: [captureAtStart],
          })
        }
        return answerFor(range)
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 0, endIndex: 30 },
        { needsCaptures: true },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.folds()).toEqual([foldAtStart])
        expect(view.captures()).toEqual([captureAtStart])

        // Move to [20, 60) -> [30, 60) returns range-unavailable -> clears folds & captures.
        view.setRange({ startIndex: 20, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.folds()).toEqual([])
        expect(view.captures()).toEqual([])

        // Prefetch [20, 40), visit ready [0, 40) (re-installing [1, 19) fold & capture) without dropping
        // the [40, 60) unavailable marker, then return to [20, 60) via the settled-unavailable path.
        view.syntax.prefetchVisibleRange(1, { startIndex: 20, endIndex: 40 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
        await settle()

        view.syntax.refreshVisibleRange(1, { delayMs: 0, range: { startIndex: 0, endIndex: 40 } })
        expect(view.folds()).toEqual([foldAtStart])
        expect(view.captures()).toEqual([captureAtStart])

        view.syntax.refreshVisibleRange(1, { delayMs: 0, range: { startIndex: 20, endIndex: 60 } })
        expect(view.syntax.status).toBe('degraded')
        expect(view.syntax.renderDataReady).toBe(true)
        expect(view.folds()).toEqual([])
        expect(view.captures()).toEqual([])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('observes prepared structural result when range capability returns between startDocument and adoptPreparedReadyResults', async () => {
      const buffer = createEditorTextBuffer('a'.repeat(120))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'prepared-range-returns-during-attach',
      })
      let allowRange = false
      let resolveRange: ((result: EditorSyntaxResult) => void) | null = null
      const range0: EditorSyntaxRange = { startIndex: 0, endIndex: 20 }
      const query = vi.fn(
        async (_range: EditorSyntaxRange): Promise<EditorSyntaxResult> =>
          new Promise<EditorSyntaxResult>((resolve) => {
            resolveRange = resolve
          }),
      )
      const provider = structuralProvider(query, { canQueryRange: () => allowRange })
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeCaptures: false,
        includeHighlights: true,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })!
      await retained.refreshBase()

      // Mirror preparedDocument.ts borrowStructural: live readyResult getter + async refresh -> queryRange.
      const resultPromise = retained
        .refresh(buffer.getTextSnapshot())
        .then(() => retained.queryRange(range0))
      const session = createEditorBufferSession(buffer)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'prepared-range-returns-during-attach',
        getCurrentSessionDocumentId: () => 'prepared-range-returns-during-attach',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => range0,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const structuralBorrow = {
        family: 'structural' as const,
        runtimeSessionId: retained.runtimeSessionId,
        provider,
        configurationTag: [],
        session: retained,
        range: range0,
        configuration: {
          includeCaptures: false,
          includeHighlights: true,
          syntaxMode: 'range' as const,
        },
        result: resultPromise,
        get readyResult(): EditorSyntaxResult | null {
          const state = retained.read(range0)
          return state.kind === 'ready' ? state.result : null
        },
        dispose: () => retained.dispose(),
      }
      const prepared = {
        lineStarts: [0],
        tabSize: 2,
        fallbackFoldIndex: null,
        highlighter: null,
        structural: structuralBorrow,
      }
      try {
        // Attach while canQueryRange() is false -> live readyResult returns base (non-null),
        // so startDocument skips observing resultPromise.
        syntax.startDocument(
          {
            analysis,
            documentId: 'prepared-range-returns-during-attach',
            languageId: 'typescript',
            snapshot: session.getSnapshot(),
            textSnapshot: session.getTextSnapshot(),
          },
          prepared,
        )
        syntax.stagePreparedReadyTokens(prepared)

        // Flip canQueryRange() to true before adoption -> live readyResult is now null!
        allowRange = true
        expect(prepared.structural.readyResult).toBeNull()
        syntax.adoptPreparedReadyResults(prepared)
        syntax.refresh(1, null, { delayMs: 0 })

        await vi.waitFor(() => expect(resolveRange).not.toBeNull())
        resolveRange!(answerFor(range0, { brackets: [{ index: 2, char: '{', depth: 1 }] }))

        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(syntax.renderDataReady).toBe(true)
        expect(syntax.brackets.map((b) => b.index)).toEqual([2])
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('clears stale folds and captures when a budget cancellation settles a viewport that already has a range-unavailable gap', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'unavailable-then-budget-cancel',
      })
      const foldAtMid: FoldRange = {
        startIndex: 21,
        endIndex: 39,
        startLine: 10,
        endLine: 19,
        type: 'block',
      }
      const captureAtMid: EditorSyntaxCapture = {
        startIndex: 21,
        endIndex: 39,
        captureName: 'function',
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'range-unavailable', message: 'unavailable-0-20' },
          }
        }
        if (range.startIndex === 40 && range.endIndex === 60) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: {
                kind: 'cancelled',
                reason: 'budget',
                coveredRange: { startIndex: 0, endIndex: 0 },
                elapsedMs: 100,
                budgetMs: 50,
              },
            },
          }
        }
        return answerFor(range, { folds: [foldAtMid], captures: [captureAtMid] })
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 20, endIndex: 40 },
        { needsCaptures: true },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.folds()).toEqual([foldAtMid])
        expect(view.captures()).toEqual([captureAtMid])

        // Widen to [0, 60): [0, 20) returns range-unavailable, then [40, 60) budget-cancels.
        // Because [0, 20) was range-unavailable, settling [0, 60) MUST clear stale folds & captures!
        view.setRange({ startIndex: 0, endIndex: 60 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.folds()).toEqual([])
        expect(view.captures()).toEqual([])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('preserves folds and captures from a budget-cancelled viewport when an off-screen prefetch arrives', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'budget-cancel-preserved-across-prefetch',
      })
      const foldAtStart: FoldRange = {
        startIndex: 1,
        endIndex: 19,
        startLine: 0,
        endLine: 9,
        type: 'block',
      }
      const captureAtStart: EditorSyntaxCapture = {
        startIndex: 1,
        endIndex: 19,
        captureName: 'function',
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 20 && range.endIndex === 40) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            projection: {
              ...createEmptySyntaxResult({ requestedRanges: [range] }).projection,
              analysis: {
                kind: 'cancelled',
                reason: 'budget',
                coveredRange: { startIndex: 0, endIndex: 0 },
                elapsedMs: 100,
                budgetMs: 50,
              },
            },
          }
        }
        if (range.startIndex === 0 && range.endIndex === 20) {
          return answerFor(range, { folds: [foldAtStart], captures: [captureAtStart] })
        }
        return answerFor(range)
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 0, endIndex: 20 },
        { needsCaptures: true },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))
        expect(view.folds()).toEqual([foldAtStart])
        expect(view.captures()).toEqual([captureAtStart])

        // Widen to [0, 40) and budget-cancel [20, 40) -> folds & captures stay preserved.
        view.setRange({ startIndex: 0, endIndex: 40 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.folds()).toEqual([foldAtStart])
        expect(view.captures()).toEqual([captureAtStart])

        // An off-screen prefetch [40, 60) must NOT erase the folds & captures preserved by budget cancellation.
        view.syntax.prefetchVisibleRange(1, { startIndex: 40, endIndex: 60 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
        await settle()
        expect(view.syntax.status).toBe('degraded')
        expect(view.folds()).toEqual([foldAtStart])
        expect(view.captures()).toEqual([captureAtStart])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('clears range-unavailable markers when a complete warm reply covers that strip before another strip budget-cancels', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(80_000))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'warm-clears-unavailable-marker',
      })
      const foldAtMid: FoldRange = {
        startIndex: 120_001,
        endIndex: 120_019,
        startLine: 60_000,
        endLine: 60_009,
        type: 'block',
      }
      const captureAtMid: EditorSyntaxCapture = {
        startIndex: 120_001,
        endIndex: 120_019,
        captureName: 'function',
      }
      let resolveWarm: ((result: EditorSyntaxResult) => void) | null = null
      let resolveRight: ((result: EditorSyntaxResult) => void) | null = null
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 120_000 && range.endIndex === 120_020) {
          return answerFor(range, { folds: [foldAtMid], captures: [captureAtMid] })
        }
        if (range.startIndex === 119_980 && range.endIndex === 120_000) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'range-unavailable', message: 'left-unavailable' },
          }
        }
        if (range.startIndex === 120_020 && range.endIndex === 120_040) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveRight = resolve
          })
        }
        if (range.startIndex < 120_000 && range.endIndex === 120_000) {
          return new Promise<EditorSyntaxResult>((resolve) => {
            resolveWarm = resolve
          })
        }
        return answerFor(range)
      })
      const view = createView(
        buffer,
        analysis,
        structuralProvider(query),
        { startIndex: 120_000, endIndex: 120_020 },
        { needsCaptures: true },
      )
      try {
        view.syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(view.syntax.status).toBe('ready'))

        // Start warm covering [0, 120_000) and hold it in flight.
        view.syntax.warmSyntaxAroundRange(
          1,
          { startIndex: 120_000, endIndex: 120_020 },
          { delayMs: 0 },
        )
        await vi.waitFor(() => expect(resolveWarm).not.toBeNull())

        // Widen to [119_980, 120_040): left [119_980, 120_000) returns range-unavailable,
        // right [120_020, 120_040) is held.
        view.setRange({ startIndex: 119_980, endIndex: 120_040 })
        view.syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveRight).not.toBeNull())

        // Complete the warm reply covering the left strip -> clears the left unavailable marker!
        const warmRange = query.mock.calls.find(
          ([r]) => r.startIndex < 120_000 && r.endIndex === 120_000,
        )![0]
        resolveWarm!(answerFor(warmRange))
        await settle()

        // Right strip budget-cancels -> settles degraded while preserving the middle fold & capture!
        resolveRight!({
          ...createEmptySyntaxResult({
            requestedRanges: [{ startIndex: 120_020, endIndex: 120_040 }],
          }),
          projection: {
            ...createEmptySyntaxResult({
              requestedRanges: [{ startIndex: 120_020, endIndex: 120_040 }],
            }).projection,
            analysis: {
              kind: 'cancelled',
              reason: 'budget',
              coveredRange: { startIndex: 0, endIndex: 0 },
              elapsedMs: 100,
              budgetMs: 50,
            },
          },
        })
        await vi.waitFor(() => expect(view.syntax.status).toBe('degraded'))
        expect(view.folds()).toEqual([foldAtMid])
        expect(view.captures()).toEqual([captureAtMid])
      } finally {
        view.dispose()
        analysis.dispose()
      }
    })

    it('withdraws stale brackets, injections, folds, captures, and records when an authoritative Markdown records query returns range-unavailable', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(40))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'md-records-unavailable-clears-facts',
      })
      const injectionAtStart: EditorSyntaxInjection = {
        parentLanguageId: 'markdown',
        languageId: 'typescript',
        startIndex: 0,
        endIndex: 10,
      }
      const foldAtStart: FoldRange = {
        startIndex: 0,
        endIndex: 20,
        startLine: 0,
        endLine: 2,
        type: 'block',
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 20 && range.endIndex === 60) {
          return {
            ...createEmptySyntaxResult({ requestedRanges: [range] }),
            degraded: { kind: 'range-unavailable', message: 'records-unavailable' },
          }
        }
        return answerFor(range, {
          brackets: [{ index: range.startIndex + 2, char: '(', depth: 1 }],
          injections: range.startIndex === 0 ? [injectionAtStart] : [],
          folds: range.startIndex === 0 ? [foldAtStart] : [],
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        })
      })
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 40 }
      let demandRanges: readonly EditorSyntaxRange[] = [
        { startIndex: 0, endIndex: 40 },
        { startIndex: 40, endIndex: 100 },
      ]
      let folds: readonly FoldRange[] = []
      let captures: readonly EditorSyntaxCapture[] = []
      let records: EditorSyntaxResult['records'] = undefined
      const getRecords = () => records
      let syntax!: EditorSyntaxController
      const publishDemand = () =>
        syntax.setDisplayDemand({
          kind: 'frame',
          snapshot: buffer.getTextSnapshot(),
          ranges: demandRanges,
        })
      syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'md-records-unavailable-clears-facts',
        getCurrentSessionDocumentId: () => 'md-records-unavailable-clears-facts',
        getLanguageId: () => 'markdown',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => publishDemand(),
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
        notifyViewUpdate: publishDemand,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'md-records-unavailable-clears-facts',
          languageId: 'markdown',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        publishDemand()
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(syntax.brackets.map((b) => b.index)).toEqual([2])
        expect(syntax.injections).toEqual([injectionAtStart])
        expect(getRecords()?.data).toEqual(new Uint32Array([0, 40]))

        // Retain complete prefetch [40, 100), then scroll to [20, 60) where authoritative records returns range-unavailable.
        syntax.prefetchVisibleRange(1, { startIndex: 40, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        currentRange = { startIndex: 20, endIndex: 60 }
        demandRanges = [{ startIndex: 20, endIndex: 60 }]
        publishDemand()
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('degraded'))
        expect(syntax.renderDataReady).toBe(true)
        expect(syntax.brackets).toEqual([])
        expect(syntax.injections).toEqual([])
        expect(folds).toEqual([])
        expect(captures).toEqual([])
        expect(getRecords()).toBeUndefined()
        // Token paint stays intact.
        expect(syntax.tokens.length).toBeGreaterThan(0)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('clears stale captures and records when an authoritative Markdown records query throws', async () => {
      const buffer = createEditorTextBuffer('# heading\n'.repeat(40))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'md-records-rejection-clears-captures',
      })
      const captureAtStart: EditorSyntaxCapture = {
        startIndex: 0,
        endIndex: 10,
        captureName: 'heading',
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 20 && range.endIndex === 60) {
          throw new Error('authoritative-records-failed')
        }
        return answerFor(range, {
          captures: range.startIndex === 0 ? [captureAtStart] : [],
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        })
      })
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 40 }
      let demandRanges: readonly EditorSyntaxRange[] = [
        { startIndex: 0, endIndex: 40 },
        { startIndex: 40, endIndex: 100 },
      ]
      let captures: readonly EditorSyntaxCapture[] = []
      let records: EditorSyntaxResult['records'] = undefined
      const getRecords = () => records
      let syntax!: EditorSyntaxController
      const publishDemand = () =>
        syntax.setDisplayDemand({
          kind: 'frame',
          snapshot: buffer.getTextSnapshot(),
          ranges: demandRanges,
        })
      syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'md-records-rejection-clears-captures',
        getCurrentSessionDocumentId: () => 'md-records-rejection-clears-captures',
        getLanguageId: () => 'markdown',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => publishDemand(),
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        setSyntaxCaptures: (nextCaptures, nextRecords) => {
          captures = nextCaptures
          records = nextRecords
        },
        needsSyntaxCaptures: () => true,
        notifyViewUpdate: publishDemand,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'md-records-rejection-clears-captures',
          languageId: 'markdown',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        publishDemand()
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(captures).toEqual([captureAtStart])
        expect(getRecords()?.data).toEqual(new Uint32Array([0, 40]))

        syntax.prefetchVisibleRange(1, { startIndex: 40, endIndex: 100 }, { delayMs: 0 })
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
        await settle()

        currentRange = { startIndex: 20, endIndex: 60 }
        demandRanges = [{ startIndex: 20, endIndex: 60 }]
        publishDemand()
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('error'))
        expect(syntax.renderDataReady).toBe(true)
        expect(captures).toEqual([])
        expect(getRecords()).toBeUndefined()
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('advances past a non-terminal partial strip to query the remaining gap instead of looping', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'provisional-strip-no-loop',
      })
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return {
            ...answerFor(range),
            projection: {
              ...answerFor(range).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          }
        }
        return answerFor(range)
      })
      let changeCount = 0
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 20, endIndex: 40 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'provisional-strip-no-loop',
        getCurrentSessionDocumentId: () => 'provisional-strip-no-loop',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => {
          changeCount += 1
        },
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'provisional-strip-no-loop',
          languageId: 'typescript',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))

        changeCount = 0
        currentRange = { startIndex: 0, endIndex: 60 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() =>
          expect(query.mock.calls.some(([r]) => r.startIndex === 40 && r.endIndex === 60)).toBe(
            true,
          ),
        )
        await settle(80)

        // Both [0, 20) and [40, 60) were queried once; no refresh loop!
        expect(query).toHaveBeenCalledTimes(3)
        expect(changeCount).toBeLessThanOrEqual(4)
        expect(syntax.status).toBe('loading')
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('queries the uncovered subrange of a narrowed terminal partial instead of stranding in loading', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(100))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'terminal-partial-narrowed-subrange',
      })
      let resolveLeft: ((result: EditorSyntaxResult) => void) | null = null
      const query = vi.fn((range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return new Promise((resolve) => {
            resolveLeft = resolve
          })
        }
        return Promise.resolve(answerFor(range))
      })
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 20, endIndex: 40 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'terminal-partial-narrowed-subrange',
        getCurrentSessionDocumentId: () => 'terminal-partial-narrowed-subrange',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'terminal-partial-narrowed-subrange',
          languageId: 'typescript',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))

        currentRange = { startIndex: 0, endIndex: 20 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(resolveLeft).not.toBeNull())

        currentRange = { startIndex: 10, endIndex: 20 }
        resolveLeft!({
          ...answerFor({ startIndex: 0, endIndex: 20 }),
          projection: {
            ...answerFor({ startIndex: 0, endIndex: 20 }).projection,
            analysis: {
              kind: 'partial',
              coveredRange: { startIndex: 0, endIndex: 20 },
              background: {
                kind: 'cancelled',
                reason: 'budget',
                coveredRange: { startIndex: 0, endIndex: 20 },
                elapsedMs: 50,
                budgetMs: 50,
              },
            },
          },
        })
        await vi.waitFor(() => expect(syntax.status).toBe('degraded'))

        currentRange = { startIndex: 0, endIndex: 10 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(query.mock.calls.some(([r]) => r.startIndex === 0 && r.endIndex === 10)).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('does not let a partial firstRows paint suppress the visible range query', async () => {
      const buffer = createEditorTextBuffer('a\n'.repeat(3000))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'partial-first-rows-does-not-suppress-visible',
      })
      const query = vi.fn((range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        if (range.startIndex === 0 && range.endIndex === 20) {
          return Promise.resolve({
            ...answerFor(range),
            projection: {
              ...answerFor(range).projection,
              analysis: { kind: 'partial', coveredRange: range },
            },
          })
        }
        return Promise.resolve(answerFor(range))
      })
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      const visibleRange: EditorSyntaxRange = { startIndex: 0, endIndex: 5000 }
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'partial-first-rows-does-not-suppress-visible',
        getCurrentSessionDocumentId: () => 'partial-first-rows-does-not-suppress-visible',
        getLanguageId: () => 'typescript',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getMountedSyntaxRange: () => ({ startIndex: 0, endIndex: 20 }),
        getVisibleSyntaxRange: () => visibleRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      try {
        syntax.startDocument({
          analysis,
          documentId: 'partial-first-rows-does-not-suppress-visible',
          languageId: 'typescript',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(query.mock.calls.some(([r]) => r.startIndex === 0 && r.endIndex === 20)).toBe(true)
        expect(query.mock.calls.some(([r]) => r.startIndex === 0 && r.endIndex === 5000)).toBe(true)
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })

    it('bypasses containing shared-cache hits for authoritative Markdown records queries', async () => {
      const buffer = createEditorTextBuffer('# Heading\n'.repeat(30))
      const analysis = createEditorDocumentAnalysis({
        buffer,
        documentId: 'authoritative-records-exact-cache-bypass',
      })
      const supersededBracket = {
        index: 96,
        char: '(',
        kind: 'open' as const,
        pairId: 'paren' as const,
        depth: 0,
      }
      const query = vi.fn(async (range: EditorSyntaxRange): Promise<EditorSyntaxResult> => {
        const base = answerFor(range)
        return {
          ...base,
          brackets: range.startIndex === 0 && range.endIndex === 100 ? [supersededBracket] : [],
          records: {
            languageId: 'markdown',
            data: new Uint32Array([range.startIndex, range.endIndex]),
          },
        }
      })
      let latestRecords: EditorSyntaxResult['records'] = undefined
      const getLatestRecords = () => latestRecords
      const session = createEditorBufferSession(buffer)
      const provider = structuralProvider(query)
      const pluginHost = new EditorPluginHost([
        { activate: (context) => context.registerSyntaxProvider(provider) },
      ])
      let currentRange: EditorSyntaxRange = { startIndex: 0, endIndex: 100 }
      let demandRanges: readonly EditorSyntaxRange[] = [{ startIndex: 0, endIndex: 100 }]
      const syntax = new EditorSyntaxController({
        pluginHost,
        getSession: () => session,
        getDocumentId: () => 'authoritative-records-exact-cache-bypass',
        getCurrentSessionDocumentId: () => 'authoritative-records-exact-cache-bypass',
        getLanguageId: () => 'markdown',
        getDocumentVersion: () => 1,
        getTextVersion: () => 0,
        getVisibleSyntaxRange: () => currentRange,
        adoptTokens: () => undefined,
        setSyntaxFolds: () => undefined,
        clearSyntaxFolds: () => undefined,
        setSyntaxCaptures: (_captures, records) => {
          latestRecords = records
        },
        notifyViewUpdate: () => undefined,
        notifyChange: () => undefined,
        notifyThemeChanged: () => undefined,
      })
      const publishDemand = () => {
        syntax.setDisplayDemand({
          kind: 'frame',
          snapshot: session.getTextSnapshot(),
          ranges: demandRanges,
        })
      }
      try {
        syntax.startDocument({
          analysis,
          documentId: 'authoritative-records-exact-cache-bypass',
          languageId: 'markdown',
          snapshot: session.getSnapshot(),
          textSnapshot: session.getTextSnapshot(),
        })
        publishDemand()
        syntax.refresh(1, null, { delayMs: 0 })
        await vi.waitFor(() => expect(syntax.status).toBe('ready'))
        expect(syntax.brackets).toEqual([supersededBracket])
        expect(getLatestRecords()?.data).toEqual(new Uint32Array([0, 100]))

        currentRange = { startIndex: 80, endIndex: 140 }
        demandRanges = [
          { startIndex: 0, endIndex: 100 },
          { startIndex: 80, endIndex: 140 },
        ]
        publishDemand()
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(getLatestRecords()?.data).toEqual(new Uint32Array([80, 140])))
        expect(syntax.brackets).toEqual([])

        currentRange = { startIndex: 0, endIndex: 60 }
        syntax.refreshVisibleRange(1, { delayMs: 0 })
        await vi.waitFor(() => expect(getLatestRecords()?.data).toEqual(new Uint32Array([0, 60])))
        expect(syntax.status).toBe('ready')
        expect(query.mock.calls.some(([r]) => r.startIndex === 0 && r.endIndex === 60)).toBe(true)
        expect(syntax.brackets).toEqual([])
      } finally {
        syntax.dispose()
        pluginHost.dispose()
        analysis.dispose()
      }
    })
  })
})
