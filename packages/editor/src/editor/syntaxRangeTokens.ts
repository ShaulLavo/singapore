import type { EditorSyntaxRange } from '../syntax/session'
import type { EditorTokenRun, EditorTokenStore } from '../syntax/tokenStore'
import type { TextEdit } from '../tokens'

/**
 * Where `ranges` (sorted, disjoint) lie after `edits`, whose offsets are in the text before them,
 * as a session change reports them.
 *
 * Text inserted at a range's edge stays outside it, and a replaced span that crosses an edge cuts
 * the range back to that edge. The editor's token projection can grow a neighbouring token into
 * such text, and a range must never take in a token its answers did not write.
 */
export function projectSyntaxRangesThroughEdits(
  ranges: readonly EditorSyntaxRange[],
  edits: readonly TextEdit[],
): readonly EditorSyntaxRange[] {
  if (ranges.length === 0 || edits.length === 0) return ranges

  const ordered = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)
  const projected: EditorSyntaxRange[] = []
  for (const range of ranges) {
    const startIndex = rangeStartAfterEdits(range.startIndex, ordered)
    const endIndex = rangeEndAfterEdits(range.endIndex, ordered)
    if (endIndex > startIndex) projected.push({ startIndex, endIndex })
  }
  return projected
}

function rangeStartAfterEdits(offset: number, edits: readonly TextEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    // A span replaced from the start on is inside the range; text inserted there is before it.
    if (edit.from === offset && edit.to > edit.from) break
    // The start sat inside the replaced span: the range begins after the replacement.
    if (edit.to > offset) return edit.from + delta + edit.text.length

    delta += edit.text.length - (edit.to - edit.from)
  }
  return offset + delta
}

function rangeEndAfterEdits(offset: number, edits: readonly TextEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (edit.from >= offset) break
    // The end sat inside the replaced span: the range ends where the replacement begins.
    if (edit.to > offset) return edit.from + delta

    delta += edit.text.length - (edit.to - edit.from)
  }
  return offset + delta
}

/**
 * `store` without the tokens that reach into one of `dropped`, except those that also reach into
 * one of `kept`: a token across the edge between the two still paints the kept side. Returns
 * `store` when nothing goes.
 */
export function removeTokensInRanges(
  store: EditorTokenStore,
  dropped: readonly EditorSyntaxRange[],
  kept: readonly EditorSyntaxRange[],
): EditorTokenStore {
  let next = store
  for (const range of dropped) next = removeTokensInRange(next, range, kept)
  return next
}

function removeTokensInRange(
  store: EditorTokenStore,
  range: EditorSyntaxRange,
  kept: readonly EditorSyntaxRange[],
): EditorTokenStore {
  const last = store.firstStartingAtOrAfter(range.endIndex)
  const first = store.firstEndingAfter(range.startIndex, last)
  if (first >= last) return store

  // Tokens that start inside the range and end inside it go unchecked. Only the ones around
  // them, which start before the range or end after it, can reach a kept range.
  const inside = Math.max(first, store.firstStartingAtOrAfter(range.startIndex))
  const after = Math.max(inside, store.firstEndingAfter(range.endIndex, last))
  const survivors = createTokenRun(inside - first + last - after)
  const keep = (start: number, end: number, styleId: number): void => {
    // With nested tokens the window can hold one that ends before the range; it is not in it.
    const reachesIn = end > range.startIndex
    if (reachesIn && !tokenReachesRanges(start, end, kept)) return
    writeTokenRun(survivors, start, end, styleId)
  }
  store.forEachInRange(first, inside, keep)
  store.forEachInRange(after, last, keep)
  if (survivors.count === last - first) return store

  return store.replaceRange(first, last, finishTokenRun(survivors), {
    delta: 0,
    keepsLiveRanges: null,
  })
}

function tokenReachesRanges(
  start: number,
  end: number,
  ranges: readonly EditorSyntaxRange[],
): boolean {
  return ranges.some((range) => start < range.endIndex && end > range.startIndex)
}

type TokenRunWriter = {
  readonly starts: Uint32Array
  readonly ends: Uint32Array
  readonly styleIds: Uint32Array
  count: number
}

function createTokenRun(capacity: number): TokenRunWriter {
  return {
    starts: new Uint32Array(capacity),
    ends: new Uint32Array(capacity),
    styleIds: new Uint32Array(capacity),
    count: 0,
  }
}

function writeTokenRun(writer: TokenRunWriter, start: number, end: number, styleId: number): void {
  writer.starts[writer.count] = start
  writer.ends[writer.count] = end
  writer.styleIds[writer.count] = styleId
  writer.count += 1
}

function finishTokenRun(writer: TokenRunWriter): EditorTokenRun {
  return {
    starts: writer.starts.subarray(0, writer.count),
    ends: writer.ends.subarray(0, writer.count),
    styleIds: writer.styleIds.subarray(0, writer.count),
  }
}
