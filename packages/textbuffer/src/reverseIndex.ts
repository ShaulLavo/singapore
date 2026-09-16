import type {
  Piece,
  PieceBufferId,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
} from './pieceTableTypes'
import { flattenNodes, PERSISTENT_EPOCH } from './tree'
import { priorityForPiece } from './priority'

export const compareReverseKeys = (
  leftBuffer: PieceBufferId,
  leftStart: number,
  rightBuffer: PieceBufferId,
  rightStart: number,
): number => {
  if (leftBuffer !== rightBuffer) return leftBuffer - rightBuffer
  return leftStart - rightStart
}

const cloneReverseIndexNode = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => ({
  buffer: node.buffer,
  start: node.start,
  piece: node.piece,
  order: node.order,
  priority: node.priority,
  epoch,
  left: node.left,
  right: node.right,
})

const ownReverseIndexNode = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => (node.epoch === epoch ? node : cloneReverseIndexNode(node, epoch))

const createReverseIndexNode = (
  piece: Piece,
  prioritySeed: number,
  epoch: number,
): PieceTableReverseIndexNode => ({
  buffer: piece.buffer,
  start: piece.start,
  piece,
  order: piece.order,
  priority: priorityForPiece(piece, prioritySeed, 'reverse-index'),
  epoch,
  left: null,
  right: null,
})

const rotateReverseRight = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => {
  const pivot = ownReverseIndexNode(node.left!, epoch)
  const newRight = ownReverseIndexNode(node, epoch)
  newRight.left = pivot.right
  pivot.right = newRight
  return pivot
}

const rotateReverseLeft = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => {
  const pivot = ownReverseIndexNode(node.right!, epoch)
  const newLeft = ownReverseIndexNode(node, epoch)
  newLeft.right = pivot.left
  pivot.left = newLeft
  return pivot
}

const insertReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  piece: Piece,
  prioritySeed: number,
  epoch: number,
): PieceTableReverseIndexNode => {
  if (!root) return createReverseIndexNode(piece, prioritySeed, epoch)

  const comparison = compareReverseKeys(piece.buffer, piece.start, root.buffer, root.start)

  if (comparison < 0) {
    const next = ownReverseIndexNode(root, epoch)
    next.left = insertReverseIndexNode(next.left, piece, prioritySeed, epoch)
    return next.left.priority < next.priority ? rotateReverseRight(next, epoch) : next
  }

  if (comparison > 0) {
    const next = ownReverseIndexNode(root, epoch)
    next.right = insertReverseIndexNode(next.right, piece, prioritySeed, epoch)
    return next.right.priority < next.priority ? rotateReverseLeft(next, epoch) : next
  }

  const replaced = ownReverseIndexNode(root, epoch)
  replaced.piece = piece
  replaced.order = piece.order
  return replaced
}

// Every entry is keyed by (buffer, start), and no edit ever moves a piece off
// its key: a split's left half, a tombstone and a coalesced tail all keep it.
// Writing is therefore insert-or-replace, and the index never deletes.
export const applyReverseIndexChanges = (
  root: PieceTableReverseIndexNode | null,
  pieces: readonly Piece[],
  prioritySeed = 0,
  epoch = PERSISTENT_EPOCH,
): PieceTableReverseIndexNode | null => {
  let next = root

  for (const piece of pieces) {
    if (piece.length === 0) continue
    next = insertReverseIndexNode(next, piece, prioritySeed, epoch)
  }

  return next
}

export const buildReverseIndex = (
  root: PieceTableTreeSnapshot['root'],
  prioritySeed = 0,
  epoch = PERSISTENT_EPOCH,
): PieceTableReverseIndexNode | null => {
  let indexRoot: PieceTableReverseIndexNode | null = null
  const nodes = flattenNodes(root, [])

  for (const node of nodes) {
    if (node.piece.length === 0) continue
    indexRoot = insertReverseIndexNode(indexRoot, node.piece, prioritySeed, epoch)
  }

  return indexRoot
}

export const reversePredecessor = (
  root: PieceTableReverseIndexNode | null,
  buffer: PieceBufferId,
  offset: number,
  strict: boolean,
): PieceTableReverseIndexNode | null => {
  let node = root
  let candidate: PieceTableReverseIndexNode | null = null

  while (node) {
    const comparison = compareReverseKeys(node.buffer, node.start, buffer, offset)
    const accepts = strict ? comparison < 0 : comparison <= 0

    if (accepts) {
      candidate = node
      node = node.right
      continue
    }

    node = node.left
  }

  if (candidate?.buffer === buffer) return candidate
  return null
}

export const coversAnchorOffset = (piece: Piece, offset: number): boolean =>
  offset >= piece.start && offset <= piece.start + piece.length

export const lookupReverseIndex = (
  snapshot: PieceTableTreeSnapshot,
  anchor: { buffer: PieceBufferId; offset: number; bias: 'left' | 'right' },
): PieceTableReverseIndexNode | null => {
  const strict = anchor.bias === 'left' && anchor.offset > 0
  const preferred = reversePredecessor(
    snapshot.reverseIndexRoot,
    anchor.buffer,
    anchor.offset,
    strict,
  )

  if (preferred && coversAnchorOffset(preferred.piece, anchor.offset)) return preferred

  const fallback = reversePredecessor(
    snapshot.reverseIndexRoot,
    anchor.buffer,
    anchor.offset,
    false,
  )
  if (fallback && coversAnchorOffset(fallback.piece, anchor.offset)) return fallback

  return null
}

export const reverseSuccessor = (
  root: PieceTableReverseIndexNode | null,
  buffer: PieceBufferId,
  offset: number,
): PieceTableReverseIndexNode | null => {
  let node = root
  let candidate: PieceTableReverseIndexNode | null = null

  while (node) {
    const comparison = compareReverseKeys(node.buffer, node.start, buffer, offset)

    if (comparison >= 0) {
      candidate = node
      node = node.left
      continue
    }

    node = node.right
  }

  if (candidate?.buffer === buffer) return candidate
  return null
}
