import type { DocumentTextSnapshot } from '../documentTextSnapshot'
import {
  EditorTokenStore,
  toEditorTokenStore,
  type EditorTokenInput,
  type EditorTokenRun,
} from '../syntax/tokenStore'
import type { EditorTokenStyle, TextEdit } from '../tokens'

export type SyntaxRangeCoverage = 'none' | 'partial' | 'full'

export type SyntaxRange = {
  readonly startIndex: number
  readonly endIndex: number
}

export type SyntaxFold = {
  readonly startIndex: number
  readonly endIndex: number
  readonly startLine: number
  readonly endLine: number
  readonly type: string
  readonly languageId?: string
}

export type SyntaxBracket = {
  readonly index: number
  readonly char: string
  readonly depth: number
}

export type SyntaxCapture = {
  readonly startIndex: number
  readonly endIndex: number
  readonly captureName: string
  readonly languageId?: string
  readonly injectionDepth?: number
}

export type SyntaxErrorRange = {
  readonly startIndex: number
  readonly endIndex: number
  readonly message: string
  readonly isMissing: boolean
}

export type SyntaxInjection = {
  readonly parentLanguageId: string
  readonly languageId: string
  readonly startIndex: number
  readonly endIndex: number
}

export type SyntaxResultLike = {
  readonly records?: { readonly languageId: string; readonly data: Uint32Array }
  readonly captures: readonly SyntaxCapture[]
  readonly folds: readonly SyntaxFold[]
  readonly brackets: readonly SyntaxBracket[]
  readonly errors: readonly SyntaxErrorRange[]
  readonly injections: readonly SyntaxInjection[]
  readonly degraded: { readonly kind: string } | null
  readonly projection: {
    readonly source?: unknown
    readonly analysis?: { readonly kind: string }
    readonly invalidation?: unknown
    readonly snapshot: unknown
    readonly requestedRanges: readonly SyntaxRange[]
  }
  readonly tokens: EditorTokenInput
}

export type IncrementalInvalidationStep<TResult extends SyntaxResultLike = SyntaxResultLike> = {
  readonly fromParseId: number
  readonly toParseId: number
  readonly beforeSnapshot: DocumentTextSnapshot
  readonly afterSnapshot: DocumentTextSnapshot
  readonly edits: readonly TextEdit[]
  readonly invalidatedRanges: readonly SyntaxRange[]
  readonly baseResult: TResult
}

const EMPTY_TOKEN_RUN: EditorTokenRun = {
  starts: new Uint32Array(0),
  ends: new Uint32Array(0),
  styleIds: new Uint32Array(0),
}

export const sameSyntaxRange = (left: SyntaxRange, right: SyntaxRange): boolean =>
  left.startIndex === right.startIndex && left.endIndex === right.endIndex

export const sameSyntaxRanges = (
  left: readonly SyntaxRange[],
  right: readonly SyntaxRange[],
): boolean =>
  left.length === right.length &&
  left.every((range, index) => sameSyntaxRange(range, right[index]!))

export const compareSyntaxRanges = (left: SyntaxRange, right: SyntaxRange): number =>
  left.startIndex - right.startIndex || left.endIndex - right.endIndex

export const syntaxRangesIntersect = (left: SyntaxRange, right: SyntaxRange): boolean =>
  left.startIndex < right.endIndex && left.endIndex > right.startIndex

export const syntaxRangeListsIntersect = (
  left: readonly SyntaxRange[],
  right: readonly SyntaxRange[],
): boolean => left.some((range) => right.some((other) => syntaxRangesIntersect(range, other)))

export const offsetInSyntaxRanges = (offset: number, ranges: readonly SyntaxRange[]): boolean =>
  ranges.some((range) => offset >= range.startIndex && offset < range.endIndex)

export const foldIntersectsSyntaxRange = (fold: SyntaxFold, range: SyntaxRange): boolean =>
  fold.startIndex < range.endIndex && fold.endIndex > range.startIndex

export const compareFoldRanges = (left: SyntaxFold, right: SyntaxFold): number =>
  left.startLine - right.startLine ||
  left.endLine - right.endLine ||
  left.startIndex - right.startIndex ||
  left.endIndex - right.endIndex

export const appendCachedSyntaxRange = (
  ranges: readonly SyntaxRange[],
  range: SyntaxRange,
): readonly SyntaxRange[] => {
  if (range.endIndex <= range.startIndex) return ranges

  const merged: SyntaxRange[] = []
  const sorted = ranges.concat(range).sort(compareSyntaxRanges)
  for (const current of sorted) mergeCachedSyntaxRange(merged, current)
  return merged
}

export const mergeSyntaxRanges = (ranges: readonly SyntaxRange[]): readonly SyntaxRange[] => {
  const nonEmpty = ranges.filter((range) => range.endIndex > range.startIndex)
  if (nonEmpty.length <= 1) return nonEmpty
  const sorted = nonEmpty.slice().sort(compareSyntaxRanges)
  const merged: SyntaxRange[] = []
  for (const current of sorted) mergeCachedSyntaxRange(merged, current)
  return merged
}

const mergeCachedSyntaxRange = (ranges: SyntaxRange[], range: SyntaxRange): void => {
  const previous = ranges.at(-1)
  if (!previous || range.startIndex > previous.endIndex) {
    ranges.push(range)
    return
  }

  ranges[ranges.length - 1] = {
    startIndex: previous.startIndex,
    endIndex: Math.max(previous.endIndex, range.endIndex),
  }
}

export const subtractSyntaxRange = (
  ranges: readonly SyntaxRange[],
  removed: SyntaxRange,
): readonly SyntaxRange[] => {
  if (removed.endIndex <= removed.startIndex) return ranges
  const remaining: SyntaxRange[] = []
  for (const range of ranges) {
    if (!syntaxRangesIntersect(range, removed)) {
      remaining.push(range)
      continue
    }
    if (range.startIndex < removed.startIndex)
      remaining.push({ startIndex: range.startIndex, endIndex: removed.startIndex })
    if (range.endIndex > removed.endIndex)
      remaining.push({ startIndex: removed.endIndex, endIndex: range.endIndex })
  }
  return remaining
}

export const subtractSyntaxRanges = (
  ranges: readonly SyntaxRange[],
  removedList: readonly SyntaxRange[],
): readonly SyntaxRange[] => {
  let remaining = ranges
  for (const removed of removedList) {
    if (remaining.length === 0) break
    remaining = subtractSyntaxRange(remaining, removed)
  }
  return remaining
}

export const intersectSyntaxRanges = (
  left: readonly SyntaxRange[],
  right: readonly SyntaxRange[],
): readonly SyntaxRange[] => {
  const result: SyntaxRange[] = []
  for (const a of left) {
    for (const b of right) {
      const startIndex = Math.max(a.startIndex, b.startIndex)
      const endIndex = Math.min(a.endIndex, b.endIndex)
      if (endIndex > startIndex) result.push({ startIndex, endIndex })
    }
  }
  return mergeSyntaxRanges(result)
}

export const syntaxRangeCoverage = (
  range: SyntaxRange,
  cachedRanges: readonly SyntaxRange[],
): SyntaxRangeCoverage => {
  if (range.endIndex <= range.startIndex) return 'none'
  let cursor = range.startIndex
  let overlaps = false
  for (const cachedRange of cachedRanges) {
    if (cachedRange.endIndex <= range.startIndex) continue
    if (cachedRange.startIndex >= range.endIndex) break

    overlaps = true
    if (cachedRange.endIndex <= cursor) continue
    if (cachedRange.startIndex > cursor) return 'partial'

    cursor = Math.max(cursor, cachedRange.endIndex)
    if (cursor >= range.endIndex) return 'full'
  }

  return overlaps ? 'partial' : 'none'
}

export const firstUncoveredSyntaxRange = (
  range: SyntaxRange,
  cachedRanges: readonly SyntaxRange[],
): SyntaxRange | null => {
  if (range.endIndex <= range.startIndex) return range
  let cursor = range.startIndex
  for (const cachedRange of cachedRanges) {
    if (cachedRange.endIndex <= cursor) continue
    if (cachedRange.startIndex >= range.endIndex) break
    if (cachedRange.startIndex > cursor) {
      return { startIndex: cursor, endIndex: Math.min(cachedRange.startIndex, range.endIndex) }
    }

    cursor = Math.max(cursor, cachedRange.endIndex)
    if (cursor >= range.endIndex) return null
  }

  return cursor < range.endIndex ? { startIndex: cursor, endIndex: range.endIndex } : null
}

/** O(1) segment-delta offset shift of a token store (zero TypedArray copy for monotonic stores). */
export const shiftTokenStore = (store: EditorTokenStore, delta: number): EditorTokenStore => {
  if (delta === 0 || store.length === 0) return store
  return store.replaceRange(0, 0, EMPTY_TOKEN_RUN, { delta, keepsLiveRanges: true })
}

/**
 * Splices `incoming` tokens into `target` strictly on each disjoint strip `[s, e)` in `strips`.
 * Any existing token crossing a strip boundary keeps its outside portion(s) intact; any incoming
 * token crossing a strip boundary is clipped to `[s, e)`.
 */
export const mergeTokensOnStrips = (
  target: EditorTokenStore,
  incoming: EditorTokenStore,
  strips: readonly SyntaxRange[],
): EditorTokenStore => {
  let current = target
  for (const strip of strips) {
    if (strip.endIndex <= strip.startIndex) continue
    current = mergeTokensOnSingleStrip(current, incoming, strip)
  }
  return current
}

const mergeTokensOnSingleStrip = (
  target: EditorTokenStore,
  incoming: EditorTokenStore,
  strip: SyntaxRange,
): EditorTokenStore => {
  const { startIndex: s, endIndex: e } = strip
  const inLast = incoming.firstStartingAtOrAfter(e)
  const inFirst = incoming.firstEndingAfter(s, inLast)

  // Zero-copy pass-through when populating an empty store with an in-bounds incoming store.
  if (
    target.length === 0 &&
    inFirst === 0 &&
    inLast === incoming.length &&
    (incoming.length === 0 || (incoming.startAt(0) >= s && maxTokenEnd(incoming) <= e))
  ) {
    return incoming
  }

  const last = target.firstStartingAtOrAfter(e)
  const first = target.firstEndingAfter(s, last)

  let styles: EditorTokenStyle[]
  let remap: Uint32Array | null = null
  if (target.styles.length === 0) {
    styles = incoming.styles as EditorTokenStyle[]
  } else if (target.styles === incoming.styles) {
    styles = target.styles as EditorTokenStyle[]
  } else {
    styles = target.styles.slice()
    const styleIdByValue = new Map<EditorTokenStyle, number>()
    for (let i = 0; i < styles.length; i += 1) styleIdByValue.set(styles[i]!, i)
    remap = new Uint32Array(incoming.styles.length)
    for (let i = 0; i < incoming.styles.length; i += 1) {
      const style = incoming.styles[i]!
      let id = styleIdByValue.get(style)
      if (id === undefined) {
        id = styles.length
        styles.push(style)
        styleIdByValue.set(style, id)
      }
      remap[i] = id
    }
  }

  let preCount = 0
  let postCount = 0
  let preStarts: number[] | null = null
  let preEnds: number[] | null = null
  let preStyles: number[] | null = null
  let postStarts: number[] | null = null
  let postEnds: number[] | null = null
  let postStyles: number[] | null = null

  if (first < last) {
    target.forEachInRange(first, last, (start, end, styleId) => {
      if (end <= s) {
        ;(preStarts ??= []).push(start)
        ;(preEnds ??= []).push(end)
        ;(preStyles ??= []).push(styleId)
        preCount += 1
        return
      }
      if (start >= e) {
        ;(postStarts ??= []).push(start)
        ;(postEnds ??= []).push(end)
        ;(postStyles ??= []).push(styleId)
        postCount += 1
        return
      }
      if (start < s) {
        ;(preStarts ??= []).push(start)
        ;(preEnds ??= []).push(s)
        ;(preStyles ??= []).push(styleId)
        preCount += 1
      }
      if (end > e) {
        ;(postStarts ??= []).push(e)
        ;(postEnds ??= []).push(end)
        ;(postStyles ??= []).push(styleId)
        postCount += 1
      }
    })
  }

  const capacity = preCount + (inLast - inFirst) + postCount
  const starts = new Uint32Array(capacity)
  const ends = new Uint32Array(capacity)
  const styleIds = new Uint32Array(capacity)
  let count = 0
  let sorted = true
  let prevStart = 0
  let prevEnd = 0

  const emit = (start: number, end: number, styleId: number): void => {
    if (count > 0 && (start < prevStart || (start === prevStart && end < prevEnd))) {
      sorted = false
    }
    starts[count] = start
    ends[count] = end
    styleIds[count] = styleId
    prevStart = start
    prevEnd = end
    count += 1
  }

  for (let i = 0; i < preCount; i += 1) {
    emit(preStarts![i]!, preEnds![i]!, preStyles![i]!)
  }
  if (inFirst < inLast) {
    incoming.forEachInRange(inFirst, inLast, (start, end, styleId) => {
      const clippedStart = start < s ? s : start
      const clippedEnd = end > e ? e : end
      if (clippedEnd <= clippedStart) return
      emit(clippedStart, clippedEnd, remap ? remap[styleId]! : styleId)
    })
  }
  for (let i = 0; i < postCount; i += 1) {
    emit(postStarts![i]!, postEnds![i]!, postStyles![i]!)
  }

  if (!sorted) {
    for (let i = 1; i < count; i += 1) {
      const st = starts[i]!
      const en = ends[i]!
      const sy = styleIds[i]!
      let j = i - 1
      while (j >= 0 && (starts[j]! > st || (starts[j]! === st && ends[j]! > en))) {
        starts[j + 1] = starts[j]!
        ends[j + 1] = ends[j]!
        styleIds[j + 1] = styleIds[j]!
        j -= 1
      }
      starts[j + 1] = st
      ends[j + 1] = en
      styleIds[j + 1] = sy
    }
  }

  const run: EditorTokenRun =
    count === capacity
      ? { starts, ends, styleIds }
      : {
          starts: starts.subarray(0, count),
          ends: ends.subarray(0, count),
          styleIds: styleIds.subarray(0, count),
        }

  return target.replaceRange(first, last, run, {
    delta: 0,
    keepsLiveRanges: null,
    styles,
  })
}

export const compactSyntaxRangeTokens = (
  store: EditorTokenStore,
  ranges: readonly SyntaxRange[],
): EditorTokenStore => {
  if (ranges.length === 0 || store.length === 0) return EditorTokenStore.empty()
  const sorted = ranges.length === 1 ? ranges : mergeSyntaxRanges(ranges)
  if (sorted.length === 0) return EditorTokenStore.empty()
  if (
    sorted.length === 1 &&
    store.startAt(0) >= sorted[0]!.startIndex &&
    maxTokenEnd(store) <= sorted[0]!.endIndex
  ) {
    return store
  }

  let count = 0
  let lastSeen = -1
  for (const range of sorted) {
    if (range.endIndex <= range.startIndex) continue
    const last = store.firstStartingAtOrAfter(range.endIndex)
    const first = Math.max(lastSeen + 1, store.firstEndingAfter(range.startIndex, last))
    store.forEachInRange(first, last, (_start, end, _styleId, index) => {
      if (end <= range.startIndex) return
      count += 1
      lastSeen = index
    })
  }
  if (count === 0) return EditorTokenStore.empty()
  if (count === store.length) return store

  const starts = new Uint32Array(count)
  const ends = new Uint32Array(count)
  const styleIds = new Uint32Array(count)
  let out = 0
  lastSeen = -1
  for (const range of sorted) {
    if (range.endIndex <= range.startIndex) continue
    const last = store.firstStartingAtOrAfter(range.endIndex)
    const first = Math.max(lastSeen + 1, store.firstEndingAfter(range.startIndex, last))
    store.forEachInRange(first, last, (start, end, styleId, index) => {
      if (end <= range.startIndex) return
      starts[out] = start
      ends[out] = end
      styleIds[out] = styleId
      out += 1
      lastSeen = index
    })
  }
  return EditorTokenStore.empty().replaceRange(
    0,
    0,
    { starts, ends, styleIds },
    { delta: 0, keepsLiveRanges: null, styles: store.styles },
  )
}

export type PromotedSyntaxRangeResult<TResult extends SyntaxResultLike = SyntaxResultLike> = {
  readonly range: SyntaxRange
  readonly offsetDelta: number
  readonly result: TResult
  readonly tokens: EditorTokenStore
}

const editDelta = (edit: TextEdit): number => edit.text.length - (edit.to - edit.from)

const sumDeltasBeforeOffset = (edits: readonly TextEdit[], offset: number): number => {
  let delta = 0
  for (const edit of edits) {
    if (edit.to < offset) delta += editDelta(edit)
  }
  return delta
}

const maxTokenEnd = (tokens: EditorTokenStore): number => {
  if (tokens.length === 0) return -1
  if (tokens.monotonicEnd) return tokens.endAt(tokens.length - 1)
  let maxEnd = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const end = tokens.endAt(index)
    if (end > maxEnd) maxEnd = end
  }
  return maxEnd
}

const computeEditEnvelope = (
  range: SyntaxRange,
  result: SyntaxResultLike,
  tokens: EditorTokenStore,
): SyntaxRange => {
  let startIndex = range.startIndex
  let endIndex = range.endIndex
  if (tokens.length > 0) {
    startIndex = Math.min(startIndex, tokens.startAt(0))
    endIndex = Math.max(endIndex, maxTokenEnd(tokens))
  }
  for (const bracket of result.brackets) {
    startIndex = Math.min(startIndex, bracket.index)
    endIndex = Math.max(endIndex, bracket.index + 1)
  }
  for (const capture of result.captures) {
    startIndex = Math.min(startIndex, capture.startIndex)
    endIndex = Math.max(endIndex, capture.endIndex)
  }
  for (const error of result.errors) {
    startIndex = Math.min(startIndex, error.startIndex)
    endIndex = Math.max(endIndex, error.endIndex)
  }
  return { startIndex, endIndex }
}

/**
 * Projects a single complete cached range result across one verified incremental parse step,
 * evaluating `step.edits` simultaneously in base-snapshot (`beforeSnapshot`) coordinates.
 * Returns `null` if any edit or invalidated range could affect the entry's facts.
 */
export const projectResultThroughIncrementalStep = <TResult extends SyntaxResultLike>(
  range: SyntaxRange,
  result: TResult,
  tokens: EditorTokenStore,
  step: IncrementalInvalidationStep<TResult>,
): PromotedSyntaxRangeResult<TResult> | null => {
  if (result.projection.analysis?.kind === 'partial') return null
  if (result.projection.analysis?.kind === 'cancelled') return null
  if (result.degraded?.kind === 'range-unavailable') return null

  const { edits, invalidatedRanges, afterSnapshot, baseResult } = step
  const envelope = computeEditEnvelope(range, result, tokens)

  // Packed syntax records (Markdown) carry absolute offsets that cannot be shifted cheaply.
  if (result.records !== undefined) {
    for (const edit of edits) {
      if (!(edit.to < envelope.startIndex || edit.from > envelope.endIndex)) return null
      if (edit.to < envelope.startIndex && editDelta(edit) !== 0) return null
    }
  }

  // Strict separation of every edit from the entry's full fact envelope in base coordinates.
  for (const edit of edits) {
    if (!(edit.to < envelope.startIndex || edit.from > envelope.endIndex)) return null
  }

  const offsetDelta = sumDeltasBeforeOffset(edits, envelope.startIndex)
  const projectedRange: SyntaxRange = {
    startIndex: range.startIndex + offsetDelta,
    endIndex: range.endIndex + offsetDelta,
  }
  const projectedEnv: SyntaxRange = {
    startIndex: envelope.startIndex + offsetDelta,
    endIndex: envelope.endIndex + offsetDelta,
  }
  if (
    projectedRange.startIndex < 0 ||
    projectedRange.endIndex > afterSnapshot.length ||
    projectedEnv.startIndex < 0
  ) {
    return null
  }

  // Check and shift injections in simultaneous base-snapshot coordinates.
  const shiftedInjections: SyntaxInjection[] = []
  for (const injection of result.injections) {
    for (const edit of edits) {
      if (!(edit.to < injection.startIndex || edit.from > injection.endIndex)) return null
    }
    const injDelta = sumDeltasBeforeOffset(edits, injection.startIndex)
    const nextStart = injection.startIndex + injDelta
    const nextEnd = injection.endIndex + injDelta
    if (nextStart < 0 || nextEnd > afterSnapshot.length || nextEnd < nextStart) return null
    shiftedInjections.push({ ...injection, startIndex: nextStart, endIndex: nextEnd })
  }

  // Check and shift folds in simultaneous base-snapshot coordinates.
  const shiftedFolds: SyntaxFold[] = []
  for (const fold of result.folds) {
    for (const edit of edits) {
      if (
        (edit.from <= fold.startIndex && fold.startIndex <= edit.to) ||
        (edit.from <= fold.endIndex && fold.endIndex <= edit.to)
      ) {
        return null
      }
    }
    const nextStart = fold.startIndex + sumDeltasBeforeOffset(edits, fold.startIndex)
    const nextEnd = fold.endIndex + sumDeltasBeforeOffset(edits, fold.endIndex)
    if (nextStart < 0 || nextEnd > afterSnapshot.length || nextEnd <= nextStart) return null
    shiftedFolds.push({
      ...fold,
      startIndex: nextStart,
      endIndex: nextEnd,
      startLine: afterSnapshot.lineAt(nextStart),
      endLine: afterSnapshot.lineAt(nextEnd),
    })
  }

  // Check post-edit invalidation ranges against projected envelope, folds, and injections.
  if (projectedEnv.endIndex > projectedEnv.startIndex) {
    if (syntaxRangeListsIntersect([projectedEnv], invalidatedRanges)) return null
  } else if (
    invalidatedRanges.some(
      (inv) => projectedEnv.startIndex >= inv.startIndex && projectedEnv.startIndex <= inv.endIndex,
    )
  ) {
    return null
  }

  for (const fold of shiftedFolds) {
    if (
      offsetInSyntaxRanges(fold.startIndex, invalidatedRanges) ||
      offsetInSyntaxRanges(fold.endIndex - 1, invalidatedRanges) ||
      offsetInSyntaxRanges(fold.endIndex, invalidatedRanges)
    ) {
      return null
    }
  }
  for (const injection of shiftedInjections) {
    if (syntaxRangeListsIntersect([injection], invalidatedRanges)) return null
  }

  const nextTokens = shiftTokenStore(tokens, offsetDelta)
  const shiftedBrackets: readonly SyntaxBracket[] =
    offsetDelta === 0
      ? result.brackets
      : result.brackets.map((bracket) => ({ ...bracket, index: bracket.index + offsetDelta }))
  const shiftedCaptures: readonly SyntaxCapture[] =
    offsetDelta === 0
      ? result.captures
      : result.captures.map((capture) => ({
          ...capture,
          startIndex: capture.startIndex + offsetDelta,
          endIndex: capture.endIndex + offsetDelta,
        }))
  const shiftedErrors: readonly SyntaxErrorRange[] =
    offsetDelta === 0
      ? result.errors
      : result.errors.map((error) => ({
          ...error,
          startIndex: error.startIndex + offsetDelta,
          endIndex: error.endIndex + offsetDelta,
        }))

  const nextResult = {
    ...result,
    brackets: shiftedBrackets,
    captures: shiftedCaptures,
    errors: shiftedErrors,
    folds: shiftedFolds,
    injections: shiftedInjections,
    tokens: nextTokens,
    projection: {
      ...result.projection,
      source: baseResult.projection.source ?? result.projection.source,
      analysis: {
        kind: 'full' as const,
        coveredRange: { startIndex: 0, endIndex: afterSnapshot.length },
      },
      invalidation: undefined,
      snapshot: baseResult.projection.snapshot,
      requestedRanges: [projectedRange],
    },
  } as TResult

  return {
    range: projectedRange,
    offsetDelta,
    result: nextResult,
    tokens: nextTokens,
  }
}

export const projectResultThroughSteps = <TResult extends SyntaxResultLike>(
  range: SyntaxRange,
  result: TResult,
  steps: readonly IncrementalInvalidationStep<TResult>[],
  initialTokens?: EditorTokenStore,
): PromotedSyntaxRangeResult<TResult> | null => {
  let currentRange = range
  let currentResult = result
  let currentTokens = initialTokens ?? toEditorTokenStore(result.tokens)
  let totalDelta = 0
  for (const step of steps) {
    const promoted = projectResultThroughIncrementalStep(
      currentRange,
      currentResult,
      currentTokens,
      step,
    )
    if (!promoted) return null
    currentRange = promoted.range
    currentResult = promoted.result
    currentTokens = promoted.tokens
    totalDelta += promoted.offsetDelta
  }
  return {
    range: currentRange,
    offsetDelta: totalDelta,
    result: currentResult,
    tokens: currentTokens,
  }
}
