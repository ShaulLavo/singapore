import type {
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapore-editor/core/extensions'
import type { EditorTheme } from '@singapore-editor/core/rendering'

import { EDITOR_SNIPPET_TOKENS_FEATURE } from '@singapore-editor/core/extensions'

import { anchoredSurfaceFollowsUpdate } from './anchoredSurface'
import { createTooltipCodeTokenizer, type TooltipCodeBlock } from './codeTokens'
import { tooltipCodeBlocks } from './markdownTooltip'
import type {
  EditorHoverParticipant,
  HoverAnchor,
  HoverPart,
  HoverRequest,
} from './hoverParticipant'
import { EDITOR_HOVER_PARTICIPANT } from './hoverToken'
import {
  hasIdentifierBeforeOffsetInSource,
  hoverTargetRangeInSource,
  isIdentifierAtOffsetInSource,
  markerTargetRangeInSource,
  sameOffsetRange,
  unionOffsetRange,
  type OffsetRange,
} from './offsetRange'
import {
  createTooltipController,
  HOVER_ASYNC_DISPATCH_DELAY_MS,
  HOVER_LOADING_DELAY_MS,
  HOVER_REQUEST_DEBOUNCE_MS,
  type TooltipController,
} from './tooltip'

export type HoverControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly classNamespace?: string
  readonly markdownCodeBackground?: boolean
}

export type HoverController = {
  update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void
  /** Shows the hover at an offset right away, as a keyboard summons does. */
  showAtOffset(offset: number, options?: { readonly focus?: boolean }): boolean
  hide(): void
  containsTarget(target: EventTarget | null): boolean
  dispose(): void
}

type PointerPoint = {
  readonly clientX: number
  readonly clientY: number
}

type CachedHoverRange = {
  readonly textVersion: number
  readonly range: OffsetRange
  readonly isIdentifier: boolean
}

type CorridorSettleState = {
  point: PointerPoint
  readonly target: CachedHoverRange | null
}

type HoverStartOptions = {
  readonly focusOnShow: boolean
  readonly immediate?: boolean
}

type HoverPointTarget = {
  readonly offset: number
  readonly range: OffsetRange
}

type ParticipantResult = {
  sync: readonly HoverPart[]
  async: readonly HoverPart[]
}

type HoverOperation = {
  readonly id: number
  readonly anchor: HoverAnchor
  readonly rangeIsIdentifier: boolean
  readonly snapshot: EditorViewSnapshot
  readonly participants: readonly EditorHoverParticipant[]
  readonly results: Map<EditorHoverParticipant, ParticipantResult>
  readonly abort: AbortController
  readonly focusOnShow: boolean
  pendingAsync: number
  revealed: boolean
  loading: boolean
  shown: boolean
  dispatchTimer: ReturnType<typeof setTimeout> | null
  revealTimer: ReturnType<typeof setTimeout> | null
  loadingTimer: ReturnType<typeof setTimeout> | null
}

/**
 * The one hover an editor view has.
 *
 * Every plugin with something to say at a position registers an EditorHoverParticipant; this asks
 * all of them on one clock and paints their answers in one surface. Two plugins can therefore never
 * put two hovers on screen, and neither can open on a different delay than the other: the timing
 * is not theirs to set.
 *
 * The clock is VS Code's. With a 300ms delay, async work starts at 150ms so a server answer
 * overlaps the rest of the dwell, sync work runs and the surface paints at 300ms, and a hover still
 * waiting on a server at 900ms shows a loading row.
 */
export function createHoverController(options: HoverControllerOptions): HoverController {
  const { context } = options
  const element = context.scrollElement
  const ownerDocument = context.container.ownerDocument
  let operation: HoverOperation | null = null
  let lastPointer: PointerPoint | null = null
  let corridorSettle: CorridorSettleState | null = null
  let trackingOutside = false
  let hideScheduled = false
  let nextOperationId = 0
  let theme: EditorTheme | null = context.getSnapshot().theme ?? null
  let disposed = false
  const snippetTokens = context.getFeature(EDITOR_SNIPPET_TOKENS_FEATURE)
  const codeTokenizer = snippetTokens ? createTooltipCodeTokenizer(snippetTokens) : null

  const clearCorridorSettle = (): void => {
    corridorSettle = null
  }

  const cancelHide = (): void => {
    hideScheduled = false
    tooltip.cancelHide()
  }

  const schedulePlainHide = (refresh: boolean): void => {
    if (hideScheduled && !refresh) return
    hideScheduled = true
    tooltip.scheduleHide()
  }

  const handleDocumentPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return hide()
    if (tooltip.containsTarget(event.target)) {
      stopOutsideTracking()
      return cancelHide()
    }
    if (event.target instanceof Node && element.contains(event.target)) return stopOutsideTracking()

    const retention = tooltip.pointerRetention(event.clientX, event.clientY)
    if (retention === 'locked' || retention === 'anchor') return cancelHide()
    if (retention === 'approaching') return schedulePlainHide(true)
    if (retention === 'corridor') return schedulePlainHide(false)
    stopOutsideTracking()
    schedulePlainHide(false)
  }

  const startOutsideTracking = (): void => {
    if (trackingOutside || disposed) return
    trackingOutside = true
    ownerDocument.addEventListener('pointermove', handleDocumentPointerMove)
  }

  const stopOutsideTracking = (): void => {
    if (!trackingOutside) return
    trackingOutside = false
    ownerDocument.removeEventListener('pointermove', handleDocumentPointerMove)
  }

  const tooltip: TooltipController = createTooltipController({
    registerKeymapNode: (options) => context.registerKeymapNode(options),
    document: ownerDocument,
    themeSource: element,
    reentryElement: element,
    markdownCodeBackground: options.markdownCodeBackground,
    classNamespace: options.classNamespace,
    codeTokenizer,
    onDidHide: () => cancelOperation(),
    onPointerEnter: () => {
      hideScheduled = false
      stopOutsideTracking()
      clearCorridorSettle()
    },
    onRequestEditorFocus: () => context.focusEditor(),
  })

  const cancelOperation = (): void => {
    hideScheduled = false
    stopOutsideTracking()
    clearCorridorSettle()
    const current = operation
    if (!current) return
    operation = null
    clearTimers(current)
    current.abort.abort()
  }

  const hide = (): void => {
    cancelOperation()
    tooltip.hide()
  }

  const warmCodeBlock = (block: TooltipCodeBlock): void => {
    void codeTokenizer?.tokenize(block.text, block.languageId)
  }

  const isCurrent = (candidate: HoverOperation): boolean => operation === candidate

  const isPointOnOperation = (
    current: HoverOperation,
    clientX: number,
    clientY: number,
  ): boolean => {
    if (!isCurrent(current) || !context.hasDocument()) return false
    const snapshot = context.getSnapshot()
    if (snapshot.textVersion !== current.snapshot.textVersion) return false
    return isPointInCachedRange(context, snapshot, cachedRangeFor(current), clientX, clientY)
  }

  const render = (current: HoverOperation): void => {
    if (!isCurrent(current)) return

    const parts = orderedParts(current)
    const blocks = parts.flatMap((part) => (part.markdown ? tooltipCodeBlocks(part.markdown) : []))
    // An answer usually lands inside the dwell, so its tokens are asked for before the reveal.
    if (!current.revealed) return blocks.forEach(warmCodeBlock)

    const pending = current.pendingAsync > 0
    if (parts.length === 0 && pending && !current.loading) return
    if (parts.length === 0 && !pending) return hide()

    const tokens = codeTokenizer?.prepare(blocks)
    if (tokens) return void tokens.then(() => render(current))

    const range = unionOffsetRange(parts.map((part) => part.range)) ?? current.anchor.range
    const rect = context.getRangeClientRect(range.start, range.end)
    if (!rect) return hide()

    const tokenRect = sameOffsetRange(range, current.anchor.range)
      ? rect
      : (context.getRangeClientRect(current.anchor.range.start, current.anchor.range.end) ?? rect)
    const pointer =
      current.anchor.source === 'pointer' && !current.shown
        ? (lastPointer ?? current.anchor.point ?? null)
        : null

    tooltip.show({
      anchor: rect,
      pointerAnchor: tokenRect,
      isPointOnAnchor: (clientX, clientY) => isPointOnOperation(current, clientX, clientY),
      pointer,
      hoverText: null,
      parts,
      theme,
      loading: current.loading && pending,
      focus: current.focusOnShow && !current.shown,
      preferredPlacement: parts.some((part) => part.presentation === 'controls') ? 'bottom' : 'top',
    })
    current.shown = true
  }

  const runAsync = (current: HoverOperation, request: HoverRequest): void => {
    for (const participant of current.participants) {
      if (!participant.computeAsync) continue
      current.pendingAsync += 1
      const emit = (parts: readonly HoverPart[]): void => {
        if (!isCurrent(current)) return
        resultFor(current, participant).async = parts
        render(current)
      }
      participant
        .computeAsync(request, emit)
        .catch(() => undefined)
        .finally(() => {
          if (!isCurrent(current)) return
          current.pendingAsync -= 1
          if (current.pendingAsync === 0 && current.loadingTimer) clearTimeout(current.loadingTimer)
          render(current)
        })
    }
  }

  const runSync = (current: HoverOperation, request: HoverRequest): void => {
    for (const participant of current.participants) {
      if (!participant.computeSync) continue
      resultFor(current, participant).sync = participant.computeSync(request)
    }
  }

  const reveal = (current: HoverOperation, request: HoverRequest): void => {
    if (!isCurrent(current)) return
    runSync(current, request)
    current.revealed = true
    render(current)
  }

  const revealLoading = (current: HoverOperation): void => {
    if (!isCurrent(current) || current.pendingAsync === 0) return
    current.revealed = true
    current.loading = true
    current.loadingTimer = null
    render(current)
  }

  const start = (anchor: HoverAnchor, startOptions: HoverStartOptions): boolean => {
    const snapshot = context.getSnapshot()
    const participants = context.getProviders(EDITOR_HOVER_PARTICIPANT, snapshot.languageId)
    if (participants.length === 0) return false

    hide()
    nextOperationId += 1
    const current: HoverOperation = {
      id: nextOperationId,
      anchor,
      rangeIsIdentifier: isIdentifierAtOffsetInSource(snapshot.textSnapshot, anchor.range.start),
      snapshot,
      participants,
      results: new Map(),
      abort: new AbortController(),
      focusOnShow: startOptions.focusOnShow,
      pendingAsync: 0,
      revealed: false,
      loading: false,
      shown: false,
      dispatchTimer: null,
      revealTimer: null,
      loadingTimer: null,
    }
    operation = current
    const request: HoverRequest = { anchor, snapshot, signal: current.abort.signal }
    // @justification Delays the loading row until the participants are observably slow; every
    // target change cancels it.
    current.loadingTimer = setTimeout(() => revealLoading(current), HOVER_LOADING_DELAY_MS)
    if (startOptions.focusOnShow || startOptions.immediate) {
      runAsync(current, request)
      reveal(current, request)
      return true
    }

    // @justification Starts server work midway through the pointer dwell so transient targets are
    // skipped while network time overlaps the rest of the dwell.
    current.dispatchTimer = setTimeout(() => {
      current.dispatchTimer = null
      runAsync(current, request)
    }, HOVER_ASYNC_DISPATCH_DELAY_MS)
    // @justification Enforces the hover dwell before paint; the pointer leaving the target clears it.
    current.revealTimer = setTimeout(() => {
      current.revealTimer = null
      reveal(current, request)
    }, HOVER_REQUEST_DEBOUNCE_MS)
    return true
  }

  const scheduleTarget = (
    target: HoverPointTarget,
    snapshot: EditorViewSnapshot,
    point: HoverAnchor['point'],
  ): void => {
    cancelHide()
    const current = operation
    if (
      current &&
      current.snapshot.textVersion === snapshot.textVersion &&
      sameOffsetRange(current.anchor.range, target.range)
    ) {
      return
    }

    start(
      { offset: target.offset, range: target.range, source: 'pointer', point },
      { focusOnShow: false },
    )
  }

  const settleCorridor = (): void => {
    const pending = corridorSettle
    corridorSettle = null
    if (!pending || disposed) return
    const retention = tooltip.pointerRetention(pending.point.clientX, pending.point.clientY)
    if (retention === 'locked' || retention === 'anchor') return
    if (!context.hasDocument()) return hide()

    const snapshot = context.getSnapshot()
    const target = hoverTargetFromPoint(
      context,
      snapshot,
      pending.point.clientX,
      pending.point.clientY,
      pending.target ?? cachedRangeForOperation(operation),
    )
    if (!target) return hide()

    const current = operation
    if (
      current &&
      current.snapshot.textVersion === snapshot.textVersion &&
      sameOffsetRange(current.anchor.range, target.range)
    ) {
      return
    }

    start(
      { offset: target.offset, range: target.range, source: 'pointer', point: pending.point },
      { focusOnShow: false, immediate: true },
    )
  }

  const scheduleCorridorSettle = (point: PointerPoint, refreshDeadline: boolean): void => {
    const snapshot = context.hasDocument() ? context.getSnapshot() : null
    const cached = corridorSettle?.target ?? cachedRangeForOperation(operation)
    const target = snapshot
      ? hoverTargetFromPoint(context, snapshot, point.clientX, point.clientY, cached)
      : null
    const targetRange = target?.range ?? null
    if (
      !refreshDeadline &&
      corridorSettle &&
      sameNullableRange(corridorSettle.target?.range ?? null, targetRange)
    ) {
      corridorSettle.point = point
      return
    }

    const nextTarget: CachedHoverRange | null =
      snapshot && target
        ? {
            textVersion: snapshot.textVersion,
            range: target.range,
            isIdentifier: isIdentifierAtOffsetInSource(snapshot.textSnapshot, target.range.start),
          }
        : null
    hideScheduled = false
    corridorSettle = { point, target: nextTarget }
    tooltip.scheduleHide(() => settleCorridor())
  }

  const handlePointerMove = (event: PointerEvent): void => {
    stopOutsideTracking()
    if (event.buttons !== 0) return hide()
    const point: PointerPoint = { clientX: event.clientX, clientY: event.clientY }
    lastPointer = point
    const retention = tooltip.pointerRetention(event.clientX, event.clientY)
    if (retention === 'locked' || retention === 'anchor') {
      clearCorridorSettle()
      return cancelHide()
    }
    if (retention === 'approaching') return scheduleCorridorSettle(point, true)
    if (retention === 'corridor') return scheduleCorridorSettle(point, false)
    clearCorridorSettle()
    if (!context.hasDocument()) return hide()

    const snapshot = context.getSnapshot()
    const target = hoverTargetFromPoint(
      context,
      snapshot,
      event.clientX,
      event.clientY,
      cachedRangeForOperation(operation),
    )
    if (!target) {
      if (operation && !operation.shown) cancelOperation()
      return schedulePlainHide(false)
    }

    scheduleTarget(target, snapshot, point)
  }

  const handlePointerLeave = (event: PointerEvent): void => {
    clearCorridorSettle()
    lastPointer = null
    if (tooltip.containsTarget(event.relatedTarget)) {
      stopOutsideTracking()
      return cancelHide()
    }
    // A hover that has not painted yet has nothing to keep: the pointer is gone.
    if (operation && !operation.shown) cancelOperation()
    if (operation?.shown) startOutsideTracking()
    schedulePlainHide(false)
  }

  const handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (tooltip.containsTarget(event.target)) return
    hide()
  }

  const keymap = context.registerKeymapNode({
    element,
    context: () => ({ identifiers: operation?.shown ? ['HoverVisible'] : [] }),
    commands: { 'tooltip.hide': hide },
  })

  element.addEventListener('pointermove', handlePointerMove)
  element.addEventListener('pointerleave', handlePointerLeave)
  ownerDocument.addEventListener('pointerdown', handleDocumentPointerDown, { capture: true })

  return {
    update: (snapshot, kind) => {
      const nextTheme = snapshot.theme ?? null
      if (nextTheme !== theme) codeTokenizer?.clear()
      theme = nextTheme
      if (shouldHideOnUpdate(kind)) hide()
    },
    showAtOffset: (offset, showOptions = {}) => {
      if (disposed || !context.hasDocument()) return false
      const range = hoverTargetRangeInSource(context.getSnapshot().textSnapshot, offset)
      const focusOnShow = showOptions.focus ?? false
      return start({ offset, range, source: 'keyboard' }, { focusOnShow })
    },
    hide,
    containsTarget: (target) => tooltip.containsTarget(target),
    dispose: () => {
      if (disposed) return
      disposed = true
      element.removeEventListener('pointermove', handlePointerMove)
      element.removeEventListener('pointerleave', handlePointerLeave)
      keymap.dispose()
      ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown, { capture: true })
      hide()
      tooltip.dispose()
    },
  }
}

function resultFor(
  operation: HoverOperation,
  participant: EditorHoverParticipant,
): ParticipantResult {
  const existing = operation.results.get(participant)
  if (existing) return existing
  const created: ParticipantResult = { sync: [], async: [] }
  operation.results.set(participant, created)
  return created
}

/** Every part on screen, lowest ordinal first; ties keep participant and emission order. */
function orderedParts(operation: HoverOperation): readonly HoverPart[] {
  const parts: HoverPart[] = []
  for (const participant of operation.participants) {
    const result = operation.results.get(participant)
    if (!result) continue
    parts.push(...result.sync, ...result.async)
  }
  return parts.sort((left, right) => left.ordinal - right.ordinal)
}

function clearTimers(operation: HoverOperation): void {
  if (operation.dispatchTimer) clearTimeout(operation.dispatchTimer)
  if (operation.revealTimer) clearTimeout(operation.revealTimer)
  if (operation.loadingTimer) clearTimeout(operation.loadingTimer)
  operation.dispatchTimer = null
  operation.revealTimer = null
  operation.loadingTimer = null
}

/**
 * A scroll or relayout moves the text out from under the hover, and an edit may have changed what
 * it says. Both belong to the old frame, so the hover goes with them.
 */
function cachedRangeFor(current: HoverOperation): CachedHoverRange {
  return {
    textVersion: current.snapshot.textVersion,
    range: current.anchor.range,
    isIdentifier: current.rangeIsIdentifier,
  }
}

function cachedRangeForOperation(current: HoverOperation | null): CachedHoverRange | null {
  return current ? cachedRangeFor(current) : null
}

function isPointInCachedRange(
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
  cached: CachedHoverRange,
  clientX: number,
  clientY: number,
): boolean {
  const marker = context.markerAtPoint(clientX, clientY)
  if (marker) return marker.offset >= cached.range.start && marker.offset < cached.range.end

  const hit = context.rowAtPoint(clientX, clientY)
  if (!hit || hit.region !== 'text' || hit.offset === null) return false
  return matchesCachedTextOffset(snapshot, cached, hit.offset)
}

function matchesCachedTextOffset(
  snapshot: EditorViewSnapshot,
  cached: CachedHoverRange,
  offset: number,
): boolean {
  if (cached.isIdentifier) return offset >= cached.range.start && offset <= cached.range.end
  if (offset < cached.range.start || offset >= cached.range.end) return false
  return !hasIdentifierBeforeOffsetInSource(snapshot.textSnapshot, cached.range.start)
}

function hoverTargetFromPoint(
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
  clientX: number,
  clientY: number,
  cached: CachedHoverRange | null = null,
): HoverPointTarget | null {
  const validCache = cached && cached.textVersion === snapshot.textVersion ? cached : null
  const marker = context.markerAtPoint(clientX, clientY)
  if (marker) {
    if (
      validCache &&
      marker.offset >= validCache.range.start &&
      marker.offset < validCache.range.end
    ) {
      return { offset: marker.offset, range: validCache.range }
    }
    return {
      offset: marker.offset,
      range: markerTargetRangeInSource(snapshot.textSnapshot, marker.offset),
    }
  }
  const hit = context.rowAtPoint(clientX, clientY)
  if (!hit || hit.region !== 'text' || hit.offset === null) return null
  if (validCache && matchesCachedTextOffset(snapshot, validCache, hit.offset)) {
    return { offset: hit.offset, range: validCache.range }
  }
  return {
    offset: hit.offset,
    range: hoverTargetRangeInSource(snapshot.textSnapshot, hit.offset),
  }
}

function sameNullableRange(left: OffsetRange | null, right: OffsetRange | null): boolean {
  if (left === null || right === null) return left === right
  return sameOffsetRange(left, right)
}

function shouldHideOnUpdate(kind: EditorViewContributionUpdateKind): boolean {
  if (anchoredSurfaceFollowsUpdate(kind)) return true
  return kind === 'content' || kind === 'document' || kind === 'clear'
}
