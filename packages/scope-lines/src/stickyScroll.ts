import type { TextReadSnapshot } from '@singapore-editor/core/document'
import type { EditorTheme, VirtualizedFoldMarker } from '@singapore-editor/core/rendering'
import type { EditorToken, EditorTokenStore } from '@singapore-editor/core/syntax'
import type {
  EditorContributionChange,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  EditorViewportSnapshot,
} from '@singapore-editor/core/extensions'
import {
  createEditorSecondaryTextView,
  type EditorSecondaryTextView,
} from '@singapore-editor/core/secondary-views'
import './style.css'

export type StickyScrollPluginOptions = {
  readonly enabled?: boolean
  /** Cap sticky rows, including the collapsed count row, below the default viewport limit. */
  readonly maxLineCount?: number
}

type ResolvedStickyScrollOptions = {
  readonly enabled: boolean
  readonly maxLineCount: number
}

type StickyScrollHeader = {
  readonly rows: readonly StickyScrollRow[]
  readonly key: string
  /** The headed scope in content coordinates: the top of its header row, and where it ends. */
  readonly top: number
  readonly bottom: number
  readonly stackHeight: number
}

type StickyScrollRow = number | { readonly collapsedScopeCount: number }

/**
 * Where rows sit, in content coordinates, for as far as the mounted band reaches. Rows past it are
 * extrapolated from the row height, which is wrong wherever something out there is collapsed or
 * taller than a row — but every row that decides the stack is within a stack's height of the
 * viewport top, and those are mounted.
 */
type StickyScrollRowGeometry = {
  readonly rowHeight: number
  readonly scrollTop: number
  readonly firstRow: number
  readonly firstTop: number
  readonly lastRow: number
  readonly lastBottom: number
  readonly tops: ReadonlyMap<number, number>
  readonly bottoms: ReadonlyMap<number, number>
}

type StickyScrollContent = {
  readonly text: string
  readonly tokens: readonly EditorToken[]
}

type StickyScrollRowRange = {
  readonly start: number
  readonly end: number
}

const EMPTY_HEADER: StickyScrollHeader = {
  rows: [],
  key: '',
  top: 0,
  bottom: 0,
  stackHeight: 0,
}

export function createStickyScrollPlugin(options: StickyScrollPluginOptions = {}): EditorPlugin {
  const resolved = resolveStickyScrollOptions(options)

  return {
    name: 'sticky-scroll',
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          createStickyScrollContribution(contributionContext, resolved),
      })
    },
  }
}

function createStickyScrollContribution(
  context: EditorViewContributionContext,
  options: ResolvedStickyScrollOptions,
): EditorViewContribution | null {
  if (!options.enabled) return null
  return new StickyScrollContribution(context, options)
}

class StickyScrollContribution implements EditorViewContribution {
  // Which scopes the viewport hides is the whole input; the caret changes none of it.
  readonly inputs = ['content', 'tokens', 'viewport', 'layout'] as const
  private readonly context: EditorViewContributionContext
  private readonly options: ResolvedStickyScrollOptions
  private readonly root: HTMLDivElement
  private lineView: EditorSecondaryTextView | null = null
  private appliedText = ''
  private appliedTokens: EditorTokenStore | null = null
  private appliedTheme: EditorTheme | null = null
  private appliedMetrics: EditorViewSnapshot['metrics'] | null = null
  private contentKey = ''
  private layoutKey = ''
  private header = EMPTY_HEADER

  public constructor(context: EditorViewContributionContext, options: ResolvedStickyScrollOptions) {
    this.context = context
    this.options = options
    this.root = createRoot(context)
    this.update(context.getSnapshot(), 'document')
  }

  public update(
    snapshot: EditorViewSnapshot,
    _kind: EditorViewContributionUpdateKind,
    _change?: EditorContributionChange | null,
  ): void {
    this.renderSnapshot(snapshot)
  }

  public dispose(): void {
    this.lineView?.dispose()
    this.lineView = null
    this.root.remove()
  }

  public updateViewport(viewport: EditorViewportSnapshot): void {
    if (this.lineView && this.header.rows.length)
      this.syncLayout(this.lineView, viewport, this.header)
  }

  private renderSnapshot(snapshot: EditorViewSnapshot): void {
    const header = stickyScrollHeader(snapshot, this.options)
    this.header = header
    if (header.rows.length === 0) {
      this.root.hidden = true
      this.layoutKey = ''
      return
    }

    const lineView = this.ensureLineView(snapshot)
    this.syncMetrics(lineView, snapshot)
    this.syncTheme(lineView, snapshot)
    this.syncContent(lineView, snapshot, header)
    this.syncLayout(lineView, snapshot.viewport, header)
  }

  private ensureLineView(snapshot: EditorViewSnapshot): EditorSecondaryTextView {
    const existing = this.lineView
    if (existing) return existing

    const created = createLineView(this.root, this.context, snapshot)
    this.lineView = created
    this.appliedMetrics = snapshot.metrics
    return created
  }

  // Character width too: a font change moves every column the mirrored rows draw at.
  private syncMetrics(lineView: EditorSecondaryTextView, snapshot: EditorViewSnapshot): void {
    const metrics = snapshot.metrics
    const applied = this.appliedMetrics
    if (
      applied?.rowHeight === metrics.rowHeight &&
      applied.characterWidth === metrics.characterWidth
    )
      return

    this.appliedMetrics = metrics
    lineView.setTextMetrics(metrics)
  }

  private syncTheme(lineView: EditorSecondaryTextView, snapshot: EditorViewSnapshot): void {
    const theme = snapshot.theme ?? null
    if (theme === this.appliedTheme) return

    this.appliedTheme = theme
    lineView.setTheme(theme)
  }

  private syncContent(
    lineView: EditorSecondaryTextView,
    snapshot: EditorViewSnapshot,
    header: StickyScrollHeader,
  ): void {
    // Keyed by document as well as by version, because opening another document starts its versions
    // over and the same rows there hold different text.
    const key = `${snapshot.documentId}:${header.key}:${snapshot.textVersion}`
    if (key === this.contentKey && snapshot.tokens === this.appliedTokens) return

    this.contentKey = key
    this.appliedTokens = snapshot.tokens
    const content = stickyScrollContent(snapshot, header.rows)
    if (content.text !== this.appliedText) {
      this.appliedText = content.text
      lineView.setText(content.text)
    }
    lineView.setTokens(content.tokens)
  }

  private syncLayout(
    lineView: EditorSecondaryTextView,
    viewport: EditorViewportSnapshot,
    header: StickyScrollHeader,
  ): void {
    const scrollTop = viewport.scrollTop
    const top = Math.max(
      header.top - scrollTop,
      Math.min(0, header.bottom - scrollTop - header.stackHeight),
    )
    const key = `${top}:${header.stackHeight}`
    this.root.hidden = false
    if (key === this.layoutKey) return

    this.layoutKey = key
    this.root.style.top = `${top}px`
    lineView.setHeight(header.stackHeight)
  }
}

function resolveStickyScrollOptions(
  options: StickyScrollPluginOptions,
): ResolvedStickyScrollOptions {
  return {
    enabled: options.enabled ?? true,
    maxLineCount: normalizeMaxLineCount(options.maxLineCount),
  }
}

function normalizeMaxLineCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(value))
}

function createRoot(context: EditorViewContributionContext): HTMLDivElement {
  const root = context.scrollElement.ownerDocument.createElement('div')
  root.className = 'editor-sticky-scroll'
  root.setAttribute('aria-hidden', 'true')
  root.hidden = true
  context.viewportOverlayElement.appendChild(root)
  return root
}

/**
 * The stack is a text view of its own rather than a second renderer, so its lines carry the tokens,
 * chunking and inline replacements of the rows they mirror instead of an approximation of them.
 */
function createLineView(
  root: HTMLDivElement,
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
): EditorSecondaryTextView {
  return createEditorSecondaryTextView(root, {
    className: 'editor-sticky-scroll-lines',
    scroll: false,
    overscan: 0,
    lineHeight: snapshot.metrics.rowHeight,
    tabSize: snapshot.tabSize,
    // Measuring the font again could land a fraction of a pixel away from the rows being mirrored.
    textMetrics: snapshot.metrics,
    selectionHighlightName: `${context.highlightPrefix}-sticky-scroll-selection`,
  })
}

function stickyScrollHeader(
  snapshot: EditorViewSnapshot,
  options: ResolvedStickyScrollOptions,
): StickyScrollHeader {
  const rowBudget = Math.min(
    options.maxLineCount,
    Math.floor(snapshot.viewport.clientHeight / (3 * snapshot.metrics.rowHeight)),
  )
  if (rowBudget <= 0) return EMPTY_HEADER

  const geometry = stickyScrollRowGeometry(snapshot)
  if (!geometry) return EMPTY_HEADER

  const scopeRows: number[] = []
  let top = 0
  let bottom = 0
  let innermostEndOffset = Number.POSITIVE_INFINITY
  for (const marker of stickyScrollCandidates(snapshot, geometry)) {
    // Sibling folds can share a display row. Once a scope takes a slot, later scopes must
    // start inside it until it scrolls out of that slot.
    if (marker.startOffset >= innermostEndOffset) break

    // Scopes that open on one row — an arrow function and the object it returns — head the same row,
    // so the first of them to be accepted has already said everything the stack can say about it.
    if (scopeRows.at(-1) === marker.startRow) continue

    const headerRowTop = contentRowTop(geometry, marker.startRow)
    const scopeBottom = contentRowBottom(geometry, marker.endRow)
    // Once the stack fills, another scope can only displace an existing row. Keep checking at the
    // last slot so deeper scopes enter only when their headers reach the actual stack.
    const slotTop = Math.min(scopeRows.length, rowBudget - 1) * geometry.rowHeight
    // A slot above the row it would stand in for is a slot for a row still on screen, which needs no
    // stand-in; a slot below the end of its scope belongs to a scope already behind us.
    if (slotTop <= headerRowTop - geometry.scrollTop) continue
    if (slotTop > scopeBottom - geometry.scrollTop) continue

    if (scopeRows.length === 0) top = headerRowTop
    innermostEndOffset = marker.endOffset
    bottom = scopeBottom
    scopeRows.push(marker.startRow)
  }

  if (scopeRows.length === 0) return EMPTY_HEADER

  const rows = selectStickyScrollRows(scopeRows, rowBudget)
  const key = rows.map((row) => (typeof row === 'number' ? row : `+${row.collapsedScopeCount}`))
  return { rows, key: key.join(','), top, bottom, stackHeight: rows.length * geometry.rowHeight }
}

function selectStickyScrollRows(
  scopeRows: readonly number[],
  rowBudget: number,
): readonly StickyScrollRow[] {
  if (scopeRows.length <= rowBudget) return scopeRows
  if (rowBudget <= 2) return scopeRows.slice(-rowBudget)

  const firstRows: StickyScrollRow[] = [
    scopeRows[0]!,
    { collapsedScopeCount: scopeRows.length - rowBudget + 1 },
  ]
  const innerCount = rowBudget - firstRows.length
  return firstRows.concat(scopeRows.slice(-innerCount))
}

/**
 * Scopes reaching into the viewport, outermost first, for the header to slot in that order.
 *
 * Fold ranges never cross, so the ones still open at a given range are exactly its ancestors. A
 * scope inside a collapsed one is dropped: the rows it heads are not on screen to be headed, even in
 * the window where the marker set and the hidden rows disagree.
 */
function stickyScrollCandidates(
  snapshot: EditorViewSnapshot,
  geometry: StickyScrollRowGeometry,
): readonly VirtualizedFoldMarker[] {
  const candidates: VirtualizedFoldMarker[] = []
  const open: VirtualizedFoldMarker[] = []

  for (const marker of visibleFoldMarkers(snapshot, geometry)) {
    while (open.length > 0 && open.at(-1)!.endOffset <= marker.startOffset) open.pop()

    const insideCollapsed = open.some((ancestor) => ancestor.collapsed)
    open.push(marker)
    if (marker.collapsed || insideCollapsed) continue

    candidates.push(marker)
  }

  return candidates
}

/**
 * Inclusive at both ends, unlike a scope guide's: a scope whose last row is the first mounted one is
 * exactly the scope whose header the stack is there to hold.
 */
function visibleFoldMarkers(
  snapshot: EditorViewSnapshot,
  geometry: StickyScrollRowGeometry,
): readonly VirtualizedFoldMarker[] {
  const markers: VirtualizedFoldMarker[] = []
  for (const marker of snapshot.foldMarkers) {
    if (marker.startRow > geometry.lastRow) continue
    if (marker.endRow < geometry.firstRow) continue

    markers.push(marker)
  }

  return markers.sort(compareMarkersByContainment)
}

/** Outermost first, which is the order a containment stack can be built in one pass. */
function compareMarkersByContainment(
  left: VirtualizedFoldMarker,
  right: VirtualizedFoldMarker,
): number {
  return left.startOffset - right.startOffset || right.endOffset - left.endOffset
}

function stickyScrollRowGeometry(snapshot: EditorViewSnapshot): StickyScrollRowGeometry | null {
  const tops = new Map<number, number>()
  const bottoms = new Map<number, number>()
  let firstRow = Number.POSITIVE_INFINITY
  let lastRow = Number.NEGATIVE_INFINITY

  // A buffer row can hold several display rows — wrapped, or with rows injected beneath it — so its
  // box is the union of them, which is what a scope starting or ending on it is measured against.
  for (const row of snapshot.visibleRows) {
    if (row.kind !== 'text') continue

    const top = tops.get(row.bufferRow)
    const bottom = bottoms.get(row.bufferRow)
    tops.set(row.bufferRow, top === undefined ? row.top : Math.min(top, row.top))
    bottoms.set(
      row.bufferRow,
      bottom === undefined ? row.top + row.height : Math.max(bottom, row.top + row.height),
    )
    firstRow = Math.min(firstRow, row.bufferRow)
    lastRow = Math.max(lastRow, row.bufferRow)
  }

  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow)) return null

  return {
    rowHeight: snapshot.metrics.rowHeight,
    scrollTop: snapshot.viewport.scrollTop,
    firstRow,
    firstTop: tops.get(firstRow)!,
    lastRow,
    lastBottom: bottoms.get(lastRow)!,
    tops,
    bottoms,
  }
}

function contentRowTop(geometry: StickyScrollRowGeometry, row: number): number {
  const top = geometry.tops.get(row)
  if (top !== undefined) return top
  if (row < geometry.firstRow) {
    return geometry.firstTop - (geometry.firstRow - row) * geometry.rowHeight
  }

  return geometry.lastBottom + (row - geometry.lastRow - 1) * geometry.rowHeight
}

function contentRowBottom(geometry: StickyScrollRowGeometry, row: number): number {
  const bottom = geometry.bottoms.get(row)
  if (bottom !== undefined) return bottom
  if (row > geometry.lastRow) {
    return geometry.lastBottom + (row - geometry.lastRow) * geometry.rowHeight
  }

  return geometry.firstTop - (geometry.firstRow - row - 1) * geometry.rowHeight
}

/**
 * The stack's own text, and the document's tokens rewritten into it. Both come out of one pass over
 * the same row ranges, because a token offset that disagrees with the text by even one character
 * paints the wrong word.
 */
function stickyScrollContent(
  snapshot: EditorViewSnapshot,
  rows: readonly StickyScrollRow[],
): StickyScrollContent {
  const textSnapshot = snapshot.textSnapshot
  const lines: string[] = []
  const tokens: EditorToken[] = []
  let base = 0

  for (const row of rows) {
    if (typeof row !== 'number') {
      const label = `⋯ ${row.collapsedScopeCount} scopes`
      lines.push(label)
      base += label.length + 1
      continue
    }

    const range = rowTextRange(snapshot, textSnapshot, row)
    lines.push(range ? textSnapshot.readRange(range.start, range.end) : '')
    if (range) appendRowTokens(tokens, snapshot.tokens, range, base)
    base += (range ? range.end - range.start : 0) + 1
  }

  return { text: lines.join('\n'), tokens }
}

function appendRowTokens(
  tokens: EditorToken[],
  documentTokens: EditorTokenStore,
  range: StickyScrollRowRange,
  base: number,
): void {
  const last = documentTokens.firstStartingAtOrAfter(range.end)
  const first = documentTokens.firstEndingAfter(range.start, last)
  documentTokens.forEachInRange(first, last, (start, end, styleId) => {
    tokens.push({
      start: base + Math.max(start, range.start) - range.start,
      end: base + Math.min(end, range.end) - range.start,
      style: documentTokens.styles[styleId]!,
    })
  })
}

function rowTextRange(
  snapshot: EditorViewSnapshot,
  textSnapshot: TextReadSnapshot,
  row: number,
): StickyScrollRowRange | null {
  const start = lineStartOffset(snapshot, row)
  if (start === undefined) return null

  const nextStart = lineStartOffset(snapshot, row + 1) ?? textSnapshot.length + 1
  return { start, end: Math.max(start, Math.min(textSnapshot.length, nextStart - 1)) }
}

function lineStartOffset(snapshot: EditorViewSnapshot, row: number): number | undefined {
  return snapshot.lineStartsView.at(row)
}
