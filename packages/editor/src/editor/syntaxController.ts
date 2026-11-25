import {
  installSyntaxRangeProjector,
  readRetainedHighlighterResult,
  retainedSyntaxCanWarm,
  setRetainedSyntaxDisplayDemand,
} from './documentAnalysis'
import { installEditorSyntaxRuntime } from './syntaxRuntime'
import type {
  EditorDocumentAnalysis,
  EditorRetainedSyntaxSession,
  EditorRetainedHighlighterSession,
  EditorAnalysisDisplayDemand,
} from './documentAnalysis'
import type { DocumentSession, DocumentSessionChange } from '../documentSession'
import type { DocumentTextSnapshot } from '../documentTextSnapshot'
import type { PieceTableSnapshot } from '@singapore-editor/textbuffer'
import type {
  EditorInitialHighlightStatus,
  EditorInitialPaintEvent,
  EditorLogInput,
  EditorPluginHost,
} from '../plugins'
import type { EditorHighlightResult, EditorHighlighterSession } from '../syntax/highlighter'
import {
  createEmptySyntaxResult,
  isTerminalIncompleteSyntaxResult,
  syntaxResultCoversRange,
} from '../syntax/session'
import type {
  BracketInfo,
  EditorSyntaxCapture,
  EditorSyntaxInjection,
  EditorSyntaxRange,
  EditorSyntaxResult,
  EditorSyntaxSession,
} from '../syntax/session'
import type { EditorSyntaxLanguageId, FoldRange } from '../syntax/session'
import type { EditorTheme } from '../theme'
import { editorThemesEqual } from '../theme'
import { EditorTokenStore, toEditorTokenStore } from '../syntax/tokenStore'
import { createTextEditBatch } from '../textEditBatch'
import type { TextEdit } from '../tokens'
import { foldRangeKey } from './folds'
import { projectTokensThroughEdit, projectTokensThroughEdits } from './tokenProjection'
import type { EditorSyntaxStatus } from './types'
import { LatestAsyncRequest } from './latestAsyncRequest'
import { syntaxRefreshDelay, SYNTAX_REFRESH_MAX_DELAY_MS } from './editorUtils'
import {
  appendCachedSyntaxRange,
  compactSyntaxRangeTokens,
  compareFoldRanges,
  firstUncoveredSyntaxRange,
  foldIntersectsSyntaxRange,
  intersectSyntaxRanges,
  mergeSyntaxRanges,
  mergeTokensOnStrips,
  offsetInSyntaxRanges,
  projectResultThroughSteps,
  sameSyntaxRange,
  sameSyntaxRanges,
  subtractSyntaxRange,
  subtractSyntaxRanges,
  syntaxRangeCoverage,
  syntaxRangeListsIntersect,
  syntaxRangesIntersect,
} from './syntaxRangeProjection'
import type {
  EditorPreparedDocument,
  EditorPreparedDocumentPayload,
  EditorPreparedHighlighterBorrow,
  EditorPreparedStructuralConfiguration,
  EditorPreparedStructuralBorrow,
  EditorPreparedTagValue,
  EditorPreparedTabSizePolicy,
} from './preparedDocument'
import { nowMs } from './timing'
import {
  editorPerformanceDiagnosticsEnabled,
  recordEditorPerformanceDiagnostic,
  traceEditorPerformanceTask,
} from './performanceDiagnostics'

export type EditorSyntaxDocumentStartOptions = {
  readonly analysis?: EditorDocumentAnalysis | null
  readonly structuralConfigurationTag?: readonly EditorPreparedTagValue[]
  readonly highlighterConfigurationTag?: readonly EditorPreparedTagValue[]
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly snapshot: PieceTableSnapshot
  readonly textSnapshot: DocumentTextSnapshot
}

export type EditorPreparedDocumentBorrowOptions = {
  readonly configuredTabSize: number
  readonly tabSizePolicy: EditorPreparedTabSizePolicy
  readonly documentConfigurationTag: readonly EditorPreparedTagValue[]
  readonly highlighterConfigurationTag: readonly EditorPreparedTagValue[]
  readonly structuralConfigurationTag: readonly EditorPreparedTagValue[]
}

export type EditorSyntaxControllerOptions = {
  readonly pluginHost: EditorPluginHost
  getDocumentVersion(): number
  getDocumentId(): string | null
  getTextVersion(): number
  getCurrentSessionDocumentId(): string
  getLanguageId(): EditorSyntaxLanguageId | null
  getSession(): DocumentSession | null
  getVisibleSyntaxRange(): EditorSyntaxRange | null
  /** Just the rows on screen, without the text kept ready around them for scrolling. */
  getMountedSyntaxRange?(): EditorSyntaxRange | null
  adoptTokens(tokens: EditorTokenStore): void
  clearSyntaxFolds(): void
  setSyntaxFolds(folds: readonly FoldRange[]): void
  notifyChange(change: DocumentSessionChange | null): void
  notifyViewUpdate(): void
  onInitialPaint?(event: EditorInitialPaintEvent): void
  setSyntaxCaptures?(
    captures: readonly EditorSyntaxCapture[],
    records?: EditorSyntaxResult['records'],
  ): void
  /**
   * Whether anything downstream reads raw captures. Captures cost payload on every parse, so a
   * session asks for them only while an inline replacement provider is registered to consume them.
   */
  needsSyntaxCaptures?(): boolean
  notifyThemeChanged(): void
  log?(event: EditorLogInput): void
}

export type EditorSyntaxControllerFactory = (
  options: EditorSyntaxControllerOptions,
) => EditorSyntaxController

/**
 * What the editor's plain pipeline (`syntaxPipeline.ts`) hands over when this controller takes the
 * document from it.
 */
export type EditorPlainSyntaxState = {
  readonly analysis: EditorDocumentAnalysis | null
  readonly structuralConfigurationTag: readonly EditorPreparedTagValue[]
  readonly highlighterConfigurationTag: readonly EditorPreparedTagValue[]
  readonly disposed: boolean
  readonly initialHighlightState: EditorInitialHighlightStatus
  readonly initialPaintDocumentVersion: number
  readonly initialTextPainted: boolean
  readonly initialTextPaintEmitted: boolean
  readonly initialHighlightPaintEmitted: boolean
  readonly configurationGeneration: number
  readonly pendingReplacement: PendingInitialHighlightReplacement | null
  readonly includesCaptures: boolean
  readonly contentVersion: number
  readonly tokens: EditorTokenStore
  readonly acceptedCopyTokens: EditorTokenStore
  readonly acceptedTokensDocumentVersion: number
  readonly acceptedTokensTextVersion: number
  readonly copyOwner: 'none' | 'external'
  readonly externalBaseTokens: {
    readonly store: EditorTokenStore
    readonly snapshot: DocumentTextSnapshot
  } | null
}

export type EditorSyntaxRefreshOptions = {
  readonly delayMs?: number
  readonly range?: EditorSyntaxRange | null
}

export type EditorFallbackFoldReason =
  | 'no-language'
  | 'no-session'
  | 'unsupported'
  | 'structural-error'

export function fallbackFoldReason(options: {
  readonly languageId: EditorSyntaxLanguageId | null
  readonly session: Pick<EditorSyntaxSession, 'foldingSupport'> | null
  readonly status: EditorSyntaxStatus
}): EditorFallbackFoldReason | null {
  if (!options.session) return options.languageId ? 'no-session' : 'no-language'
  if (options.status === 'error') return 'structural-error'
  if (options.session.foldingSupport === 'unsupported') return 'unsupported'
  return null
}

type DocumentParseState =
  | { readonly kind: 'plain' }
  | { readonly kind: 'loading'; readonly contentVersion: number; readonly parseGeneration: number }
  | {
      readonly kind: 'parsed'
      readonly contentVersion: number
      readonly parseGeneration: number
      readonly parseId: number | null
      readonly mode: 'full' | 'range'
      readonly parseKind: 'full' | 'partial'
      readonly fullResult: EditorSyntaxResult | null
    }
  | { readonly kind: 'error'; readonly contentVersion: number; readonly parseGeneration: number }

type PublishedViewportScope =
  | { readonly kind: 'full'; readonly degraded: boolean }
  | {
      readonly kind: 'range'
      readonly range: EditorSyntaxRange
      readonly degraded: boolean
      readonly unavailable: boolean
    }

type CachedSyntaxRangeEntry = {
  readonly range: EditorSyntaxRange
  readonly result: EditorSyntaxResult
  readonly snapshot: DocumentTextSnapshot
  /** True for `analysis.kind === 'partial'` or `firstRows`: provides token coverage only. */
  readonly tokensOnly: boolean
  readonly firstRows: boolean
  readonly source: 'visible' | 'prefetch' | 'warm'
  /** Whether this entry's tokens are eligible to populate `copyTokens`. */
  readonly copyEligible: boolean
  /** Pairwise-disjoint sub-ranges of `range` for which this entry owns tokens. */
  readonly tokenOwnedRanges: readonly EditorSyntaxRange[]
  /** Pairwise-disjoint sub-ranges of `range` for which this entry owns complete scope facts. */
  readonly scopeOwnedRanges: readonly EditorSyntaxRange[]
  readonly folds: readonly FoldRange[]
  readonly brackets: readonly BracketInfo[]
  readonly injections: readonly EditorSyntaxInjection[]
  readonly captures: readonly EditorSyntaxCapture[]
  readonly tokens: EditorTokenStore
}

type CarriedRangeCache = {
  readonly parseId: number | null
  readonly entries: readonly CachedSyntaxRangeEntry[]
}

type RequestGuard = {
  readonly documentVersion: number
  readonly contentVersion: number
  readonly configurationGeneration: number
  readonly parseGeneration: number
}

type EditorSyntaxLoadSource = 'full' | 'visible' | 'prefetch' | 'warm'

type EditorSyntaxLoadResult = {
  readonly contentVersion: number
  readonly parseGeneration: number
  readonly parseId?: number | null
  readonly baseResult?: EditorSyntaxResult
  readonly range: EditorSyntaxRange | null
  readonly result: EditorSyntaxResult
  readonly source: EditorSyntaxLoadSource
  readonly skipApply?: boolean
  readonly suppressWarm?: boolean
  readonly updatesDocument?: boolean
  /** The rows on screen, asked for ahead of the visible range that is already on its way. */
  readonly firstRows?: boolean
  readonly promotedEntries?: readonly CachedSyntaxRangeEntry[]
  readonly promotedOnly?: boolean
  readonly visibleSequence?: number
  readonly rangeFailure?: {
    readonly range: EditorSyntaxRange
    readonly error: unknown
    readonly change: DocumentSessionChange | null
  }
}

type ViewportCompositionResult =
  | {
      readonly kind: 'composed'
      readonly contributors: readonly CachedSyntaxRangeEntry[]
      readonly folds: readonly FoldRange[]
      readonly brackets: readonly BracketInfo[]
      readonly injections: readonly EditorSyntaxInjection[]
      readonly captures: readonly EditorSyntaxCapture[]
      readonly records: EditorSyntaxResult['records']
      readonly degraded: boolean
    }
  | { readonly kind: 'needs-authoritative-records-query' }

type ReconcileViewportResult =
  | {
      readonly kind: 'settled'
      readonly degraded: boolean
      readonly contributors: readonly CachedSyntaxRangeEntry[]
      readonly promoted: boolean
      readonly scopeChanged: boolean
    }
  | { readonly kind: 'settled-degraded' }
  | { readonly kind: 'needs-authoritative-records-query' }
  | { readonly kind: 'incomplete' }

/**
 * A document with no colors yet is asked for the rows on screen before the full visible range,
 * when that leaves at least this much text for the second request. A smaller difference is not
 * worth a second answer.
 */
const FIRST_ROWS_MIN_SAVED_CHARS = 4_096

type PendingSyntaxPrefetch = {
  readonly contentVersion: number
  readonly documentVersion: number
  readonly parseGeneration: number
  readonly options: EditorSyntaxRefreshOptions
  readonly range: EditorSyntaxRange
}

type PendingSyntaxWarm = {
  readonly configurationGeneration: number
  readonly contentVersion: number
  readonly parseGeneration: number
  readonly delayMs: number
  readonly documentVersion: number
  readonly generation: number
  readonly seedRange: EditorSyntaxRange
}

type InitialHighlightReplacement = 'all' | 'syntax' | 'theme'

type PendingInitialHighlightReplacement = {
  readonly generation: number
  readonly kind: InitialHighlightReplacement
}

type SettledHighlightStatus = Exclude<EditorInitialHighlightStatus, 'idle' | 'loading'>

type PendingInitialHighlightThemeTerminal = {
  readonly configurationGeneration: number
  readonly status: SettledHighlightStatus
}

const BACKGROUND_SYNTAX_TILE_CHARS = 120_000

// Quiet time after which an edit's colors are refreshed without the debounce. Typing keys come
// closer together, so a typing burst refreshes once at its first key and then as debounced.
const EDIT_PAUSE_MS = 250

// Backoff before each retry of a failed highlight refresh. The last rung retries on a new
// highlighter session; the failure after it is terminal.
const HIGHLIGHT_RETRY_DELAYS_MS: readonly number[] = [100, 400]

const syntaxWorkTags = (
  documentVersion: number,
  contentVersion: number,
  source: EditorSyntaxLoadSource,
  range?: EditorSyntaxRange,
) => ({
  version: documentVersion,
  snapshotVersion: contentVersion,
  configuration: source,
  viewport: range ? `${range.startIndex}:${range.endIndex}` : null,
})

export class EditorSyntaxController {
  private analysis: EditorDocumentAnalysis | null = null
  private retainedSyntax: EditorRetainedSyntaxSession | null = null
  #retainedHighlighter: EditorRetainedHighlighterSession | null = null
  private structuralConfigurationTag: readonly EditorPreparedTagValue[] = []
  private highlighterConfigurationTag: readonly EditorPreparedTagValue[] = []
  private disposed = false
  #parseState: DocumentParseState = { kind: 'plain' }
  #parseGeneration = 0
  #acceptedContentVersion: number | null = null
  #acceptedParseGeneration: number | null = null
  #acceptedParseId: number | null = null
  #publishedScope: PublishedViewportScope | null = null
  #applyingRenderData = false
  #initialHighlightState: EditorInitialHighlightStatus = 'idle'
  #initialPaintDocumentVersion = 0
  #initialTextPainted = false
  #initialTextPaintEmitted = false
  #initialHighlightPaintEmitted = false
  #initialHighlightConfigurationGeneration = 0
  private pendingInitialHighlightReplacement: PendingInitialHighlightReplacement | null = null
  #pendingInitialHighlightThemeTerminal: PendingInitialHighlightThemeTerminal | null = null
  #highlighterThemePending = false
  #lastInitialHighlightTerminalStatus: SettledHighlightStatus | null = 'plain'
  #undebouncedRefreshClaimed = false
  private syntaxSession: EditorSyntaxSession | null = null
  #syntaxSessionIncludesCaptures = false
  #highlighterSession: EditorHighlighterSession | null = null
  // Refresh failures since the last success or re-entry (document, provider or highlighter theme).
  #failedHighlightRefreshes = 0
  #unsubscribeHighlighterTheme: (() => void) | null = null
  #unsubscribeProducedSyntax: (() => void) | null = null
  #unsubscribeProducedTokens: (() => void) | null = null
  #preparedSyntaxDisposer: (() => void) | null = null
  #preparedHighlighterDisposer: (() => void) | null = null
  #preparedInitialTokensInstalled = false
  #preparedStructuralContentVersion: number | null = null
  #preparedHighlighterContentVersion: number | null = null
  #providerHighlighterTheme: EditorTheme | null = null
  #highlighterTheme: EditorTheme | null = null
  #rangeEntries: readonly CachedSyntaxRangeEntry[] = []
  #carriedEntries: CarriedRangeCache | null = null
  #unavailableRanges: readonly EditorSyntaxRange[] = []
  #unavailableClearsScopeRanges: readonly EditorSyntaxRange[] = []
  #unavailableEmptyRange: EditorSyntaxRange | null = null
  #unavailableEmptyClearsScope = false
  #unavailableRecordsRange: EditorSyntaxRange | null = null
  #unavailableRecordsClearsScope = false
  #observingPreparedStructural = false
  readonly #syntaxRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.document',
    taskClass: 'background-derived',
  })
  private readonly rangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.visibleRange',
    taskClass: 'viewport-derived',
  })
  readonly #prefetchRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.prefetchRange',
    taskClass: 'idle-cache',
  })
  readonly #warmRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.warmRange',
    taskClass: 'idle-cache',
  })
  readonly #highlightRequests = new LatestAsyncRequest<EditorHighlightResult>({
    key: 'editor.syntax.highlight',
    taskClass: 'background-derived',
  })
  readonly #highlighterThemeRequests = new LatestAsyncRequest<EditorTheme | null | undefined>({
    key: 'editor.syntax.highlighterTheme',
    taskClass: 'background-derived',
  })
  #currentTokens = EditorTokenStore.empty()
  #rangeTokenOwner: {
    readonly store: EditorTokenStore
    readonly snapshot: DocumentTextSnapshot
  } | null = null
  #externalBaseTokens: {
    readonly store: EditorTokenStore
    readonly snapshot: DocumentTextSnapshot
  } | null = null
  #pendingUnownedStrips: readonly EditorSyntaxRange[] = []
  #projectedRangeTokens: EditorTokenStore | null = null
  #awaitingProjectedEditTokens = false
  #copyOwner: 'none' | 'range' | 'external' = 'none'
  #rangeCopyTokens = EditorTokenStore.empty()
  private rangeCopyOwner: {
    readonly store: EditorTokenStore
    readonly contributor: CachedSyntaxRangeEntry
  } | null = null
  #rangeScopeOwners: readonly CachedSyntaxRangeEntry[] = []
  private stoppedWarm: {
    readonly snapshot: DocumentTextSnapshot
    readonly configurationGeneration: number
  } | null = null
  #lastFrameDemand: {
    readonly kind: 'frame'
    readonly snapshot: DocumentTextSnapshot
    readonly ranges: readonly EditorSyntaxRange[]
  } | null = null
  #lastRangeTrim: {
    readonly snapshot: DocumentTextSnapshot
    readonly ranges: readonly EditorSyntaxRange[]
    readonly cache: readonly CachedSyntaxRangeEntry[]
    readonly store: EditorTokenStore
  } | null = null
  #acceptedCopyTokens = EditorTokenStore.empty()
  #acceptedTokensDocumentVersion = -1
  #acceptedTokensTextVersion = -1
  #currentBrackets: readonly BracketInfo[] = []
  #currentInjections: readonly EditorSyntaxInjection[] = []
  #syntaxContentVersion = 0
  #visibleRangeSequence = 0
  #pendingVisibleRange: {
    readonly documentVersion: number
    readonly contentVersion: number
    readonly parseGeneration: number
    readonly range: EditorSyntaxRange
    readonly bypassCache: boolean
  } | null = null
  #pendingPrefetch: PendingSyntaxPrefetch | null = null
  private pendingWarm: PendingSyntaxWarm | null = null
  #warmGeneration = 0
  #lastStructuralEditRefreshAt = Number.NEGATIVE_INFINITY

  constructor(private readonly options: EditorSyntaxControllerOptions) {
    installSyntaxRangeProjector(projectResultThroughSteps)
  }

  /**
   * Takes the document over from the plain pipeline the editor ran before its first provider was
   * installed, as though this controller had been running it with no provider all along.
   */
  adoptPlainState(state: EditorPlainSyntaxState): void {
    this.analysis = state.analysis
    this.structuralConfigurationTag = state.structuralConfigurationTag
    this.highlighterConfigurationTag = state.highlighterConfigurationTag
    this.disposed = state.disposed
    this.#initialHighlightState = state.initialHighlightState
    this.#initialPaintDocumentVersion = state.initialPaintDocumentVersion
    this.#initialTextPainted = state.initialTextPainted
    this.#initialTextPaintEmitted = state.initialTextPaintEmitted
    this.#initialHighlightPaintEmitted = state.initialHighlightPaintEmitted
    this.#initialHighlightConfigurationGeneration = state.configurationGeneration
    this.pendingInitialHighlightReplacement = state.pendingReplacement
    this.#syntaxSessionIncludesCaptures = state.includesCaptures
    this.#syntaxContentVersion = state.contentVersion
    this.#currentTokens = state.tokens
    this.#acceptedCopyTokens = state.acceptedCopyTokens
    this.#acceptedTokensDocumentVersion = state.acceptedTokensDocumentVersion
    this.#acceptedTokensTextVersion = state.acceptedTokensTextVersion
    this.#copyOwner = state.copyOwner
    this.#externalBaseTokens = state.externalBaseTokens
  }

  setDisplayDemand(demand: EditorAnalysisDisplayDemand): void {
    if (demand.kind === 'frame') {
      this.#lastFrameDemand = {
        kind: 'frame',
        snapshot: demand.snapshot,
        ranges: demand.ranges,
      }
    } else if (demand.kind === 'unknown') {
      this.#lastFrameDemand = null
    }
    const tokens = this.#currentTokens
    const discarded = this.#trimRangeCache(demand)
    if (this.retainedSyntax) {
      setRetainedSyntaxDisplayDemand(
        this.retainedSyntax,
        demand,
        this.#rangeContributors(demand),
        discarded,
      )
      if (this.pendingWarm && !retainedSyntaxCanWarm(this.retainedSyntax))
        this.#cancelOptionalWarm()
    }
    if (tokens !== this.#currentTokens) this.options.adoptTokens(this.#currentTokens)
  }

  #rangeContributors(
    demand: EditorAnalysisDisplayDemand,
  ): readonly CachedSyntaxRangeEntry[] | null {
    if (demand.kind !== 'frame' || demand.snapshot !== this.options.getSession()?.getTextSnapshot())
      return null
    const seen = new Set<CachedSyntaxRangeEntry>()
    const contributors: CachedSyntaxRangeEntry[] = []
    const add = (entry: CachedSyntaxRangeEntry): void => {
      if (entry.snapshot !== demand.snapshot || seen.has(entry)) return
      seen.add(entry)
      contributors.push(entry)
    }
    for (const entry of this.#rangeEntries) add(entry)
    if (this.rangeCopyOwner?.store === this.copyTokens) add(this.rangeCopyOwner.contributor)
    for (const owner of this.#rangeScopeOwners) add(owner)
    return contributors
  }

  #trimRangeCache(demand: EditorAnalysisDisplayDemand): readonly CachedSyntaxRangeEntry[] | null {
    if (demand.kind !== 'frame') return null
    if (demand.snapshot !== this.options.getSession()?.getTextSnapshot()) return null
    if (this.#applyingRenderData) return null
    const visible = this.options.getVisibleSyntaxRange()
    const shown = visible ? appendCachedSyntaxRange(demand.ranges, visible) : demand.ranges
    const previous = this.#lastRangeTrim
    if (
      previous?.snapshot === demand.snapshot &&
      previous.cache === this.#rangeEntries &&
      previous.store === this.#currentTokens &&
      sameSyntaxRanges(previous.ranges, shown)
    )
      return null

    const oldCache = this.#rangeEntries
    const rangeOwned =
      !this.#highlighterSession &&
      this.#rangeTokenOwner?.store === this.#currentTokens &&
      this.#rangeTokenOwner.snapshot === demand.snapshot
    const retained = new Set<CachedSyntaxRangeEntry>()

    // 1. Authoritative token owners (and fold/scope owners, since scopeOwnedRanges ⊆ tokenOwnedRanges)
    //    for shown text.
    for (const entry of oldCache) {
      if (
        syntaxRangeListsIntersect(entry.tokenOwnedRanges, shown) ||
        (entry.range.endIndex <= entry.range.startIndex &&
          visible !== null &&
          sameSyntaxRange(entry.range, visible))
      ) {
        retained.add(entry)
      }
    }

    // 2. Active viewport scope owners.
    for (const owner of this.#rangeScopeOwners) {
      if (owner.snapshot === demand.snapshot && oldCache.includes(owner)) retained.add(owner)
    }

    // 4. Single most recent prefetch intersecting shown.
    for (let index = oldCache.length - 1; index >= 0; index -= 1) {
      const entry = oldCache[index]!
      if (entry.source === 'prefetch' && syntaxRangeListsIntersect([entry.range], shown)) {
        retained.add(entry)
        break
      }
    }

    // 5. Active range copy owner (only when still matching copyTokens and current snapshot).
    const copyContributor =
      this.rangeCopyOwner?.store === this.copyTokens ? this.rangeCopyOwner.contributor : null
    if (copyContributor && copyContributor.snapshot === demand.snapshot) {
      for (const entry of oldCache) {
        if (
          entry === copyContributor ||
          (entry.result === copyContributor.result &&
            sameSyntaxRange(entry.range, copyContributor.range))
        ) {
          retained.add(entry)
        }
      }
    }

    const nextCache = oldCache.filter((entry) => retained.has(entry))
    const discardedOffDemand = oldCache.filter(
      (entry) => !retained.has(entry) && !syntaxRangeListsIntersect([entry.range], shown),
    )

    // Prune unavailable markers outside shown demand.
    this.#unavailableRanges = this.#unavailableRanges.filter((range) =>
      syntaxRangeListsIntersect([range], shown),
    )
    this.#unavailableClearsScopeRanges = this.#unavailableClearsScopeRanges.filter((range) =>
      syntaxRangeListsIntersect([range], shown),
    )
    if (
      this.#unavailableEmptyRange &&
      (!visible || !sameSyntaxRange(this.#unavailableEmptyRange, visible))
    ) {
      this.#unavailableEmptyRange = null
      this.#unavailableEmptyClearsScope = false
    }
    if (
      this.#unavailableRecordsRange &&
      !syntaxRangeListsIntersect([this.#unavailableRecordsRange], shown) &&
      (!visible || !sameSyntaxRange(this.#unavailableRecordsRange, visible))
    ) {
      this.#unavailableRecordsRange = null
      this.#unavailableRecordsClearsScope = false
    }

    const removed = nextCache.length !== oldCache.length
    this.#rangeEntries = nextCache
    if (removed) {
      if (rangeOwned) {
        const tokenRanges = this.#tokenCoverage(nextCache)
        const tokens = compactSyntaxRangeTokens(this.#currentTokens, tokenRanges)
        this.#currentTokens = tokens
        this.#rangeTokenOwner = { store: tokens, snapshot: demand.snapshot }
      } else if (!this.#highlighterSession) {
        const removedEntries = oldCache.filter((entry) => !retained.has(entry))
        const evictedRanges = this.#tokenCoverage(removedEntries)
        if (evictedRanges.length > 0) {
          const fallback =
            this.#externalBaseTokens?.snapshot === demand.snapshot
              ? this.#externalBaseTokens.store
              : EditorTokenStore.empty()
          this.#currentTokens = mergeTokensOnStrips(this.#currentTokens, fallback, evictedRanges)
        }
      }
      if (!this.#highlighterSession && this.#copyOwner === 'range') {
        this.#compactRangeCopyStore(nextCache, this.#currentTokens, rangeOwned)
      }
    }
    if (discardedOffDemand.length > 0 && !this.retainedSyntax)
      this.#stopOptionalWarm(demand.snapshot)
    this.#lastRangeTrim = {
      snapshot: demand.snapshot,
      ranges: shown,
      cache: nextCache,
      store: this.#currentTokens,
    }
    return discardedOffDemand
  }

  #compactRangeCopyStore(
    entries: readonly CachedSyntaxRangeEntry[],
    currentTokens: EditorTokenStore,
    rangeOwned: boolean,
  ): void {
    const copyEntries = entries.filter((entry) => entry.copyEligible)
    const allCopyEligible = copyEntries.length === entries.length
    const nextCopyTokens =
      allCopyEligible && rangeOwned
        ? currentTokens
        : compactSyntaxRangeTokens(this.#rangeCopyTokens, this.#tokenCoverage(copyEntries))
    this.#rangeCopyTokens = nextCopyTokens
    const currentContributor = this.rangeCopyOwner?.contributor ?? null
    const nextContributor =
      currentContributor && copyEntries.includes(currentContributor)
        ? currentContributor
        : this.#primaryCopyContributor(copyEntries)
    this.rangeCopyOwner = nextContributor
      ? { store: nextCopyTokens, contributor: nextContributor }
      : null
    if (
      this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
      this.#acceptedTokensTextVersion === this.options.getTextVersion()
    ) {
      this.#acceptedCopyTokens = nextCopyTokens
    }
  }

  #primaryCopyContributor(
    entries: readonly CachedSyntaxRangeEntry[],
  ): CachedSyntaxRangeEntry | null {
    const visibleRange = this.options.getVisibleSyntaxRange()
    if (visibleRange) {
      const visibleCovering = entries.find(
        (entry) =>
          entry.copyEligible &&
          entry.source === 'visible' &&
          (visibleRange.endIndex <= visibleRange.startIndex
            ? sameSyntaxRange(entry.range, visibleRange)
            : syntaxRangeListsIntersect(entry.tokenOwnedRanges, [visibleRange])),
      )
      if (visibleCovering) return visibleCovering
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.copyEligible && entry.source !== 'prefetch') return entry
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.copyEligible) return entry
    }
    return null
  }

  #stopOptionalWarm(snapshot: DocumentTextSnapshot): void {
    this.stoppedWarm = {
      snapshot,
      configurationGeneration: this.#initialHighlightConfigurationGeneration,
    }
    this.#cancelOptionalWarm()
  }

  #cancelOptionalWarm(): void {
    this.#nextWarmGeneration()
    this.pendingWarm = null
    this.#warmRangeRequests.cancel()
  }

  #structuralBaseStatus(): EditorSyntaxStatus {
    const state = this.#parseState
    if (state.kind === 'plain') return 'plain'
    if (state.kind === 'error') return 'error'
    if (state.kind === 'loading') return 'loading'
    const scope = this.#publishedScope
    if (!scope) return 'loading'
    if (scope.kind === 'full') {
      if (state.parseKind === 'partial' && !scope.degraded) return 'loading'
      return scope.degraded ? 'degraded' : 'ready'
    }
    return scope.degraded ? 'degraded' : 'ready'
  }

  get status(): EditorSyntaxStatus {
    const state = this.#parseState
    if (state.kind === 'plain') return 'plain'
    if (state.kind === 'error') return 'error'
    if (state.kind === 'loading') return 'loading'
    const scope = this.#publishedScope
    if (!scope) return 'loading'
    if (scope.kind === 'full') {
      if (state.parseKind === 'partial' && !scope.degraded) return 'loading'
      return scope.degraded ? 'degraded' : 'ready'
    }
    const visible = this.options.getVisibleSyntaxRange()
    if (visible === null) return 'loading'
    if (visible.endIndex <= visible.startIndex) {
      return sameSyntaxRange(visible, scope.range)
        ? scope.degraded
          ? 'degraded'
          : 'ready'
        : 'loading'
    }
    if (syntaxRangeCoverage(visible, [scope.range]) !== 'full') return 'loading'
    return scope.degraded ? 'degraded' : 'ready'
  }

  get usesFallbackFolds(): boolean {
    return this.fallbackFoldReason !== null
  }

  get fallbackFoldReason(): EditorFallbackFoldReason | null {
    return fallbackFoldReason({
      languageId: this.options.getLanguageId(),
      session: this.syntaxSession,
      status: this.#structuralBaseStatus(),
    })
  }

  get fallbackFoldSelection() {
    return {
      reason: this.fallbackFoldReason,
      provider: this.#structuralProviderKind(),
      foldingSupport: this.syntaxSession?.foldingSupport ?? null,
      structuralStatus: this.#structuralBaseStatus(),
      structuralSession: this.syntaxSession !== null,
      structuralSuppression: this.fallbackFoldReason === null,
      configurationGeneration: this.#initialHighlightConfigurationGeneration,
    }
  }

  #structuralProviderKind(): 'plugin' | null {
    if (this.options.pluginHost.hasSyntaxProviders()) return 'plugin'
    return null
  }

  #publishedScopeCoversViewport(): boolean {
    const scope = this.#publishedScope
    if (!scope) return false
    if (scope.kind === 'full') {
      return (
        this.#parseState.kind === 'parsed' &&
        (this.#parseState.parseKind !== 'partial' || scope.degraded)
      )
    }
    const visible = this.options.getVisibleSyntaxRange()
    if (!visible) return false
    if (visible.endIndex <= visible.startIndex) return sameSyntaxRange(visible, scope.range)
    return syntaxRangeCoverage(visible, [scope.range]) === 'full'
  }

  get renderDataReady(): boolean {
    return (
      !this.#applyingRenderData &&
      this.#initialHighlightState !== 'loading' &&
      this.status !== 'loading'
    )
  }

  get initialHighlightStatus(): EditorInitialHighlightStatus {
    return this.#initialHighlightState
  }

  /**
   * The document has a syntax or highlighter session and none of its results has landed yet, so no
   * colors are on screen for an edit to leave stale.
   */
  get awaitingFirstHighlight(): boolean {
    return this.#lastInitialHighlightTerminalStatus === null
  }

  /**
   * True once per document, for the first edit that arrives while nothing is colored yet: that
   * one skips the typing debounce. The edits after it are debounced and coalesced as usual, so
   * a burst of keys before the first colors asks for syntax twice, not once per key.
   */
  claimUndebouncedRefresh(): boolean {
    if (!this.awaitingFirstHighlight || this.#undebouncedRefreshClaimed) return false
    this.#undebouncedRefreshClaimed = true
    return true
  }

  get copyTokens(): EditorTokenStore {
    if (
      this.#acceptedTokensDocumentVersion !== this.options.getDocumentVersion() ||
      this.#acceptedTokensTextVersion !== this.options.getTextVersion()
    )
      return EditorTokenStore.empty()
    return this.#acceptedCopyTokens
  }

  get tokens(): EditorTokenStore {
    return this.#currentTokens
  }

  /**
   * Bracket positions from the last structural parse, sorted by offset. Empty while a windowed
   * parse is in flight, because a partial list would pair brackets across a hole it cannot see.
   */
  get brackets(): readonly BracketInfo[] {
    return this.#currentBrackets
  }

  /**
   * The stretches the last structural parse handed to another grammar, so that anything acting on a
   * position can ask which language actually owns it instead of assuming the file's own.
   */
  get injections(): readonly EditorSyntaxInjection[] {
    return this.#currentInjections
  }

  get providerTheme(): EditorTheme | null {
    return this.#providerHighlighterTheme
  }

  get theme(): EditorTheme | null {
    return this.#highlighterTheme
  }

  setTokens(tokens: EditorTokenStore, current = true, copyTokens = tokens): void {
    this.#applyTokens(tokens, current, copyTokens, 'external')
  }

  #applyTokens(
    tokens: EditorTokenStore,
    current: boolean,
    copyTokens: EditorTokenStore,
    owner: 'none' | 'range' | 'external',
  ): void {
    if (this.#rangeTokenOwner?.store !== tokens) this.#rangeTokenOwner = null
    if (current) {
      this.#projectedRangeTokens = null
      this.#awaitingProjectedEditTokens = false
    } else if (this.#awaitingProjectedEditTokens) {
      this.#awaitingProjectedEditTokens = false
      this.#projectedRangeTokens = tokens
    } else if (tokens !== this.#currentTokens) {
      this.#projectedRangeTokens = null
    }
    if (!current || owner !== 'range' || this.rangeCopyOwner?.store !== copyTokens) {
      this.rangeCopyOwner = null
    }
    if (!current && tokens !== this.#currentTokens) {
      this.#acceptedCopyTokens = EditorTokenStore.empty()
      if (this.#copyOwner === 'range') this.#copyOwner = 'none'
    }
    const previousTokens = this.#currentTokens
    this.#currentTokens = tokens
    if (current) {
      this.#copyOwner = owner
      this.#pendingUnownedStrips = []
      if (owner === 'external') {
        const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
        this.#externalBaseTokens = snapshot ? { store: tokens, snapshot } : null
      } else {
        this.#externalBaseTokens = null
      }
      if (owner !== 'range') this.rangeCopyOwner = null
      this.#acceptedCopyTokens = copyTokens
      this.#acceptedTokensDocumentVersion = this.options.getDocumentVersion()
      this.#acceptedTokensTextVersion = this.options.getTextVersion()
    }
    if (this.#preparedInitialTokensInstalled) {
      this.#preparedInitialTokensInstalled = false
      if (tokens === previousTokens) return
    }
    this.options.adoptTokens(tokens)
  }

  setExternalTokens(tokens: EditorTokenStore): void {
    if (!this.#highlighterSession) {
      this.setTokens(tokens)
      return
    }
    this.#commitInitialHighlightStatus(
      'painted',
      () => this.setTokens(tokens),
      this.#initialHighlightConfigurationGeneration,
    )
  }

  stagePreparedReadyTokens(prepared: EditorPreparedDocumentPayload | null): EditorTokenStore {
    const highlighterResult = prepared?.highlighter?.readyResult
    const canRange = Boolean(this.syntaxSession?.queryRange && this.#canProviderQuerySyntaxRange())
    const structuralResult = prepared?.structural?.readyResult
      ? canRange
        ? prepared.structural.readyResult
        : (this.retainedSyntax?.readBaseResult() ?? prepared.structural.readyResult)
      : undefined
    const structuralTokens = prepared?.highlighter ? undefined : structuralResult?.tokens
    const tokens = highlighterResult?.tokens ?? toEditorTokenStore(structuralTokens ?? [])

    this.#currentTokens = tokens
    const structural = prepared?.structural
    const read = canRange ? structural?.session.read(structural.range) : undefined
    this.#rangeTokenOwner =
      !prepared?.highlighter &&
      canRange &&
      read?.kind === 'ready' &&
      read.result === structuralResult
        ? { store: tokens, snapshot: read.snapshot }
        : null
    this.#preparedInitialTokensInstalled = Boolean(highlighterResult || structuralTokens)
    if (highlighterResult?.theme !== undefined) this.#setHighlighterTheme(highlighterResult.theme)
    return tokens
  }

  borrowPreparedDocument(
    document: EditorSyntaxDocumentStartOptions,
    preparedDocument: EditorPreparedDocument,
    tags: EditorPreparedDocumentBorrowOptions,
  ): EditorPreparedDocumentPayload | null {
    const highlighter = this.options.pluginHost.getHighlighterProvider()
    const structuralProvider = this.options.pluginHost.getSyntaxProvider()
    const structuralConfiguration = this.#preparedStructuralConfiguration(
      document.languageId,
      structuralProvider !== null,
      highlighter !== null,
    )
    return preparedDocument.borrow({
      configuredTabSize: tags.configuredTabSize,
      tabSizePolicy: tags.tabSizePolicy,
      documentId: document.documentId,
      languageId: document.languageId,
      snapshot: document.snapshot,
      documentConfigurationTag: tags.documentConfigurationTag,
      structuralProvider,
      highlighterProvider: highlighter?.provider ?? null,
      highlighterThemeProviders: highlighter?.themeProviders ?? [],
      structuralConfiguration,
      structuralConfigurationTag: tags.structuralConfigurationTag,
      highlighterConfigurationTag: tags.highlighterConfigurationTag,
    })
  }

  startDocument(
    document: EditorSyntaxDocumentStartOptions,
    prepared: EditorPreparedDocumentPayload | null = null,
  ): void {
    if (this.disposed) return

    this.#advanceInitialHighlightConfigurationGeneration()
    this.#disposeSyntaxSession()
    this.#disposeHighlighterSession()
    this.#externalBaseTokens = null
    this.#pendingUnownedStrips = []
    this.#clearSyntaxRangeCache()
    this.#copyOwner = 'none'
    this.#resetSyntaxContentVersion()
    this.#parseGeneration += 1
    this.#lastFrameDemand = null
    this.#currentBrackets = []
    this.#currentInjections = []
    this.analysis = document.analysis ?? null
    this.structuralConfigurationTag = document.structuralConfigurationTag ?? []
    this.highlighterConfigurationTag = document.highlighterConfigurationTag ?? []
    this.#failedHighlightRefreshes = 0
    this.#highlighterSession =
      prepared?.highlighter?.session ?? this.#createHighlighterSession(document.languageId)
    if (prepared?.highlighter) this.#retainedHighlighter = prepared.highlighter.session
    this.#preparedHighlighterDisposer = prepared?.highlighter?.dispose ?? null
    this.#observeHighlighterTheme()
    this.syntaxSession = prepared?.structural?.session ?? this.#createSyntaxSession(document)
    if (prepared?.structural) this.retainedSyntax = prepared.structural.session
    this.retainedSyntax?.setDisplayDemand({ kind: 'unknown' })
    this.#preparedSyntaxDisposer = prepared?.structural?.dispose ?? null
    this.#preparedStructuralContentVersion = prepared?.structural
      ? this.#syntaxContentVersion
      : null
    this.#preparedHighlighterContentVersion = prepared?.highlighter
      ? this.#syntaxContentVersion
      : null
    if (prepared?.structural) {
      this.#syntaxSessionIncludesCaptures = prepared.structural.configuration.includeCaptures
    }
    this.#parseState = this.syntaxSession
      ? {
          kind: 'loading',
          contentVersion: this.#syntaxContentVersion,
          parseGeneration: this.#parseGeneration,
        }
      : { kind: 'plain' }
    this.#initialPaintDocumentVersion = this.options.getDocumentVersion()
    this.#initialTextPainted = false
    this.#initialTextPaintEmitted = false
    this.#initialHighlightPaintEmitted = false
    this.pendingInitialHighlightReplacement = null
    this.#preparedInitialTokensInstalled = false
    this.#initialHighlightState =
      this.#highlighterSession || this.syntaxSession || this.#highlighterThemePending
        ? 'loading'
        : 'plain'
    this.#lastInitialHighlightTerminalStatus =
      this.#initialHighlightState === 'plain' ? 'plain' : null
    this.#undebouncedRefreshClaimed = false
    if (this.#retainedHighlighter) {
      this.refreshHighlighterTheme(false)
    }
    this.#observeProducedHighlighterTokens()
    this.#observeProducedStructuralSyntax()
    this.#observePreparedResults(prepared)
    this.#logSyntaxStatus('editor.syntax.document_started')
  }

  adoptPreparedReadyResults(
    prepared: EditorPreparedDocumentPayload | null,
    prefetchRange?: EditorSyntaxRange | null,
  ): void {
    if (!prepared) return

    const guard = this.#captureRequestGuard()
    const readyStructural = prepared.structural?.readyResult ?? null
    if (prepared.structural && readyStructural) {
      this.#applyPreparedStructuralResult(prepared.structural, readyStructural, guard)
      this.#adoptReadyPrefetch(prefetchRange, guard)
    } else if (prepared.structural) {
      if (!this.#observingPreparedStructural) {
        this.#observePreparedStructural(prepared.structural, guard)
      }
    } else {
      this.#adoptReadyStructuralAnalysis(prefetchRange, guard)
    }
    if (prepared.highlighter?.readyResult) {
      this.#applyHighlightResult(
        prepared.highlighter.readyResult,
        guard.documentVersion,
        nowMs(),
        guard.configurationGeneration,
      )
    }
  }

  adoptReadyAnalysis(prefetchRange?: EditorSyntaxRange | null): void {
    const guard = this.#captureRequestGuard()
    this.#adoptReadyStructuralAnalysis(prefetchRange, guard)
    const highlighter = this.#retainedHighlighter?.read()
    if (highlighter?.kind === 'ready') {
      this.#consumeRetainedProviderTheme()
      this.#applyHighlightResult(
        highlighter.result,
        guard.documentVersion,
        nowMs(),
        guard.configurationGeneration,
      )
    }
  }

  #adoptReadyStructuralAnalysis(
    prefetchRange: EditorSyntaxRange | null | undefined,
    guard: RequestGuard,
  ): void {
    const canRange = Boolean(this.syntaxSession?.queryRange && this.#canProviderQuerySyntaxRange())
    const visible = canRange ? this.options.getVisibleSyntaxRange() : null
    const structural = this.retainedSyntax?.read(visible ?? undefined)
    if (structural?.kind !== 'ready') return
    const cachedRange = structural.range ?? structural.result.projection.requestedRanges[0]
    const adoptedRange =
      canRange &&
      visible &&
      cachedRange &&
      cachedRange.startIndex <= visible.startIndex &&
      cachedRange.endIndex >= visible.endIndex
        ? cachedRange
        : visible
    const range = canRange ? adoptedRange : null
    const baseResult = this.retainedSyntax?.readBaseResult() ?? structural.result
    this.#applySyntaxResult(
      {
        contentVersion: guard.contentVersion,
        parseGeneration: guard.parseGeneration,
        parseId: this.retainedSyntax?.currentParseId() ?? null,
        baseResult,
        range,
        result: range ? structural.result : baseResult,
        source: range ? 'visible' : 'full',
        suppressWarm: true,
        updatesDocument: true,
      },
      guard,
      nowMs(),
    )
    if (canRange) this.#adoptReadyPrefetch(prefetchRange, guard)
  }

  #adoptReadyPrefetch(
    prefetchRange: EditorSyntaxRange | null | undefined,
    guard: RequestGuard,
  ): void {
    if (!prefetchRange || !this.retainedSyntax || !this.#canQueryCurrentSyntaxRange()) return
    if (this.#rangeCoveredByTokens(prefetchRange)) return
    const ready = this.retainedSyntax.read(prefetchRange)
    if (ready.kind !== 'ready' || ready.result.projection.analysis?.kind === 'partial') return
    const cachedRange = ready.range ?? prefetchRange
    if (syntaxRangeCoverage(prefetchRange, [cachedRange]) !== 'full') return
    this.#applySyntaxResult(
      {
        contentVersion: guard.contentVersion,
        parseGeneration: guard.parseGeneration,
        parseId: this.retainedSyntax.currentParseId(),
        baseResult: ready.result,
        range: cachedRange,
        result: ready.result,
        source: 'prefetch',
        suppressWarm: true,
        updatesDocument: false,
      },
      guard,
      nowMs(),
    )
  }

  notifyBaseTextPainted(): void {
    if (this.#initialPaintDocumentVersion !== this.options.getDocumentVersion()) return

    this.#initialTextPainted = true
    if (!this.#initialTextPaintEmitted) {
      this.#initialTextPaintEmitted = true
      this.options.onInitialPaint?.({ ...this.#initialPaintEventBase(), phase: 'text' })
    }
    this.#emitInitialHighlightPaintIfReady()
  }

  clearDocument(): void {
    this.#advanceInitialHighlightConfigurationGeneration()
    this.#parseGeneration += 1
    this.#parseState = { kind: 'plain' }
    this.#lastFrameDemand = null
    this.#initialHighlightState = 'idle'
    this.#failedHighlightRefreshes = 0
    this.#initialPaintDocumentVersion = this.options.getDocumentVersion()
    this.#initialTextPainted = false
    this.#initialTextPaintEmitted = false
    this.#initialHighlightPaintEmitted = false
    this.pendingInitialHighlightReplacement = null
    this.#preparedInitialTokensInstalled = false
    this.#lastInitialHighlightTerminalStatus = 'plain'
    this.#currentBrackets = []
    this.#currentInjections = []
    this.#externalBaseTokens = null
    this.#pendingUnownedStrips = []
    this.#clearSyntaxRangeCache()
    this.#copyOwner = 'none'
    this.#resetSyntaxContentVersion()
    this.#disposeSyntaxSession()
    this.#disposeHighlighterSession()
    this.analysis = null
    this.refreshHighlighterTheme()
    this.#logSyntaxStatus('editor.syntax.document_cleared')
  }

  dispose(): void {
    this.disposed = true
    this.#parseGeneration += 1
    this.#parseState = { kind: 'plain' }
    this.#lastFrameDemand = null
    this.analysis = null
    this.#highlighterThemeRequests.dispose()
    this.#disposeSyntaxSession()
    this.#disposeHighlighterSession()
  }

  /**
   * Reparses when the capture requirement flips. A provider that registers after the document
   * started — plugin activation is async — would otherwise wait for the next edit to see captures,
   * and the first one it ever gets is the one it needs to paint the file it was opened on.
   */
  syncCaptureRequirement(): void {
    if (this.disposed) return
    if ((this.options.needsSyntaxCaptures?.() ?? false) === this.#syntaxSessionIncludesCaptures)
      return

    this.reloadSyntaxSession()
  }

  reloadHighlighterAndSyntax(): void {
    this.#beginInitialHighlightReplacement('all')
    this.#failedHighlightRefreshes = 0
    this.#reloadHighlighterSession()
    this.reloadSyntaxSession(false)
    if (!this.options.getSession()) this.refreshHighlighterTheme()
    this.#settlePlainInitialHighlightIfNeeded()
  }

  reloadSyntaxSession(resetInitialHighlight = true): void {
    // Plugin activation resolves async; a provider-changed callback can land
    // after dispose (StrictMode tears the editor down before tree-sitter
    // registers). Recreating a session then leaks an undisposed worker parse.
    if (this.disposed) return

    if (resetInitialHighlight) this.#beginInitialHighlightReplacement('syntax')

    this.#parseGeneration += 1
    this.#disposeSyntaxSession()
    this.#clearSyntaxRangeCache()
    this.#currentBrackets = []
    this.#currentInjections = []

    const session = this.options.getSession()
    if (!session) {
      this.#parseState = { kind: 'plain' }
      this.#settlePlainInitialHighlightIfNeeded()
      return
    }

    this.syntaxSession = this.#createSyntaxSession({
      documentId: this.options.getCurrentSessionDocumentId(),
      languageId: this.options.getLanguageId(),
      textSnapshot: session.getTextSnapshot(),
      snapshot: session.getSnapshot(),
    })
    this.#observeProducedStructuralSyntax()
    this.#parseState = this.syntaxSession
      ? {
          kind: 'loading',
          contentVersion: this.#syntaxContentVersion,
          parseGeneration: this.#parseGeneration,
        }
      : { kind: 'plain' }
    this.options.clearSyntaxFolds()
    this.#logSyntaxStatus('editor.syntax.reloaded')
    const configurationGeneration = this.#initialHighlightConfigurationGeneration
    if (
      !this.syntaxSession &&
      this.#highlighterSession &&
      this.#pendingReplacementMatches('syntax', configurationGeneration)
    ) {
      const terminalStatus = this.#lastInitialHighlightTerminalStatus ?? 'painted'
      this.#commitInitialHighlightStatus(
        terminalStatus,
        () => this.setTokens(this.#currentTokens, false),
        configurationGeneration,
      )
    }
    const documentVersion = this.options.getDocumentVersion()
    if (resetInitialHighlight) this.refresh(documentVersion, null)
    else this.#refreshStructuralSyntax(documentVersion, null)
    this.options.notifyChange(null)
    this.#settlePlainInitialHighlightIfNeeded()
  }

  beginThemeReplacement(): number {
    return this.#beginInitialHighlightReplacement('theme')
  }

  completeThemeReplacement(configurationGeneration: number): boolean {
    if (!this.options.getSession()) return false
    if (!this.#pendingReplacementMatches('theme', configurationGeneration)) return false

    const status =
      this.#lastInitialHighlightTerminalStatus ?? this.#currentApplicableTerminalStatus()
    if (status === null) return false
    this.#commitInitialHighlightStatus(
      status,
      () => this.setTokens(this.#currentTokens, false),
      configurationGeneration,
    )
    return true
  }

  refreshHighlighterTheme(retryFailed = true): void {
    if (this.#retainedHighlighter) {
      const retained = this.#retainedHighlighter
      this.#highlighterThemeRequests.cancel()
      this.#highlighterThemePending = true
      const read = retained.read()
      if (read.kind === 'ready' && read.providerTheme.kind === 'ready') {
        this.#consumeRetainedProviderTheme()
        return
      }
      const session = this.options.getSession()
      if (!session) return
      const documentVersion = this.options.getDocumentVersion()
      const generation = this.#beginInitialHighlightReplacement('theme')
      const retry = retryFailed && read.kind === 'ready' && read.providerTheme.kind === 'failed'
      this.#highlighterThemeRequests.schedule({
        tags: { configuration: 'highlighterTheme' },
        run: async (signal) => {
          if (retry) await retained.refresh(session.getTextSnapshot())
          const outcome = await retained.waitForProviderTheme(signal)
          return outcome.kind === 'ready' ? outcome.theme : null
        },
        apply: (theme) => {
          if (!this.#preparedResultStillCurrent(retained, documentVersion, generation)) return
          this.#completeProviderHighlighterTheme(theme)
          const current = retained.read()
          if (retry && current.kind === 'ready')
            this.#applyHighlightResult(current.result, documentVersion, nowMs(), generation)
        },
        fail: (error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          if (!this.#preparedResultStillCurrent(retained, documentVersion, generation)) return
          this.#completeProviderHighlighterTheme(null)
        },
      })
      return
    }
    const context = this.options.pluginHost.getHighlighterProvider()
    if (!context?.themeProviders.some((provider) => provider.loadTheme !== undefined)) {
      this.#highlighterThemeRequests.cancel()
      this.#completeProviderHighlighterTheme(null)
      return
    }

    this.#highlighterThemePending = true
    this.#highlighterThemeRequests.schedule({
      tags: { configuration: 'highlighterTheme' },
      run: (signal) => this.options.pluginHost.loadHighlighterTheme(signal),
      apply: (theme) => this.#completeProviderHighlighterTheme(theme),
      fail: () => this.#completeProviderHighlighterTheme(null),
    })
  }

  refresh(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.options.getSession()) return
    if (
      change &&
      (change.kind === 'none' || change.kind === 'selection' || change.kind === 'synchronize')
    ) {
      return
    }

    const explicitRetry = change === null
    const retryDegradedPrepared =
      explicitRetry &&
      (this.#parseState.kind === 'error' ||
        this.#publishedScope?.degraded === true ||
        this.retainedSyntax?.hasDegradedOrFailedBase() === true)
    if (explicitRetry) {
      this.#unavailableRanges = []
      this.#unavailableClearsScopeRanges = []
      this.#unavailableEmptyRange = null
      this.#unavailableEmptyClearsScope = false
      this.#unavailableRecordsRange = null
      this.#unavailableRecordsClearsScope = false
      this.#pruneDegradedAndPartialRangeEntries()
      this.retainedSyntax?.clearDegradedOrPartialRanges()
    }

    this.options.log?.({
      action: 'editor.syntax.refresh_scheduled',
      level: 'debug',
      syntax: {
        ...this.fallbackFoldSelection,
        changeKind: change?.kind ?? null,
        documentVersion,
        range: options.range ?? null,
      },
    })
    const skipPreparedStructural =
      this.#syntaxContentVersion === this.#preparedStructuralContentVersion &&
      !retryDegradedPrepared
    if (!skipPreparedStructural) {
      this.#preparedStructuralContentVersion = null
      this.#refreshStructuralSyntax(documentVersion, change, options, explicitRetry)
    }
    if (
      this.#syntaxContentVersion !== this.#preparedHighlighterContentVersion &&
      (!this.#retainedHighlighter || change === null)
    ) {
      this.#refreshHighlightTokens(documentVersion, change, options)
    }
  }

  acceptChange(change: DocumentSessionChange): void {
    if (change.kind === 'none' || change.kind === 'selection' || change.kind === 'synchronize') {
      return
    }
    this.stoppedWarm = null
    this.#syntaxContentVersion += 1
    this.#parseGeneration += 1
    this.#lastFrameDemand = null
    this.#lastRangeTrim = null
    this.rangeRequests.cancel()
    this.#prefetchRangeRequests.cancel()
    this.#warmRangeRequests.cancel()
    this.#pendingVisibleRange = null
    this.#pendingPrefetch = null
    this.pendingWarm = null
    this.pendingInitialHighlightReplacement = null
    this.#pendingInitialHighlightThemeTerminal = null
    this.#publishedScope = null
    this.#unavailableRanges = []
    this.#unavailableClearsScopeRanges = []
    this.#unavailableEmptyRange = null
    this.#unavailableEmptyClearsScope = false
    this.#unavailableRecordsRange = null
    this.#unavailableRecordsClearsScope = false
    // Immediately clear stale pre-edit brackets and injections while reanalysis is in flight.
    this.#currentBrackets = []
    this.#currentInjections = []

    // Preserve the earliest accepted parse's complete entries across rapid edits so incremental
    // promotion replays every intervening parse step once parsing catches up.
    if (
      this.#carriedEntries === null &&
      this.#parseState.kind === 'parsed' &&
      this.#parseState.mode === 'range'
    ) {
      const complete = this.#rangeEntries.filter((entry) => !entry.tokensOnly)
      if (complete.length > 0) {
        this.#carriedEntries = {
          parseId: this.#parseState.parseId,
          entries: complete,
        }
      }
    }

    const hadRangeOwnedPaint =
      !this.#highlighterSession &&
      (this.#rangeTokenOwner?.store === this.#currentTokens ||
        (this.#projectedRangeTokens !== null && this.#projectedRangeTokens === this.#currentTokens))
    if (!this.#highlighterSession && !hadRangeOwnedPaint) {
      const priorStrips = mergeSyntaxRanges(
        this.#tokenCoverage(this.#rangeEntries).concat(this.#pendingUnownedStrips),
      )
      this.#pendingUnownedStrips =
        priorStrips.length > 0
          ? projectRangesThroughEdits(priorStrips, change.edits, change.textSnapshot.length)
          : []
      if (this.#externalBaseTokens) {
        if (change.edits.length === 1) {
          this.#externalBaseTokens = {
            store: projectTokensThroughEdit(
              this.#externalBaseTokens.store,
              change.edits[0]!,
              this.#externalBaseTokens.snapshot,
            ),
            snapshot: change.textSnapshot,
          }
        } else if (change.edits.length > 1) {
          this.#externalBaseTokens = {
            store: projectTokensThroughEdits(
              this.#externalBaseTokens.store,
              createTextEditBatch(
                this.#externalBaseTokens.snapshot,
                change.textSnapshot,
                change.edits,
              ),
            ),
            snapshot: change.textSnapshot,
          }
        } else {
          this.#externalBaseTokens = null
        }
      }
    } else {
      this.#pendingUnownedStrips = []
      this.#externalBaseTokens = null
    }
    this.#rangeEntries = []
    this.#rangeScopeOwners = []
    this.rangeCopyOwner = null
    this.#rangeTokenOwner = null
    this.#projectedRangeTokens = hadRangeOwnedPaint ? this.#currentTokens : null
    this.#awaitingProjectedEditTokens = hadRangeOwnedPaint
    this.#rangeCopyTokens = EditorTokenStore.empty()
    if (!this.#highlighterSession) this.#copyOwner = 'none'

    if (this.syntaxSession) {
      this.#parseState = {
        kind: 'loading',
        contentVersion: this.#syntaxContentVersion,
        parseGeneration: this.#parseGeneration,
      }
    }
    if (this.#retainedHighlighter) {
      this.#refreshHighlightTokens(this.options.getDocumentVersion(), change, { delayMs: 0 })
    }
  }

  refreshVisibleRange(documentVersion: number, options: EditorSyntaxRefreshOptions = {}): void {
    if (!this.syntaxSession?.queryRange) return
    if (!this.options.getSession()) return
    if (!this.#canQueryCurrentSyntaxRange()) {
      if (!this.#isParseIdCurrent()) {
        this.#resetForProducedStructuralSyntax(documentVersion)
        return
      }
      if (
        this.#canProviderQuerySyntaxRange() &&
        this.#parseState.kind === 'parsed' &&
        this.#parseState.mode === 'full' &&
        this.#parseState.parseKind === 'full' &&
        this.#parseState.contentVersion === this.#syntaxContentVersion &&
        this.#parseState.parseGeneration === this.#parseGeneration
      ) {
        this.#parseState = {
          ...this.#parseState,
          mode: 'range',
          fullResult: null,
        }
      } else {
        // If range capability was disabled after an earlier range-mode parse settled, scrolling to an
        // uncached or unavailable viewport must transition cleanly to full-document publication
        // instead of stranding the editor in `loading` or stale range degradation.
        if (
          !this.#publishedScopeCoversViewport() ||
          (this.#publishedScope?.kind === 'range' && this.#publishedScope.unavailable)
        ) {
          this.#transitionRangeToFullOnCapabilityLoss(documentVersion, options.delayMs ?? 0)
        }
        return
      }
    }

    const range = options.range ?? this.options.getVisibleSyntaxRange()
    if (!range) return
    const configurationGeneration = this.#initialHighlightConfigurationGeneration

    // Cache hit check (promotes copy eligibility for warmed/prefetched ranges when scrolled onto,
    // and honors terminal authoritative records failure when multi-strip coverage is unavailable).
    if (this.#repaintCachedVisibleSyntaxRange(range, configurationGeneration)) {
      this.#visibleRangeSequence += 1
      return
    }

    // If all missing parts of `range` are already terminally unavailable, reconcile & settle.
    if (!this.#needsAuthoritativeRecordsQuery(range) && this.#rangeCoveredBySettled(range)) {
      this.#reconcileViewportScope(range, { configurationGeneration })
      return
    }

    const bypassCache = this.#needsAuthoritativeRecordsQuery(range)
    const queryRange = this.#nextRequiredVisibleRange(range)
    if (!queryRange) return

    const pending = this.#pendingVisibleRange
    if (
      this.rangeRequests.isActive() &&
      pending?.documentVersion === documentVersion &&
      pending.contentVersion === this.#syntaxContentVersion &&
      pending.parseGeneration === this.#parseGeneration &&
      (bypassCache
        ? pending.bypassCache && sameSyntaxRange(queryRange, pending.range)
        : queryRange.endIndex <= queryRange.startIndex
          ? sameSyntaxRange(queryRange, pending.range)
          : syntaxRangeCoverage(queryRange, [pending.range]) === 'full')
    ) {
      return
    }

    this.#visibleRangeSequence += 1
    this.#pendingVisibleRange = {
      documentVersion,
      contentVersion: this.#syntaxContentVersion,
      parseGeneration: this.#parseGeneration,
      range: queryRange,
      bypassCache,
    }

    this.#scheduleSyntaxRangeRequest(
      this.rangeRequests,
      documentVersion,
      queryRange,
      options,
      'visible',
      bypassCache,
    )
  }

  prefetchVisibleRange(
    documentVersion: number,
    range: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): boolean {
    if (!this.syntaxSession?.queryRange) return false
    if (!this.options.getSession()) return false
    if (!this.#canQueryCurrentSyntaxRange()) return false
    if (!range) return false
    if (this.#rangeCoveredByTokens(range)) return false
    if (this.rangeRequests.isActive()) {
      this.#pendingPrefetch = {
        contentVersion: this.#syntaxContentVersion,
        documentVersion,
        parseGeneration: this.#parseGeneration,
        options,
        range,
      }
      return true
    }

    this.#scheduleSyntaxRangeRequest(
      this.#prefetchRangeRequests,
      documentVersion,
      range,
      options,
      'prefetch',
    )
    return true
  }

  warmSyntaxAroundRange(
    documentVersion: number,
    seedRange: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.syntaxSession?.queryRange) return
    if (!this.options.getSession()) return
    if (!this.#canQueryCurrentSyntaxRange()) return
    if (!seedRange) return
    if (!this.#canWarmSyntax()) return
    const snapshot = this.options.getSession()?.getTextSnapshot()
    if (
      this.stoppedWarm &&
      this.stoppedWarm.snapshot === snapshot &&
      this.stoppedWarm.configurationGeneration === this.#initialHighlightConfigurationGeneration
    )
      return

    const pendingWarm: PendingSyntaxWarm = {
      configurationGeneration: this.#initialHighlightConfigurationGeneration,
      contentVersion: this.#syntaxContentVersion,
      parseGeneration: this.#parseGeneration,
      delayMs: options.delayMs ?? 120,
      documentVersion,
      generation: this.#nextWarmGeneration(),
      seedRange,
    }
    this.pendingWarm = pendingWarm
    this.#warmRangeRequests.cancel()
    this.#scheduleNextWarmRange(pendingWarm)
  }

  #reloadHighlighterSession(options: EditorSyntaxRefreshOptions = {}): void {
    if (this.disposed) return

    this.#disposeHighlighterSession()

    const session = this.options.getSession()
    if (!session) return

    this.#highlighterSession = this.#createHighlighterSession(this.options.getLanguageId())
    this.refreshHighlighterTheme()
    this.#refreshHighlightTokens(this.options.getDocumentVersion(), null, options)
    this.#observeHighlighterTheme()
    this.#observeProducedHighlighterTokens()
  }

  #observeProducedStructuralSyntax(): void {
    this.#unsubscribeProducedSyntax?.()
    this.#unsubscribeProducedSyntax = null
    const retained = this.retainedSyntax
    if (!retained) return
    this.#unsubscribeProducedSyntax = retained.onDidProduceSyntax(() => {
      if (this.retainedSyntax !== retained || this.disposed) return
      this.#resetForProducedStructuralSyntax(this.options.getDocumentVersion())
    })
  }

  #resetForProducedStructuralSyntax(documentVersion: number): void {
    const hadRangeOwnedPaint =
      !this.#highlighterSession &&
      (this.#rangeTokenOwner?.store === this.#currentTokens ||
        (this.#projectedRangeTokens !== null && this.#projectedRangeTokens === this.#currentTokens))
    if (!this.#highlighterSession && !hadRangeOwnedPaint) {
      this.#pendingUnownedStrips = mergeSyntaxRanges(
        this.#tokenCoverage(this.#rangeEntries).concat(this.#pendingUnownedStrips),
      )
    }
    this.#parseGeneration += 1
    this.rangeRequests.cancel()
    this.#prefetchRangeRequests.cancel()
    this.#warmRangeRequests.cancel()
    this.#pendingVisibleRange = null
    this.#pendingPrefetch = null
    this.pendingWarm = null
    this.#clearSyntaxRangeCache()
    if (hadRangeOwnedPaint) this.#projectedRangeTokens = this.#currentTokens
    this.#parseState = {
      kind: 'loading',
      contentVersion: this.#syntaxContentVersion,
      parseGeneration: this.#parseGeneration,
    }
    this.#refreshStructuralSyntax(documentVersion, null, { delayMs: 0 }, false)
  }

  #observeProducedHighlighterTokens(): void {
    this.#unsubscribeProducedTokens?.()
    this.#unsubscribeProducedTokens = null
    const retained = this.#retainedHighlighter
    if (!retained) return
    const apply = () => {
      if (this.#retainedHighlighter !== retained) return
      const result = retained.readProducedTokens()
      if (!result) return
      this.#applyHighlightResult(
        result,
        this.options.getDocumentVersion(),
        nowMs(),
        this.#initialHighlightConfigurationGeneration,
      )
    }
    this.#unsubscribeProducedTokens = retained.onDidProduceTokens(apply)
    apply()
  }

  #createSyntaxSession(document: EditorSyntaxDocumentStartOptions): EditorSyntaxSession | null {
    if (!document.languageId) return null

    const includeCaptures = this.options.needsSyntaxCaptures?.() ?? false
    this.#syntaxSessionIncludesCaptures = includeCaptures
    const sessionOptions = {
      documentId: document.documentId,
      languageId: document.languageId,
      includeHighlights: !this.#highlighterSession,
      includeCaptures,
      syntaxMode: 'range' as const,
    }
    const provider = this.options.pluginHost.getSyntaxProvider()
    this.retainedSyntax =
      this.analysis && provider
        ? this.analysis.borrowStructural({
            ...sessionOptions,
            provider,
            configurationTag: this.structuralConfigurationTag,
          })
        : null
    this.retainedSyntax?.setDisplayDemand({ kind: 'unknown' })
    const session = this.retainedSyntax
    if (session) {
      recordEditorPerformanceDiagnostic('editor.syntax.session_created', {
        family: 'structural',
      })
    }
    return session
  }

  #observeHighlighterTheme(): void {
    this.#unsubscribeHighlighterTheme?.()
    this.#unsubscribeHighlighterTheme =
      this.#highlighterSession?.onDidChangeTheme?.(() => {
        this.#failedHighlightRefreshes = 0
        if (this.#retainedHighlighter) {
          this.#beginInitialHighlightReplacement('theme')
          this.refreshHighlighterTheme()
        }
        this.#refreshHighlightTokens(this.options.getDocumentVersion(), null, { delayMs: 0 })
      }) ?? null
  }

  #preparedStructuralConfiguration(
    languageId: EditorSyntaxLanguageId | null,
    hasStructuralProvider: boolean,
    hasHighlighterProvider: boolean,
  ): EditorPreparedStructuralConfiguration | null {
    if (!languageId || !hasStructuralProvider) return null

    return {
      includeCaptures: this.options.needsSyntaxCaptures?.() ?? false,
      includeHighlights: !hasHighlighterProvider,
      syntaxMode: 'range',
    }
  }

  #observePreparedStructural(
    structural: EditorPreparedStructuralBorrow,
    guard: RequestGuard,
  ): void {
    this.#observingPreparedStructural = true
    void structural.result.then(
      (result) => this.#applyPreparedStructuralResult(structural, result, guard),
      () => this.#recoverPreparedStructural(structural, guard),
    )
  }

  #observePreparedResults(prepared: EditorPreparedDocumentPayload | null): void {
    if (!prepared) return

    const guard = this.#captureRequestGuard()
    const structural = prepared.structural
    if (structural && !structural.readyResult) {
      this.#observePreparedStructural(structural, guard)
    }
    const highlighter = prepared.highlighter
    if (!highlighter || highlighter.readyResult) return
    void highlighter.result.then(
      (result) =>
        this.#applyPreparedHighlighterResult(
          highlighter,
          result,
          guard.documentVersion,
          guard.configurationGeneration,
          guard.contentVersion,
        ),
      () =>
        this.#recoverPreparedHighlighter(
          highlighter,
          guard.documentVersion,
          guard.configurationGeneration,
        ),
    )
  }

  #applyPreparedHighlighterResult(
    transfer: EditorPreparedHighlighterBorrow,
    result: EditorHighlightResult,
    documentVersion: number,
    configurationGeneration: number,
    contentVersion: number,
  ): void {
    if (
      !this.#preparedResultStillCurrent(transfer.session, documentVersion, configurationGeneration)
    ) {
      return
    }
    if (contentVersion !== this.#syntaxContentVersion) return

    this.#applyHighlightResult(result, documentVersion, nowMs(), configurationGeneration)
  }

  #applyPreparedStructuralResult(
    transfer: EditorPreparedStructuralBorrow,
    result: EditorSyntaxResult,
    guard: RequestGuard,
  ): void {
    if (this.syntaxSession !== transfer.session) return
    if (!this.#isRequestCurrent(guard)) return

    const canRange = Boolean(this.syntaxSession?.queryRange && this.#canProviderQuerySyntaxRange())
    const range = canRange ? transfer.range : null
    const baseResult = this.retainedSyntax?.readBaseResult() ?? result
    this.#applySyntaxResult(
      {
        contentVersion: guard.contentVersion,
        parseGeneration: guard.parseGeneration,
        parseId: this.retainedSyntax?.currentParseId() ?? null,
        baseResult,
        range,
        result: range ? result : baseResult,
        source: range ? 'visible' : 'full',
        suppressWarm: true,
        updatesDocument: true,
      },
      guard,
      nowMs(),
    )
  }

  #recoverPreparedStructural(transfer: EditorPreparedStructuralBorrow, guard: RequestGuard): void {
    if (
      !this.#preparedResultStillCurrent(
        transfer.session,
        guard.documentVersion,
        guard.configurationGeneration,
      )
    ) {
      return
    }
    if (guard.parseGeneration !== this.#parseGeneration) return

    this.#parseGeneration += 1
    this.#disposeSyntaxSession()
    const session = this.options.getSession()
    if (!session) return
    this.syntaxSession = this.#createSyntaxSession({
      documentId: this.options.getCurrentSessionDocumentId(),
      languageId: this.options.getLanguageId(),
      textSnapshot: session.getTextSnapshot(),
      snapshot: session.getSnapshot(),
    })
    this.#observeProducedStructuralSyntax()
    this.#parseState = this.syntaxSession
      ? {
          kind: 'loading',
          contentVersion: this.#syntaxContentVersion,
          parseGeneration: this.#parseGeneration,
        }
      : { kind: 'plain' }
    this.#refreshStructuralSyntax(guard.documentVersion, null)
  }

  #recoverPreparedHighlighter(
    transfer: EditorPreparedHighlighterBorrow,
    documentVersion: number,
    configurationGeneration: number,
  ): void {
    if (
      !this.#preparedResultStillCurrent(transfer.session, documentVersion, configurationGeneration)
    ) {
      return
    }

    this.#disposeHighlighterSession()
    const session = this.options.getSession()
    if (!session) return
    this.#highlighterSession = this.#createHighlighterSession(this.options.getLanguageId())
    this.#refreshHighlightTokens(documentVersion, null)
    this.#observeHighlighterTheme()
    this.#observeProducedHighlighterTokens()
  }

  #preparedResultStillCurrent(
    session: EditorSyntaxSession | EditorHighlighterSession,
    documentVersion: number,
    configurationGeneration: number,
  ): boolean {
    if (documentVersion !== this.options.getDocumentVersion()) return false
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return false
    return this.syntaxSession === session || this.#highlighterSession === session
  }

  #createHighlighterSession(
    languageId: EditorSyntaxLanguageId | null,
  ): EditorHighlighterSession | null {
    const context = this.options.pluginHost.getHighlighterProvider()
    this.#retainedHighlighter =
      this.analysis && context
        ? this.analysis.borrowHighlighter({
            provider: context.provider,
            themeProviders: context.themeProviders,
            languageId,
            configurationTag: this.highlighterConfigurationTag,
          })
        : null
    const session = this.#retainedHighlighter
    if (session) {
      recordEditorPerformanceDiagnostic('editor.syntax.session_created', {
        family: 'highlighter',
      })
    }
    return session
  }

  #disposeSyntaxSession(): void {
    this.#unsubscribeProducedSyntax?.()
    this.#unsubscribeProducedSyntax = null
    this.stoppedWarm = null
    this.#syntaxRequests.cancel()
    this.rangeRequests.cancel()
    this.#prefetchRangeRequests.cancel()
    this.#warmRangeRequests.cancel()
    this.#pendingVisibleRange = null
    this.#pendingPrefetch = null
    this.pendingWarm = null
    this.#clearSyntaxRangeCache()
    if (this.#preparedSyntaxDisposer) this.#preparedSyntaxDisposer()
    else this.syntaxSession?.dispose()
    this.#preparedSyntaxDisposer = null
    this.#preparedStructuralContentVersion = null
    this.#observingPreparedStructural = false
    this.syntaxSession = null
    this.retainedSyntax = null
    this.#syntaxSessionIncludesCaptures = false
  }

  #captureRequestGuard(documentVersion = this.options.getDocumentVersion()): RequestGuard {
    return {
      documentVersion,
      contentVersion: this.#syntaxContentVersion,
      configurationGeneration: this.#initialHighlightConfigurationGeneration,
      parseGeneration: this.#parseGeneration,
    }
  }

  #isRequestCurrent(guard: RequestGuard): boolean {
    return (
      !this.disposed &&
      this.options.getSession() !== null &&
      guard.documentVersion === this.options.getDocumentVersion() &&
      guard.contentVersion === this.#syntaxContentVersion &&
      guard.configurationGeneration === this.#initialHighlightConfigurationGeneration &&
      guard.parseGeneration === this.#parseGeneration
    )
  }

  #scheduleSyntaxRangeRequest(
    request: LatestAsyncRequest<EditorSyntaxLoadResult>,
    documentVersion: number,
    range: EditorSyntaxRange,
    options: EditorSyntaxRefreshOptions,
    kind: 'visible' | 'prefetch',
    bypassCache = false,
  ): void {
    const guard = this.#captureRequestGuard(documentVersion)
    request.schedule({
      delayMs: options.delayMs ?? 50,
      tags: syntaxWorkTags(documentVersion, guard.contentVersion, kind, range),
      run: traceEditorPerformanceTask('editor.syntax.range.request', (signal: AbortSignal) =>
        this.loadSyntaxRangeResult(range, kind, {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          signal,
          bypassCache,
        }),
      ),
      apply: traceEditorPerformanceTask('editor.syntax.range.apply', (result, startedAt) => {
        if (!this.#isRequestCurrent(guard)) return
        if (
          kind === 'visible' &&
          !this.#canProviderQuerySyntaxRange() &&
          (result.skipApply ||
            result.result.projection.analysis?.kind === 'partial' ||
            result.result.projection.analysis?.kind === 'cancelled' ||
            result.result.degraded?.kind === 'range-unavailable' ||
            !syntaxResultCoversRange(result.result, result.range)) &&
          this.#transitionRangeToFullOnCapabilityLoss(documentVersion, 0)
        ) {
          return
        }
        const applied = this.#applySyntaxResult(result, guard, startedAt)
        if (applied && kind === 'visible' && this.#publishedScopeCoversViewport()) {
          if (!this.#flushPendingPrefetch()) this.#flushPendingWarm()
        }
        if (applied && kind === 'prefetch') this.#flushPendingWarm()
      }),
      fail: traceEditorPerformanceTask('editor.syntax.range.fail', (error, startedAt) => {
        if (!this.#isRequestCurrent(guard)) return
        if (kind === 'prefetch') {
          this.#logOptionalSyntaxFailure(documentVersion, error, startedAt)
          return
        }
        if (
          !(error instanceof DOMException && error.name === 'AbortError') &&
          !this.#canProviderQuerySyntaxRange() &&
          this.#transitionRangeToFullOnCapabilityLoss(documentVersion, 0)
        ) {
          return
        }
        this.#handleVisibleRangeRejection(range, error, startedAt, guard)
      }),
    })
  }

  #transitionRangeToFullOnCapabilityLoss(documentVersion: number, delayMs: number): boolean {
    if (
      this.#canProviderQuerySyntaxRange() ||
      this.#parseState.kind !== 'parsed' ||
      this.#parseState.mode !== 'range' ||
      this.#parseState.contentVersion !== this.#syntaxContentVersion ||
      this.#parseState.parseGeneration !== this.#parseGeneration ||
      this.#syntaxRequests.isActive()
    ) {
      return false
    }
    this.rangeRequests.cancel()
    this.#prefetchRangeRequests.cancel()
    this.#warmRangeRequests.cancel()
    this.#pendingVisibleRange = null
    this.#pendingPrefetch = null
    this.pendingWarm = null
    this.#refreshStructuralSyntax(documentVersion, null, { delayMs }, false)
    return true
  }

  #handleVisibleRangeRejection(
    range: EditorSyntaxRange,
    error: unknown,
    startedAt: number,
    guard: RequestGuard,
    change: DocumentSessionChange | null = null,
  ): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (!this.#isRequestCurrent(guard)) return
    if (this.#parseState.kind === 'parsed' && this.#parseState.mode === 'full') return
    const { gaps, emptyGap, recordsGap } = this.#stillRequiredGaps(range, guard)
    if (gaps.length === 0 && !emptyGap && !recordsGap) {
      if (!this.#publishedScopeCoversViewport() && !this.#activePendingVisibleRange(guard)) {
        this.refreshVisibleRange(guard.documentVersion, { delayMs: 0 })
      }
      return
    }
    if (recordsGap) {
      const visible = this.options.getVisibleSyntaxRange()
      if (visible) {
        this.#unavailableRecordsRange = visible
        this.#unavailableRecordsClearsScope = true
      }
    }
    this.#recoverSyntaxError(change, error, startedAt, guard)
  }

  /**
   * A look-ahead or background answer that fails leaves the viewport's state alone: the rows on
   * screen have their own request, and that one reports its failure.
   */
  #logOptionalSyntaxFailure(documentVersion: number, error: unknown, startedAt: number): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    this.options.log?.({
      action: 'editor.syntax.optional_request_failed',
      level: 'warn',
      error: syntaxLogError(error),
      syntax: { ...this.#debugContext(documentVersion), startedAt },
    })
  }

  #repaintCachedVisibleSyntaxRange(
    range: EditorSyntaxRange,
    configurationGeneration: number,
  ): boolean {
    if (!this.#rangeCoveredByComplete(range)) {
      if (this.#rangeIntersectsTokens(range)) this.options.adoptTokens(this.#currentTokens)
      return false
    }

    const reconciled = this.#reconcileViewportScope(range, {
      configurationGeneration,
    })
    if (reconciled.kind === 'needs-authoritative-records-query') {
      this.options.adoptTokens(this.#currentTokens)
      return false
    }
    if (reconciled.kind === 'settled-degraded') {
      this.rangeRequests.cancel()
      this.options.notifyChange(null)
      return true
    }
    if (reconciled.kind !== 'settled') return false

    this.rangeRequests.cancel()
    let notifyUpdate = reconciled.scopeChanged || reconciled.promoted
    if (!this.#highlighterSession) {
      const status: SettledHighlightStatus = reconciled.degraded ? 'degraded' : 'painted'
      const copyCurrent =
        this.#copyOwner === 'range' &&
        this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
        this.#acceptedTokensTextVersion === this.options.getTextVersion()
      const needsStatusCommit =
        this.#initialHighlightState !== status || this.pendingInitialHighlightReplacement !== null
      const needsCopyOrStatusUpdate =
        this.#copyOwner !== 'external' && (reconciled.promoted || !copyCurrent || needsStatusCommit)
      if (needsCopyOrStatusUpdate) {
        const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
        const primary =
          reconciled.contributors[0] ?? this.#primaryCopyContributor(this.#rangeEntries)
        const nextCopyTokens =
          reconciled.promoted || !copyCurrent
            ? this.#rebuildRangeCopyTokens(this.#rangeEntries, this.#currentTokens)
            : this.#rangeCopyTokens
        this.#rangeCopyTokens = nextCopyTokens
        this.#copyOwner = 'range'
        this.rangeCopyOwner = primary ? { store: nextCopyTokens, contributor: primary } : null
        if (snapshot && this.#rangeTokenOwner?.store === this.#currentTokens) {
          this.#rangeTokenOwner = { store: this.#currentTokens, snapshot }
        }
        if (needsStatusCommit) {
          this.#commitInitialHighlightStatus(
            status,
            () => this.#applyTokens(this.#currentTokens, true, nextCopyTokens, 'range'),
            configurationGeneration,
          )
        } else {
          this.#applyTokens(this.#currentTokens, true, nextCopyTokens, 'range')
        }
        notifyUpdate = true
      } else if (this.#copyOwner === 'external' && needsStatusCommit) {
        this.#commitInitialHighlightStatus(
          status,
          () => this.options.adoptTokens(this.#currentTokens),
          configurationGeneration,
        )
        notifyUpdate = true
      } else {
        this.options.adoptTokens(this.#currentTokens)
      }
    } else {
      this.options.adoptTokens(this.#currentTokens)
      if (this.#pendingReplacementMatches('syntax', configurationGeneration)) {
        this.#commitInitialHighlightStatus(
          this.#lastInitialHighlightTerminalStatus ?? 'painted',
          () => this.setTokens(this.#currentTokens, false),
          configurationGeneration,
        )
        notifyUpdate = true
      }
    }
    if (notifyUpdate) this.options.notifyViewUpdate()
    return true
  }

  #disposeHighlighterSession(): void {
    this.#unsubscribeProducedTokens?.()
    this.#unsubscribeProducedTokens = null
    this.#unsubscribeHighlighterTheme?.()
    this.#unsubscribeHighlighterTheme = null
    this.#highlightRequests.cancel()
    if (this.#preparedHighlighterDisposer) this.#preparedHighlighterDisposer()
    else this.#highlighterSession?.dispose()
    this.#preparedHighlighterDisposer = null
    this.#preparedHighlighterContentVersion = null
    this.#highlighterSession = null
    this.#retainedHighlighter = null
    this.#setHighlighterTheme(null)
  }

  #refreshStructuralSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
    forceRetry = false,
  ): void {
    const session = this.options.getSession()
    if (!this.syntaxSession || !session || !this.options.getLanguageId()) return

    const guard = this.#captureRequestGuard(documentVersion)
    this.#parseState = {
      kind: 'loading',
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
    }

    const delayMs = options.delayMs ?? this.#structuralRefreshDelay(change)
    this.#syntaxRequests.schedule({
      delayMs,
      maxDelayMs: SYNTAX_REFRESH_MAX_DELAY_MS,
      tags: syntaxWorkTags(documentVersion, guard.contentVersion, 'full'),
      run: traceEditorPerformanceTask('editor.syntax.structural.request', (signal: AbortSignal) =>
        this.#loadSyntaxResult(guard, change, forceRetry, signal),
      ),
      apply: traceEditorPerformanceTask('editor.syntax.structural.apply', (result, startedAt) => {
        if (!this.#isRequestCurrent(guard)) return
        this.#applySyntaxResult(result, guard, startedAt)
      }),
      fail: traceEditorPerformanceTask('editor.syntax.structural.fail', (error, startedAt) => {
        if (!this.#isRequestCurrent(guard)) return
        this.#recoverSyntaxError(change, error, startedAt, guard)
      }),
    })
  }

  /**
   * The worker reparses every edit as it arrives, so waiting only delays the colors. An edit after
   * a pause is re-highlighted at once; the debounce spaces out the refreshes of typing, whose keys
   * come closer together than the pause.
   */
  #structuralRefreshDelay(change: DocumentSessionChange | null): number {
    const debounce = syntaxRefreshDelay(change)
    if (debounce === 0) return 0
    const now = nowMs()
    const previous = this.#lastStructuralEditRefreshAt
    this.#lastStructuralEditRefreshAt = now
    return now - previous >= EDIT_PAUSE_MS ? 0 : debounce
  }

  #refreshHighlightTokens(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    const session = this.options.getSession()
    if (!this.#highlighterSession || !session) return

    if (change) this.#initialHighlightState = 'loading'
    const configurationGeneration = this.#initialHighlightConfigurationGeneration
    const delayMs = options.delayMs ?? syntaxRefreshDelay(change)
    this.#highlightRequests.schedule({
      delayMs,
      maxDelayMs: SYNTAX_REFRESH_MAX_DELAY_MS,
      tags: { version: documentVersion, configuration: 'highlight' },
      run: traceEditorPerformanceTask('editor.syntax.highlight.request', () =>
        this.#loadHighlightResult(),
      ),
      apply: traceEditorPerformanceTask('editor.syntax.highlight.apply', (result, startedAt) =>
        this.#applyHighlightResult(result, documentVersion, startedAt, configurationGeneration),
      ),
      fail: traceEditorPerformanceTask('editor.syntax.highlight.fail', (_error, startedAt) =>
        this.#recoverHighlightError(
          documentVersion,
          change,
          _error,
          startedAt,
          configurationGeneration,
        ),
      ),
    })
  }

  async #loadSyntaxResult(
    guard: RequestGuard,
    change: DocumentSessionChange | null,
    forceRetry: boolean,
    signal: AbortSignal,
  ): Promise<EditorSyntaxLoadResult> {
    if (!this.syntaxSession) throw new Error('No syntax session')
    const base = this.retainedSyntax
      ? await this.retainedSyntax.refreshBase({ forceRetry })
      : {
          parseId: null,
          snapshot: this.options.getSession()?.getTextSnapshot() ?? null,
          result: await this.#loadSyntaxBaseResult(),
        }
    if (signal.aborted || !this.#isRequestCurrent(guard)) {
      throw new DOMException('Syntax request was superseded', 'AbortError')
    }

    // Cancelled or terminal partial base parse settles directly without issuing a range query.
    if (isTerminalIncompleteSyntaxResult(base.result)) {
      return {
        contentVersion: guard.contentVersion,
        parseGeneration: guard.parseGeneration,
        parseId: base.parseId,
        baseResult: base.result,
        range: null,
        result: base.result,
        source: 'full',
        updatesDocument: true,
      }
    }

    if (this.syntaxSession?.queryRange && this.#canProviderQuerySyntaxRange()) {
      const promotedEntries = this.#computePromotedEntries(base.snapshot)
      const visibleRange = this.options.getVisibleSyntaxRange()
      if (!visibleRange) {
        return {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          parseId: base.parseId,
          baseResult: base.result,
          range: null,
          result: base.result,
          source: 'full',
          updatesDocument: true,
          promotedEntries,
        }
      }

      const promotedCompleteCoverage = this.#completeScopeCoverage(promotedEntries)
      const promotedCoversVisible =
        visibleRange.endIndex <= visibleRange.startIndex
          ? promotedEntries.some(
              (entry) => !entry.tokensOnly && sameSyntaxRange(entry.range, visibleRange),
            )
          : syntaxRangeCoverage(visibleRange, promotedCompleteCoverage) === 'full'
      const needsAuthoritativeRecords = this.#entriesNeedAuthoritativeRecordsQuery(
        visibleRange,
        promotedEntries,
      )

      // Skip `queryRange` IPC completely when promoted surviving ranges already cover the viewport.
      if (promotedCoversVisible && !needsAuthoritativeRecords) {
        return {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          parseId: base.parseId,
          baseResult: base.result,
          range: visibleRange,
          result: base.result,
          source: 'visible',
          updatesDocument: true,
          promotedEntries,
          promotedOnly: true,
        }
      }

      // Partially covered by promoted entries (non-records): query only the first uncovered strip.
      if (
        promotedEntries.length > 0 &&
        visibleRange.endIndex > visibleRange.startIndex &&
        !needsAuthoritativeRecords
      ) {
        const uncovered =
          firstUncoveredSyntaxRange(visibleRange, promotedCompleteCoverage) ?? visibleRange
        const visibleSequence = this.#visibleRangeSequence
        try {
          const loaded = await this.loadSyntaxRangeResult(uncovered, 'visible', {
            contentVersion: guard.contentVersion,
            parseGeneration: guard.parseGeneration,
            updatesDocument: true,
            signal,
          })
          if (!this.#canProviderQuerySyntaxRange()) {
            return {
              contentVersion: guard.contentVersion,
              parseGeneration: guard.parseGeneration,
              parseId: base.parseId,
              baseResult: base.result,
              range: null,
              result: base.result,
              source: 'full',
              updatesDocument: true,
              promotedEntries,
            }
          }
          return {
            ...loaded,
            parseId: base.parseId,
            baseResult: base.result,
            promotedEntries,
            visibleSequence,
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          return {
            contentVersion: guard.contentVersion,
            parseGeneration: guard.parseGeneration,
            parseId: base.parseId,
            baseResult: base.result,
            range: uncovered,
            result: base.result,
            source: 'visible',
            updatesDocument: true,
            promotedEntries,
            visibleSequence,
            rangeFailure: { range: uncovered, error, change },
          }
        }
      }

      await this.#paintFirstRows(guard, base.parseId, base.result, signal)
      // A newer request took this one's place while the rows were on their way. The range
      // around them is that request's to ask for, not a second one from here.
      if (signal.aborted || !this.#isRequestCurrent(guard)) {
        throw new DOMException('Syntax request was superseded', 'AbortError')
      }
      const queryTarget = this.options.getVisibleSyntaxRange()
      if (!queryTarget || !this.syntaxSession?.queryRange || !this.#canProviderQuerySyntaxRange()) {
        return {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          parseId: base.parseId,
          baseResult: base.result,
          range: null,
          result: base.result,
          source: 'full',
          updatesDocument: true,
          promotedEntries,
        }
      }
      const visibleSequence = this.#visibleRangeSequence
      try {
        const bypassCache =
          this.#entriesNeedAuthoritativeRecordsQuery(queryTarget, promotedEntries) ||
          this.#entriesNeedAuthoritativeRecordsQuery(queryTarget, this.#rangeEntries)
        const loaded = await this.loadSyntaxRangeResult(queryTarget, 'visible', {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          updatesDocument: true,
          signal,
          bypassCache,
        })
        if (!this.#canProviderQuerySyntaxRange()) {
          return {
            contentVersion: guard.contentVersion,
            parseGeneration: guard.parseGeneration,
            parseId: base.parseId,
            baseResult: base.result,
            range: null,
            result: base.result,
            source: 'full',
            updatesDocument: true,
            promotedEntries,
          }
        }
        return {
          ...loaded,
          parseId: base.parseId,
          baseResult: base.result,
          promotedEntries,
          visibleSequence,
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        return {
          contentVersion: guard.contentVersion,
          parseGeneration: guard.parseGeneration,
          parseId: base.parseId,
          baseResult: base.result,
          range: queryTarget,
          result: base.result,
          source: 'visible',
          updatesDocument: true,
          promotedEntries,
          visibleSequence,
          rangeFailure: { range: queryTarget, error, change },
        }
      }
    }

    return {
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
      parseId: base.parseId,
      baseResult: base.result,
      range: null,
      result: base.result,
      source: 'full',
      updatesDocument: true,
    }
  }

  #computePromotedEntries(
    currentSnapshot: DocumentTextSnapshot | null,
  ): readonly CachedSyntaxRangeEntry[] {
    const carried = this.#carriedEntries
    if (!carried || carried.parseId === null || !this.retainedSyntax) return []
    const steps = this.retainedSyntax.invalidationStepsSince(carried.parseId)
    if (steps === null) return []
    const promotedEntries: CachedSyntaxRangeEntry[] = []
    for (const entry of carried.entries) {
      if (entry.tokensOnly) continue
      const promoted = projectResultThroughSteps(entry.range, entry.result, steps, entry.tokens)
      if (!promoted) continue
      const delta = promoted.offsetDelta
      const shiftOwned = (owned: readonly EditorSyntaxRange[]): readonly EditorSyntaxRange[] =>
        delta === 0
          ? owned
          : owned.map((r) => ({ startIndex: r.startIndex + delta, endIndex: r.endIndex + delta }))
      const shiftedOwned = shiftOwned(entry.tokenOwnedRanges)
      const nextSnapshot = steps.at(-1)?.afterSnapshot ?? currentSnapshot ?? entry.snapshot
      promotedEntries.push({
        ...entry,
        range: promoted.range,
        result: promoted.result,
        snapshot: nextSnapshot,
        tokensOnly: false,
        firstRows: false,
        tokenOwnedRanges: shiftedOwned,
        scopeOwnedRanges: shiftedOwned,
        folds: promoted.result.folds,
        brackets: promoted.result.brackets,
        injections: promoted.result.injections,
        captures: promoted.result.captures,
        tokens: promoted.tokens,
      })
    }
    return promotedEntries
  }

  /**
   * The first colors of a document: asks for only the rows on screen and paints their tokens. The
   * visible range, which also covers the text around those rows and carries folds and brackets,
   * is asked for right after, as it always was, and it is that answer which settles the
   * document's highlight. A failure here is left to that request to report.
   */
  async #paintFirstRows(
    guard: RequestGuard,
    parseId: number | null,
    baseResult: EditorSyntaxResult,
    signal: AbortSignal,
  ): Promise<void> {
    const range = this.#firstRowsRange()
    if (!range || signal.aborted || !this.#isRequestCurrent(guard)) return

    const firstRows = await this.loadSyntaxRangeResult(range, 'visible', {
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
      updatesDocument: true,
    }).catch(() => null)
    if (!firstRows || signal.aborted || !this.#isRequestCurrent(guard)) return

    this.#applySyntaxResult(
      { ...firstRows, parseId, baseResult, firstRows: true, suppressWarm: true },
      guard,
      nowMs(),
    )
  }

  #firstRowsRange(): EditorSyntaxRange | null {
    if (!this.awaitingFirstHighlight || this.#highlighterSession) return null

    const rows = this.options.getMountedSyntaxRange?.()
    const visible = this.options.getVisibleSyntaxRange()
    if (!rows || !visible) return null

    const saved = visible.endIndex - visible.startIndex - (rows.endIndex - rows.startIndex)
    return saved >= FIRST_ROWS_MIN_SAVED_CHARS ? rows : null
  }

  #loadSyntaxBaseResult(): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error('No syntax session'))
    const session = this.options.getSession()
    if (!session) return Promise.reject(new Error('No document snapshot'))

    return this.syntaxSession.refresh(session.getTextSnapshot())
  }

  private loadSyntaxRangeResult(
    range: EditorSyntaxRange,
    source: EditorSyntaxLoadSource,
    options: {
      readonly contentVersion?: number
      readonly parseGeneration?: number
      readonly updatesDocument?: boolean
      readonly signal?: AbortSignal
      readonly bypassCache?: boolean
    } = {},
  ): Promise<EditorSyntaxLoadResult> {
    const contentVersion = options.contentVersion ?? this.#syntaxContentVersion
    const parseGeneration = options.parseGeneration ?? this.#parseGeneration
    if (!this.syntaxSession?.queryRange) {
      return Promise.resolve({
        contentVersion,
        parseGeneration,
        range: null,
        result: this.syntaxSession?.getResult() ?? createEmptySyntaxResult(),
        source: 'full',
        updatesDocument: options.updatesDocument,
      })
    }
    if (
      !this.#canQuerySyntaxRangeForRequest(options.updatesDocument === true) ||
      (source === 'warm' && !this.#canWarmSyntax())
    ) {
      return Promise.resolve({
        contentVersion,
        parseGeneration,
        range: null,
        result: createEmptySyntaxResult(),
        source,
        skipApply: true,
        updatesDocument: options.updatesDocument,
      })
    }

    // A replaced look-ahead keeps running: when the scroll turns back, its answer is what the next
    // look-ahead needs, and a request for the same window joins it. Edits and disposal still stop
    // it. Requests for shown rows and background tiles are cancelled once nobody waits for them.
    const signal = source === 'prefetch' ? undefined : options.signal
    const result = this.retainedSyntax
      ? this.retainedSyntax.queryRange(range, { signal, bypassCache: options.bypassCache })
      : this.syntaxSession.queryRange(range)
    return result.then((answer) => ({
      contentVersion,
      parseGeneration,
      range,
      result: answer,
      source,
      updatesDocument: options.updatesDocument,
    }))
  }

  #loadHighlightResult(): Promise<EditorHighlightResult> {
    if (!this.#highlighterSession) return Promise.reject(new Error('No highlighter session'))
    const session = this.options.getSession()
    if (!session) return Promise.reject(new Error('No document snapshot'))

    return this.#retainedHighlighter?.read().kind === 'ready'
      ? readRetainedHighlighterResult(this.#retainedHighlighter, session.getTextSnapshot())
      : this.#highlighterSession.refresh(session.getTextSnapshot())
  }

  #applySyntaxResult(
    loadResult: EditorSyntaxLoadResult,
    guard: RequestGuard,
    startedAt: number,
  ): boolean {
    if (loadResult.skipApply) return false
    if (!this.#isRequestCurrent(guard)) return false
    if (loadResult.contentVersion !== this.#syntaxContentVersion) return false
    if (loadResult.parseGeneration !== this.#parseGeneration) return false
    if (!loadResult.updatesDocument && loadResult.range !== null && !this.#isParseIdCurrent()) {
      return false
    }

    this.#applyingRenderData = true
    try {
      return this.#publishSyntaxResult(loadResult, guard, startedAt)
    } finally {
      this.#applyingRenderData = false
      this.options.notifyViewUpdate()
    }
  }

  #publishSyntaxResult(
    loadResult: EditorSyntaxLoadResult,
    guard: RequestGuard,
    startedAt: number,
  ): boolean {
    const result = loadResult.result
    const analysis = result.projection.analysis
    const isOptional = loadResult.source === 'prefetch' || loadResult.source === 'warm'
    const isFirstRows = loadResult.firstRows === true

    // Optional requests (prefetch / warm) that returned cancelled, terminal partial, or
    // range-unavailable are silent no-ops.
    if (
      isOptional &&
      (isTerminalIncompleteSyntaxResult(result) ||
        !syntaxResultCoversRange(result, loadResult.range))
    ) {
      return false
    }

    // firstRows that failed, cancelled, or returned terminal partial is ignored; the visible
    // request right after reports failure.
    if (
      isFirstRows &&
      (isTerminalIncompleteSyntaxResult(result) ||
        !syntaxResultCoversRange(result, loadResult.range))
    ) {
      return false
    }

    // Ignore superseded document-refresh range replies BEFORE accepting parse state so an older
    // reply cannot overwrite a newer error/full state and strand the editor in `loading`.
    if (
      loadResult.updatesDocument &&
      loadResult.range !== null &&
      !isFirstRows &&
      loadResult.visibleSequence !== undefined &&
      loadResult.visibleSequence !== this.#visibleRangeSequence
    ) {
      return false
    }

    // Handle base parse / document acceptance FIRST when updatesDocument is true.
    if (loadResult.updatesDocument) {
      const baseResult = loadResult.baseResult ?? result
      const baseAnalysis = baseResult.projection.analysis
      if (baseAnalysis?.kind === 'cancelled') {
        if (baseAnalysis.reason === 'superseded') return false
        this.#settleCancelledOrTerminalPartialBase(guard, loadResult.parseId ?? null)
        return true
      }
      const canRange = Boolean(
        this.syntaxSession?.queryRange && this.#canProviderQuerySyntaxRange(),
      )
      if (
        isTerminalIncompleteSyntaxResult(baseResult) &&
        (loadResult.range === null || !canRange)
      ) {
        this.#settleCancelledOrTerminalPartialBase(guard, loadResult.parseId ?? null)
        return true
      }

      const mode: 'full' | 'range' = canRange ? 'range' : 'full'
      const parseKind: 'full' | 'partial' =
        baseAnalysis?.kind === 'partial' || (canRange && analysis?.kind === 'partial')
          ? 'partial'
          : 'full'
      this.#acceptSyntaxDocument(
        guard,
        loadResult.parseId ?? null,
        mode,
        parseKind,
        mode === 'full' ? baseResult : null,
        loadResult.promotedEntries ?? [],
      )
      if (!canRange) {
        return this.#publishFullDocumentResult(baseResult, guard)
      }
    }

    // Never apply late range-scoped replies or failures once the accepted parse is in full-document mode.
    if (
      loadResult.range !== null &&
      this.#parseState.kind === 'parsed' &&
      this.#parseState.mode === 'full'
    ) {
      return false
    }

    // Route range-phase rejections from document refreshes through the gap gate so a late
    // rejection cannot downgrade a viewport already settled by prefetch or another range answer.
    if (loadResult.rangeFailure) {
      this.#handleVisibleRangeRejection(
        loadResult.rangeFailure.range,
        loadResult.rangeFailure.error,
        startedAt,
        guard,
        loadResult.rangeFailure.change,
      )
      return true
    }

    // Handle required `cancelled` outcome on a visible range query.
    if (analysis?.kind === 'cancelled') {
      if (analysis.reason === 'superseded') return false
      if (loadResult.range) {
        this.#handleRequiredRangeFailure(loadResult.range, guard, {
          preserveProvisionalPaint: true,
        })
      }
      return true
    }

    // Handle required `range-unavailable` outcome on a visible range query.
    if (result.degraded?.kind === 'range-unavailable') {
      if (loadResult.range) {
        this.#handleRequiredRangeFailure(loadResult.range, guard, {
          preserveProvisionalPaint: false,
        })
      }
      return true
    }

    // Never allow a late degraded range reply to overwrite already-settled complete coverage.
    if (loadResult.range !== null && !isOptional && !isFirstRows && result.degraded !== null) {
      const { gaps, emptyGap, recordsGap } = this.#stillRequiredGaps(loadResult.range, guard)
      if (gaps.length === 0 && !emptyGap && !recordsGap) {
        return false
      }
    }

    const partial = analysis?.kind === 'partial'
    const terminalPartial = isTerminalIncompleteSyntaxResult(result)
    const coveredPartialRange =
      partial && loadResult.range !== null
        ? loadResult.range.endIndex <= loadResult.range.startIndex
          ? sameSyntaxRange(analysis.coveredRange, loadResult.range)
            ? loadResult.range
            : null
          : (intersectSyntaxRanges([loadResult.range], [analysis.coveredRange])[0] ?? null)
        : null

    if (!loadResult.promotedOnly && !syntaxResultCoversRange(result, loadResult.range)) {
      if (terminalPartial && partial && loadResult.range !== null && !isOptional && !isFirstRows) {
        if (!coveredPartialRange) {
          this.#handleRequiredRangeFailure(loadResult.range, guard, {
            preserveProvisionalPaint: true,
          })
          return true
        }
      } else {
        if (loadResult.range && !isOptional && !isFirstRows) {
          this.#handleRequiredRangeFailure(loadResult.range, guard, {
            preserveProvisionalPaint: false,
          })
        }
        return false
      }
    }

    if (editorPerformanceDiagnosticsEnabled()) {
      recordEditorPerformanceDiagnostic('editor.syntax.structural.accepted', () => ({
        documentVersion: guard.documentVersion,
        contentVersion: loadResult.contentVersion,
        source: loadResult.source,
      }))
    }

    // Full-document mode (strictly determined by the result's own scope, never by mid-flight
    // capability changes on a range-scoped reply). In range mode with no visible viewport yet,
    // accept the base parse without publishing full-document coverage so the editor stays loading
    // until an actual viewport range settles.
    if (loadResult.range === null) {
      if (this.#parseState.kind === 'parsed' && this.#parseState.mode === 'range') {
        const visibleRange = this.options.getVisibleSyntaxRange()
        if (visibleRange) return this.#publishPromotedViewport(visibleRange, guard)
        this.options.notifyChange(null)
        return true
      }
      return this.#publishFullDocumentResult(result, guard)
    }

    // Promoted-only fast path (incremental edit where surviving cached entries cover the viewport).
    if (loadResult.promotedOnly) {
      return this.#publishPromotedViewport(loadResult.range, guard)
    }

    // Range mode: check off-screen warm direct retirement before mutating tokens or copyTokens.
    const snapshot = this.options.getSession()?.getTextSnapshot()
    if (!snapshot) return false
    if (
      loadResult.source === 'warm' &&
      this.#tryRetireOffScreenWarm(loadResult.range, result, snapshot)
    ) {
      return false
    }

    const admitRange =
      terminalPartial && partial && coveredPartialRange ? coveredPartialRange : loadResult.range

    // Admit range entry according to strict disjoint ownership & copy-eligibility rules.
    const admitted = this.#admitRangeEntry(
      admitRange,
      result,
      loadResult.source === 'full' ? 'visible' : loadResult.source,
      isFirstRows,
      snapshot,
    )
    if (!admitted.admitted || !admitted.entry) {
      // Even when a terminal partial claims no uncovered token strips (e.g. an authoritative
      // Markdown records query over already-covered strips), still record its failure outcome so
      // the viewport settles instead of staying in `loading`.
      if (terminalPartial && !isOptional && !isFirstRows) {
        this.#handleRequiredRangeFailure(loadResult.range, guard, {
          preserveProvisionalPaint: true,
        })
        return true
      }
      return false
    }

    const visibleRange = this.options.getVisibleSyntaxRange()

    // Paint tokens & copy store (updating `rangeCopyOwner` BEFORE painting for `firstRows` provenance).
    if (!this.#highlighterSession) {
      this.#paintAfterRangeAdmission(
        admitted,
        isFirstRows,
        partial,
        terminalPartial,
        guard.configurationGeneration,
      )
    }

    // Handle terminal partial on a required visible query (e.g. background complete parse cancelled/failed).
    if (terminalPartial && !isOptional && !isFirstRows) {
      this.#handleRequiredRangeFailure(loadResult.range, guard, {
        preserveProvisionalPaint: true,
      })
      return true
    }

    // Reconcile viewport scope (F1 hole-free composition, prefetch promotion, Markdown records).
    let settledStatus: SettledHighlightStatus | null = null
    if (!partial && !isFirstRows && visibleRange) {
      const reconciled = this.#reconcileViewportScope(visibleRange, {
        configurationGeneration: guard.configurationGeneration,
      })
      if (reconciled.kind === 'settled') {
        settledStatus = reconciled.degraded ? 'degraded' : 'painted'
        // Settle highlighting independently of copy ownership: external/host copy owners settle
        // initialHighlightStatus without clobbering host-installed copyTokens.
        if (!this.#highlighterSession) {
          const needsStatusCommit =
            this.#initialHighlightState !== settledStatus ||
            this.pendingInitialHighlightReplacement !== null
          if (this.#copyOwner !== 'external') {
            const needsRebuild = reconciled.promoted || this.#copyOwner !== 'range'
            if (needsRebuild) {
              const nextCopyTokens = this.#rebuildRangeCopyTokens(
                this.#rangeEntries,
                this.#currentTokens,
              )
              const primary =
                reconciled.contributors[0] ?? this.#primaryCopyContributor(this.#rangeEntries)
              this.#rangeCopyTokens = nextCopyTokens
              this.#copyOwner = 'range'
              this.rangeCopyOwner = primary ? { store: nextCopyTokens, contributor: primary } : null
              this.#commitInitialHighlightStatus(
                settledStatus,
                () => this.#applyTokens(this.#currentTokens, true, nextCopyTokens, 'range'),
                guard.configurationGeneration,
              )
            } else if (needsStatusCommit) {
              this.#commitInitialHighlightStatus(
                settledStatus,
                () => this.#applyTokens(this.#currentTokens, true, this.#rangeCopyTokens, 'range'),
                guard.configurationGeneration,
              )
            }
          } else if (needsStatusCommit) {
            this.#commitInitialHighlightStatus(
              settledStatus,
              () => this.options.adoptTokens(this.#currentTokens),
              guard.configurationGeneration,
            )
          }
        }
      } else if (
        reconciled.kind === 'needs-authoritative-records-query' ||
        (!isOptional && reconciled.kind === 'incomplete')
      ) {
        this.refreshVisibleRange(guard.documentVersion, { delayMs: 0, range: visibleRange })
      }
    } else if (
      !this.#highlighterSession &&
      !isFirstRows &&
      !isOptional &&
      partial &&
      !terminalPartial
    ) {
      // Non-terminal partial on a required visible query: provisional tokens painted; settle
      // initialHighlightStatus to 'painted' without clobbering external/host copy ownership.
      const status: SettledHighlightStatus = result.degraded ? 'degraded' : 'painted'
      const publish =
        this.#copyOwner === 'external'
          ? () => this.options.adoptTokens(this.#currentTokens)
          : () => this.#applyTokens(this.#currentTokens, true, this.#rangeCopyTokens, 'range')
      this.#commitInitialHighlightStatus(status, publish, guard.configurationGeneration)
    }

    // Settle pending structural replacement when an external highlighter owns colors.
    if (
      this.#highlighterSession &&
      !isFirstRows &&
      !partial &&
      this.#publishedScopeCoversViewport() &&
      this.#pendingReplacementMatches('syntax', guard.configurationGeneration)
    ) {
      this.#commitInitialHighlightStatus(
        this.#lastInitialHighlightTerminalStatus ?? 'painted',
        () => this.setTokens(this.#currentTokens, false),
        guard.configurationGeneration,
      )
    }

    // Start background warming after visible/full range settles.
    if (
      !this.#highlighterSession &&
      loadResult.source === 'visible' &&
      !isFirstRows &&
      !loadResult.suppressWarm &&
      !this.pendingWarm
    ) {
      this.warmSyntaxAroundRange(guard.documentVersion, loadResult.range)
    }

    this.options.log?.({
      action: 'editor.syntax.structural_applied',
      level: 'debug',
      syntax: {
        ...this.fallbackFoldSelection,
        documentVersion: guard.documentVersion,
        contentVersion: loadResult.contentVersion,
        source: loadResult.source,
        foldingSupport: this.syntaxSession?.foldingSupport ?? 'unsupported',
        foldCount: result.folds.length,
        viewportCovered: this.#publishedScopeCoversViewport(),
        scopeFactsApplied: settledStatus !== null,
        status: this.status,
      },
    })

    // After firstRows, the full visible range request is already under way.
    // For partial answers, avoid re-querying a viewport already covered by provisional tokens.
    if (
      !isFirstRows &&
      !isOptional &&
      !this.#publishedScopeCoversViewport() &&
      !(partial && visibleRange && this.#rangeCoveredByTokens(visibleRange))
    ) {
      this.refreshVisibleRange(guard.documentVersion, { delayMs: 0 })
    }
    this.options.notifyChange(null)
    return true
  }

  #publishFullDocumentResult(result: EditorSyntaxResult, guard: RequestGuard): boolean {
    const partial = result.projection.analysis?.kind === 'partial'
    const degraded = result.degraded !== null
    this.rangeRequests.cancel()
    this.#prefetchRangeRequests.cancel()
    this.#warmRangeRequests.cancel()
    this.#pendingVisibleRange = null
    this.#pendingPrefetch = null
    this.pendingWarm = null
    if (!partial) {
      this.#rangeEntries = []
      this.#rangeScopeOwners = []
      this.#currentBrackets = result.brackets
      this.#currentInjections = result.injections
      this.#publishedScope = { kind: 'full', degraded }
      this.options.setSyntaxFolds(result.folds)
      this.options.setSyntaxCaptures?.(result.captures, result.records)
    } else if (degraded) {
      this.#publishedScope = { kind: 'full', degraded: true }
    }

    if (!this.#highlighterSession) {
      const tokens = toEditorTokenStore(result.tokens)
      this.#rangeTokenOwner = null
      this.#projectedRangeTokens = null
      this.#awaitingProjectedEditTokens = false
      this.rangeCopyOwner = null
      const status: SettledHighlightStatus = degraded ? 'degraded' : 'painted'
      if (this.#copyOwner === 'external') {
        this.#commitInitialHighlightStatus(
          status,
          () => {
            this.#currentTokens = tokens
            this.options.adoptTokens(tokens)
          },
          guard.configurationGeneration,
        )
      } else {
        this.#commitInitialHighlightStatus(
          status,
          () => this.#applyTokens(tokens, true, tokens, 'none'),
          guard.configurationGeneration,
        )
      }
    } else if (this.#pendingReplacementMatches('syntax', guard.configurationGeneration)) {
      this.#commitInitialHighlightStatus(
        this.#lastInitialHighlightTerminalStatus ?? 'painted',
        () => this.setTokens(this.#currentTokens, false),
        guard.configurationGeneration,
      )
    }
    this.options.notifyChange(null)
    return true
  }

  #publishPromotedViewport(sampledRange: EditorSyntaxRange, guard: RequestGuard): boolean {
    const visibleRange = this.options.getVisibleSyntaxRange() ?? sampledRange
    const reconciled = this.#reconcileViewportScope(visibleRange, {
      configurationGeneration: guard.configurationGeneration,
    })
    if (reconciled.kind === 'settled') {
      if (!this.#highlighterSession) {
        const status: SettledHighlightStatus = reconciled.degraded ? 'degraded' : 'painted'
        if (this.#copyOwner !== 'external') {
          const nextCopyTokens = this.#rebuildRangeCopyTokens(
            this.#rangeEntries,
            this.#currentTokens,
          )
          const primary =
            reconciled.contributors[0] ?? this.#primaryCopyContributor(this.#rangeEntries)
          this.#rangeCopyTokens = nextCopyTokens
          this.#copyOwner = 'range'
          this.rangeCopyOwner = primary ? { store: nextCopyTokens, contributor: primary } : null
          this.#commitInitialHighlightStatus(
            status,
            () => this.#applyTokens(this.#currentTokens, true, nextCopyTokens, 'range'),
            guard.configurationGeneration,
          )
        } else {
          this.#commitInitialHighlightStatus(
            status,
            () => this.options.adoptTokens(this.#currentTokens),
            guard.configurationGeneration,
          )
        }
      } else if (this.#pendingReplacementMatches('syntax', guard.configurationGeneration)) {
        this.#commitInitialHighlightStatus(
          this.#lastInitialHighlightTerminalStatus ?? 'painted',
          () => this.setTokens(this.#currentTokens, false),
          guard.configurationGeneration,
        )
      }
      if (!this.#highlighterSession && !this.pendingWarm) {
        this.warmSyntaxAroundRange(guard.documentVersion, visibleRange)
      }
    } else if (
      reconciled.kind === 'incomplete' ||
      reconciled.kind === 'needs-authoritative-records-query'
    ) {
      this.refreshVisibleRange(guard.documentVersion, { delayMs: 0, range: visibleRange })
    }
    this.options.notifyChange(null)
    return true
  }

  #settleCancelledOrTerminalPartialBase(guard: RequestGuard, parseId: number | null): void {
    this.#carriedEntries = null
    this.#parseState = {
      kind: 'parsed',
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
      parseId,
      mode: 'full',
      parseKind: 'partial',
      fullResult: null,
    }
    this.#publishedScope = { kind: 'full', degraded: true }
    this.#currentBrackets = []
    this.#currentInjections = []
    if (!this.#highlighterSession) {
      this.#commitInitialHighlightStatus(
        'degraded',
        () => this.options.notifyViewUpdate(),
        guard.configurationGeneration,
      )
    } else if (this.#pendingReplacementMatches('syntax', guard.configurationGeneration)) {
      this.#commitInitialHighlightStatus(
        this.#lastInitialHighlightTerminalStatus ?? 'painted',
        () => this.setTokens(this.#currentTokens, false),
        guard.configurationGeneration,
      )
    }
    this.options.notifyChange(null)
  }

  #handleRequiredRangeFailure(
    requestRange: EditorSyntaxRange,
    guard: RequestGuard,
    options: { readonly preserveProvisionalPaint: boolean },
  ): void {
    if (this.#parseState.kind === 'parsed' && this.#parseState.mode === 'full') return
    const { gaps, emptyGap, recordsGap } = this.#stillRequiredGaps(requestRange, guard)
    if (gaps.length === 0 && !emptyGap && !recordsGap) {
      if (!this.#publishedScopeCoversViewport() && !this.#activePendingVisibleRange(guard)) {
        this.refreshVisibleRange(guard.documentVersion, { delayMs: 0 })
      }
      return
    }

    for (const gap of gaps) {
      this.#unavailableRanges = appendCachedSyntaxRange(this.#unavailableRanges, gap)
      if (!options.preserveProvisionalPaint) {
        this.#unavailableClearsScopeRanges = appendCachedSyntaxRange(
          this.#unavailableClearsScopeRanges,
          gap,
        )
      }
    }
    if (emptyGap) {
      this.#unavailableEmptyRange = requestRange
      if (!options.preserveProvisionalPaint) this.#unavailableEmptyClearsScope = true
    }
    if (!options.preserveProvisionalPaint && (gaps.length > 0 || emptyGap)) {
      const nextEntries: CachedSyntaxRangeEntry[] = []
      let entriesChanged = false
      for (const existing of this.#rangeEntries) {
        if (!existing.tokensOnly) {
          nextEntries.push(existing)
          continue
        }
        if (
          emptyGap &&
          existing.range.endIndex <= existing.range.startIndex &&
          sameSyntaxRange(existing.range, requestRange)
        ) {
          entriesChanged = true
          continue
        }
        if (gaps.length === 0) {
          nextEntries.push(existing)
          continue
        }
        const nextTokenOwned = subtractSyntaxRanges(existing.tokenOwnedRanges, gaps)
        if (
          nextTokenOwned.length === existing.tokenOwnedRanges.length &&
          nextTokenOwned.every((item, index) =>
            sameSyntaxRange(item, existing.tokenOwnedRanges[index]!),
          )
        ) {
          nextEntries.push(existing)
          continue
        }
        entriesChanged = true
        if (nextTokenOwned.length === 0 && existing.range.endIndex > existing.range.startIndex) {
          continue
        }
        nextEntries.push({ ...existing, tokenOwnedRanges: nextTokenOwned })
      }
      if (entriesChanged) {
        this.#rangeEntries = nextEntries
        this.#lastRangeTrim = null
      }

      if (!this.#highlighterSession) {
        const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
        if (gaps.length > 0) {
          const ownsProjectedPaint =
            this.#projectedRangeTokens !== null &&
            this.#projectedRangeTokens === this.#currentTokens
          const rangeOwned =
            snapshot !== null &&
            this.#rangeTokenOwner?.store === this.#currentTokens &&
            this.#rangeTokenOwner.snapshot === snapshot
          const fallback =
            snapshot !== null && this.#externalBaseTokens?.snapshot === snapshot
              ? this.#externalBaseTokens.store
              : EditorTokenStore.empty()
          const nextTokens =
            (ownsProjectedPaint || rangeOwned) && this.#rangeEntries.length === 0
              ? EditorTokenStore.empty()
              : rangeOwned
                ? compactSyntaxRangeTokens(
                    this.#currentTokens,
                    this.#tokenCoverage(this.#rangeEntries),
                  )
                : mergeTokensOnStrips(this.#currentTokens, fallback, gaps)
          if (nextTokens !== this.#currentTokens) {
            this.#currentTokens = nextTokens
            if (ownsProjectedPaint || this.#rangeTokenOwner !== null) {
              this.#rangeTokenOwner = snapshot ? { store: nextTokens, snapshot } : null
              this.#projectedRangeTokens = null
              this.#awaitingProjectedEditTokens = false
            }
            this.options.adoptTokens(nextTokens)
          }
        }
        if (this.#copyOwner !== 'external' && (gaps.length > 0 || entriesChanged)) {
          const currentRangeOwned =
            snapshot !== null &&
            this.#rangeTokenOwner?.store === this.#currentTokens &&
            this.#rangeTokenOwner.snapshot === snapshot
          this.#compactRangeCopyStore(this.#rangeEntries, this.#currentTokens, currentRangeOwned)
        }
      }
    }
    const visibleRange = this.options.getVisibleSyntaxRange()
    if (recordsGap && visibleRange) {
      this.#unavailableRecordsRange = visibleRange
      this.#unavailableRecordsClearsScope = !options.preserveProvisionalPaint
    }

    if (!visibleRange) {
      this.options.notifyChange(null)
      return
    }

    const reconciled = this.#reconcileViewportScope(visibleRange, {
      configurationGeneration: guard.configurationGeneration,
    })
    if (reconciled.kind === 'incomplete') {
      this.refreshVisibleRange(guard.documentVersion, { delayMs: 0, range: visibleRange })
    }
    this.options.notifyChange(null)
  }

  #activePendingVisibleRange(guard: RequestGuard): EditorSyntaxRange | null {
    if (!this.rangeRequests.isActive()) return null
    const pending = this.#pendingVisibleRange
    if (!pending) return null
    if (
      pending.documentVersion !== guard.documentVersion ||
      pending.contentVersion !== guard.contentVersion ||
      pending.parseGeneration !== guard.parseGeneration
    ) {
      return null
    }
    return pending.range
  }

  #stillRequiredGaps(
    range: EditorSyntaxRange,
    guard?: RequestGuard,
  ): {
    readonly gaps: readonly EditorSyntaxRange[]
    readonly emptyGap: boolean
    readonly recordsGap: boolean
  } {
    const visible = this.options.getVisibleSyntaxRange()
    if (!visible) return { gaps: [], emptyGap: false, recordsGap: false }
    const pendingVisible = guard ? this.#activePendingVisibleRange(guard) : null
    const recordsCoveredByPending =
      pendingVisible !== null &&
      (visible.endIndex <= visible.startIndex
        ? sameSyntaxRange(pendingVisible, visible)
        : syntaxRangeCoverage(visible, [pendingVisible]) === 'full')
    const recordsGap =
      !recordsCoveredByPending &&
      this.#needsAuthoritativeRecordsQuery(visible) &&
      (visible.endIndex <= visible.startIndex
        ? sameSyntaxRange(range, visible)
        : syntaxRangeCoverage(visible, [range]) === 'full')
    if (visible.endIndex <= visible.startIndex) {
      return {
        gaps: [],
        emptyGap:
          sameSyntaxRange(range, visible) &&
          !this.#hasCompleteEmptyEntry(visible) &&
          !(pendingVisible !== null && sameSyntaxRange(pendingVisible, visible)),
        recordsGap,
      }
    }
    const required = intersectSyntaxRanges([range], [visible])
    if (required.length === 0) {
      return { gaps: [], emptyGap: false, recordsGap }
    }
    const excluded = pendingVisible
      ? appendCachedSyntaxRange(this.#completeScopeCoverage(), pendingVisible)
      : this.#completeScopeCoverage()
    return {
      gaps: subtractSyntaxRanges(required, excluded),
      emptyGap: false,
      recordsGap,
    }
  }

  #tryRetireOffScreenWarm(
    range: EditorSyntaxRange,
    result: EditorSyntaxResult,
    snapshot: DocumentTextSnapshot,
  ): boolean {
    const demand = this.#lastFrameDemand
    if (!demand || demand.snapshot !== snapshot) return false
    const visible = this.options.getVisibleSyntaxRange()
    const shown = visible ? appendCachedSyntaxRange(demand.ranges, visible) : demand.ranges
    if (syntaxRangeListsIntersect([range], shown)) return false

    const discarded: CachedSyntaxRangeEntry = {
      range,
      result,
      snapshot,
      tokensOnly: result.projection.analysis?.kind === 'partial',
      firstRows: false,
      source: 'warm',
      copyEligible: false,
      tokenOwnedRanges: [],
      scopeOwnedRanges: [],
      folds: result.folds,
      brackets: result.brackets,
      injections: result.injections,
      captures: result.captures,
      tokens: EditorTokenStore.empty(),
    }
    if (this.retainedSyntax) {
      setRetainedSyntaxDisplayDemand(this.retainedSyntax, demand, this.#rangeContributors(demand), [
        discarded,
      ])
      if (!retainedSyntaxCanWarm(this.retainedSyntax)) this.#cancelOptionalWarm()
    } else {
      this.#stopOptionalWarm(snapshot)
    }
    return true
  }

  #admitRangeEntry(
    range: EditorSyntaxRange,
    result: EditorSyntaxResult,
    source: 'visible' | 'prefetch' | 'warm',
    firstRows: boolean,
    snapshot: DocumentTextSnapshot,
  ): {
    readonly admitted: boolean
    readonly entry: CachedSyntaxRangeEntry | null
    readonly copyStoreChanged: boolean
    readonly primaryCopyContributor: CachedSyntaxRangeEntry | null
  } {
    const partial = result.projection.analysis?.kind === 'partial'
    const tokensOnly = partial || firstRows
    const incomingTokens = toEditorTokenStore(result.tokens)
    const isEmptyRange = range.endIndex <= range.startIndex
    const visibleRange = this.options.getVisibleSyntaxRange()
    const intersectsVisible =
      visibleRange !== null &&
      (isEmptyRange
        ? sameSyntaxRange(range, visibleRange)
        : syntaxRangesIntersect(range, visibleRange))
    const copyEligible = source === 'visible' || (source === 'prefetch' && intersectsVisible)
    const ownsProjectedPaint =
      this.#projectedRangeTokens !== null && this.#projectedRangeTokens === this.#currentTokens
    const canOwnRanges =
      !this.#highlighterSession &&
      (this.#rangeTokenOwner?.store === this.#currentTokens ||
        ownsProjectedPaint ||
        this.#currentTokens.length === 0 ||
        (range.startIndex === 0 && range.endIndex >= snapshot.length))
    const setRangeTokenOwner = (store: EditorTokenStore): void => {
      this.#rangeTokenOwner = canOwnRanges ? { store, snapshot } : null
      if (canOwnRanges) {
        this.#projectedRangeTokens = null
        this.#awaitingProjectedEditTokens = false
      }
    }

    const makeEntry = (
      tokenOwnedRanges: readonly EditorSyntaxRange[],
      scopeOwnedRanges: readonly EditorSyntaxRange[],
    ): CachedSyntaxRangeEntry => ({
      range,
      result,
      snapshot,
      tokensOnly,
      firstRows,
      source,
      copyEligible,
      tokenOwnedRanges,
      scopeOwnedRanges,
      folds: result.folds,
      brackets: result.brackets,
      injections: result.injections,
      captures: result.captures,
      tokens: incomingTokens,
    })

    // Authoritative complete visible answer.
    if (source === 'visible' && !tokensOnly) {
      const nextEntries: CachedSyntaxRangeEntry[] = []
      for (const existing of this.#rangeEntries) {
        if (isEmptyRange) {
          if (sameSyntaxRange(existing.range, range)) continue
          nextEntries.push(existing)
          continue
        }
        const nextTokenOwned = subtractSyntaxRange(existing.tokenOwnedRanges, range)
        if (nextTokenOwned.length === 0 && existing.range.endIndex > existing.range.startIndex) {
          continue
        }
        const nextScopeOwned = existing.tokensOnly
          ? []
          : subtractSyntaxRange(existing.scopeOwnedRanges, range)
        nextEntries.push({
          ...existing,
          tokenOwnedRanges: nextTokenOwned,
          scopeOwnedRanges: nextScopeOwned,
        })
      }
      const owned = isEmptyRange ? [] : [range]
      const entry = makeEntry(owned, owned)
      nextEntries.push(entry)
      this.#rangeEntries = nextEntries

      // Clear any unavailable markers covered by this complete answer.
      if (isEmptyRange) {
        if (this.#unavailableEmptyRange && sameSyntaxRange(this.#unavailableEmptyRange, range)) {
          this.#unavailableEmptyRange = null
          this.#unavailableEmptyClearsScope = false
        }
      } else {
        this.#unavailableRanges = subtractSyntaxRange(this.#unavailableRanges, range)
        this.#unavailableClearsScopeRanges = subtractSyntaxRange(
          this.#unavailableClearsScopeRanges,
          range,
        )
      }
      if (
        this.#unavailableRecordsRange &&
        result.records !== undefined &&
        (isEmptyRange
          ? sameSyntaxRange(range, this.#unavailableRecordsRange)
          : syntaxRangeCoverage(this.#unavailableRecordsRange, [range]) === 'full')
      ) {
        this.#unavailableRecordsRange = null
        this.#unavailableRecordsClearsScope = false
      }

      if (!this.#highlighterSession) {
        const previousTokens = this.#currentTokens
        const singleRangeOwned = nextEntries.length === 1 && canOwnRanges && !isEmptyRange
        const nextTokens = singleRangeOwned
          ? mergeTokensOnStrips(EditorTokenStore.empty(), incomingTokens, owned)
          : mergeTokensOnStrips(previousTokens, incomingTokens, owned)
        this.#currentTokens = nextTokens
        setRangeTokenOwner(nextTokens)

        if (this.#copyOwner !== 'external') {
          const baseCopyTokens =
            this.#copyOwner === 'range' ? this.#rangeCopyTokens : EditorTokenStore.empty()
          const allCopyEligible = nextEntries.every((item) => item.copyEligible)
          const nextCopyTokens =
            allCopyEligible &&
            canOwnRanges &&
            (singleRangeOwned || (this.#copyOwner === 'range' && baseCopyTokens === previousTokens))
              ? nextTokens
              : mergeTokensOnStrips(baseCopyTokens, incomingTokens, owned)
          this.#rangeCopyTokens = nextCopyTokens
          this.#copyOwner = 'range'
          return {
            admitted: true,
            entry,
            copyStoreChanged: true,
            primaryCopyContributor: entry,
          }
        }
      }
      return { admitted: true, entry, copyStoreChanged: false, primaryCopyContributor: null }
    }

    // Authoritative partial visible answer or firstRows.
    if (source === 'visible' && tokensOnly) {
      const completeCoverage = this.#completeScopeCoverage()
      const claimable = isEmptyRange ? [] : subtractSyntaxRanges([range], completeCoverage)
      if (!isEmptyRange && claimable.length === 0) {
        return {
          admitted: false,
          entry: null,
          copyStoreChanged: false,
          primaryCopyContributor: null,
        }
      }
      const nextEntries: CachedSyntaxRangeEntry[] = []
      for (const existing of this.#rangeEntries) {
        if (!existing.tokensOnly) {
          nextEntries.push(existing)
          continue
        }
        if (isEmptyRange) {
          if (sameSyntaxRange(existing.range, range)) continue
          nextEntries.push(existing)
          continue
        }
        const nextTokenOwned = subtractSyntaxRanges(existing.tokenOwnedRanges, claimable)
        if (nextTokenOwned.length === 0 && existing.range.endIndex > existing.range.startIndex) {
          continue
        }
        nextEntries.push({ ...existing, tokenOwnedRanges: nextTokenOwned })
      }
      const entry = makeEntry(claimable, [])
      nextEntries.push(entry)
      this.#rangeEntries = nextEntries

      if (!this.#highlighterSession) {
        const previousTokens = this.#currentTokens
        const baseWasEmpty = previousTokens.length === 0
        const nextTokens = mergeTokensOnStrips(previousTokens, incomingTokens, claimable)
        this.#currentTokens = nextTokens
        setRangeTokenOwner(nextTokens)

        if (this.#copyOwner !== 'external') {
          const baseCopyTokens =
            this.#copyOwner === 'range' ? this.#rangeCopyTokens : EditorTokenStore.empty()
          const allCopyEligible = nextEntries.every((item) => item.copyEligible)
          const nextCopyTokens =
            allCopyEligible &&
            canOwnRanges &&
            ((nextEntries.length === 1 && baseWasEmpty && baseCopyTokens.length === 0) ||
              (this.#copyOwner === 'range' && baseCopyTokens === previousTokens))
              ? nextTokens
              : mergeTokensOnStrips(baseCopyTokens, incomingTokens, claimable)
          this.#rangeCopyTokens = nextCopyTokens
          this.#copyOwner = 'range'
          return {
            admitted: true,
            entry,
            copyStoreChanged: true,
            primaryCopyContributor: entry,
          }
        }
      }
      return { admitted: true, entry, copyStoreChanged: false, primaryCopyContributor: null }
    }

    // Unified optional `prefetch` rule (both complete and `partial` — DESIGN §2.2 Revision 7).
    if (source === 'prefetch') {
      const protectedRanges = this.#tokenCoverage(
        this.#rangeEntries.filter((existing) => existing.source !== 'prefetch'),
      )
      const claimable = isEmptyRange ? [] : subtractSyntaxRanges([range], protectedRanges)
      const emptyAlreadyOwned =
        isEmptyRange &&
        this.#rangeEntries.some(
          (existing) => existing.source !== 'prefetch' && sameSyntaxRange(existing.range, range),
        )
      if (isEmptyRange ? emptyAlreadyOwned : claimable.length === 0) {
        // Pure no-op: do not evict anything, do not touch tokens or copy store.
        return {
          admitted: false,
          entry: null,
          copyStoreChanged: false,
          primaryCopyContributor: null,
        }
      }

      const evictedPrefetches = this.#rangeEntries.filter(
        (existing) => existing.source === 'prefetch',
      )
      const evictedCopyEligible = evictedPrefetches.some((existing) => existing.copyEligible)
      const keptEntries = this.#rangeEntries.filter((existing) => existing.source !== 'prefetch')
      const entry = makeEntry(claimable, tokensOnly ? [] : claimable)
      const nextEntries = keptEntries.concat(entry)
      this.#rangeEntries = nextEntries
      if (!tokensOnly) {
        if (isEmptyRange) {
          if (this.#unavailableEmptyRange && sameSyntaxRange(this.#unavailableEmptyRange, range)) {
            this.#unavailableEmptyRange = null
            this.#unavailableEmptyClearsScope = false
          }
        } else {
          this.#unavailableRanges = subtractSyntaxRanges(this.#unavailableRanges, claimable)
          this.#unavailableClearsScopeRanges = subtractSyntaxRanges(
            this.#unavailableClearsScopeRanges,
            claimable,
          )
        }
      }

      if (!this.#highlighterSession) {
        const baseTokens =
          evictedPrefetches.length > 0
            ? canOwnRanges
              ? compactSyntaxRangeTokens(this.#currentTokens, this.#tokenCoverage(keptEntries))
              : mergeTokensOnStrips(
                  this.#currentTokens,
                  this.#externalBaseTokens?.snapshot === snapshot
                    ? this.#externalBaseTokens.store
                    : EditorTokenStore.empty(),
                  this.#tokenCoverage(evictedPrefetches),
                )
            : this.#currentTokens
        const nextTokens = mergeTokensOnStrips(baseTokens, incomingTokens, claimable)
        this.#currentTokens = nextTokens
        setRangeTokenOwner(nextTokens)

        if (this.#copyOwner !== 'external') {
          let copyStoreChanged = false
          let nextCopyTokens = this.#rangeCopyTokens
          let nextCopyContributor = this.rangeCopyOwner?.contributor ?? null

          if (evictedCopyEligible && this.#copyOwner === 'range') {
            const keptCopyEntries = keptEntries.filter((item) => item.copyEligible)
            nextCopyTokens = compactSyntaxRangeTokens(
              nextCopyTokens,
              this.#tokenCoverage(keptCopyEntries),
            )
            if (nextCopyContributor && !keptCopyEntries.includes(nextCopyContributor)) {
              nextCopyContributor = this.#primaryCopyContributor(keptCopyEntries)
            }
            copyStoreChanged = true
          }

          if (copyEligible) {
            nextCopyTokens = mergeTokensOnStrips(nextCopyTokens, incomingTokens, claimable)
            this.#copyOwner = 'range'
            nextCopyContributor ??= entry
            copyStoreChanged = true
          } else if (copyStoreChanged) {
            this.#rangeCopyTokens = nextCopyTokens
          }

          if (copyStoreChanged) {
            this.#rangeCopyTokens = nextCopyTokens
            return {
              admitted: true,
              entry,
              copyStoreChanged: true,
              primaryCopyContributor: nextCopyContributor,
            }
          }
        }
      }

      return {
        admitted: true,
        entry,
        copyStoreChanged: false,
        primaryCopyContributor: this.rangeCopyOwner?.contributor ?? null,
      }
    }

    // Optional `warm` rule (never overwrites complete coverage, never contributes to copyTokens).
    if (!tokensOnly) {
      const completeCoverage = this.#completeScopeCoverage()
      const claimable = isEmptyRange ? [] : subtractSyntaxRanges([range], completeCoverage)
      if (claimable.length === 0) {
        return {
          admitted: false,
          entry: null,
          copyStoreChanged: false,
          primaryCopyContributor: null,
        }
      }
      const nextEntries: CachedSyntaxRangeEntry[] = []
      let trimmedCopyEligible = false
      for (const existing of this.#rangeEntries) {
        if (!existing.tokensOnly) {
          nextEntries.push(existing)
          continue
        }
        const nextTokenOwned = subtractSyntaxRanges(existing.tokenOwnedRanges, claimable)
        const changed =
          nextTokenOwned.length !== existing.tokenOwnedRanges.length ||
          nextTokenOwned.some(
            (item, index) => !sameSyntaxRange(item, existing.tokenOwnedRanges[index]!),
          )
        if (changed && existing.copyEligible) trimmedCopyEligible = true
        if (nextTokenOwned.length === 0 && existing.range.endIndex > existing.range.startIndex) {
          continue
        }
        nextEntries.push(changed ? { ...existing, tokenOwnedRanges: nextTokenOwned } : existing)
      }
      const entry = makeEntry(claimable, claimable)
      nextEntries.push(entry)
      this.#rangeEntries = nextEntries
      this.#unavailableRanges = subtractSyntaxRanges(this.#unavailableRanges, claimable)
      this.#unavailableClearsScopeRanges = subtractSyntaxRanges(
        this.#unavailableClearsScopeRanges,
        claimable,
      )

      if (!this.#highlighterSession) {
        const nextTokens = mergeTokensOnStrips(this.#currentTokens, incomingTokens, claimable)
        this.#currentTokens = nextTokens
        setRangeTokenOwner(nextTokens)

        if (trimmedCopyEligible && this.#copyOwner === 'range') {
          const copyEntries = nextEntries.filter((item) => item.copyEligible)
          const nextCopyTokens = compactSyntaxRangeTokens(
            this.#rangeCopyTokens,
            this.#tokenCoverage(copyEntries),
          )
          const currentContributor = this.rangeCopyOwner?.contributor ?? null
          const nextContributor =
            currentContributor && copyEntries.includes(currentContributor)
              ? currentContributor
              : this.#primaryCopyContributor(copyEntries)
          this.#rangeCopyTokens = nextCopyTokens
          return {
            admitted: true,
            entry,
            copyStoreChanged: true,
            primaryCopyContributor: nextContributor,
          }
        }
      }
      return {
        admitted: true,
        entry,
        copyStoreChanged: false,
        primaryCopyContributor: this.rangeCopyOwner?.contributor ?? null,
      }
    }

    // Optional partial `warm`.
    const tokenCoverage = this.#tokenCoverage()
    const claimable = isEmptyRange ? [] : subtractSyntaxRanges([range], tokenCoverage)
    if (claimable.length === 0) {
      return { admitted: false, entry: null, copyStoreChanged: false, primaryCopyContributor: null }
    }
    const entry = makeEntry(claimable, [])
    this.#rangeEntries = this.#rangeEntries.concat(entry)
    if (!this.#highlighterSession) {
      const nextTokens = mergeTokensOnStrips(this.#currentTokens, incomingTokens, claimable)
      this.#currentTokens = nextTokens
      setRangeTokenOwner(nextTokens)
    }
    return {
      admitted: true,
      entry,
      copyStoreChanged: false,
      primaryCopyContributor: this.rangeCopyOwner?.contributor ?? null,
    }
  }

  #paintAfterRangeAdmission(
    admitted: {
      readonly entry: CachedSyntaxRangeEntry | null
      readonly copyStoreChanged: boolean
      readonly primaryCopyContributor: CachedSyntaxRangeEntry | null
    },
    firstRows: boolean,
    partial: boolean,
    terminalPartial: boolean,
    configurationGeneration: number,
  ): void {
    const entry = admitted.entry
    if (!entry) return

    if (admitted.copyStoreChanged && this.#copyOwner === 'range') {
      const copyStore = this.#rangeCopyTokens
      this.rangeCopyOwner = admitted.primaryCopyContributor
        ? { store: copyStore, contributor: admitted.primaryCopyContributor }
        : null
      if (firstRows) {
        // Set rangeCopyOwner BEFORE painting so adoptTokens sees exact paint provenance.
        this.#paintAheadOfSettlement(
          () => this.#applyTokens(this.#currentTokens, true, copyStore, 'range'),
          configurationGeneration,
        )
        return
      }
      if (!partial && !terminalPartial) {
        // Complete visible/intersecting-prefetch paint: update tokens and copy store without
        // prematurely settling initialHighlightStatus if the viewport isn't settled yet.
        const currentCopyAccepted =
          this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
          this.#acceptedTokensTextVersion === this.options.getTextVersion()
        if (currentCopyAccepted || entry.copyEligible) {
          this.#applyTokens(this.#currentTokens, true, copyStore, 'range')
        } else {
          this.options.adoptTokens(this.#currentTokens)
        }
        return
      }
      // Partial (non-terminal or terminal): paint provisional tokens without losing copy store.
      this.#applyTokens(this.#currentTokens, true, copyStore, 'range')
      return
    }

    // Off-screen warm/prefetch or external copy owner: adopt display tokens without modifying copyTokens.
    this.options.adoptTokens(this.#currentTokens)
  }

  #rebuildRangeCopyTokens(
    entries: readonly CachedSyntaxRangeEntry[],
    currentTokens: EditorTokenStore,
  ): EditorTokenStore {
    const copyEntries = entries.filter((entry) => entry.copyEligible)
    if (copyEntries.length === 0) return EditorTokenStore.empty()
    if (copyEntries.length === entries.length && this.#rangeTokenOwner?.store === currentTokens) {
      return currentTokens
    }
    let store = EditorTokenStore.empty()
    for (const entry of copyEntries) {
      store = mergeTokensOnStrips(store, entry.tokens, entry.tokenOwnedRanges)
    }
    return store
  }

  #reconcileViewportScope(
    visibleRange: EditorSyntaxRange,
    options: {
      readonly configurationGeneration: number
    },
  ): ReconcileViewportResult {
    if (this.#parseState.kind !== 'parsed' || this.#parseState.mode !== 'range') {
      return { kind: 'incomplete' }
    }

    // 1. Check full complete coverage of the viewport.
    if (this.#rangeCoveredByComplete(visibleRange)) {
      const composed = this.#composeViewportScope(visibleRange)
      if (composed.kind === 'needs-authoritative-records-query') {
        if (this.#isRecordsUnavailableFor(visibleRange)) {
          this.#currentBrackets = []
          this.#currentInjections = []
          this.#publishedScope = {
            kind: 'range',
            range: visibleRange,
            degraded: true,
            unavailable: true,
          }
          if (this.#unavailableRecordsClearsScope) {
            this.#rangeScopeOwners = []
            this.options.clearSyntaxFolds()
            this.options.setSyntaxCaptures?.([], undefined)
          }
          this.#settleDegradedHighlight(options.configurationGeneration)
          return { kind: 'settled-degraded' }
        }
        return { kind: 'needs-authoritative-records-query' }
      }

      // Viewport-settled promotion: any prefetch/warm contributor that settled the viewport is
      // promoted to `visible` (for prefetches) and `copyEligible = true`.
      const promotedMap = new Map<CachedSyntaxRangeEntry, CachedSyntaxRangeEntry>()
      let entriesChanged = false
      const nextEntries = this.#rangeEntries.map((entry) => {
        if (!composed.contributors.includes(entry)) return entry
        const nextSource = entry.source === 'prefetch' ? 'visible' : entry.source
        if (nextSource === entry.source && entry.copyEligible) return entry
        entriesChanged = true
        const promoted: CachedSyntaxRangeEntry = {
          ...entry,
          source: nextSource,
          copyEligible: true,
        }
        promotedMap.set(entry, promoted)
        return promoted
      })
      if (entriesChanged) this.#rangeEntries = nextEntries
      const finalContributors = composed.contributors.map(
        (entry) => promotedMap.get(entry) ?? entry,
      )

      const sole = finalContributors[0]
      const unsupersededSole =
        finalContributors.length === 1 &&
        sole !== undefined &&
        (visibleRange.endIndex <= visibleRange.startIndex ||
          sameSyntaxRanges(sole.scopeOwnedRanges, [sole.range]))
      const sameSingleOwner =
        !entriesChanged &&
        unsupersededSole &&
        this.#rangeScopeOwners.length === 1 &&
        this.#rangeScopeOwners[0] === sole &&
        this.#publishedScope?.kind === 'range' &&
        !this.#publishedScope.unavailable &&
        this.#publishedScope.degraded === composed.degraded

      this.#publishedScope = {
        kind: 'range',
        range: visibleRange,
        degraded: composed.degraded,
        unavailable: false,
      }
      if (!sameSingleOwner) {
        this.#rangeScopeOwners = finalContributors
        this.#currentBrackets = composed.brackets
        this.#currentInjections = composed.injections
        this.options.setSyntaxFolds(composed.folds)
        this.options.setSyntaxCaptures?.(composed.captures, composed.records)
      }
      return {
        kind: 'settled',
        degraded: composed.degraded,
        contributors: finalContributors,
        promoted: entriesChanged,
        scopeChanged: !sameSingleOwner,
      }
    }

    // 3. Check whether complete ∪ unavailable covers ALL of the viewport (terminal degraded settlement).
    if (this.#rangeCoveredBySettled(visibleRange)) {
      const clearsScope =
        visibleRange.endIndex <= visibleRange.startIndex
          ? this.#unavailableEmptyClearsScope &&
            this.#unavailableEmptyRange !== null &&
            sameSyntaxRange(this.#unavailableEmptyRange, visibleRange)
          : syntaxRangeListsIntersect(this.#unavailableClearsScopeRanges, [visibleRange])
      this.#currentBrackets = []
      this.#currentInjections = []
      this.#publishedScope = {
        kind: 'range',
        range: visibleRange,
        degraded: true,
        unavailable: true,
      }
      if (clearsScope) {
        this.#rangeScopeOwners = []
        this.options.clearSyntaxFolds()
        this.options.setSyntaxCaptures?.([], undefined)
      }
      this.#settleDegradedHighlight(options.configurationGeneration)
      return { kind: 'settled-degraded' }
    }

    return { kind: 'incomplete' }
  }

  #settleDegradedHighlight(configurationGeneration: number): void {
    if (!this.#highlighterSession) {
      this.#commitInitialHighlightStatus(
        'degraded',
        () => this.options.notifyViewUpdate(),
        configurationGeneration,
      )
      return
    }
    if (this.#pendingReplacementMatches('syntax', configurationGeneration)) {
      this.#commitInitialHighlightStatus(
        this.#lastInitialHighlightTerminalStatus ?? 'painted',
        () => this.setTokens(this.#currentTokens, false),
        configurationGeneration,
      )
    }
  }

  #composeViewportScope(visibleRange: EditorSyntaxRange): ViewportCompositionResult {
    const isEmpty = visibleRange.endIndex <= visibleRange.startIndex
    const contributors = this.#rangeEntries.filter(
      (entry) =>
        !entry.tokensOnly &&
        (isEmpty
          ? sameSyntaxRange(entry.range, visibleRange)
          : syntaxRangeListsIntersect(entry.scopeOwnedRanges, [visibleRange])),
    )

    // Exact unsuperseded single-entry fast path.
    if (
      contributors.length === 1 &&
      (isEmpty || sameSyntaxRanges(contributors[0]!.scopeOwnedRanges, [contributors[0]!.range]))
    ) {
      const sole = contributors[0]!
      return {
        kind: 'composed',
        contributors,
        folds: sole.folds,
        brackets: sole.brackets,
        injections: sole.injections,
        captures: sole.captures,
        records: sole.result.records,
        degraded: sole.result.degraded !== null,
      }
    }

    // Multi-entry or partially superseded entry: records-bearing providers require one authoritative
    // answer when a downstream consumer reads syntax records/captures.
    if (
      this.#consumesSyntaxRecords() &&
      contributors.some((entry) => entry.result.records !== undefined)
    ) {
      return { kind: 'needs-authoritative-records-query' }
    }

    const mergedOwned = mergeSyntaxRanges(contributors.flatMap((entry) => entry.scopeOwnedRanges))
    const contiguousSpan =
      mergedOwned.find(
        (span) =>
          span.startIndex <= visibleRange.startIndex && span.endIndex >= visibleRange.endIndex,
      ) ?? visibleRange

    const bracketsByIndex = new Map<number, BracketInfo>()
    const foldsByKey = new Map<string, FoldRange>()
    const injectionsByKey = new Map<string, EditorSyntaxInjection>()
    const includeCaptures = this.options.needsSyntaxCaptures?.() ?? false
    const capturesByKey = includeCaptures ? new Map<string, EditorSyntaxCapture>() : null
    let degraded = false

    for (const contributor of contributors) {
      if (contributor.result.degraded !== null) degraded = true
      const ownedInScope = intersectSyntaxRanges(contributor.scopeOwnedRanges, [contiguousSpan])
      const ownedInViewport = intersectSyntaxRanges(contributor.scopeOwnedRanges, [visibleRange])

      for (const bracket of contributor.brackets) {
        if (!offsetInSyntaxRanges(bracket.index, ownedInScope)) continue
        bracketsByIndex.set(bracket.index, bracket)
      }
      for (const fold of contributor.folds) {
        if (!foldIntersectsSyntaxRange(fold, visibleRange)) continue
        if (!syntaxRangeListsIntersect([fold], ownedInViewport)) continue
        foldsByKey.set(foldRangeKey(fold), fold)
      }
      for (const injection of contributor.injections) {
        if (!syntaxRangeListsIntersect([injection], ownedInScope)) continue
        const key = `${injection.parentLanguageId}\0${injection.languageId}\0${injection.startIndex}\0${injection.endIndex}`
        injectionsByKey.set(key, injection)
      }
      if (capturesByKey) {
        for (const capture of contributor.captures) {
          if (!syntaxRangeListsIntersect([capture], ownedInScope)) continue
          const key = `${capture.startIndex}:${capture.endIndex}:${capture.captureName}:${capture.languageId ?? ''}:${capture.injectionDepth ?? 0}`
          capturesByKey.set(key, capture)
        }
      }
    }

    return {
      kind: 'composed',
      contributors,
      folds: Array.from(foldsByKey.values()).sort(compareFoldRanges),
      brackets: Array.from(bracketsByIndex.values()).sort(
        (left, right) => left.index - right.index,
      ),
      injections: Array.from(injectionsByKey.values()).sort(
        (left, right) =>
          left.startIndex - right.startIndex ||
          left.endIndex - right.endIndex ||
          left.parentLanguageId.localeCompare(right.parentLanguageId) ||
          left.languageId.localeCompare(right.languageId),
      ),
      captures: capturesByKey
        ? Array.from(capturesByKey.values()).sort(
            (left, right) =>
              left.startIndex - right.startIndex ||
              left.endIndex - right.endIndex ||
              (left.injectionDepth ?? 0) - (right.injectionDepth ?? 0) ||
              left.captureName.localeCompare(right.captureName),
          )
        : [],
      records: undefined,
      degraded,
    }
  }

  #isRecordsUnavailableFor(range: EditorSyntaxRange): boolean {
    const marker = this.#unavailableRecordsRange
    if (!marker) return false
    if (range.endIndex <= range.startIndex) return sameSyntaxRange(marker, range)
    return syntaxRangeCoverage(range, [marker]) === 'full'
  }

  #consumesSyntaxRecords(): boolean {
    return this.options.setSyntaxCaptures !== undefined
  }

  #needsAuthoritativeRecordsQuery(visibleRange: EditorSyntaxRange): boolean {
    if (!this.#consumesSyntaxRecords()) return false
    if (this.#isRecordsUnavailableFor(visibleRange)) return false
    if (this.#parseState.kind === 'error') return false
    return this.#entriesNeedAuthoritativeRecordsQuery(visibleRange, this.#rangeEntries)
  }

  #entriesNeedAuthoritativeRecordsQuery(
    visibleRange: EditorSyntaxRange,
    entries: readonly CachedSyntaxRangeEntry[],
  ): boolean {
    if (!this.#consumesSyntaxRecords()) return false
    const isEmpty = visibleRange.endIndex <= visibleRange.startIndex
    const completeIntersecting = entries.filter(
      (entry) =>
        !entry.tokensOnly &&
        (isEmpty
          ? sameSyntaxRange(entry.range, visibleRange)
          : syntaxRangeListsIntersect(entry.scopeOwnedRanges, [visibleRange])),
    )
    if (!completeIntersecting.some((entry) => entry.result.records !== undefined)) return false
    if (completeIntersecting.length !== 1) return true
    const sole = completeIntersecting[0]!
    if (isEmpty) return !sameSyntaxRange(sole.range, visibleRange)
    if (!sameSyntaxRanges(sole.scopeOwnedRanges, [sole.range])) return true
    return syntaxRangeCoverage(visibleRange, [sole.range]) !== 'full'
  }

  #nextRequiredVisibleRange(range: EditorSyntaxRange): EditorSyntaxRange | null {
    if (this.#needsAuthoritativeRecordsQuery(range)) return range

    const isEmpty = range.endIndex <= range.startIndex
    if (isEmpty) {
      if (this.#hasCompleteEmptyEntry(range)) return null
      if (this.#unavailableEmptyRange && sameSyntaxRange(this.#unavailableEmptyRange, range)) {
        return null
      }
      if (
        this.#rangeEntries.some(
          (entry) =>
            entry.tokensOnly &&
            !entry.firstRows &&
            entry.result.projection.analysis?.kind === 'partial' &&
            !isTerminalIncompleteSyntaxResult(entry.result) &&
            sameSyntaxRange(entry.range, range),
        )
      ) {
        return null
      }
      return range
    }

    const covered = mergeSyntaxRanges(
      this.#settledCoverage().concat(this.#provisionalPartialCoverage()),
    )
    return firstUncoveredSyntaxRange(range, covered)
  }

  #provisionalPartialCoverage(): readonly EditorSyntaxRange[] {
    const ranges: EditorSyntaxRange[] = []
    for (const entry of this.#rangeEntries) {
      if (
        entry.tokensOnly &&
        !entry.firstRows &&
        entry.result.projection.analysis?.kind === 'partial' &&
        !isTerminalIncompleteSyntaxResult(entry.result)
      ) {
        for (const owned of entry.tokenOwnedRanges) ranges.push(owned)
      }
    }
    return mergeSyntaxRanges(ranges)
  }

  #completeScopeCoverage(
    entries: readonly CachedSyntaxRangeEntry[] = this.#rangeEntries,
  ): readonly EditorSyntaxRange[] {
    const ranges: EditorSyntaxRange[] = []
    for (const entry of entries) {
      if (entry.tokensOnly) continue
      for (const owned of entry.scopeOwnedRanges) ranges.push(owned)
    }
    return mergeSyntaxRanges(ranges)
  }

  #tokenCoverage(
    entries: readonly CachedSyntaxRangeEntry[] = this.#rangeEntries,
  ): readonly EditorSyntaxRange[] {
    const ranges: EditorSyntaxRange[] = []
    for (const entry of entries) {
      for (const owned of entry.tokenOwnedRanges) ranges.push(owned)
    }
    return mergeSyntaxRanges(ranges)
  }

  #settledCoverage(): readonly EditorSyntaxRange[] {
    return mergeSyntaxRanges(this.#completeScopeCoverage().concat(this.#unavailableRanges))
  }

  #hasCompleteEmptyEntry(range: EditorSyntaxRange): boolean {
    return this.#rangeEntries.some(
      (entry) => !entry.tokensOnly && sameSyntaxRange(entry.range, range),
    )
  }

  #hasAnyEmptyEntry(range: EditorSyntaxRange): boolean {
    return this.#rangeEntries.some((entry) => sameSyntaxRange(entry.range, range))
  }

  #rangeCoveredByComplete(range: EditorSyntaxRange): boolean {
    if (range.endIndex <= range.startIndex) return this.#hasCompleteEmptyEntry(range)
    return syntaxRangeCoverage(range, this.#completeScopeCoverage()) === 'full'
  }

  #rangeCoveredBySettled(range: EditorSyntaxRange): boolean {
    if (range.endIndex <= range.startIndex) {
      return (
        this.#hasCompleteEmptyEntry(range) ||
        (this.#unavailableEmptyRange !== null &&
          sameSyntaxRange(this.#unavailableEmptyRange, range))
      )
    }
    return syntaxRangeCoverage(range, this.#settledCoverage()) === 'full'
  }

  #rangeCoveredByTokens(range: EditorSyntaxRange): boolean {
    if (range.endIndex <= range.startIndex) return this.#hasAnyEmptyEntry(range)
    return syntaxRangeCoverage(range, this.#tokenCoverage()) === 'full'
  }

  #rangeIntersectsTokens(range: EditorSyntaxRange): boolean {
    if (range.endIndex <= range.startIndex) return this.#hasAnyEmptyEntry(range)
    return syntaxRangeCoverage(range, this.#tokenCoverage()) !== 'none'
  }

  #canProviderQuerySyntaxRange(): boolean {
    return this.syntaxSession?.canQueryRange?.() ?? true
  }

  #isParseIdCurrent(): boolean {
    if (!this.retainedSyntax || this.#parseState.kind !== 'parsed') return true
    if (this.#parseState.parseId === null) return true
    return this.retainedSyntax.currentParseId() === this.#parseState.parseId
  }

  #canQueryCurrentSyntaxRange(): boolean {
    return (
      this.#canProviderQuerySyntaxRange() &&
      this.#parseState.kind === 'parsed' &&
      this.#parseState.mode === 'range' &&
      this.#parseState.contentVersion === this.#syntaxContentVersion &&
      this.#parseState.parseGeneration === this.#parseGeneration &&
      this.#isParseIdCurrent()
    )
  }

  #canQuerySyntaxRangeForRequest(updatesDocument: boolean): boolean {
    if (updatesDocument) return this.#canProviderQuerySyntaxRange()
    return this.#canQueryCurrentSyntaxRange()
  }

  #acceptSyntaxDocument(
    guard: RequestGuard,
    parseId: number | null,
    mode: 'full' | 'range',
    parseKind: 'full' | 'partial',
    fullResult: EditorSyntaxResult | null,
    promotedEntries: readonly CachedSyntaxRangeEntry[],
  ): void {
    const alreadyAcceptedThisParse =
      this.#acceptedContentVersion === guard.contentVersion &&
      this.#acceptedParseGeneration === guard.parseGeneration &&
      this.#acceptedParseId === parseId

    this.#carriedEntries = null
    this.#acceptedContentVersion = guard.contentVersion
    this.#acceptedParseGeneration = guard.parseGeneration
    this.#acceptedParseId = parseId
    this.#parseState = {
      kind: 'parsed',
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
      parseId,
      mode,
      parseKind,
      fullResult,
    }

    if (alreadyAcceptedThisParse) return

    const previousEntries = this.#rangeEntries
    this.#publishedScope = null
    this.#unavailableRanges = []
    this.#unavailableClearsScopeRanges = []
    this.#unavailableEmptyRange = null
    this.#unavailableEmptyClearsScope = false
    this.#unavailableRecordsRange = null
    this.#unavailableRecordsClearsScope = false
    this.#rangeScopeOwners = []
    this.#rangeEntries = promotedEntries

    if (!this.#highlighterSession && mode === 'range') {
      const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
      const ownsProjectedPaint =
        this.#projectedRangeTokens !== null && this.#projectedRangeTokens === this.#currentTokens
      const canOwnRanges =
        this.#copyOwner !== 'external' &&
        (this.#rangeTokenOwner?.store === this.#currentTokens ||
          ownsProjectedPaint ||
          this.#currentTokens.length === 0)
      const priorUnownedStrips =
        !canOwnRanges && (this.#pendingUnownedStrips.length > 0 || previousEntries.length > 0)
          ? mergeSyntaxRanges(
              this.#pendingUnownedStrips.concat(this.#tokenCoverage(previousEntries)),
            )
          : []
      if (promotedEntries.length > 0) {
        let nextTokens = canOwnRanges ? EditorTokenStore.empty() : this.#currentTokens
        let restoredHostPaint = false
        if (!canOwnRanges && priorUnownedStrips.length > 0) {
          const staleStrips = subtractSyntaxRanges(
            priorUnownedStrips,
            this.#tokenCoverage(promotedEntries),
          )
          if (staleStrips.length > 0) {
            const fallback =
              this.#externalBaseTokens?.snapshot === snapshot
                ? this.#externalBaseTokens.store
                : EditorTokenStore.empty()
            nextTokens = mergeTokensOnStrips(nextTokens, fallback, staleStrips)
            restoredHostPaint = true
          }
        }
        this.#pendingUnownedStrips = []
        for (const entry of promotedEntries) {
          nextTokens = mergeTokensOnStrips(nextTokens, entry.tokens, entry.tokenOwnedRanges)
        }
        const previousTokens = this.#currentTokens
        this.#currentTokens = nextTokens
        this.#rangeTokenOwner = canOwnRanges && snapshot ? { store: nextTokens, snapshot } : null
        if (canOwnRanges) {
          this.#projectedRangeTokens = null
          this.#awaitingProjectedEditTokens = false
        }
        if (this.#copyOwner !== 'external') {
          const nextCopyTokens = this.#rebuildRangeCopyTokens(promotedEntries, nextTokens)
          this.#rangeCopyTokens = nextCopyTokens
          this.#copyOwner = 'range'
          const primary = this.#primaryCopyContributor(promotedEntries)
          this.rangeCopyOwner = primary ? { store: nextCopyTokens, contributor: primary } : null
          if (
            this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
            this.#acceptedTokensTextVersion === this.options.getTextVersion()
          ) {
            this.#acceptedCopyTokens = nextCopyTokens
          }
        }
        if (restoredHostPaint || nextTokens !== previousTokens) {
          this.options.adoptTokens(this.#currentTokens)
        }
      } else if (!canOwnRanges && priorUnownedStrips.length > 0) {
        const fallback =
          this.#externalBaseTokens?.snapshot === snapshot
            ? this.#externalBaseTokens.store
            : EditorTokenStore.empty()
        this.#currentTokens = mergeTokensOnStrips(this.#currentTokens, fallback, priorUnownedStrips)
        this.#pendingUnownedStrips = []
        if (this.#copyOwner !== 'external') {
          this.#rangeCopyTokens = EditorTokenStore.empty()
          this.rangeCopyOwner = null
          this.#copyOwner = 'none'
          if (
            this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
            this.#acceptedTokensTextVersion === this.options.getTextVersion()
          ) {
            this.#acceptedCopyTokens = EditorTokenStore.empty()
          }
        }
        this.options.adoptTokens(this.#currentTokens)
      } else {
        this.#pendingUnownedStrips = []
        if (previousEntries.length > 0) {
          if (this.#copyOwner !== 'external') {
            this.#rangeCopyTokens = EditorTokenStore.empty()
            this.rangeCopyOwner = null
            this.#copyOwner = 'none'
            if (
              this.#acceptedTokensDocumentVersion === this.options.getDocumentVersion() &&
              this.#acceptedTokensTextVersion === this.options.getTextVersion()
            ) {
              this.#acceptedCopyTokens = EditorTokenStore.empty()
            }
          }
          if (canOwnRanges) {
            this.#currentTokens = EditorTokenStore.empty()
            this.#rangeTokenOwner = snapshot ? { store: this.#currentTokens, snapshot } : null
            this.#projectedRangeTokens = null
            this.#awaitingProjectedEditTokens = false
            this.options.adoptTokens(this.#currentTokens)
          }
        }
      }
    }
  }

  #resetSyntaxContentVersion(): void {
    this.#syntaxContentVersion += 1
  }

  #flushPendingPrefetch(): boolean {
    const pending = this.#pendingPrefetch
    this.#pendingPrefetch = null
    if (!pending) return false
    if (pending.documentVersion !== this.options.getDocumentVersion()) return false
    if (pending.contentVersion !== this.#syntaxContentVersion) return false
    if (pending.parseGeneration !== this.#parseGeneration) return false

    const scheduled = this.prefetchVisibleRange(
      pending.documentVersion,
      pending.range,
      pending.options,
    )
    if (!scheduled) this.#flushPendingWarm()
    return scheduled
  }

  #flushPendingWarm(): void {
    const pending = this.pendingWarm
    if (!pending) return
    if (pending.documentVersion !== this.options.getDocumentVersion()) return
    if (pending.contentVersion !== this.#syntaxContentVersion) return
    if (pending.parseGeneration !== this.#parseGeneration) return
    if (pending.configurationGeneration !== this.#initialHighlightConfigurationGeneration) return

    this.#scheduleNextWarmRange(pending)
  }

  #scheduleNextWarmRange(pending: PendingSyntaxWarm): void {
    if (pending.generation !== this.#warmGeneration) return
    if (!this.#canRunWarmRangeRequest()) return

    const range = this.#nextWarmRange(pending.seedRange)
    if (!range) {
      this.pendingWarm = null
      return
    }

    const guard: RequestGuard = {
      documentVersion: pending.documentVersion,
      contentVersion: pending.contentVersion,
      configurationGeneration: pending.configurationGeneration,
      parseGeneration: pending.parseGeneration,
    }
    this.#warmRangeRequests.schedule({
      delayMs: pending.delayMs,
      tags: syntaxWorkTags(pending.documentVersion, pending.contentVersion, 'warm', range),
      run: traceEditorPerformanceTask('editor.syntax.warm.request', (signal: AbortSignal) =>
        this.loadSyntaxRangeResult(range, 'warm', {
          contentVersion: pending.contentVersion,
          parseGeneration: pending.parseGeneration,
          signal,
        }),
      ),
      apply: traceEditorPerformanceTask('editor.syntax.warm.apply', (result, startedAt) => {
        if (pending.generation !== this.#warmGeneration) return
        if (!this.#isRequestCurrent(guard)) return
        const applied = this.#applySyntaxResult(result, guard, startedAt)
        if (applied) this.#scheduleNextWarmRange(pending)
      }),
      fail: traceEditorPerformanceTask('editor.syntax.warm.fail', (error, startedAt) => {
        if (!this.#isRequestCurrent(guard)) return
        this.#logOptionalSyntaxFailure(pending.documentVersion, error, startedAt)
      }),
    })
  }

  #canRunWarmRangeRequest(): boolean {
    if (!this.syntaxSession?.queryRange) return false
    if (!this.options.getSession()) return false
    if (!this.#canQueryCurrentSyntaxRange()) return false
    if (!this.#canWarmSyntax()) return false
    if (this.rangeRequests.isActive()) return false
    return !this.#prefetchRangeRequests.isActive()
  }

  #canWarmSyntax(): boolean {
    return !this.retainedSyntax || retainedSyntaxCanWarm(this.retainedSyntax)
  }

  #nextWarmRange(seedRange: EditorSyntaxRange): EditorSyntaxRange | null {
    const session = this.options.getSession()
    const documentLength = session?.getSnapshot().length ?? 0
    return nextUncachedSyntaxWarmRange(documentLength, seedRange, this.#tokenCoverage())
  }

  #nextWarmGeneration(): number {
    this.#warmGeneration += 1
    return this.#warmGeneration
  }

  #pruneDegradedAndPartialRangeEntries(): void {
    const previousEntries = this.#rangeEntries
    const kept = previousEntries.filter(
      (entry) => entry.result.degraded === null && !entry.tokensOnly,
    )
    if (kept.length === previousEntries.length) return
    const keptSet = new Set(kept)
    this.#rangeEntries = kept
    this.#lastRangeTrim = null
    if (this.#rangeScopeOwners.some((owner) => !keptSet.has(owner))) {
      this.#rangeScopeOwners = this.#rangeScopeOwners.filter((owner) => keptSet.has(owner))
      this.#publishedScope = null
    } else if (this.#publishedScope?.degraded) {
      this.#publishedScope = null
    }
    const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
    const rangeOwned =
      !this.#highlighterSession &&
      snapshot !== null &&
      this.#rangeTokenOwner?.store === this.#currentTokens &&
      this.#rangeTokenOwner.snapshot === snapshot
    let adoptedUpdatedTokens = false
    if (rangeOwned) {
      const tokens = compactSyntaxRangeTokens(this.#currentTokens, this.#tokenCoverage(kept))
      this.#currentTokens = tokens
      this.#rangeTokenOwner = { store: tokens, snapshot }
      adoptedUpdatedTokens = true
    } else if (!this.#highlighterSession) {
      const removed = previousEntries.filter((entry) => !keptSet.has(entry))
      const evictedRanges = this.#tokenCoverage(removed)
      if (evictedRanges.length > 0) {
        const fallback =
          snapshot !== null && this.#externalBaseTokens?.snapshot === snapshot
            ? this.#externalBaseTokens.store
            : EditorTokenStore.empty()
        this.#currentTokens = mergeTokensOnStrips(this.#currentTokens, fallback, evictedRanges)
        adoptedUpdatedTokens = true
      }
    }
    if (!this.#highlighterSession && this.#copyOwner === 'range') {
      this.#compactRangeCopyStore(kept, this.#currentTokens, rangeOwned)
    }
    if (adoptedUpdatedTokens) {
      this.options.adoptTokens(this.#currentTokens)
    }
  }

  #clearSyntaxRangeCache(): void {
    this.#lastRangeTrim = null
    this.#acceptedContentVersion = null
    this.#acceptedParseGeneration = null
    this.#acceptedParseId = null
    this.#rangeTokenOwner = null
    this.#projectedRangeTokens = null
    this.#awaitingProjectedEditTokens = false
    this.rangeCopyOwner = null
    this.#rangeCopyTokens = EditorTokenStore.empty()
    if (this.#copyOwner === 'range') this.#copyOwner = 'none'
    this.#rangeScopeOwners = []
    this.#publishedScope = null
    this.#rangeEntries = []
    this.#carriedEntries = null
    this.#unavailableRanges = []
    this.#unavailableClearsScopeRanges = []
    this.#unavailableEmptyRange = null
    this.#unavailableEmptyClearsScope = false
    this.#unavailableRecordsRange = null
    this.#unavailableRecordsClearsScope = false
  }

  #applyHighlightResult(
    result: EditorHighlightResult,
    documentVersion: number,
    _startedAt: number,
    configurationGeneration: number,
  ): void {
    const session = this.options.getSession()
    if (!session || documentVersion !== this.options.getDocumentVersion()) return
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return

    if (editorPerformanceDiagnosticsEnabled()) {
      recordEditorPerformanceDiagnostic('editor.syntax.highlight.accepted', () => ({
        documentVersion,
        configurationGeneration,
      }))
    }
    const failedRefreshes = this.#failedHighlightRefreshes
    this.#failedHighlightRefreshes = 0
    this.#consumeRetainedProviderTheme()
    if (result.theme !== undefined) this.#setHighlighterTheme(result.theme)
    if (
      this.#currentTokens === result.tokens &&
      this.#acceptedTokensDocumentVersion === documentVersion &&
      this.#acceptedTokensTextVersion === this.options.getTextVersion() &&
      this.#initialHighlightState === 'painted' &&
      this.pendingInitialHighlightReplacement === null
    )
      return
    this.#commitInitialHighlightStatus(
      'painted',
      () => this.setTokens(result.tokens),
      configurationGeneration,
    )
    this.options.log?.({
      action: 'editor.syntax.highlight_applied',
      level: 'debug',
      syntax: {
        documentVersion,
        tokenCount: result.tokens.length,
      },
    })
    if (failedRefreshes > 0) {
      this.options.log?.({
        action: 'editor.syntax.highlight_recovered',
        level: 'info',
        syntax: { ...this.#debugContext(documentVersion), attempts: failedRefreshes + 1 },
      })
    }
    this.options.notifyChange(null)
  }

  #applySyntaxError(guard: RequestGuard): void {
    if (!this.#isRequestCurrent(guard)) return

    this.#carriedEntries = null
    this.#parseState = {
      kind: 'error',
      contentVersion: guard.contentVersion,
      parseGeneration: guard.parseGeneration,
    }
    this.#publishedScope = null
    this.#rangeScopeOwners = []
    this.#currentBrackets = []
    this.#currentInjections = []
    this.options.clearSyntaxFolds()
    this.options.setSyntaxCaptures?.([], undefined)
    this.options.notifyViewUpdate()
    if (!this.#highlighterSession) this.#commitInitialHighlightError(guard.configurationGeneration)
    if (
      this.#highlighterSession &&
      this.#pendingReplacementMatches('syntax', guard.configurationGeneration)
    ) {
      const terminalStatus = this.#lastInitialHighlightTerminalStatus ?? 'painted'
      this.#commitInitialHighlightStatus(
        terminalStatus,
        () => this.setTokens(this.#currentTokens, false),
        guard.configurationGeneration,
      )
    }
    warnEditorSyntax('mark structural syntax error', this.#debugContext(guard.documentVersion))
    this.options.notifyChange(null)
  }

  #recoverSyntaxError(
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
    guard: RequestGuard,
  ): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (!this.#isRequestCurrent(guard)) return
    const changeKind = change?.kind ?? 'refresh'

    if (!change) this.#applySyntaxError(guard)
    if (change) {
      this.#carriedEntries = null
      warnEditorSyntax('reload structural syntax after edit failure', {
        ...this.#debugContext(guard.documentVersion),
        changeKind,
      })
      this.reloadSyntaxSession(false)
    }

    this.options.log?.({
      action: 'editor.syntax.structural_request_failed',
      level: 'error',
      error: syntaxLogError(error),
      syntax: {
        ...this.#debugContext(guard.documentVersion),
        changeKind,
        startedAt,
      },
    })
    warnEditorSyntax(`structural syntax request failed: ${syntaxErrorMessage(error)}`, {
      ...this.#debugContext(guard.documentVersion),
      changeKind,
      error: syntaxDebugError(error),
      startedAt,
    })
  }

  #applyHighlightError(
    documentVersion: number,
    error: unknown,
    configurationGeneration: number,
  ): void {
    const session = this.options.getSession()
    if (!session || documentVersion !== this.options.getDocumentVersion()) return
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return

    const attempts = this.#failedHighlightRefreshes
    this.options.log?.({
      action: 'editor.syntax.highlight_retries_exhausted',
      level: 'warn',
      error: syntaxLogError(error),
      syntax: { ...this.#debugContext(documentVersion), attempts },
    })
    warnEditorSyntax(
      `plugin highlighting failed ${attempts} times, clearing it: ${syntaxErrorMessage(error)}`,
      this.#debugContext(documentVersion),
    )
    this.#setHighlighterTheme(null)
    this.#commitInitialHighlightStatus(
      'error',
      () => this.setTokens(EditorTokenStore.empty()),
      configurationGeneration,
    )
    this.options.notifyChange(null)
  }

  #recoverHighlightError(
    documentVersion: number,
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
    configurationGeneration: number,
  ): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (documentVersion !== this.options.getDocumentVersion()) return
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return
    if (!change) this.#failedHighlightRefreshes += 1
    this.options.log?.({
      action: 'editor.syntax.highlight_request_failed',
      level: 'warn',
      error: syntaxLogError(error),
      syntax: {
        ...this.#debugContext(documentVersion),
        changeKind: change?.kind ?? 'refresh',
        failedRefreshes: this.#failedHighlightRefreshes,
        startedAt,
      },
    })
    warnEditorSyntax(`plugin highlighting request failed: ${syntaxErrorMessage(error)}`, {
      ...this.#debugContext(documentVersion),
      changeKind: change?.kind ?? 'refresh',
      error: syntaxDebugError(error),
      startedAt,
    })

    if (!change) {
      this.#retryHighlightRefresh(documentVersion, error, configurationGeneration)
      return
    }

    warnEditorSyntax('reload plugin highlighter after edit failure', {
      ...this.#debugContext(documentVersion),
      changeKind: change.kind,
    })
    // The reloaded session's refresh starts a fresh ladder, even after an earlier one ran out.
    this.#failedHighlightRefreshes = 0
    this.#reloadHighlighterSession()
  }

  // Each retry lands through applyHighlightResult or recoverHighlightError, which drop it once
  // the document version has moved on.
  #retryHighlightRefresh(
    documentVersion: number,
    error: unknown,
    configurationGeneration: number,
  ): void {
    const rung = this.#failedHighlightRefreshes - 1
    const delayMs = HIGHLIGHT_RETRY_DELAYS_MS[rung]
    if (delayMs === undefined) {
      this.#applyHighlightError(documentVersion, error, configurationGeneration)
      return
    }
    if (rung === HIGHLIGHT_RETRY_DELAYS_MS.length - 1) {
      this.#reloadHighlighterSession({ delayMs })
      // A provider that declines the new session leaves nothing to retry.
      if (!this.#highlighterSession) {
        this.#applyHighlightError(documentVersion, error, configurationGeneration)
      }
      return
    }
    this.#refreshHighlightTokens(documentVersion, null, { delayMs })
  }

  #debugContext(documentVersion: number): EditorSyntaxDebugPayload {
    const session = this.options.getSession()
    return {
      currentDocumentVersion: this.options.getDocumentVersion(),
      documentId: this.options.getCurrentSessionDocumentId(),
      documentLength: session?.getSnapshot().length ?? null,
      documentVersion,
      hasHighlighterSession: Boolean(this.#highlighterSession),
      hasSyntaxSession: Boolean(this.syntaxSession),
      languageId: this.options.getLanguageId(),
      syntaxStatus: this.#structuralBaseStatus(),
      ...this.fallbackFoldSelection,
    }
  }

  #setHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.#highlighterTheme, nextTheme)) return

    this.#highlighterTheme = nextTheme
    this.options.log?.({
      action: 'editor.syntax.highlighter_theme_changed',
      level: 'debug',
      syntax: { hasTheme: nextTheme !== null },
    })
    this.options.notifyThemeChanged()
  }

  #setProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.#providerHighlighterTheme, nextTheme)) return

    this.#providerHighlighterTheme = nextTheme
    this.options.log?.({
      action: 'editor.syntax.provider_theme_changed',
      level: 'debug',
      syntax: { hasTheme: nextTheme !== null },
    })
    this.options.notifyThemeChanged()
  }

  #completeProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    this.#highlighterThemePending = false
    this.#setProviderHighlighterTheme(theme)

    const terminal = this.#pendingInitialHighlightThemeTerminal
    this.#pendingInitialHighlightThemeTerminal = null
    if (
      terminal &&
      terminal.configurationGeneration === this.#initialHighlightConfigurationGeneration
    ) {
      this.#commitInitialHighlightStatus(
        terminal.status,
        () => this.setTokens(this.#currentTokens, false),
        terminal.configurationGeneration,
      )
      return
    }

    this.#settlePlainInitialHighlightIfNeeded()
  }

  #consumeRetainedProviderTheme(): void {
    const read = this.#retainedHighlighter?.read()
    if (read?.kind !== 'ready') return
    this.#completeProviderHighlighterTheme(
      read.providerTheme.kind === 'ready' ? read.providerTheme.theme : null,
    )
  }

  #beginInitialHighlightReplacement(replacement: InitialHighlightReplacement): number {
    if (!this.options.getSession()) return this.#initialHighlightConfigurationGeneration

    const pending = this.pendingInitialHighlightReplacement
    if (!pending && this.#initialHighlightState === 'loading' && replacement !== 'all') {
      return this.#initialHighlightConfigurationGeneration
    }
    if (pending && replacementPriority(replacement) < replacementPriority(pending.kind)) {
      return pending.generation
    }

    if (replacement === 'theme') {
      const generation = this.#initialHighlightConfigurationGeneration
      this.pendingInitialHighlightReplacement = { generation, kind: replacement }
      this.#initialHighlightState = 'loading'
      this.options.notifyViewUpdate()
      return generation
    }

    const generation = this.#advanceInitialHighlightConfigurationGeneration()
    this.pendingInitialHighlightReplacement = { generation, kind: replacement }
    this.#initialHighlightState = 'loading'
    this.#initialHighlightPaintEmitted = false
    this.options.notifyViewUpdate()
    return generation
  }

  #settlePlainInitialHighlightIfNeeded(): void {
    if (!this.options.getSession()) return
    if (this.#highlighterSession || this.syntaxSession) return

    this.#commitInitialHighlightStatus(
      'plain',
      () => this.options.notifyViewUpdate(),
      this.#initialHighlightConfigurationGeneration,
    )
  }

  #currentApplicableTerminalStatus(): SettledHighlightStatus | null {
    if (this.#highlighterSession) {
      if (this.#initialHighlightState === 'error') return 'error'
      if (this.#initialHighlightState === 'loading') return null
      return 'painted'
    }
    if (this.syntaxSession) {
      const status = this.status
      if (status === 'loading') return null
      if (status === 'degraded') return 'degraded'
      if (status === 'error') return 'error'
      return 'painted'
    }
    return 'plain'
  }

  #commitInitialHighlightError(configurationGeneration: number): void {
    this.#commitInitialHighlightStatus(
      'error',
      () => this.options.notifyViewUpdate(),
      configurationGeneration,
    )
  }

  /**
   * Puts tokens on screen without settling the document's highlight: the status stays `loading`
   * and no initial-paint event is sent, because the answer that covers the visible range is
   * still on its way.
   */
  #paintAheadOfSettlement(paint: () => void, configurationGeneration: number): void {
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return
    paint()
  }

  #commitInitialHighlightStatus(
    status: SettledHighlightStatus,
    publish: () => void,
    configurationGeneration: number,
  ): void {
    if (configurationGeneration !== this.#initialHighlightConfigurationGeneration) return

    if (this.#highlighterThemePending) {
      this.#lastInitialHighlightTerminalStatus = status
      this.pendingInitialHighlightReplacement = null
      publish()
      this.#pendingInitialHighlightThemeTerminal = {
        configurationGeneration,
        status,
      }
      return
    }

    this.#initialHighlightState = status
    this.#lastInitialHighlightTerminalStatus = status
    this.pendingInitialHighlightReplacement = null
    publish()
    this.#emitInitialHighlightPaintIfReady()
  }

  #pendingReplacementMatches(
    kind: InitialHighlightReplacement,
    configurationGeneration: number,
  ): boolean {
    const pending = this.pendingInitialHighlightReplacement
    return pending?.generation === configurationGeneration && pending.kind === kind
  }

  #advanceInitialHighlightConfigurationGeneration(): number {
    this.stoppedWarm = null
    this.#initialHighlightConfigurationGeneration += 1
    this.#pendingInitialHighlightThemeTerminal = null
    return this.#initialHighlightConfigurationGeneration
  }

  #emitInitialHighlightPaintIfReady(): void {
    if (!this.#initialTextPainted || this.#initialHighlightPaintEmitted) return
    if (this.#initialHighlightState === 'loading' || this.#initialHighlightState === 'idle') return
    if (this.#initialPaintDocumentVersion !== this.options.getDocumentVersion()) return

    this.#initialHighlightPaintEmitted = true
    this.options.onInitialPaint?.({
      ...this.#initialPaintEventBase(),
      phase: 'highlight-settled',
      status: this.#initialHighlightState,
    })
  }

  #initialPaintEventBase(): Omit<EditorInitialPaintEvent, 'phase' | 'status'> {
    return {
      documentId: this.options.getDocumentId(),
      documentGeneration: this.#initialPaintDocumentVersion,
      textVersion: this.options.getTextVersion(),
    }
  }

  #logSyntaxStatus(action: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    recordEditorPerformanceDiagnostic(action, () =>
      this.#debugContext(this.options.getDocumentVersion()),
    )
    this.options.log?.({
      action,
      level,
      syntax: this.#debugContext(this.options.getDocumentVersion()),
    })
  }
}

type EditorSyntaxDebugPayload = Record<string, unknown>

/**
 * Makes this controller what editors on the page run once they have a provider. Called by what
 * providers are built with, so the code travels with the providers rather than with every editor.
 */
export function installEditorSyntaxController(): void {
  installSyntaxRangeProjector(projectResultThroughSteps)
  const create: EditorSyntaxControllerFactory = (options) => new EditorSyntaxController(options)
  installEditorSyntaxRuntime(create)
}

const replacementPriority = (replacement: InitialHighlightReplacement): number => {
  if (replacement === 'all') return 2
  if (replacement === 'syntax') return 1
  return 0
}

const warnEditorSyntax = (message: string, payload: EditorSyntaxDebugPayload): void => {
  console.warn(`[editor-syntax] ${message}\n${JSON.stringify(payload, null, 2)}`)
}

const syntaxDebugError = (error: unknown): EditorSyntaxDebugPayload => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }

  return { value: String(error) }
}

const syntaxLogError = (
  error: unknown,
): { readonly message: string; readonly name?: string; readonly stack?: string } => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }

  return { message: String(error) }
}

const syntaxErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const nextUncachedSyntaxWarmRange = (
  documentLength: number,
  seedRange: EditorSyntaxRange,
  cachedRanges: readonly EditorSyntaxRange[],
): EditorSyntaxRange | null => {
  if (documentLength <= 0) return null

  const tileCount = Math.ceil(documentLength / BACKGROUND_SYNTAX_TILE_CHARS)
  const seedCenter = boundedIndex(
    Math.floor((seedRange.startIndex + seedRange.endIndex) / 2),
    documentLength,
  )
  const seedTile = Math.min(tileCount - 1, Math.floor(seedCenter / BACKGROUND_SYNTAX_TILE_CHARS))
  for (let distance = 0; distance < tileCount; distance += 1) {
    const forward = syntaxWarmTileRange(seedTile + distance, documentLength)
    if (isUncachedSyntaxWarmRange(forward, cachedRanges, seedRange)) return forward
    if (distance === 0) continue

    const backward = syntaxWarmTileRange(seedTile - distance, documentLength)
    if (isUncachedSyntaxWarmRange(backward, cachedRanges, seedRange)) return backward
  }

  return null
}

const syntaxWarmTileRange = (
  tileIndex: number,
  documentLength: number,
): EditorSyntaxRange | null => {
  if (tileIndex < 0) return null

  const startIndex = tileIndex * BACKGROUND_SYNTAX_TILE_CHARS
  if (startIndex >= documentLength) return null

  return {
    startIndex,
    endIndex: Math.min(documentLength, startIndex + BACKGROUND_SYNTAX_TILE_CHARS),
  }
}

const isUncachedSyntaxWarmRange = (
  range: EditorSyntaxRange | null,
  cachedRanges: readonly EditorSyntaxRange[],
  seedRange: EditorSyntaxRange,
): range is EditorSyntaxRange => {
  if (!range) return false
  if (syntaxRangesIntersect(range, seedRange)) return false
  return syntaxRangeCoverage(range, cachedRanges) !== 'full'
}

const boundedIndex = (index: number, documentLength: number): number =>
  Math.max(0, Math.min(index, Math.max(0, documentLength - 1)))

const projectRangesThroughEdits = (
  ranges: readonly EditorSyntaxRange[],
  edits: readonly TextEdit[],
  afterLength: number,
): readonly EditorSyntaxRange[] => {
  if (ranges.length === 0 || afterLength <= 0) return []
  let current = ranges
  if (edits.length > 0) {
    const ordered =
      edits.length === 1
        ? edits
        : edits.toSorted((left, right) => right.from - left.from || right.to - left.to)
    for (const edit of ordered) {
      const delta = edit.text.length - (edit.to - edit.from)
      const next: EditorSyntaxRange[] = []
      for (const range of current) {
        if (range.endIndex < edit.from) {
          next.push(range)
        } else if (range.startIndex > edit.to) {
          next.push({
            startIndex: range.startIndex + delta,
            endIndex: range.endIndex + delta,
          })
        } else {
          const startIndex = range.startIndex <= edit.from ? range.startIndex : edit.from
          const endIndex =
            range.endIndex >= edit.to ? range.endIndex + delta : edit.from + edit.text.length
          if (endIndex > startIndex) next.push({ startIndex, endIndex })
        }
      }
      current = next
      if (current.length === 0) return []
    }
  }
  const clamped: EditorSyntaxRange[] = []
  for (const range of current) {
    const startIndex = Math.max(0, Math.min(range.startIndex, afterLength))
    const endIndex = Math.max(startIndex, Math.min(range.endIndex, afterLength))
    if (endIndex > startIndex) clamped.push({ startIndex, endIndex })
  }
  return mergeSyntaxRanges(clamped)
}
