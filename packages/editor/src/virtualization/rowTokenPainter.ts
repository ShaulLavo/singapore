import type { EditorTokenStyle } from '../tokens'
import { SharedStyleRules } from '../style-utils'
import { segmentGraphemes } from '../graphemes'
import { isSimpleRowText } from '../textCharacters'
import { scheduleHighlightRepaintNudge } from './geckoHighlightRepaint'
import { getSharedTokenHighlights } from './sharedTokenHighlights'
import {
  addTokenRangeToChunk,
  appendTokenRange,
  updateMutableRowChunks,
} from './virtualizedTextViewHelpers'
import { clearRowGeometryCache, releaseNativeRowGeometry } from './virtualizedTextViewGeometry'
import { rowLocalIndexForOffset } from './virtualizedTextViewInlineMapping'
import { memoizedContainsRTL } from './virtualizedTextViewBidi'
import type {
  EditorTokenPainting,
  HighlightRegistry,
  MountedVirtualizedTextRow,
  RowTokenPainterKind,
  TokenGroup,
  TokenRowSegment,
  VirtualizedTextChunk,
  VirtualizedTextChunkPart,
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'

export type RowTokenPaintResult = {
  readonly addedRangeCount: number
  readonly deletedRangeCount: number
  readonly liveRangeCount: number
  readonly staticRangeCount: number
  readonly styleRulesDirty: boolean
  readonly domMutated: boolean
}

export interface RowTokenPainter {
  readonly kind: RowTokenPainterKind
  /** True when this painter renders overlay-base styling for untokenized text directly. */
  readonly paintsOverlayBase: boolean
  readonly tokenGroups?: ReadonlyMap<string, TokenGroup>
  readonly rowTokenRanges?: ReadonlyMap<number, ReadonlyMap<string, readonly AbstractRange[]>>
  hasPaintedState(): boolean
  syncPalette(
    styles: ReadonlyMap<string, EditorTokenStyle>,
    onStyleRemoved: (rowSlotId: number) => void,
  ): boolean
  paintRow(
    row: MountedVirtualizedTextRow,
    segments: readonly TokenRowSegment[],
  ): RowTokenPaintResult
  clearRow(rowSlotId: number, row?: MountedVirtualizedTextRow): number
  clearRows(rows?: Iterable<MountedVirtualizedTextRow>): void
  clearAll(rows?: Iterable<MountedVirtualizedTextRow>): void
  flushStyles(): void
  restore(reason: 'presentation' | 'resume'): boolean
}

const AUTO_SPAN_ENTER_ROWS = 200
const AUTO_SPAN_EXIT_ROWS = 140
const AUTO_SPAN_ENTER_SEGMENTS = 2_000
const AUTO_SPAN_EXIT_SEGMENTS = 1_400
const MAX_SPLIT_TEXT_NODE_LENGTH = 50
const TOKEN_SPAN_BASE_CLASS = 'editor-token'
const TOKEN_SPAN_CLASS_PREFIX = 'editor-token-'

const NO_PAINT_RESULT: RowTokenPaintResult = {
  addedRangeCount: 0,
  deletedRangeCount: 0,
  liveRangeCount: 0,
  staticRangeCount: 0,
  styleRulesDirty: false,
  domMutated: false,
}

export function normalizeTokenPainting(mode: EditorTokenPainting | undefined): EditorTokenPainting {
  if (mode === 'css-highlight' || mode === 'spans') return mode
  return 'auto'
}

export function supportsCssHighlights(registry: HighlightRegistry | null): boolean {
  return registry !== null && typeof Highlight === 'function'
}

export function resolveTokenPainterKind(
  mode: EditorTokenPainting,
  registry: HighlightRegistry | null,
  scrollMode: VirtualizedTextViewInternal['scrollMode'],
  currentKind: RowTokenPainterKind | null,
  mountedRowCount: number,
  segmentCount: number,
): RowTokenPainterKind {
  if (mode === 'css-highlight') return 'css-highlight'
  if (mode === 'spans') return 'spans'
  if (!supportsCssHighlights(registry)) return 'spans'
  if (scrollMode === 'virtualized') return 'css-highlight'
  if (currentKind === 'spans') {
    return mountedRowCount <= AUTO_SPAN_EXIT_ROWS && segmentCount <= AUTO_SPAN_EXIT_SEGMENTS
      ? 'css-highlight'
      : 'spans'
  }
  return mountedRowCount >= AUTO_SPAN_ENTER_ROWS || segmentCount >= AUTO_SPAN_ENTER_SEGMENTS
    ? 'spans'
    : 'css-highlight'
}

export function isTokenSpanElement(node: Node | null): node is HTMLSpanElement {
  return (
    node !== null &&
    node.nodeType === 1 &&
    (node as Element).tagName === 'SPAN' &&
    (node as Element).classList.contains(TOKEN_SPAN_BASE_CLASS)
  )
}

export function createRowTokenPainter(
  view: VirtualizedTextViewInternal,
  kind: RowTokenPainterKind,
): RowTokenPainter {
  return kind === 'spans' ? new SpanRowTokenPainter(view) : new CssHighlightRowTokenPainter(view)
}

class CssHighlightRowTokenPainter implements RowTokenPainter {
  public readonly kind = 'css-highlight' as const
  public readonly paintsOverlayBase = false
  readonly #view: VirtualizedTextViewInternal
  readonly #tokenGroups = new Map<string, TokenGroup>()
  readonly #rowTokenRanges = new Map<number, Map<string, readonly AbstractRange[]>>()

  public constructor(view: VirtualizedTextViewInternal) {
    this.#view = view
  }

  public get tokenGroups(): ReadonlyMap<string, TokenGroup> {
    return this.#tokenGroups
  }

  public get rowTokenRanges(): ReadonlyMap<number, ReadonlyMap<string, readonly AbstractRange[]>> {
    return this.#rowTokenRanges
  }

  public hasPaintedState(): boolean {
    return this.#tokenGroups.size > 0 || this.#rowTokenRanges.size > 0
  }

  public syncPalette(
    styles: ReadonlyMap<string, EditorTokenStyle>,
    onStyleRemoved: (rowSlotId: number) => void,
  ): boolean {
    if (!supportsCssHighlights(this.#view.highlightRegistry)) return false
    let changed = false
    for (const [styleKey, style] of styles) {
      changed = this.#ensureTokenGroup(styleKey, style).created || changed
    }
    const shared = getSharedTokenHighlights(
      this.#view.scrollElement.ownerDocument,
      this.#view.highlightRegistry,
    )
    for (const [key, group] of this.#tokenGroups) {
      if (styles.has(key)) continue
      for (const [rowSlotId, rangesByStyle] of this.#rowTokenRanges) {
        const ranges = rangesByStyle.get(key)
        if (!ranges) continue
        for (const range of ranges) group.highlight.delete(range)
        rangesByStyle.delete(key)
        onStyleRemoved(rowSlotId)
      }
      shared?.release(key)
      this.#tokenGroups.delete(key)
      changed = true
    }
    return changed
  }

  public paintRow(
    row: MountedVirtualizedTextRow,
    segments: readonly TokenRowSegment[],
  ): RowTokenPaintResult {
    if (!supportsCssHighlights(this.#view.highlightRegistry)) return NO_PAINT_RESULT
    const deletedRangeCount = this.clearRow(row.tokenHighlightSlotId)
    const rangesByStyle = new Map<string, AbstractRange[]>()
    const document = this.#view.scrollElement.ownerDocument
    let addedRangeCount = 0
    let liveRangeCount = 0
    let staticRangeCount = 0
    let styleRulesDirty = false

    for (const segment of segments) {
      const result = this.#ensureTokenGroup(segment.styleKey, segment.style)
      const group = result.group
      if (!group) continue

      const range = addTokenRangeToChunk(
        document,
        group.highlight,
        row,
        segment.chunk,
        segment.start,
        segment.end,
      )
      if (!range) continue

      addedRangeCount += 1
      if (isLiveRange(document, range)) liveRangeCount += 1
      else staticRangeCount += 1
      styleRulesDirty = styleRulesDirty || result.created
      appendTokenRange(rangesByStyle, segment.styleKey, range)
    }

    if (rangesByStyle.size > 0) {
      this.#rowTokenRanges.set(row.tokenHighlightSlotId, rangesByStyle)
    }
    scheduleHighlightRepaintNudge(this.#view.highlightRegistry)
    return {
      addedRangeCount,
      deletedRangeCount,
      liveRangeCount,
      staticRangeCount,
      styleRulesDirty,
      domMutated: false,
    }
  }

  public clearRow(rowSlotId: number): number {
    const rangesByStyle = this.#rowTokenRanges.get(rowSlotId)
    if (!rangesByStyle) return 0

    let deletedRangeCount = 0
    for (const [styleKey, capturedRanges] of rangesByStyle) {
      const group = this.#tokenGroups.get(styleKey)
      if (!group) continue
      for (const range of capturedRanges) group.highlight.delete(range)
      deletedRangeCount += capturedRanges.length
    }

    this.#rowTokenRanges.delete(rowSlotId)
    if (deletedRangeCount > 0) {
      scheduleHighlightRepaintNudge(this.#view.highlightRegistry)
    }
    return deletedRangeCount
  }

  public clearRows(): void {
    for (const rowSlotId of this.#rowTokenRanges.keys()) this.clearRow(rowSlotId)
    this.#rowTokenRanges.clear()
  }

  public clearAll(): void {
    if (!this.hasPaintedState()) return
    this.clearRows()
    const shared = getSharedTokenHighlights(
      this.#view.scrollElement.ownerDocument,
      this.#view.highlightRegistry,
    )
    for (const group of this.#tokenGroups.values()) shared?.release(group.styleKey)
    this.#tokenGroups.clear()
    shared?.flush()
  }

  public flushStyles(): void {
    getSharedTokenHighlights(
      this.#view.scrollElement.ownerDocument,
      this.#view.highlightRegistry,
    )?.flush()
  }

  public restore(reason: 'presentation' | 'resume'): boolean {
    const registry = this.#view.highlightRegistry
    if (!supportsCssHighlights(registry) || !registry) return false

    let restored = false
    for (const group of this.#tokenGroups.values()) {
      registry.set(group.name, group.highlight)
      restored = true
    }
    getSharedTokenHighlights(this.#view.scrollElement.ownerDocument, registry)?.restore()

    if (reason === 'presentation') {
      // WebKit bug: async syntax ranges registered while hidden can stay unpainted on reveal.
      // NBSP support selects WebKit, not the bug; remove when native paint passes without refresh.
      if (
        this.#view.scrollElement.ownerDocument.defaultView?.CSS.supports(
          '-webkit-nbsp-mode',
          'space',
        )
      ) {
        for (const rangesByStyle of this.#rowTokenRanges.values()) {
          for (const [styleKey, ranges] of rangesByStyle) {
            const group = this.#tokenGroups.get(styleKey)
            if (!group) continue
            for (const range of ranges) {
              group.highlight.delete(range)
              group.highlight.add(range)
            }
          }
        }
      }
    }
    return restored
  }

  #ensureTokenGroup(
    styleKey: string,
    style: EditorTokenStyle,
  ): { readonly group: TokenGroup | null; readonly created: boolean } {
    const existing = this.#tokenGroups.get(styleKey)
    if (existing) return { group: existing, created: false }

    const shared = getSharedTokenHighlights(
      this.#view.scrollElement.ownerDocument,
      this.#view.highlightRegistry,
    )
    if (!shared) return { group: null, created: false }

    const handle = shared.acquire(styleKey, style)
    const group: TokenGroup = {
      name: handle.name,
      highlight: handle.highlight,
      style,
      styleKey,
    }
    this.#tokenGroups.set(styleKey, group)
    return { group, created: true }
  }
}

type SharedSpanStyleHandle = {
  readonly id: string
  readonly className: string
  readonly paintKey: string
}

type SharedSpanStyleEntry = SharedSpanStyleHandle & {
  readonly rule: string
}

const sharedSpanStylesByDocument = new WeakMap<Document, SharedTokenSpanStyles>()
let nextSharedSpanTokenId = 0

function getSharedTokenSpanStyles(doc: Document): SharedTokenSpanStyles {
  const existing = sharedSpanStylesByDocument.get(doc)
  if (existing) return existing
  const created = new SharedTokenSpanStyles(doc)
  sharedSpanStylesByDocument.set(doc, created)
  return created
}

class SharedTokenSpanStyles {
  readonly #rules: SharedStyleRules
  readonly #entries = new Map<string, SharedSpanStyleEntry>()

  public constructor(doc: Document) {
    this.#rules = new SharedStyleRules(doc)
  }

  public acquire(paintKey: string, style: EditorTokenStyle): SharedSpanStyleHandle {
    const existing = this.#entries.get(paintKey)
    if (existing) {
      this.#rules.acquire(paintKey, existing.rule)
      return existing
    }

    const id = String(nextSharedSpanTokenId++)
    const tokenClass = `${TOKEN_SPAN_CLASS_PREFIX}${id}`
    const className = `${tokenClass} ${TOKEN_SPAN_BASE_CLASS}`
    const rule = buildTokenSpanRule(id, tokenClass, style)
    const entry: SharedSpanStyleEntry = { id, className, paintKey, rule }
    this.#entries.set(paintKey, entry)
    this.#rules.acquire(paintKey, rule)
    return entry
  }

  public release(paintKey: string): void {
    const entry = this.#entries.get(paintKey)
    if (!entry) return
    if (!this.#rules.release(paintKey)) return
    this.#entries.delete(paintKey)
  }

  public flush(): void {
    this.#rules.flush()
  }

  public restore(): void {
    this.#rules.restore()
  }
}

function buildTokenSpanRule(id: string, className: string, style: EditorTokenStyle): string {
  const declarations: string[] = []
  if (style.color) declarations.push(`color: ${style.color};`)
  if (style.backgroundColor) declarations.push(`background-color: ${style.backgroundColor};`)
  if (style.textDecoration) declarations.push(`text-decoration: ${style.textDecoration};`)
  const body = declarations.join(' ')
  const base = `.editor-virtualized-row .${className}, .editor-virtualized-row [data-editor-token="${id}"] { ${body} }`
  // Inherit the widget's already-computed color onto nested anchors (e.g. Markdown links) so
  // `color-mix(..., currentColor ...)` resolves once and translucent backgrounds never double-paint.
  if (!style.color) return base
  return `${base}\n.editor-virtualized-row [data-editor-token="${id}"] a { color: inherit; }`
}

type PaintStyle = {
  readonly color?: string
  readonly backgroundColor?: string
  readonly textDecoration?: string
  readonly paintKey: string
}

type LocalPaintInterval = {
  readonly start: number
  readonly end: number
  readonly style: PaintStyle
}

type PaintedSpanRowState = {
  readonly row: MountedVirtualizedTextRow
  readonly taggedElements: HTMLElement[]
}

const paintStyleCache = new WeakMap<EditorTokenStyle, PaintStyle | null>()

function resolvePaintStyle(style: EditorTokenStyle): PaintStyle | null {
  const cached = paintStyleCache.get(style)
  if (cached !== undefined) return cached

  const color = style.color || undefined
  const backgroundColor = style.backgroundColor || undefined
  const textDecoration = style.textDecoration || undefined
  if (!color && !backgroundColor && !textDecoration) {
    paintStyleCache.set(style, null)
    return null
  }
  const paintKey = `${color ?? ''}\0${backgroundColor ?? ''}\0${textDecoration ?? ''}`
  const resolved: PaintStyle = {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(textDecoration ? { textDecoration } : {}),
    paintKey,
  }
  paintStyleCache.set(style, resolved)
  return resolved
}

class SpanRowTokenPainter implements RowTokenPainter {
  public readonly kind = 'spans' as const
  public readonly paintsOverlayBase = true
  readonly #view: VirtualizedTextViewInternal
  readonly #acquiredStyles = new Map<string, SharedSpanStyleHandle>()
  readonly #paintedRows = new Map<number, PaintedSpanRowState>()

  public constructor(view: VirtualizedTextViewInternal) {
    this.#view = view
  }

  public hasPaintedState(): boolean {
    return this.#acquiredStyles.size > 0 || this.#paintedRows.size > 0
  }

  public syncPalette(
    styles: ReadonlyMap<string, EditorTokenStyle>,
    onStyleRemoved: (rowSlotId: number) => void,
  ): boolean {
    const nextPaintStyles = new Map<string, PaintStyle>()
    for (const style of styles.values()) {
      const paint = resolvePaintStyle(style)
      if (paint) nextPaintStyles.set(paint.paintKey, paint)
    }

    let changed = false
    for (const paint of nextPaintStyles.values()) {
      changed = this.#ensureStyleHandle(paint).created || changed
    }

    const shared = getSharedTokenSpanStyles(this.#view.scrollElement.ownerDocument)
    let removedAny = false
    for (const paintKey of this.#acquiredStyles.keys()) {
      if (nextPaintStyles.has(paintKey)) continue
      shared.release(paintKey)
      this.#acquiredStyles.delete(paintKey)
      changed = true
      removedAny = true
    }
    if (removedAny) {
      for (const rowSlotId of this.#paintedRows.keys()) onStyleRemoved(rowSlotId)
    }
    return changed
  }

  public paintRow(
    row: MountedVirtualizedTextRow,
    segments: readonly TokenRowSegment[],
  ): RowTokenPaintResult {
    const previous = this.#paintedRows.get(row.tokenHighlightSlotId)
    const deletedRangeCount = previous ? 1 : 0
    if (previous) {
      clearTaggedElements(previous.taggedElements)
      this.#paintedRows.delete(row.tokenHighlightSlotId)
    }

    if (segments.length === 0) {
      if (!row.hasTokenSpans) return { ...NO_PAINT_RESULT, deletedRangeCount }
      const domMutated = this.#unwrapRow(row)
      return { ...NO_PAINT_RESULT, deletedRangeCount, domMutated }
    }

    const segmentsByChunk = groupSegmentsByChunk(segments)
    let addedSpanCount = 0
    let styleRulesDirty = false
    let domMutated = false
    let rowHasPaintedTokens = false
    const taggedElements: HTMLElement[] = []
    const maxNodeLength = spanTextNodeLimit(this.#view, row)

    for (const chunk of row.chunks) {
      const chunkSegments = segmentsByChunk.get(chunk)
      const intervals = chunkSegments
        ? resolveChunkLocalIntervals(row, chunk, chunkSegments)
        : EMPTY_INTERVALS

      if (intervals.length === 0 && !row.hasTokenSpans) continue

      const chunkResult = this.#paintChunk(row, chunk, intervals, maxNodeLength, taggedElements)
      addedSpanCount += chunkResult.spanCount
      styleRulesDirty = styleRulesDirty || chunkResult.styleRulesDirty
      domMutated = domMutated || chunkResult.domMutated
      rowHasPaintedTokens = rowHasPaintedTokens || chunkResult.hasPaintedTokens
    }

    if (rowHasPaintedTokens) {
      this.#paintedRows.set(row.tokenHighlightSlotId, { row, taggedElements })
    }
    if (domMutated || row.hasTokenSpans !== rowHasPaintedTokens) {
      markRowTokenDomUpdated(row, rowHasPaintedTokens, domMutated)
    }

    return {
      addedRangeCount: addedSpanCount,
      deletedRangeCount,
      liveRangeCount: 0,
      staticRangeCount: 0,
      styleRulesDirty,
      domMutated,
    }
  }

  public clearRow(rowSlotId: number, row?: MountedVirtualizedTextRow): number {
    const state = this.#paintedRows.get(rowSlotId)
    const targetRow = row ?? state?.row
    if (state) {
      clearTaggedElements(state.taggedElements)
      this.#paintedRows.delete(rowSlotId)
    }
    if (!targetRow || !targetRow.hasTokenSpans) return 0
    return this.#unwrapRow(targetRow) ? 1 : 0
  }

  public clearRows(rows?: Iterable<MountedVirtualizedTextRow>): void {
    const visited = new Set<number>()
    for (const [slotId, state] of this.#paintedRows) {
      visited.add(slotId)
      this.clearRow(slotId, state.row)
    }
    if (rows) {
      for (const row of rows) {
        if (visited.has(row.tokenHighlightSlotId)) continue
        if (row.hasTokenSpans) this.clearRow(row.tokenHighlightSlotId, row)
      }
    }
    this.#paintedRows.clear()
  }

  public clearAll(rows?: Iterable<MountedVirtualizedTextRow>): void {
    this.clearRows(rows)
    if (this.#acquiredStyles.size === 0) return
    const shared = getSharedTokenSpanStyles(this.#view.scrollElement.ownerDocument)
    for (const paintKey of this.#acquiredStyles.keys()) shared.release(paintKey)
    this.#acquiredStyles.clear()
    shared.flush()
  }

  public flushStyles(): void {
    sharedSpanStylesByDocument.get(this.#view.scrollElement.ownerDocument)?.flush()
  }

  public restore(): boolean {
    if (this.#acquiredStyles.size === 0) return false
    getSharedTokenSpanStyles(this.#view.scrollElement.ownerDocument).restore()
    return true
  }

  #ensureStyleHandle(paint: PaintStyle): {
    readonly handle: SharedSpanStyleHandle
    readonly created: boolean
  } {
    const existing = this.#acquiredStyles.get(paint.paintKey)
    if (existing) return { handle: existing, created: false }

    const handle = getSharedTokenSpanStyles(this.#view.scrollElement.ownerDocument).acquire(
      paint.paintKey,
      paint,
    )
    this.#acquiredStyles.set(paint.paintKey, handle)
    return { handle, created: true }
  }

  #unwrapRow(row: MountedVirtualizedTextRow): boolean {
    const maxNodeLength = spanTextNodeLimit(this.#view, row)
    let domMutated = false
    for (const chunk of row.chunks) {
      const result = this.#paintChunk(row, chunk, EMPTY_INTERVALS, maxNodeLength, [])
      domMutated = domMutated || result.domMutated
    }
    markRowTokenDomUpdated(row, false, domMutated)
    return domMutated
  }

  #paintChunk(
    row: MountedVirtualizedTextRow,
    chunk: VirtualizedTextChunk,
    intervals: readonly LocalPaintInterval[],
    maxNodeLength: number,
    taggedElements: HTMLElement[],
  ): {
    readonly spanCount: number
    readonly styleRulesDirty: boolean
    readonly domMutated: boolean
    readonly hasPaintedTokens: boolean
  } {
    const doc = row.element.ownerDocument
    const parts = chunk.parts
    if (parts.length === 0) {
      return { spanCount: 0, styleRulesDirty: false, domMutated: false, hasPaintedTokens: false }
    }

    const nextParts: VirtualizedTextChunkPart[] = []
    let spanCount = 0
    let styleRulesDirty = false
    let domMutated = false
    let hasPaintedTokens = false
    let intervalCursor = 0

    let index = 0
    while (index < parts.length) {
      const part = parts[index]!
      if (part.kind !== 'text') {
        const covering = findIntersectingInterval(intervals, part.localStart, part.localEnd)
        if (covering) {
          const { handle, created } = this.#ensureStyleHandle(covering.style)
          styleRulesDirty = styleRulesDirty || created
          if (part.element.dataset.editorToken !== handle.id) {
            part.element.dataset.editorToken = handle.id
          }
          taggedElements.push(part.element)
          hasPaintedTokens = true
        } else if (part.element.dataset.editorToken !== undefined) {
          delete part.element.dataset.editorToken
        }
        nextParts.push(part)
        index += 1
        continue
      }

      // Group contiguous text parts that share one logical parent (stripping any token span wrappers).
      const firstHost = hostNodeForTextPart(part.node)
      const logicalParent = firstHost.parentNode
      if (!logicalParent) {
        nextParts.push(part)
        index += 1
        continue
      }

      const runStart = part.localStart
      let runEnd = part.localEnd
      let runText = part.node.data
      const oldHosts: Node[] = [firstHost]
      let hasOldTokenSpans = firstHost !== part.node
      let cursor = index + 1

      while (cursor < parts.length) {
        const candidate = parts[cursor]!
        if (candidate.kind !== 'text' || candidate.localStart !== runEnd) break
        const candidateHost = hostNodeForTextPart(candidate.node)
        if (candidateHost.parentNode !== logicalParent) break
        if (candidateHost !== oldHosts.at(-1)) {
          if (oldHosts.at(-1)!.nextSibling !== candidateHost) break
          oldHosts.push(candidateHost)
        }
        if (candidateHost !== candidate.node) hasOldTokenSpans = true
        runText += candidate.node.data
        runEnd = candidate.localEnd
        cursor += 1
      }

      while (intervalCursor < intervals.length && intervals[intervalCursor]!.end <= runStart) {
        intervalCursor += 1
      }

      const runHasIntervals =
        intervalCursor < intervals.length && intervals[intervalCursor]!.start < runEnd

      if (!runHasIntervals && !hasOldTokenSpans) {
        for (let i = index; i < cursor; i += 1) nextParts.push(parts[i]!)
        index = cursor
        continue
      }

      const anchor = oldHosts.at(-1)!.nextSibling
      const replacement = doc.createDocumentFragment()
      let localCursor = runStart
      let scan = intervalCursor

      while (scan < intervals.length && intervals[scan]!.start < runEnd) {
        const interval = intervals[scan]!
        const segStart = Math.max(localCursor, interval.start)
        const segEnd = Math.min(runEnd, interval.end)
        if (segStart > localCursor) {
          appendBareTextNodes(
            doc,
            replacement,
            nextParts,
            runText.slice(localCursor - runStart, segStart - runStart),
            localCursor,
            maxNodeLength,
          )
        }
        if (segEnd > segStart) {
          const { handle, created } = this.#ensureStyleHandle(interval.style)
          styleRulesDirty = styleRulesDirty || created
          spanCount += appendStyledTextSpans(
            doc,
            replacement,
            nextParts,
            runText.slice(segStart - runStart, segEnd - runStart),
            segStart,
            handle.className,
            maxNodeLength,
          )
          hasPaintedTokens = true
          localCursor = segEnd
        }
        if (interval.end > runEnd) break
        scan += 1
      }

      if (localCursor < runEnd) {
        appendBareTextNodes(
          doc,
          replacement,
          nextParts,
          runText.slice(localCursor - runStart),
          localCursor,
          maxNodeLength,
        )
      }

      if (
        oldHosts[0] === logicalParent.firstChild &&
        anchor === null &&
        logicalParent.nodeType === 1
      ) {
        ;(logicalParent as Element).replaceChildren(replacement)
      } else {
        for (const oldHost of oldHosts) oldHost.parentNode?.removeChild(oldHost)
        logicalParent.insertBefore(replacement, anchor)
      }
      domMutated = true
      index = cursor
    }

    if (domMutated) {
      const mutableChunk = chunk as {
        parts: readonly VirtualizedTextChunkPart[]
        textNode: Text
      }
      mutableChunk.parts = nextParts
      mutableChunk.textNode = firstTextNode(nextParts) ?? chunk.textNode
      updateMutableRowChunks(row, row.chunks)
    }

    return { spanCount, styleRulesDirty, domMutated, hasPaintedTokens }
  }
}

const EMPTY_INTERVALS: readonly LocalPaintInterval[] = []

function clearTaggedElements(elements: readonly HTMLElement[]): void {
  for (const element of elements) {
    if (element.dataset.editorToken !== undefined) delete element.dataset.editorToken
  }
}

function hostNodeForTextPart(node: Text): Node {
  const parent = node.parentNode
  return isTokenSpanElement(parent) ? parent : node
}

function firstTextNode(parts: readonly VirtualizedTextChunkPart[]): Text | null {
  for (const part of parts) {
    if (part.kind === 'text') return part.node
  }
  return null
}

function spanTextNodeLimit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  if (memoizedContainsRTL(view, row)) return MAX_SPLIT_TEXT_NODE_LENGTH
  if (row.textRenderMode === 'rendered' && view.monospace && row.text.length > 512) {
    return MAX_SPLIT_TEXT_NODE_LENGTH
  }
  return Number.POSITIVE_INFINITY
}

function appendBareTextNodes(
  doc: Document,
  target: DocumentFragment,
  parts: VirtualizedTextChunkPart[],
  text: string,
  localStart: number,
  maxNodeLength: number,
): void {
  if (text.length === 0) return
  if (text.length <= maxNodeLength) {
    const node = doc.createTextNode(text)
    target.appendChild(node)
    parts.push({ kind: 'text', localStart, localEnd: localStart + text.length, node })
    return
  }
  for (const slice of splitTextSlices(text, maxNodeLength)) {
    const node = doc.createTextNode(slice.text)
    target.appendChild(node)
    parts.push({
      kind: 'text',
      localStart: localStart + slice.offset,
      localEnd: localStart + slice.offset + slice.text.length,
      node,
    })
  }
}

function appendStyledTextSpans(
  doc: Document,
  target: DocumentFragment,
  parts: VirtualizedTextChunkPart[],
  text: string,
  localStart: number,
  className: string,
  maxNodeLength: number,
): number {
  if (text.length === 0) return 0
  const span = doc.createElement('span')
  span.className = className
  if (text.length <= maxNodeLength) {
    const node = doc.createTextNode(text)
    span.appendChild(node)
    parts.push({ kind: 'text', localStart, localEnd: localStart + text.length, node })
  } else {
    for (const slice of splitTextSlices(text, maxNodeLength)) {
      const node = doc.createTextNode(slice.text)
      span.appendChild(node)
      parts.push({
        kind: 'text',
        localStart: localStart + slice.offset,
        localEnd: localStart + slice.offset + slice.text.length,
        node,
      })
    }
  }
  target.appendChild(span)
  return 1
}

function splitTextSlices(
  text: string,
  maxNodeLength: number,
): readonly { readonly offset: number; readonly text: string }[] {
  if (text.length <= maxNodeLength) return [{ offset: 0, text }]
  if (isSimpleRowText(text)) {
    const slices: { readonly offset: number; readonly text: string }[] = []
    for (let offset = 0; offset < text.length; offset += maxNodeLength) {
      slices.push({ offset, text: text.slice(offset, offset + maxNodeLength) })
    }
    return slices
  }

  const slices: { readonly offset: number; readonly text: string }[] = []
  let sliceStart = 0
  for (const segment of segmentGraphemes(text)) {
    const segmentEnd = segment.index + segment.segment.length
    if (segmentEnd - sliceStart <= maxNodeLength || segment.index === sliceStart) continue
    slices.push({ offset: sliceStart, text: text.slice(sliceStart, segment.index) })
    sliceStart = segment.index
  }
  if (sliceStart < text.length) {
    slices.push({ offset: sliceStart, text: text.slice(sliceStart) })
  }
  return slices
}

function groupSegmentsByChunk(
  segments: readonly TokenRowSegment[],
): Map<VirtualizedTextChunk, TokenRowSegment[]> {
  const byChunk = new Map<VirtualizedTextChunk, TokenRowSegment[]>()
  for (const segment of segments) {
    const existing = byChunk.get(segment.chunk)
    if (existing) existing.push(segment)
    else byChunk.set(segment.chunk, [segment])
  }
  return byChunk
}

export function resolveChunkLocalIntervals(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  segments: readonly TokenRowSegment[],
): readonly LocalPaintInterval[] {
  const raw: LocalPaintInterval[] = []
  let hasOverlap = false
  let prevEnd = chunk.localStart

  for (const segment of segments) {
    const style = resolvePaintStyle(segment.style)
    if (!style) continue
    const start = clampLocal(chunk, rowLocalIndexForOffset(row, segment.start, 'before'))
    const end = clampLocal(chunk, rowLocalIndexForOffset(row, segment.end, 'after'))
    if (end <= start) continue
    if (raw.length > 0 && start < prevEnd) hasOverlap = true
    if (end > prevEnd) prevEnd = end
    raw.push({ start, end, style })
  }

  if (raw.length === 0) return EMPTY_INTERVALS
  const disjoint = hasOverlap ? flattenOverlappingIntervals(raw) : raw
  return coalesceAdjacentIntervals(chunk, disjoint)
}

function clampLocal(chunk: VirtualizedTextChunk, local: number): number {
  if (local < chunk.localStart) return chunk.localStart
  if (local > chunk.localEnd) return chunk.localEnd
  return local
}

type OrderedPaintProperty = {
  readonly order: number
  readonly end: number
  readonly value: string
}

/** Binary max-heap keyed by `order` with lazy expiration of intervals ended at or before `at`. */
class PropertyMaxHeap {
  readonly #items: OrderedPaintProperty[] = []

  public push(entry: OrderedPaintProperty): void {
    const items = this.#items
    let index = items.length
    items.push(entry)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (items[parent]!.order >= entry.order) break
      items[index] = items[parent]!
      index = parent
    }
    items[index] = entry
  }

  public activeValue(at: number): string | undefined {
    const items = this.#items
    while (items.length > 0 && items[0]!.end <= at) {
      const last = items.pop()!
      if (items.length === 0) break
      let index = 0
      const length = items.length
      while (true) {
        const left = (index << 1) + 1
        if (left >= length) break
        const right = left + 1
        const best = right < length && items[right]!.order > items[left]!.order ? right : left
        if (items[best]!.order <= last.order) break
        items[index] = items[best]!
        index = best
      }
      items[index] = last
    }
    return items.length > 0 ? items[0]!.value : undefined
  }
}

/** O(k log k) endpoint sweep for overlapping syntax tokens; later interval wins per paint property. */
function flattenOverlappingIntervals(
  intervals: readonly LocalPaintInterval[],
): readonly LocalPaintInterval[] {
  const count = intervals.length
  const coords: number[] = []
  const byStart: {
    readonly start: number
    readonly end: number
    readonly order: number
    readonly style: PaintStyle
  }[] = []

  for (let order = 0; order < count; order += 1) {
    const interval = intervals[order]!
    coords.push(interval.start, interval.end)
    byStart.push({ start: interval.start, end: interval.end, order, style: interval.style })
  }
  coords.sort((left, right) => left - right)
  byStart.sort((left, right) => left.start - right.start || left.order - right.order)

  const colorHeap = new PropertyMaxHeap()
  const backgroundHeap = new PropertyMaxHeap()
  const decorationHeap = new PropertyMaxHeap()
  const result: LocalPaintInterval[] = []

  let startCursor = 0
  let previousCoord = coords[0]!
  for (let coordIndex = 1; coordIndex < coords.length; coordIndex += 1) {
    const nextCoord = coords[coordIndex]!
    if (nextCoord === previousCoord) continue

    while (startCursor < count && byStart[startCursor]!.start <= previousCoord) {
      const item = byStart[startCursor++]!
      if (item.end <= previousCoord) continue
      const { style, order, end } = item
      if (style.color) colorHeap.push({ order, end, value: style.color })
      if (style.backgroundColor) {
        backgroundHeap.push({ order, end, value: style.backgroundColor })
      }
      if (style.textDecoration) {
        decorationHeap.push({ order, end, value: style.textDecoration })
      }
    }

    const color = colorHeap.activeValue(previousCoord)
    const backgroundColor = backgroundHeap.activeValue(previousCoord)
    const textDecoration = decorationHeap.activeValue(previousCoord)
    if (color || backgroundColor || textDecoration) {
      const style = resolvePaintStyle({ color, backgroundColor, textDecoration })
      if (style) {
        const tail = result.at(-1)
        if (tail && tail.end === previousCoord && tail.style.paintKey === style.paintKey) {
          result[result.length - 1] = { start: tail.start, end: nextCoord, style: tail.style }
        } else {
          result.push({ start: previousCoord, end: nextCoord, style })
        }
      }
    }
    previousCoord = nextCoord
  }
  return result
}

function coalesceAdjacentIntervals(
  chunk: VirtualizedTextChunk,
  intervals: readonly LocalPaintInterval[],
): readonly LocalPaintInterval[] {
  if (intervals.length <= 1) return intervals
  const merged: LocalPaintInterval[] = [intervals[0]!]
  for (let index = 1; index < intervals.length; index += 1) {
    const current = intervals[index]!
    const previous = merged.at(-1)!
    if (
      previous.style.paintKey === current.style.paintKey &&
      (current.start === previous.end ||
        (!previous.style.backgroundColor &&
          !previous.style.textDecoration &&
          isChunkAsciiWhitespace(chunk, previous.end, current.start)))
    ) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, current.end),
        style: previous.style,
      }
      continue
    }
    merged.push(current)
  }
  return merged
}

function isChunkAsciiWhitespace(
  chunk: VirtualizedTextChunk,
  localStart: number,
  localEnd: number,
): boolean {
  const from = localStart - chunk.localStart
  const to = localEnd - chunk.localStart
  for (let index = from; index < to; index += 1) {
    const code = chunk.text.charCodeAt(index)
    if (code !== 32 && code !== 9) return false
  }
  return true
}

function findIntersectingInterval(
  intervals: readonly LocalPaintInterval[],
  localStart: number,
  localEnd: number,
): LocalPaintInterval | null {
  let low = 0
  let high = intervals.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (intervals[middle]!.end <= localStart) low = middle + 1
    else high = middle
  }
  const candidate = intervals[low]
  if (!candidate || candidate.start >= localEnd) return null
  return candidate
}

function markRowTokenDomUpdated(
  row: MountedVirtualizedTextRow,
  hasTokenSpans: boolean,
  domMutated: boolean,
): void {
  const mutable = row as {
    hasTokenSpans: boolean
    tokenDomRevision: number
  }
  mutable.hasTokenSpans = hasTokenSpans
  if (domMutated) {
    mutable.tokenDomRevision += 1
    clearRowGeometryCache(row)
    releaseNativeRowGeometry(row)
  }
}

function isLiveRange(document: Document, range: AbstractRange): boolean {
  const RangeConstructor = document.defaultView?.Range
  return RangeConstructor ? range instanceof RangeConstructor : false
}
