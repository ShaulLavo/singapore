import type { PieceTableEdit, PieceTableTreeSnapshot, PieceTreeNode } from './pieceTableTypes'
import type { InsertContext, InsertProbe, SplitContext } from './internalTypes'
import { EDITS } from './bakeoff'
import { appendChunksToBuffers, extendTailChunk } from './buffers'
import { assignPieceOrders } from './orders'
import { applyReverseIndexChanges } from './reverseIndex'
import { ensureValidRange, isHighSurrogate, isLowSurrogate, splitsSurrogatePair } from './reads'
import { createSnapshotWithIndex, editingEpoch } from './snapshot'
import { getSubtreeMaxOrder, getSubtreeMinOrder } from './node'
import {
  createTreeFromPieces,
  hideVisibleRange,
  insertAtVisibleOffset,
  markTreeInvisible,
  merge,
  splitByVisibleOffset,
} from './tree'

const compareEditsDescending = (left: PieceTableEdit, right: PieceTableEdit): number => {
  if (left.from !== right.from) return right.from - left.from
  return right.to - left.to
}

type BatchBoundaries = {
  readonly starts: ReadonlyMap<number, number>
  readonly ends: ReadonlyMap<number, number>
}

// Counted rather than a set membership test because several siblings may share
// a boundary, and only over the range edits: a collapsed edit consumes nothing
// at the offset it sits on, and snapEditToCodePoints moves it off that offset
// anyway, so crediting it with a surrogate half leaves the half behind.
const coveredByAnother = (boundaries: ReadonlyMap<number, number>, offset: number): boolean =>
  (boundaries.get(offset) ?? 0) > 0

// An edit only corrupts the buffer when it leaves half a surrogate pair behind,
// and it only does that when the replacement text does not put the missing half
// back. Checking the range alone would also widen edits that are already whole:
// syncTextEdit (editor/textEdits.ts) diffs by code unit, so swapping one emoji
// for another arrives as a replacement of a low surrogate by another low
// surrogate — perfectly safe, and expanding it would delete the character the
// caller was building. So the test is on the text this edit leaves behind, not
// on where its endpoints happen to fall.
const orphansSurrogateAtStart = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): boolean => {
  if (!splitsSurrogatePair(snapshot, edit.from)) return false
  // A sibling edit ending here consumes the leading half, so the pair leaves the
  // document whole rather than in halves.
  if (coveredByAnother(boundaries.ends, edit.from)) return false
  return !isLowSurrogate(edit.text.charCodeAt(0))
}

const orphansSurrogateAtEnd = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): boolean => {
  if (!splitsSurrogatePair(snapshot, edit.to)) return false
  if (coveredByAnother(boundaries.starts, edit.to)) return false
  return !isHighSurrogate(edit.text.charCodeAt(edit.text.length - 1))
}

const snapEditToCodePoints = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): PieceTableEdit => {
  const atStart = orphansSurrogateAtStart(snapshot, edit, boundaries)
  const atEnd = orphansSurrogateAtEnd(snapshot, edit, boundaries)
  if (!atStart && !atEnd) return edit

  // Asymmetric on purpose: a non-empty range expands outward so that deleting
  // half an emoji deletes the emoji, while a collapsed one moves left instead —
  // expanding a caret would turn an insertion point into a selection.
  if (edit.from === edit.to) return { ...edit, from: edit.from - 1, to: edit.to - 1 }
  return { ...edit, from: atStart ? edit.from - 1 : edit.from, to: atEnd ? edit.to + 1 : edit.to }
}

// Only snapping can produce an overlap here — the batch was checked before it —
// and the overlap is the one surrogate half both neighbours expanded across, so
// concatenating in document order is the whole of the repair. Throwing instead
// would surface a lone RangeError out of an ordinary multi-cursor replace.
const mergeSnappedOverlaps = (edits: readonly PieceTableEdit[]): readonly PieceTableEdit[] => {
  const merged: PieceTableEdit[] = []
  for (const edit of edits) {
    const previous = merged.at(-1)
    if (previous && edit.from < previous.to) {
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, edit.to),
        text: previous.text + edit.text,
      }
      continue
    }

    merged.push(edit)
  }

  return merged
}

/**
 * The edits a batch will actually apply: validated, ordered, and snapped off any
 * surrogate pair they would otherwise split. Callers that report a change to
 * anyone else — the session's change events, undo inversion, incremental
 * re-render — must describe these, not the edits they were handed, or every
 * consumer is told about a transformation that did not happen.
 *
 * Snapping is idempotent, so a caller may run this and still hand the result to
 * applyBatchToPieceTable.
 */
export const snapBatchEditRanges = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): readonly PieceTableEdit[] => {
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)

  let previousEnd = -1
  for (const edit of sorted) {
    ensureValidRange(snapshot, edit.from, edit.to)
    if (edit.from < previousEnd) throw new RangeError('batch edits must not overlap')
    previousEnd = edit.to
  }

  const boundaries = {
    starts: countBoundaries(sorted, (edit) => edit.from),
    ends: countBoundaries(sorted, (edit) => edit.to),
  }
  return mergeSnappedOverlaps(
    sorted.map((edit) => snapEditToCodePoints(snapshot, edit, boundaries)),
  )
}

// One edit has no sibling to consume a half for it, so the batch's sorting,
// overlap check and boundary counting have nothing to decide: only the
// snapping policy runs, shared with the batch path so the two cannot drift.
const NO_SIBLINGS: BatchBoundaries = { starts: new Map(), ends: new Map() }

const snapEditRange = (snapshot: PieceTableTreeSnapshot, edit: PieceTableEdit): PieceTableEdit => {
  ensureValidRange(snapshot, edit.from, edit.to)
  return snapEditToCodePoints(snapshot, edit, NO_SIBLINGS)
}

const countBoundaries = (
  edits: readonly PieceTableEdit[],
  offsetOf: (edit: PieceTableEdit) => number,
): ReadonlyMap<number, number> => {
  const counts = new Map<number, number>()
  for (const edit of edits) {
    // Collapsed edits are left out entirely — see coveredByAnother — which is
    // also why no edit can be counted at its own boundary any more.
    if (edit.from === edit.to) continue

    const offset = offsetOf(edit)
    counts.set(offset, (counts.get(offset) ?? 0) + 1)
  }

  return counts
}

export const insertIntoPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  text: string,
): PieceTableTreeSnapshot => {
  if (text.length === 0) return snapshot
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError('invalid offset')
  }

  // The offset is snapped inside the split's descent; see InsertProbe. The
  // document's ends are never inside a pair, so those skip the probe's reads.
  return insertTextAt(snapshot, offset, text, offset > 0 && offset < snapshot.length)
}

// One descent. The split probes the landing for a surrogate pair and for a
// piece the text can extend; a pair straddling two pieces asks for a retry
// one unit left, which the caller already snapped so it cannot recur.
const insertTextAt = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  text: string,
  snap: boolean,
): PieceTableTreeSnapshot => {
  const epoch = editingEpoch(snapshot)
  if (EDITS === 'direct') return insertDirect(snapshot, from, text, snap, epoch)
  const probe: InsertProbe = { text, snap, leftTurns: [], outcome: 'split', coalesced: null }
  const context: SplitContext = { changes: [], normalizeOrders: false, probe }
  const { left, right } = splitByVisibleOffset(
    snapshot.root,
    from,
    snapshot.buffers,
    context,
    epoch,
  )
  if (probe.outcome === 'retry') return insertSplitAt(snapshot, from - 1, text, epoch)
  if (probe.outcome === 'coalesce') {
    const buffers = extendTailChunk(snapshot.buffers, text)
    const reverseIndexRoot = applyReverseIndexChanges(
      snapshot.reverseIndexRoot,
      [probe.coalesced!],
      buffers.prioritySeed,
      epoch,
    )
    return createSnapshotWithIndex(buffers, left, reverseIndexRoot, false)
  }

  return finishInsert(snapshot, left, right, text, context, epoch)
}

const insertDirect = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  text: string,
  snap: boolean,
  epoch: number,
): PieceTableTreeSnapshot => {
  const probe: InsertProbe = { text, snap, leftTurns: [], outcome: 'split', coalesced: null }
  const context: InsertContext = {
    changes: [],
    normalizeOrders: false,
    probe,
    appendedBuffers: null,
  }
  const root = insertAtVisibleOffset(snapshot.root, from, snapshot.buffers, context, epoch)
  if (probe.outcome === 'retry') return insertDirect(snapshot, from - 1, text, false, epoch)

  const coalesced = probe.outcome === 'coalesce'
  const buffers = coalesced ? extendTailChunk(snapshot.buffers, text) : context.appendedBuffers!
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    coalesced ? [probe.coalesced!] : context.changes,
    buffers.prioritySeed,
    epoch,
  )
  return createSnapshotWithIndex(buffers, root, reverseIndexRoot, context.normalizeOrders)
}

const insertSplitAt = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  text: string,
  epoch: number,
): PieceTableTreeSnapshot => {
  const probe: InsertProbe = {
    text,
    snap: false,
    leftTurns: [],
    outcome: 'split',
    coalesced: null,
  }
  const context: SplitContext = { changes: [], normalizeOrders: false, probe }
  const { left, right } = splitByVisibleOffset(
    snapshot.root,
    from,
    snapshot.buffers,
    context,
    epoch,
  )
  if (probe.outcome === 'coalesce') {
    const buffers = extendTailChunk(snapshot.buffers, text)
    const reverseIndexRoot = applyReverseIndexChanges(
      snapshot.reverseIndexRoot,
      [probe.coalesced!],
      buffers.prioritySeed,
      epoch,
    )
    return createSnapshotWithIndex(buffers, left, reverseIndexRoot, false)
  }
  return finishInsert(snapshot, left, right, text, context, epoch)
}

const finishInsert = (
  snapshot: PieceTableTreeSnapshot,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
  text: string,
  context: SplitContext,
  epoch: number,
): PieceTableTreeSnapshot => {
  const leftOrder = left ? getSubtreeMaxOrder(left) : null
  const rightOrder = right ? getSubtreeMinOrder(right) : null
  const appended = appendChunksToBuffers(snapshot.buffers, text)
  const ordered = assignPieceOrders(appended.pieces, leftOrder, rightOrder)
  const insertionTree = createTreeFromPieces(ordered.pieces, epoch)
  const merged = merge(merge(left, insertionTree, epoch), right, epoch)
  for (const piece of ordered.pieces) context.changes.push(piece)
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    context.changes,
    appended.buffers.prioritySeed,
    epoch,
  )

  return createSnapshotWithIndex(
    appended.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders || ordered.normalizeOrders,
  )
}

export const deleteFromPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  length: number,
): PieceTableTreeSnapshot => {
  if (length <= 0) return snapshot

  const snapped = snapEditRange(snapshot, { from: offset, to: offset + length, text: '' })
  return deleteRange(snapshot, snapped.from, snapped.to)
}

const deleteRange = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  to: number,
): PieceTableTreeSnapshot => {
  if (to <= from) return snapshot

  const epoch = editingEpoch(snapshot)
  const context: SplitContext = { changes: [], normalizeOrders: false }
  if (EDITS === 'direct') {
    const root = hideVisibleRange(snapshot.root, from, to, snapshot.buffers, context, epoch)
    const index = applyReverseIndexChanges(
      snapshot.reverseIndexRoot,
      context.changes,
      snapshot.buffers.prioritySeed,
      epoch,
    )
    return createSnapshotWithIndex(snapshot.buffers, root, index, context.normalizeOrders)
  }
  const { left, right } = splitByVisibleOffset(
    snapshot.root,
    from,
    snapshot.buffers,
    context,
    epoch,
  )
  const { left: deleted, right: tail } = splitByVisibleOffset(
    right,
    to - from,
    snapshot.buffers,
    context,
    epoch,
  )
  const invisible = markTreeInvisible(deleted, context.changes, epoch)
  const merged = merge(merge(left, invisible, epoch), tail, epoch)
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    context.changes,
    snapshot.buffers.prioritySeed,
    epoch,
  )
  return createSnapshotWithIndex(
    snapshot.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders,
  )
}

export const applyBatchToPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): PieceTableTreeSnapshot => {
  if (edits.length === 0) return snapshot
  if (edits.length === 1) return applyEdit(snapshot, snapEditRange(snapshot, edits[0]!))

  // Snapped once, against this snapshot. Re-snapping per edit as the tree
  // changes underneath would measure offsets against a document that no longer
  // matches the ones the caller asked about.
  const applied = snapBatchEditRanges(snapshot, edits)

  let next = snapshot
  for (const edit of applied.toSorted(compareEditsDescending)) next = applyEdit(next, edit)
  return next
}

const applyEdit = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
): PieceTableTreeSnapshot => {
  const deleted = deleteRange(snapshot, edit.from, edit.to)
  if (edit.text.length === 0) return deleted
  return insertTextAt(deleted, edit.from, edit.text, false)
}
