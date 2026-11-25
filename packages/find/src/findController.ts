import {
  wordRangeAtOffset,
  type TextEdit,
  type TextReadSnapshot,
} from '@singapore-editor/core/document'
import type { EditorSetSelectionOptions } from '@singapore-editor/core/editor'
import type {
  EditorContributionChange,
  EditorDisposable,
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContributionUpdateKind,
} from '@singapore-editor/core/extensions'
import type { VirtualizedTextHighlightStyle } from '@singapore-editor/core/rendering'
import { EditorSecondaryViewScheduler } from '@singapore-editor/core/secondary-views'
import {
  createFindRangeScanner,
  escapeRegExpCharacters,
  FIND_CHUNK_MAX_WINDOWS_PER_SLICE,
  FIND_CHUNK_SLICE_BUDGET_MS,
  FIND_INITIAL_SLICE_BUDGET_MS,
  FIND_MATCHES_LIMIT,
  FIND_REPLACE_ALL_LIMIT,
  FIND_SELECT_ALL_LIMIT,
  FIND_SYNC_THRESHOLD,
  findLineRange,
  findMatchIndex,
  findMatches,
  findNextMatchFrom,
  findPreviousMatchFrom,
  findQueryPlan,
  findTextSourceFromSnapshot,
  partitionViewportRanges,
  searchedRangesLength,
  type FindMatch,
  type FindMatchFromOptions,
  type FindMatchFromSearcher,
  type FindQuery,
  type FindRange,
  type FindRangeScanner,
  type FindTextSource,
} from './search'
import { parseReplaceString, ReplacePattern } from './replacePattern'
import type { EditorFindOptions } from './types'

// These three overlap by construction — the current match is always also a
// match, and both sit inside the scope — so their stacking is declared rather
// than left to the order the groups happen to reach the highlight registry in.
//
// The numbers are exported because they are half of a cross-package agreement: the highlight
// priority space is one namespace that several subsystems write into, and priority is what settles
// a contest between two of them that declare the same property. A regression test elsewhere asserts
// the resulting order, and it can only do that by reading these rather than by restating them.
//
// They sit above the error diagnostic, which declares a background of its own at 2. `current` is the
// only find style that declares a `color`, so it is the only one contending on that axis — but all
// three declare a background, and so does the error, which is why none of them may share its number.
// A tie there would put the background contest back where the numbers exist to take it out of:
// registration order in the document's shared registry.
export const FIND_HIGHLIGHT_Z_INDEX = {
  scope: 4,
  match: 5,
  current: 6,
} as const

const FIND_MATCH_STYLE = {
  dimmable: false,
  backgroundColor: 'rgba(234, 179, 8, 0.34)',
  zIndex: FIND_HIGHLIGHT_Z_INDEX.match,
}
const FIND_CURRENT_STYLE = {
  dimmable: false,
  backgroundColor: 'rgba(245, 158, 11, 0.72)',
  color: '#111827',
  zIndex: FIND_HIGHLIGHT_Z_INDEX.current,
}
const FIND_SCOPE_STYLE = {
  dimmable: false,
  backgroundColor: 'rgba(59, 130, 246, 0.22)',
  zIndex: FIND_HIGHLIGHT_Z_INDEX.scope,
}

// A match on screen stays where the reader is looking at it; one that is not lands
// in the middle, with context on both sides rather than on the viewport's edge.
function findReveal(match: FindRange, committed = true): EditorSetSelectionOptions {
  return {
    ...(committed ? { jumpCause: 'find' as const } : {}),
    revealOffset: match.end,
    revealBlock: 'center-if-outside',
  }
}

// Seeding stops here rather than pushing a multi-megabyte selection through the
// find input and searching for it.
const SEARCH_STRING_MAX_LENGTH = 524_288

// A re-search reads the whole document, which is not a bill a keystroke can be
// handed. The ceiling is the load-bearing half: a sustained typing run never
// leaves the quiet gap, so waiting only for quiet would mean never re-searching
// at all for as long as the user keeps going.
const FIND_RESEARCH_KEY = 'find.research'
const FIND_SCAN_SLICE_KEY = 'find.scanSlice'
const FIND_RESEARCH_DELAY_MS = 100
const FIND_RESEARCH_MAX_DELAY_MS = 400

type EditorFindSelectionRange = EditorSelectionRange

export type EditorFindResolvedSelection = EditorResolvedSelection & {
  readonly collapsed: boolean
}

/**
 * Ranges the host follows through edits on find's behalf.
 *
 * A scope outlives the selection it was taken from: the first replace inside it moves the caret off
 * that selection, so a scope re-derived from what is selected now would be re-derived from
 * something else — or from nothing, and a scope of nothing is indistinguishable from no scope at
 * all. Handed over once, it answers from wherever its text went, however many edits later.
 */
export type FindTrackedRanges = {
  resolve(): readonly FindRange[]
}

export type EditorFindHost = {
  hasDocument(): boolean
  // Ranges rather than a string, so nothing find does can cost a copy of the
  // document — the reason there is no full-text accessor here to reach for.
  textSource(): FindTextSource
  hasTextSnapshot(snapshot: TextReadSnapshot): boolean
  // Followed wherever they end up, however far off screen: a scope decides where
  // Replace All rewrites, and one that stopped being followed would rewrite text
  // the user never marked.
  trackRanges(ranges: readonly FindRange[]): FindTrackedRanges
  // Followed only as far as the host paints them, the rest answered with the
  // offsets they were handed; see adoptMatches.
  trackPaintedRanges(ranges: readonly FindRange[]): FindTrackedRanges
  // The offset span of mounted viewport rows, when known. Large-file searches
  // scan this span synchronously first so on-screen matches paint immediately.
  visibleRange?(): FindRange | null
  getSelections(): readonly EditorFindResolvedSelection[]
  focusEditor(): void
  announce(message: string): void
  setSelection(
    anchor: number,
    head: number,
    timingName: string,
    options?: EditorSetSelectionOptions,
  ): void
  setSelections(
    selections: readonly EditorFindSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
  setRangeHighlight(
    name: string,
    ranges: readonly FindRange[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
  readonly workScheduler?: EditorSecondaryViewScheduler
}

export type EditorFindEditHost = {
  textSnapshot(): TextReadSnapshot | null
  getSelections(): readonly EditorFindResolvedSelection[]
  applyEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorFindSelectionRange,
  ): void
}

export type EditorFindStartOptions = {
  readonly replace: boolean
  readonly focus: 'find' | 'replace' | 'none'
}

export type EditorFindState = FindQuery & {
  readonly replaceString: string
  readonly preserveCase: boolean
  readonly revealed: boolean
  readonly replaceRevealed: boolean
  readonly inSelection: boolean
}

export type EditorFindWidgetState = EditorFindState & {
  // Counted up to FIND_MATCHES_LIMIT; when `highlightsTruncated` is true, more
  // matches exist beyond the cap (displayed as e.g. `19999+`).
  readonly matchesCount: number
  readonly matchesPosition: number
  // Counting and painting stopped at FIND_MATCHES_LIMIT; Find Next and Replace
  // All still cover the entire document.
  readonly highlightsTruncated: boolean
  // True while a large-file background scan is still scanning off-screen slices.
  readonly searching?: boolean
}

export type EditorFindUiEvent =
  | { readonly type: 'show'; readonly replaceVisible: boolean }
  | { readonly type: 'hide' }
  | { readonly type: 'focus'; readonly target: 'find' | 'replace' }
  | { readonly type: 'update'; readonly state: EditorFindWidgetState }

type ResolvedFindOptions = Required<EditorFindOptions>
type EditorFindUiListener = (event: EditorFindUiEvent) => void

// What every search resolves to before it runs: the text, and the ranges of it
// the query is allowed to answer from. Null scopes are the whole document; an
// empty scope refuses the search outright, so it is never one of these.
type FindSearchTarget = {
  readonly source: FindTextSource
  readonly scopes: readonly FindRange[] | null
}

type FindSelectionSnapshot = {
  readonly anchorOffset: number
  readonly headOffset: number
  readonly affinity: EditorFindResolvedSelection['affinity']
}

type ActiveFindScan = {
  readonly generation: number
  readonly snapshot: TextReadSnapshot | null
  readonly source: FindTextSource
  readonly scopes: readonly FindRange[] | null
  readonly query: FindQuery
  readonly viewportSpan: FindRange | null
  readonly viewportMatches: readonly FindMatch[]
  readonly prefixScanner: FindRangeScanner | null
  readonly suffixRanges: readonly FindRange[]
  suffixScanner: FindRangeScanner | null
  readonly prefixMatches: FindMatch[]
  readonly suffixMatches: FindMatch[]
  readonly remainingLimit: number
  prefixDone: boolean
  moveCursor: boolean
  readonly moveCursorSelection: FindSelectionSnapshot | null
  channel: MessageChannel | null
}

// Cooperative forward search used when cursorMoveOnType needs a match past a
// truncated prefix on a large file without blocking the input stack or
// rescanning from offset 0.
type ActiveCursorScan = {
  readonly generation: number
  readonly snapshot: TextReadSnapshot | null
  scanner: FindRangeScanner
  readonly fallbackMatch: FindMatch | null
  wrapTarget: {
    readonly source: FindTextSource
    readonly query: FindQuery
    readonly scopes: readonly FindRange[] | null
  } | null
  readonly expectedSelection: FindSelectionSnapshot | null
  channel: MessageChannel | null
}

let nextFindControllerId = 0

export class EditorFindController {
  private readonly options: ResolvedFindOptions
  private readonly listeners = new Set<EditorFindUiListener>()
  private host: EditorFindHost | null = null
  private editHost: EditorFindEditHost | null = null
  private matchHighlightName = ''
  private currentHighlightName = ''
  private scopeHighlightName = ''
  private state: EditorFindState = {
    searchString: '',
    replaceString: '',
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    preserveCase: false,
    revealed: false,
    replaceRevealed: false,
    inSelection: false,
  }
  private ownScheduler: EditorSecondaryViewScheduler | null = null
  private readonly researchKey: string
  private readonly scanSliceKey: string
  private matches: readonly FindMatch[] = []
  private highlightsTruncated = false
  // True while a chunked scan is running OR was cancelled by an edit before
  // completing, so followPendingMatches keeps the count provisional (`N+`)
  // until the replacement search lands.
  private matchesIncomplete = false
  // Number of leading entries in `matches` that form a gap-free prefix from
  // the start of the searched text. Positions beyond this prefix report `?`
  // rather than rescanning from offset 0.
  private exactPrefixMatchCount = 0
  private scope: FindTrackedRanges | null = null
  // What the host follows the painted matches by, so a deferred re-search cannot
  // leave a highlight standing on text that moved out from under it.
  private trackedMatches: FindTrackedRanges | null = null
  private currentMatch: FindMatch | null = null
  private replacing = false
  private pendingResearch = false
  private searchDirty = false
  private scanGeneration = 0
  private activeScan: ActiveFindScan | null = null
  private activeCursorScan: ActiveCursorScan | null = null

  public constructor(options: EditorFindOptions = {}) {
    this.options = resolveFindOptions(options)
    const id = ++nextFindControllerId
    this.researchKey = `${FIND_RESEARCH_KEY}:${id}`
    this.scanSliceKey = `${FIND_SCAN_SLICE_KEY}:${id}`
  }

  public attachHost(host: EditorFindHost, highlightPrefix: string): EditorDisposable {
    if (this.host && this.host !== host) {
      this.cancelActiveScan()
      this.activeScheduler()?.cancel(this.researchKey)
      this.clearHighlights()
    }

    this.host = host
    this.matchHighlightName = `${highlightPrefix}-find-match`
    this.currentHighlightName = `${highlightPrefix}-find-current`
    this.scopeHighlightName = `${highlightPrefix}-find-scope`
    return { dispose: () => this.detachHost(host) }
  }

  public attachEditHost(host: EditorFindEditHost): EditorDisposable {
    this.editHost = host
    return { dispose: () => this.detachEditHost(host) }
  }

  public subscribe(listener: EditorFindUiListener): EditorDisposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  public dispose(): void {
    this.pendingResearch = false
    this.searchDirty = false
    this.matchesIncomplete = false
    this.cancelActiveScan()
    this.activeScheduler()?.cancel(this.researchKey)
    this.ownScheduler?.dispose()
    this.ownScheduler = null
    this.clearHighlights()
    this.listeners.clear()
    this.host = null
    this.editHost = null
  }

  public isVisible(): boolean {
    return this.state.revealed
  }

  public openFind(): boolean {
    return this.open({ replace: false, focus: 'find' })
  }

  public toggleFind(): boolean {
    if (this.state.revealed) return this.close()
    return this.openFind()
  }

  public openFindReplace(): boolean {
    return this.open({ replace: true, focus: 'replace' })
  }

  public close(): boolean {
    const host = this.host
    if (!this.state.revealed || !host) return false

    this.pendingResearch = false
    this.searchDirty = false
    this.matchesIncomplete = false
    this.cancelActiveScan()
    this.state = { ...this.state, revealed: false, inSelection: false }
    this.scope = null
    this.trackedMatches = null
    this.currentMatch = null
    this.activeScheduler()?.cancel(this.researchKey)
    this.clearHighlights()
    this.emit({ type: 'hide' })
    host.focusEditor()
    return true
  }

  public findNext(): boolean {
    if (!this.ensureFindReady('none')) return false

    const startOffset = this.primarySelection()?.endOffset ?? 0
    const match = this.nextMatchAt(startOffset, true)
    // Landing behind where the search started is the search having run out and begun again. Nothing
    // on screen says so to a reader who cannot see the caret jump back up the file.
    if (match && match.start < startOffset) this.host?.announce('Wrapped to the first match')

    return this.selectMatch(match)
  }

  public findPrevious(): boolean {
    if (!this.ensureFindReady('none')) return false

    const startOffset = this.primarySelection()?.startOffset ?? 0
    const match = this.searchFrom(findPreviousMatchFrom, startOffset, {
      escapeEmptyMatchAtOffset: true,
    })
    if (match && match.start > startOffset) this.host?.announce('Wrapped to the last match')

    return this.selectMatch(match)
  }

  public replaceOne(): boolean {
    if (!this.ensureFindReady('replace')) return false
    const editHost = this.editHost
    if (!editHost) return false

    const selection = this.primarySelection()
    if (!selection) return false
    const search = this.commandSearchTarget()
    if (!search) return false

    // One scan, from the cursor, with the capture groups of the one match that
    // may be about to be rewritten: enumerating the document for them allocates
    // a capture array per match in it to use exactly one.
    const match = findNextMatchFrom(
      search.source,
      this.state,
      selection.startOffset,
      search.scopes,
      { captureMatches: true, loop: this.options.loop },
    )
    if (!match) return false
    // Not on it yet, so this press is the one that selects it and the next one
    // replaces it.
    if (match.start !== selection.startOffset || match.end !== selection.endOffset)
      return this.selectMatch(match)

    const replaceText = this.replacePattern().buildReplaceString(
      match.matches,
      this.state.preserveCase,
    )
    this.applyReplacement(
      [{ from: match.start, to: match.end, text: replaceText }],
      'input.findReplaceOne',
      { anchor: match.start + replaceText.length, head: match.start + replaceText.length },
    )
    this.selectNextReplacementMatch()
    this.research(false)
    return true
  }

  public replaceAll(): boolean {
    if (!this.ensureFindReady('replace')) return false
    const editHost = this.editHost
    if (!editHost) return false
    const search = this.commandSearchTarget()
    if (!search) return false

    const pattern = this.replacePattern()
    // Deliberately not FIND_MATCHES_LIMIT: that cap exists to bound painting,
    // and applying it here would rewrite the first 19,999 matches and leave the
    // rest, silently.
    const matches = findMatches(
      search.source,
      this.state,
      search.scopes,
      pattern.hasReplacementPatterns || this.state.preserveCase,
      FIND_REPLACE_ALL_LIMIT,
    )
    if (matches.length === 0) return false

    const edits = mergeAdjacentReplaceEdits(
      matches.map((match) => ({
        from: match.start,
        to: match.end,
        text: pattern.buildReplaceString(match.matches, this.state.preserveCase),
      })),
    )
    this.applyReplacement(edits, 'input.findReplaceAll')
    this.research(false)
    return true
  }

  public selectAllMatches(): boolean {
    const host = this.host
    if (!host) return false
    if (!this.ensureFindReady('none')) return false

    // Bounded at FIND_SELECT_ALL_LIMIT so dense matches on large files cannot
    // freeze the tab by creating hundreds of thousands of cursors in one frame.
    const search = this.commandSearchTarget()
    if (!search) return false
    const found = findMatches(
      search.source,
      this.state,
      search.scopes,
      false,
      FIND_SELECT_ALL_LIMIT + 1,
    )
    if (found.length === 0) return false

    const truncated = found.length > FIND_SELECT_ALL_LIMIT
    const matches = truncated ? found.slice(0, FIND_SELECT_ALL_LIMIT) : found
    this.cancelActiveCursorScan()
    if (this.activeScan) this.activeScan.moveCursor = false
    const selections = orderedMatchSelections(matches, this.primarySelection())
    host.setSelections(selections, 'input.findSelectAll', selections[0]?.head)
    if (this.canPaintCurrentDocument()) {
      this.currentMatch = matchAtSelection(matches, this.primarySelection())
      this.updateHighlights()
      this.updateWidget()
    }
    if (truncated) host.announce(`Selected the first ${FIND_SELECT_ALL_LIMIT} matches`)
    return true
  }

  public toggleMatchCase(): boolean {
    this.state = { ...this.state, matchCase: !this.state.matchCase }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public toggleWholeWord(): boolean {
    this.state = { ...this.state, wholeWord: !this.state.wholeWord }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public toggleRegex(): boolean {
    this.state = { ...this.state, isRegex: !this.state.isRegex }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public togglePreserveCase(): boolean {
    this.state = { ...this.state, preserveCase: !this.state.preserveCase }
    this.updateWidget()
    return true
  }

  public toggleReplace(): boolean {
    this.state = { ...this.state, replaceRevealed: !this.state.replaceRevealed }
    this.updateWidget()
    return true
  }

  public toggleFindInSelection(): boolean {
    if (this.state.inSelection) {
      this.state = { ...this.state, inSelection: false }
      this.scope = null
      this.research(this.options.cursorMoveOnType)
      return true
    }

    const host = this.host
    if (!host) return false

    const scopes = nonEmptySelectionRanges(this.commandSelections())
    if (scopes.length === 0) return false

    this.state = { ...this.state, inSelection: true }
    this.scope = host.trackRanges(scopes)
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public setSearchString(value: string): void {
    this.state = { ...this.state, searchString: value }
    if (this.options.findOnType) {
      this.research(this.options.cursorMoveOnType)
      return
    }
    const hadIncompleteScan = this.activeScan !== null || this.matchesIncomplete
    this.cancelActiveScan()
    this.matchesIncomplete = false
    this.searchDirty = true
    if (hadIncompleteScan) {
      this.highlightsTruncated = false
      this.exactPrefixMatchCount = 0
      this.adoptMatches([])
      this.currentMatch = null
      this.updateHighlights()
      this.updateWidget()
    }
  }

  public setReplaceString(value: string): void {
    this.state = { ...this.state, replaceString: value }
    this.updateWidget()
  }

  public handleViewUpdate(
    kind: EditorViewContributionUpdateKind,
    change: EditorContributionChange | null,
  ): void {
    if (!this.state.revealed) return
    if (!isFindDocumentUpdate(kind)) return
    if (change?.kind === 'selection' || change?.kind === 'none') return

    if (kind === 'clear') {
      this.close()
      return
    }

    // Find's own replace re-searches once the edit it is applying has landed,
    // rather than from inside it, so the matches it is about to discard are not
    // followed through the edit first.
    if (this.replacing) return
    // Nothing to follow across a document swap: the ranges being tracked belong
    // to the buffer that was just replaced. A scope among them is the one that
    // cannot simply be dropped on the floor — resolved against the new buffer it
    // answers with offsets of text the user never marked, and a search confined
    // to those is a Replace All rewriting inside a region nobody drew.
    if (kind === 'document') {
      this.pendingResearch = false
      this.scope = null
      this.state = { ...this.state, inSelection: false }
      this.research(false)
      return
    }

    if (this.pendingResearch) {
      this.research(false)
      return
    }
    if (this.activeScan) this.matchesIncomplete = true
    this.cancelActiveScan()
    this.scheduleResearch()
  }

  private detachHost(host: EditorFindHost): void {
    if (this.host !== host) return

    this.pendingResearch = false
    this.searchDirty = false
    this.matchesIncomplete = false
    this.cancelActiveScan()
    this.activeScheduler()?.cancel(this.researchKey)
    this.clearHighlights()
    this.host = null
    this.matchHighlightName = ''
    this.currentHighlightName = ''
    this.scopeHighlightName = ''
    this.state = { ...this.state, revealed: false, inSelection: false }
    this.matches = []
    this.highlightsTruncated = false
    this.exactPrefixMatchCount = 0
    this.scope = null
    this.trackedMatches = null
    this.currentMatch = null
  }

  private detachEditHost(host: EditorFindEditHost): void {
    if (this.editHost !== host) return

    this.pendingResearch = false
    this.editHost = null
  }

  private open(options: EditorFindStartOptions): boolean {
    const host = this.host
    if (!host || !host.hasDocument()) return false

    const searchString = this.seedSearchString()
    this.state = {
      ...this.state,
      searchString: searchString || this.state.searchString,
      revealed: true,
      replaceRevealed: options.replace || this.state.replaceRevealed,
    }
    this.applyAutoFindInSelection(host)
    this.emit({ type: 'show', replaceVisible: this.state.replaceRevealed })
    this.research(false)
    this.focusWidget(options.focus)
    return true
  }

  private ensureFindReady(focus: 'find' | 'replace' | 'none'): boolean {
    if (!this.state.revealed) return this.open({ replace: focus === 'replace', focus })
    if (this.searchDirty || (this.pendingResearch && !this.activeScan)) this.research(false)
    return this.state.searchString.length > 0
  }

  private research(moveCursor: boolean): void {
    if (!this.host) return
    if (!this.canPaintCurrentDocument()) {
      this.cancelActiveScan()
      this.pendingResearch = true
      if (moveCursor) this.selectFirstMatchFromSelection()
      return
    }
    this.pendingResearch = false
    this.searchDirty = false

    // Whatever a deferred run or background scan was going to answer, this run
    // supersedes it now.
    this.activeScheduler()?.cancel(this.researchKey)
    this.cancelActiveScan()

    const search = this.searchTarget()
    const plan = search ? findQueryPlan(this.state) : null
    if (!search || !plan) {
      this.highlightsTruncated = false
      this.matchesIncomplete = false
      this.exactPrefixMatchCount = 0
      this.adoptMatches([])
      this.currentMatch = null
      this.updateHighlights()
      this.updateWidget()
      return
    }

    const totalLength = searchedRangesLength(search.source, search.scopes)
    if (totalLength <= FIND_SYNC_THRESHOLD) {
      this.runSyncSearch(search, moveCursor)
      return
    }

    this.startChunkedSearch(search, plan.kind, moveCursor)
  }

  private runSyncSearch(search: FindSearchTarget, moveCursor: boolean): void {
    // One past the cap, so a document holding exactly FIND_MATCHES_LIMIT
    // matches is reported as a complete count rather than an overflow, without
    // ever rescanning from offset 0.
    const found = findMatches(
      search.source,
      this.state,
      search.scopes,
      false,
      FIND_MATCHES_LIMIT + 1,
    )
    this.highlightsTruncated = found.length > FIND_MATCHES_LIMIT
    this.matchesIncomplete = false
    const adopted = this.highlightsTruncated ? found.slice(0, FIND_MATCHES_LIMIT) : found
    this.exactPrefixMatchCount = adopted.length
    this.adoptMatches(adopted)
    const selection = this.primarySelection()
    this.currentMatch = matchAtSelection(this.matches, selection)
    this.updateHighlights()
    this.updateWidget()
    // Nothing listed is nothing to land on, and asking anyway is two more passes
    // over the document for every keystroke of a query that matches nothing.
    if (moveCursor && adopted.length > 0) {
      const offset = selection?.endOffset ?? 0
      const inList = firstMatchAtOrAfterInList(
        adopted,
        offset,
        !this.highlightsTruncated && this.options.loop,
      )
      if (inList) {
        this.selectMatch(inList, false)
        return
      }
      if (this.highlightsTruncated) {
        const ahead = this.searchFrom(findNextMatchFrom, offset, {
          escapeEmptyMatchAtOffset: false,
          loop: false,
        })
        this.selectMatch(ahead ?? (this.options.loop ? (adopted[0] ?? null) : null), false)
      }
    }
  }

  private startChunkedSearch(
    search: FindSearchTarget,
    planKind: 'lines' | 'anchored-lines' | 'literal-lines' | 'range',
    moveCursor: boolean,
  ): void {
    const host = this.host
    if (!host) return

    const query: FindQuery = {
      searchString: this.state.searchString,
      isRegex: this.state.isRegex,
      matchCase: this.state.matchCase,
      wholeWord: this.state.wholeWord,
    }
    const selection = this.primarySelection()
    const selectionSnapshot = snapshotSelection(selection)
    const anchorOffset = selection?.endOffset ?? 0
    const snapshot = this.editHost?.textSnapshot() ?? null

    if (planKind === 'lines' || planKind === 'anchored-lines') {
      const frame0Start = nowMs()
      const partition = partitionViewportRanges(
        search.source,
        search.scopes,
        host.visibleRange?.() ?? null,
        anchorOffset,
      )
      const vpFound =
        partition.viewportRanges.length > 0
          ? findMatches(
              search.source,
              query,
              partition.viewportRanges,
              false,
              FIND_MATCHES_LIMIT + 1,
            )
          : []
      const vpTruncated = vpFound.length > FIND_MATCHES_LIMIT
      const vpMatches = vpTruncated ? vpFound.slice(0, FIND_MATCHES_LIMIT) : vpFound
      const hasBackgroundWork =
        !vpTruncated && (partition.prefixRanges.length > 0 || partition.suffixRanges.length > 0)

      if (!hasBackgroundWork) {
        this.highlightsTruncated = vpTruncated
        this.matchesIncomplete = false
        this.exactPrefixMatchCount = partition.prefixRanges.length === 0 ? vpMatches.length : 0
        this.adoptMatches(vpMatches)
        this.currentMatch = matchAtSelection(this.matches, selection)
        this.updateHighlights()
        this.updateWidget()
        if (moveCursor && vpMatches.length > 0) {
          this.moveCursorForTruncatedLargeFile(
            search,
            query,
            snapshot,
            vpMatches,
            partition.viewportSpan,
            selectionSnapshot,
            anchorOffset,
          )
        }
        return
      }

      const remainingLimit = FIND_MATCHES_LIMIT - vpMatches.length
      const prefixScanner =
        partition.prefixRanges.length > 0
          ? createFindRangeScanner(search.source, query, partition.prefixRanges, remainingLimit)
          : null

      const scan: ActiveFindScan = {
        generation: ++this.scanGeneration,
        snapshot,
        source: search.source,
        scopes: search.scopes,
        query,
        viewportSpan: partition.viewportSpan,
        viewportMatches: vpMatches,
        prefixScanner,
        suffixRanges: partition.suffixRanges,
        suffixScanner: null,
        prefixMatches: [],
        suffixMatches: [],
        remainingLimit,
        prefixDone: prefixScanner === null,
        moveCursor,
        moveCursorSelection: selectionSnapshot,
        channel: null,
      }
      this.activeScan = scan

      // For literal queries with a bounded viewport, spend any remaining sub-4 ms
      // Frame-0 budget advancing off-screen windows so fast 1-2 MiB searches
      // finish in Frame 1. Regex queries and oversized single lines (where
      // viewportSpan is null) defer off-screen scanning to MessageChannel so a
      // single RegExp.exec call cannot stall the input handler.
      const remainingFrame0Ms = FIND_INITIAL_SLICE_BUDGET_MS - (nowMs() - frame0Start)
      if (!query.isRegex && partition.viewportSpan !== null && remainingFrame0Ms > 0) {
        const outcome = this.advanceScanSlice(scan, remainingFrame0Ms)
        if (outcome.finished) {
          this.finishActiveScan(scan, outcome.truncated, outcome.prefixComplete)
          return
        }
      }

      const immediateMatch = moveCursor
        ? firstMatchInViewport(
            vpMatches,
            partition.viewportSpan,
            partition.prefixRanges.length === 0,
            anchorOffset,
          )
        : null
      if (immediateMatch) scan.moveCursor = false

      this.highlightsTruncated = false
      this.matchesIncomplete = true
      this.exactPrefixMatchCount = partition.prefixRanges.length === 0 ? vpMatches.length : 0
      this.adoptMatches(vpMatches)
      this.currentMatch = immediateMatch ?? matchAtSelection(vpMatches, selection)

      if (immediateMatch) {
        host.setSelection(
          immediateMatch.start,
          immediateMatch.end,
          'input.findNavigate',
          findReveal(immediateMatch, false),
        )
      }
      // Re-check generation in case a selection listener edited the document
      // and cancelled this scan synchronously.
      if (this.activeScan !== scan) return

      this.updateHighlights()
      this.updateWidget()
      this.scheduleNextScanSlice(scan)
      return
    }

    // Line-crossing literals and multiline regexes need contiguous range scans
    // to preserve non-overlap phase and multi-line anchors. Yield across slices
    // without blocking the typing frame.
    const prefixScanner = createFindRangeScanner(
      search.source,
      query,
      search.scopes,
      FIND_MATCHES_LIMIT,
    )
    this.highlightsTruncated = false
    this.matchesIncomplete = true
    this.exactPrefixMatchCount = 0
    this.adoptMatches([])
    this.currentMatch = null

    const scan: ActiveFindScan = {
      generation: ++this.scanGeneration,
      snapshot,
      source: search.source,
      scopes: search.scopes,
      query,
      viewportSpan: null,
      viewportMatches: [],
      prefixScanner,
      suffixRanges: [],
      suffixScanner: null,
      prefixMatches: [],
      suffixMatches: [],
      remainingLimit: FIND_MATCHES_LIMIT,
      prefixDone: false,
      moveCursor,
      moveCursorSelection: selectionSnapshot,
      channel: null,
    }
    this.activeScan = scan
    this.updateHighlights()
    this.updateWidget()
    this.scheduleNextScanSlice(scan)
  }

  private scheduleNextScanSlice(scan: ActiveFindScan): void {
    if (typeof MessageChannel !== 'undefined') {
      if (!scan.channel) {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => this.runScanSlice(scan)
        scan.channel = channel
      }
      scan.channel.port2.postMessage(undefined)
      return
    }

    this.ensureScheduler().schedule({
      key: this.scanSliceKey,
      taskClass: 'background-derived',
      defer: true,
      run: () => this.runScanSlice(scan),
    })
  }

  private runScanSlice(scan: ActiveFindScan): void {
    if (this.activeScan !== scan || scan.generation !== this.scanGeneration) return
    if (!this.host || !this.state.revealed) {
      this.cancelActiveScan()
      return
    }
    if (scan.snapshot && !this.host.hasTextSnapshot(scan.snapshot)) {
      this.cancelActiveScan()
      return
    }

    const outcome = this.advanceScanSlice(scan, FIND_CHUNK_SLICE_BUDGET_MS)
    if (outcome.finished) {
      this.finishActiveScan(scan, outcome.truncated, outcome.prefixComplete)
      return
    }

    this.scheduleNextScanSlice(scan)
  }

  private advanceScanSlice(
    scan: ActiveFindScan,
    budgetMs: number,
  ):
    | { readonly finished: false }
    | { readonly finished: true; readonly truncated: boolean; readonly prefixComplete: boolean } {
    const sliceStart = nowMs()
    let remainingWindows = FIND_CHUNK_MAX_WINDOWS_PER_SLICE
    if (!scan.prefixDone) {
      if (scan.prefixScanner) {
        const step = scan.prefixScanner.step(budgetMs, remainingWindows)
        remainingWindows -= step.windowsScanned
        for (const match of step.matches) scan.prefixMatches.push(match)
        if (step.truncated) return { finished: true, truncated: true, prefixComplete: false }
        if (step.done) scan.prefixDone = true
      } else {
        scan.prefixDone = true
      }
    }

    if (scan.prefixDone) {
      if (scan.suffixRanges.length === 0) {
        return { finished: true, truncated: false, prefixComplete: true }
      }

      const remainingMs = budgetMs - (nowMs() - sliceStart)
      if ((remainingMs <= 0 || remainingWindows <= 0) && scan.prefixScanner !== null) {
        return { finished: false }
      }

      scan.suffixScanner ??= createFindRangeScanner(
        scan.source,
        scan.query,
        scan.suffixRanges,
        scan.remainingLimit - scan.prefixMatches.length,
      )
      const step = scan.suffixScanner.step(
        Math.max(0.5, remainingMs),
        Math.max(1, remainingWindows),
      )
      for (const match of step.matches) scan.suffixMatches.push(match)
      if (step.truncated) return { finished: true, truncated: true, prefixComplete: true }
      if (step.done) return { finished: true, truncated: false, prefixComplete: true }
    }

    return { finished: false }
  }

  private finishActiveScan(
    scan: ActiveFindScan,
    truncated: boolean,
    prefixComplete: boolean,
  ): void {
    if (this.activeScan !== scan || scan.generation !== this.scanGeneration) return

    this.closeScanChannel(scan)
    this.activeScheduler()?.cancel(this.scanSliceKey)
    this.activeScan = null

    const finalMatches = scan.prefixMatches.concat(scan.viewportMatches, scan.suffixMatches)
    this.highlightsTruncated = truncated
    this.matchesIncomplete = false
    this.exactPrefixMatchCount = prefixComplete ? finalMatches.length : scan.prefixMatches.length
    this.adoptMatches(finalMatches)

    const selection = this.primarySelection()
    const preservedCurrent =
      this.currentMatch &&
      selection &&
      this.currentMatch.start === selection.startOffset &&
      this.currentMatch.end === selection.endOffset
        ? this.currentMatch
        : null
    this.currentMatch = matchAtSelection(finalMatches, selection) ?? preservedCurrent

    this.updateHighlights()
    this.updateWidget()

    if (
      scan.moveCursor &&
      finalMatches.length > 0 &&
      sameSelectionSnapshot(selection, scan.moveCursorSelection)
    ) {
      const offset = selection?.endOffset ?? 0
      if (!truncated) {
        const target = firstMatchAtOrAfterInList(finalMatches, offset, this.options.loop)
        this.selectMatch(target, false)
      } else {
        this.moveCursorForTruncatedLargeFile(
          { source: scan.source, scopes: scan.scopes },
          scan.query,
          scan.snapshot,
          finalMatches,
          scan.viewportSpan,
          scan.moveCursorSelection,
          offset,
        )
      }
    }
  }

  private moveCursorForTruncatedLargeFile(
    search: FindSearchTarget,
    query: FindQuery,
    snapshot: TextReadSnapshot | null,
    listedMatches: readonly FindMatch[],
    viewportSpan: FindRange | null,
    expectedSelection: FindSelectionSnapshot | null,
    offset: number,
  ): void {
    const exactPrefixMatches = listedMatches.slice(0, this.exactPrefixMatchCount)
    const inExactPrefix = firstMatchAtOrAfterInList(exactPrefixMatches, offset, false)
    if (inExactPrefix) {
      this.selectMatch(inExactPrefix, false)
      return
    }
    const inViewport = firstMatchInViewport(listedMatches, viewportSpan, false, offset)
    if (inViewport) {
      this.selectMatch(inViewport, false)
      return
    }

    // Search forward from the caret's line cooperatively so a multi-megabyte
    // empty tail never blocks the input stack and wrapping reuses `matches[0]`
    // instead of rescanning from offset 0.
    const plan = findQueryPlan(query)
    const isLineLocal = plan?.kind === 'lines' || plan?.kind === 'anchored-lines'
    const tailRanges = isLineLocal
      ? tailRangesFromOffset(search.source, search.scopes, offset)
      : search.scopes
    const fallbackMatch =
      this.options.loop && this.exactPrefixMatchCount > 0 ? (listedMatches[0] ?? null) : null
    const wrapTarget =
      this.options.loop && fallbackMatch === null
        ? { source: search.source, query, scopes: search.scopes }
        : null
    if (tailRanges !== null && tailRanges.length === 0) {
      if (fallbackMatch) {
        this.selectMatch(fallbackMatch, false)
        return
      }
      if (!wrapTarget) return
      const wrapScan: ActiveCursorScan = {
        generation: ++this.scanGeneration,
        snapshot,
        scanner: createFindRangeScanner(
          wrapTarget.source,
          wrapTarget.query,
          wrapTarget.scopes,
          1,
          0,
        ),
        fallbackMatch: null,
        wrapTarget: null,
        expectedSelection,
        channel: null,
      }
      this.activeCursorScan = wrapScan
      this.scheduleNextCursorScanSlice(wrapScan)
      return
    }

    const cursorScan: ActiveCursorScan = {
      generation: ++this.scanGeneration,
      snapshot,
      scanner: createFindRangeScanner(search.source, query, tailRanges, 1, offset),
      fallbackMatch,
      wrapTarget,
      expectedSelection,
      channel: null,
    }
    this.activeCursorScan = cursorScan
    this.scheduleNextCursorScanSlice(cursorScan)
  }

  private scheduleNextCursorScanSlice(cursorScan: ActiveCursorScan): void {
    if (typeof MessageChannel !== 'undefined') {
      if (!cursorScan.channel) {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => this.runCursorScanSlice(cursorScan)
        cursorScan.channel = channel
      }
      cursorScan.channel.port2.postMessage(undefined)
      return
    }

    this.ensureScheduler().schedule({
      key: this.scanSliceKey,
      taskClass: 'background-derived',
      defer: true,
      run: () => this.runCursorScanSlice(cursorScan),
    })
  }

  private runCursorScanSlice(cursorScan: ActiveCursorScan): void {
    if (this.activeCursorScan !== cursorScan || cursorScan.generation !== this.scanGeneration)
      return
    if (!this.host || !this.state.revealed) {
      this.cancelActiveCursorScan()
      return
    }
    if (cursorScan.snapshot && !this.host.hasTextSnapshot(cursorScan.snapshot)) {
      this.cancelActiveCursorScan()
      return
    }
    if (!sameSelectionSnapshot(this.primarySelection(), cursorScan.expectedSelection)) {
      this.cancelActiveCursorScan()
      return
    }

    const step = cursorScan.scanner.step(FIND_CHUNK_SLICE_BUDGET_MS)
    const found = step.matches[0] ?? null
    if (found) {
      this.cancelActiveCursorScan()
      this.selectMatch(found, false)
      return
    }
    if (step.done) {
      if (cursorScan.fallbackMatch) {
        this.cancelActiveCursorScan()
        this.selectMatch(cursorScan.fallbackMatch, false)
        return
      }
      if (cursorScan.wrapTarget) {
        const wrap = cursorScan.wrapTarget
        cursorScan.wrapTarget = null
        cursorScan.scanner = createFindRangeScanner(wrap.source, wrap.query, wrap.scopes, 1, 0)
        this.scheduleNextCursorScanSlice(cursorScan)
        return
      }
      this.cancelActiveCursorScan()
      return
    }

    this.scheduleNextCursorScanSlice(cursorScan)
  }

  private cancelActiveScan(): void {
    const scan = this.activeScan
    const cursorScan = this.activeCursorScan
    this.scanGeneration += 1
    this.activeScheduler()?.cancel(this.scanSliceKey)
    if (scan) {
      this.activeScan = null
      this.closeScanChannel(scan)
    }
    if (cursorScan) {
      this.activeCursorScan = null
      this.closeScanChannel(cursorScan)
    }
  }

  private cancelActiveCursorScan(): void {
    const cursorScan = this.activeCursorScan
    if (!cursorScan) return

    this.activeCursorScan = null
    this.closeScanChannel(cursorScan)
    if (!this.activeScan) this.activeScheduler()?.cancel(this.scanSliceKey)
  }

  private closeScanChannel(scan: { channel: MessageChannel | null }): void {
    const channel = scan.channel
    if (!channel) return

    scan.channel = null
    channel.port1.onmessage = null
    channel.port1.close()
    channel.port2.close()
  }

  private scheduleResearch(): void {
    this.followPendingMatches()
    this.ensureScheduler().schedule({
      key: this.researchKey,
      taskClass: 'background-derived',
      delayMs: FIND_RESEARCH_DELAY_MS,
      maxDelayMs: FIND_RESEARCH_MAX_DELAY_MS,
      run: () => this.research(false),
    })
  }

  private activeScheduler(): EditorSecondaryViewScheduler | null {
    return this.host?.workScheduler ?? this.ownScheduler
  }

  private ensureScheduler(): EditorSecondaryViewScheduler {
    return this.host?.workScheduler ?? (this.ownScheduler ??= new EditorSecondaryViewScheduler())
  }

  /**
   * Adopts a match set and hands it to the host to follow as far as it is painted.
   *
   * Handed over now rather than when an edit arrives: find is told about an edit
   * once the text has already moved, and a range recorded against the document
   * as it is by then is a range that will never shift.
   *
   * What the reader can see is the bound. A set stopping at the paint cap holds
   * twenty thousand matches, and asking the host to carry all of them costs more
   * per keystroke than the search this deferral exists to keep off it.
   */
  private adoptMatches(matches: readonly FindMatch[]): void {
    this.matches = matches
    this.trackedMatches = this.host?.trackPaintedRanges(matches) ?? null
  }

  /**
   * Carries the painted matches through the edit that deferred their re-search.
   *
   * Until it lands they are what the reader sees, and the offsets they were found
   * at address text that has since moved — so they are read back from where that
   * text went. A match whose text is gone resolves to nothing and stops being
   * painted.
   */
  /** Takes the offsets again from what the host is following, after the line it follows to moved. */
  public refreshTrackedMatches(): void {
    this.followPendingMatches()
  }

  private followPendingMatches(): void {
    if (!this.canPaintCurrentDocument()) return
    const tracked = this.trackedMatches
    if (!tracked || this.matches.length === 0) return

    // The capture groups belonged to the text that was there; only the ranges
    // survive the edit, and the re-search is what recovers the rest.
    const previousLength = this.matches.length
    this.matches = tracked.resolve().map((range) => ({ ...range, matches: null }))
    this.exactPrefixMatchCount =
      this.exactPrefixMatchCount === previousLength ? this.matches.length : 0
    this.currentMatch = matchAtSelection(this.matches, this.primarySelection())
    this.updateHighlights()
    this.updateWidget()
  }

  private applyReplacement(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorFindSelectionRange,
  ): void {
    const editHost = this.editHost
    if (!editHost) return

    this.cancelActiveScan()
    this.replacing = true
    try {
      editHost.applyEdits(edits, timingName, selection)
    } finally {
      this.replacing = false
    }
  }

  private selectNextReplacementMatch(): void {
    const offset = this.primarySelection()?.endOffset ?? 0
    const match = this.searchFrom(findNextMatchFrom, offset, {})
    if (!match) return
    this.host?.setSelection(match.start, match.end, 'input.findNavigate', findReveal(match))
  }

  private canPaintCurrentDocument(): boolean {
    if (!this.editHost) return true
    const snapshot = this.editHost.textSnapshot()
    return snapshot !== null && this.host?.hasTextSnapshot(snapshot) === true
  }

  private commandTextSource(): FindTextSource | undefined {
    if (!this.editHost) return this.host?.textSource()
    const snapshot = this.editHost.textSnapshot()
    return snapshot ? findTextSourceFromSnapshot(snapshot) : undefined
  }

  private commandSelections(): readonly EditorFindResolvedSelection[] {
    return this.editHost?.getSelections() ?? this.host?.getSelections() ?? []
  }

  private commandSearchTarget(): FindSearchTarget | null {
    const source = this.commandTextSource()
    return source ? this.searchTarget(source) : null
  }

  private searchFrom(
    find: FindMatchFromSearcher,
    offset: number,
    options: FindMatchFromOptions,
  ): FindMatch | null {
    const search = this.commandSearchTarget()
    if (!search) return null

    return find(search.source, this.state, offset, search.scopes, {
      loop: this.options.loop,
      ...options,
    })
  }

  private searchTarget(source = this.host?.textSource()): FindSearchTarget | null {
    if (!source) return null

    const scopes = this.scopeRanges()
    // A scope that has run out of ranges is not the absence of a scope: every
    // range the user marked was edited away, and widening the search to the
    // document would let the next Replace All rewrite text they never marked.
    if (scopes && scopes.length === 0) return null

    return { source, scopes }
  }

  private scopeRanges(): readonly FindRange[] | null {
    return this.scope?.resolve() ?? null
  }

  private selectFirstMatchFromSelection(): void {
    const offset = this.primarySelection()?.endOffset ?? 0
    // Deliberately not escaping an empty match here: re-searching should land
    // on the match at the cursor, empty or not. Only an explicit Find
    // Next/Previous is asking to move off it.
    this.selectMatch(this.nextMatchAt(offset, false), false)
  }

  private nextMatchAt(offset: number, escapeEmptyMatchAtOffset: boolean): FindMatch | null {
    return this.searchFrom(findNextMatchFrom, offset, { escapeEmptyMatchAtOffset })
  }

  private selectMatch(match: FindMatch | null, committed = true): boolean {
    const host = this.host
    if (!match || !host) return false

    if (committed) {
      this.cancelActiveCursorScan()
      if (this.activeScan) this.activeScan.moveCursor = false
    }
    if (this.canPaintCurrentDocument()) this.currentMatch = match
    host.setSelection(match.start, match.end, 'input.findNavigate', findReveal(match, committed))
    if (!this.canPaintCurrentDocument()) return true
    this.updateHighlights()
    this.updateWidget()
    return true
  }

  private updateHighlights(): void {
    if (!this.canPaintCurrentDocument()) return
    const host = this.host
    if (!host) return

    host.setRangeHighlight(this.matchHighlightName, this.matches, FIND_MATCH_STYLE)
    host.setRangeHighlight(this.currentHighlightName, this.currentMatchRanges(), FIND_CURRENT_STYLE)
    const scopes = this.scopeRanges()
    if (scopes) {
      host.setRangeHighlight(this.scopeHighlightName, scopes, FIND_SCOPE_STYLE)
      return
    }

    host.clearRangeHighlight(this.scopeHighlightName)
  }

  private currentMatchRanges(): readonly FindRange[] {
    return this.currentMatch ? [this.currentMatch] : []
  }

  private clearHighlights(): void {
    const host = this.host
    if (!host || !this.matchHighlightName) return

    host.clearRangeHighlight(this.matchHighlightName)
    host.clearRangeHighlight(this.currentHighlightName)
    host.clearRangeHighlight(this.scopeHighlightName)
  }

  private updateWidget(): void {
    this.emit({ type: 'update', state: this.widgetState() })
  }

  private widgetState(): EditorFindWidgetState {
    return {
      ...this.state,
      matchesCount: this.matches.length,
      matchesPosition: this.currentMatchPosition(),
      highlightsTruncated: this.highlightsTruncated,
      searching: this.activeScan !== null || this.matchesIncomplete,
    }
  }

  // Only report an exact 1-based position when the match lies inside the
  // contiguous prefix scanned from offset 0; matches past the cap or past an
  // unscanned gap report `?` without rescanning from offset 0.
  private currentMatchPosition(): number {
    if (!this.currentMatch) return 0

    const painted = findMatchIndex(this.matches, this.currentMatch)
    if (painted < 0 || painted >= this.exactPrefixMatchCount) return 0
    return painted + 1
  }

  private focusWidget(focus: 'find' | 'replace' | 'none'): void {
    if (focus === 'find') this.emit({ type: 'focus', target: 'find' })
    if (focus === 'replace') this.emit({ type: 'focus', target: 'replace' })
  }

  private seedSearchString(): string {
    if (this.options.seedSearchStringFromSelection === 'never') return ''

    const selection = this.primarySelection()
    if (!selection) return ''

    const source = this.commandTextSource()
    if (!source) return ''
    if (!selection.collapsed)
      return this.seedFromLiteralText(selectedSingleLineText(source, selection))
    if (this.options.seedSearchStringFromSelection === 'selection') return ''

    return this.seedFromLiteralText(wordTextAtOffset(source, selection.headOffset))
  }

  // The seed is document text, never a pattern: unescaped, `foo(bar)` seeded
  // into a regex search becomes a capture group and finds nothing, with no hint
  // to the user why.
  private seedFromLiteralText(value: string): string {
    return this.state.isRegex ? escapeRegExpCharacters(value) : value
  }

  private applyAutoFindInSelection(host: EditorFindHost): void {
    const scopes = nonEmptySelectionRanges(this.commandSelections())
    if (scopes.length === 0) return
    if (this.options.autoFindInSelection === 'never') return
    if (this.options.autoFindInSelection === 'always') {
      this.state = { ...this.state, inSelection: true }
      this.scope = host.trackRanges(scopes)
      return
    }

    const source = this.commandTextSource()
    if (!source || !hasMultilineScope(source, scopes)) return

    this.state = { ...this.state, inSelection: true }
    this.scope = host.trackRanges(scopes)
  }

  private replacePattern(): ReplacePattern {
    if (this.state.isRegex) return parseReplaceString(this.state.replaceString)
    return ReplacePattern.fromStaticValue(this.state.replaceString)
  }

  private primarySelection(): EditorFindResolvedSelection | null {
    return this.commandSelections()[0] ?? null
  }

  private emit(event: EditorFindUiEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function resolveFindOptions(options: EditorFindOptions): ResolvedFindOptions {
  return {
    loop: options.loop ?? true,
    seedSearchStringFromSelection: options.seedSearchStringFromSelection ?? 'always',
    findOnType: options.findOnType ?? true,
    cursorMoveOnType: options.cursorMoveOnType ?? true,
    autoFindInSelection: options.autoFindInSelection ?? 'never',
  }
}

function isFindDocumentUpdate(kind: EditorViewContributionUpdateKind): boolean {
  return kind === 'document' || kind === 'content' || kind === 'clear'
}

function selectedSingleLineText(
  source: FindTextSource,
  selection: EditorFindResolvedSelection,
): string {
  // Both bounds are checked before the read, so an oversized or multi-line
  // selection is never copied at all.
  if (selection.endOffset - selection.startOffset >= SEARCH_STRING_MAX_LENGTH) return ''
  if (spansLines(source, selection.startOffset, selection.endOffset)) return ''

  return source.readRange(selection.startOffset, selection.endOffset)
}

// A word ends at a line break, so the line holding the caret is the whole
// haystack the scan can need.
function wordTextAtOffset(source: FindTextSource, offset: number): string {
  const line = findLineRange(source, offset)
  const text = source.readRange(line.start, line.end)
  const word = wordRangeAtOffset(text, offset - line.start)
  return text.slice(word.start, word.end)
}

function nonEmptySelectionRanges(
  selections: readonly EditorFindResolvedSelection[],
): readonly FindRange[] {
  return selections
    .filter((selection) => !selection.collapsed)
    .map((selection) => ({ start: selection.startOffset, end: selection.endOffset }))
}

function hasMultilineScope(source: FindTextSource, scopes: readonly FindRange[]): boolean {
  return scopes.some((scope) => spansLines(source, scope.start, scope.end))
}

// Asked of the line index instead of the text: whether two offsets sit on one
// line is already known there, and reading the span out to look for a break
// would copy a selection that can be the whole document.
function spansLines(source: FindTextSource, start: number, end: number): boolean {
  const lineStartsView = source.lineStartsView
  return lineStartsView.indexForOffset(start) !== lineStartsView.indexForOffset(end)
}

function matchAtSelection(
  matches: readonly FindMatch[],
  selection: EditorFindResolvedSelection | null,
): FindMatch | null {
  if (!selection) return null
  return (
    matches.find(
      (match) => match.start === selection.startOffset && match.end === selection.endOffset,
    ) ?? null
  )
}

function orderedMatchSelections(
  matches: readonly FindMatch[],
  currentSelection: EditorFindResolvedSelection | null,
): readonly EditorFindSelectionRange[] {
  const selections = matches.map(selectionForMatch)
  const currentMatch = matchAtSelection(matches, currentSelection)
  const currentIndex = currentMatch ? findMatchIndex(matches, currentMatch) : -1
  if (!currentSelection || currentIndex < 0) return selections

  const current: EditorFindSelectionRange = {
    anchor: currentSelection.anchorOffset,
    head: currentSelection.headOffset,
    affinity: currentSelection.affinity,
  }
  if (currentIndex === 0) return [current].concat(selections.slice(1))
  return [current].concat(selections.slice(0, currentIndex), selections.slice(currentIndex + 1))
}

function selectionForMatch(match: FindMatch): EditorFindSelectionRange {
  return { anchor: match.start, head: match.end, affinity: 'after' }
}

function mergeAdjacentReplaceEdits(edits: TextEdit[]): readonly TextEdit[] {
  const sorted = edits.sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: TextEdit[] = []
  for (const edit of sorted) mergeReplaceEdit(merged, edit)
  return merged
}

function mergeReplaceEdit(merged: TextEdit[], edit: TextEdit): void {
  const previous = merged.at(-1)
  if (!previous || previous.to !== edit.from) {
    merged.push({ ...edit })
    return
  }

  merged[merged.length - 1] = {
    from: previous.from,
    to: edit.to,
    text: previous.text + edit.text,
  }
}

function firstMatchInViewport(
  viewportMatches: readonly FindMatch[],
  viewportSpan: FindRange | null,
  noPrefixBeforeViewport: boolean,
  offset: number,
): FindMatch | null {
  if (!viewportSpan || viewportMatches.length === 0) return null
  const offsetCovered =
    (offset >= viewportSpan.start && offset <= viewportSpan.end) ||
    (noPrefixBeforeViewport && offset <= viewportSpan.end)
  if (!offsetCovered) return null

  return viewportMatches.find((match) => match.start >= offset) ?? null
}

function firstMatchAtOrAfterInList(
  matches: readonly FindMatch[],
  offset: number,
  loop: boolean,
): FindMatch | null {
  const ahead = matches.find((match) => match.start >= offset)
  if (ahead) return ahead
  return loop ? (matches[0] ?? null) : null
}

function snapshotSelection(
  selection: EditorFindResolvedSelection | null,
): FindSelectionSnapshot | null {
  if (!selection) return null
  return {
    anchorOffset: selection.anchorOffset,
    headOffset: selection.headOffset,
    affinity: selection.affinity,
  }
}

function sameSelectionSnapshot(
  current: EditorFindResolvedSelection | null,
  expected: FindSelectionSnapshot | null,
): boolean {
  if (!current || !expected) return current === expected
  return (
    current.anchorOffset === expected.anchorOffset &&
    current.headOffset === expected.headOffset &&
    current.affinity === expected.affinity
  )
}

function tailRangesFromOffset(
  source: FindTextSource,
  scopes: readonly FindRange[] | null,
  offset: number,
): readonly FindRange[] {
  const clamped = Math.min(Math.max(0, offset), source.length)
  const line = source.lineStartsView.indexForOffset(clamped)
  const lineStart = source.lineStartsView.at(line) ?? 0
  if (!scopes) return [{ start: lineStart, end: source.length }]

  const tail: FindRange[] = []
  for (const scope of scopes) {
    if (scope.end < clamped) continue
    tail.push({ start: Math.max(scope.start, lineStart), end: scope.end })
  }
  return tail
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}
