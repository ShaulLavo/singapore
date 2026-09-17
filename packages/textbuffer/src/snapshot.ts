import type {
  Piece,
  PieceTableBuffers,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
} from './pieceTableTypes'
import { createInitialBuffers, createOriginalPiece, type PieceTableBufferOptions } from './buffers'
import { buildReverseIndex, relabelReverseIndex } from './reverseIndex'
import { normalizePieceOrders } from './tree'
import { createNode, getSubtreePieces, getSubtreeVisibleLength } from './node'
import { PIECE_ORDER_STEP } from './orders'
import { DEFAULT_DOCUMENT_LINE_ENDING, normalizeDocumentText } from './lineEndings'

export const createSnapshot = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
): PieceTableTreeSnapshot => ({
  buffers,
  root,
  reverseIndexRoot,
  length: getSubtreeVisibleLength(root),
  pieceCount: getSubtreePieces(root),
  epoch: buffers.lineage.epoch,
  consumed: false,
})

export const createSnapshotWithIndex = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
  normalizeOrders: boolean,
): PieceTableTreeSnapshot => {
  if (!normalizeOrders) return createSnapshot(buffers, root, reverseIndexRoot)

  const epoch = buffers.lineage.epoch
  const relabeled = new Map<Piece, Piece>()
  const normalizedRoot = normalizePieceOrders(root, { value: PIECE_ORDER_STEP }, epoch, relabeled)
  const index =
    relabelReverseIndex(reverseIndexRoot, relabeled, epoch) ??
    buildReverseIndex(normalizedRoot, epoch)
  return createSnapshot(buffers, normalizedRoot, index)
}

// Makes the snapshot persistent: nothing created before this call is ever
// mutated again. A snapshot older than the lineage epoch already is.
export const retainPieceTableSnapshot = <Snapshot extends PieceTableTreeSnapshot>(
  snapshot: Snapshot,
): Snapshot => {
  const lineage = snapshot.buffers.lineage
  if (snapshot.epoch === lineage.epoch) lineage.epoch += 1
  return snapshot
}

// The epoch an edit of this snapshot writes with. Auto-retain keeps today's
// behaviour: every edit clones its path. Otherwise a transient snapshot is
// consumed by the edit and a second edit of it would read mutated nodes.
export const editingEpoch = (snapshot: PieceTableTreeSnapshot): number => {
  const lineage = snapshot.buffers.lineage
  if (lineage.autoRetain) return retainPieceTableSnapshot(snapshot).buffers.lineage.epoch
  if (snapshot.consumed) throw new Error('piece table snapshot already edited in place')
  if (snapshot.epoch === lineage.epoch) snapshot.consumed = true
  return lineage.epoch
}

export type CreatePieceTableSnapshotOptions = PieceTableBufferOptions & {
  // Skip ingestion normalization when the caller already holds LF-only text
  // (snapshot round-trips, undo restores, worker-side reconstruction).
  readonly normalized?: boolean
}

export const createPieceTableSnapshot = (
  original: string,
  options: CreatePieceTableSnapshotOptions = {},
): PieceTableTreeSnapshot => {
  const ingested = options.normalized
    ? null
    : normalizeDocumentText(original, options.lineEnding ?? DEFAULT_DOCUMENT_LINE_ENDING)
  const buffers = createInitialBuffers(ingested ? ingested.text : original, {
    ...options,
    lineEnding: ingested ? ingested.lineEnding : options.lineEnding,
    byteOrderMark: ingested ? ingested.byteOrderMark : options.byteOrderMark,
    containsUnusualLineTerminators: ingested
      ? ingested.containsUnusualLineTerminators
      : options.containsUnusualLineTerminators,
  })
  const originalPiece = createOriginalPiece(buffers)
  const epoch = buffers.lineage.epoch
  const root = originalPiece ? createNode(originalPiece, null, null, epoch) : null
  return createSnapshot(buffers, root, buildReverseIndex(root, epoch))
}
