import type {
  Piece,
  PieceBufferId,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
} from './pieceTableTypes'
import { flattenNodes } from './tree'
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

const cloneReverseIndexNode = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => ({
  buffer: node.buffer,
  start: node.start,
  piece: node.piece,
  order: node.order,
  priority: node.priority,
  left: node.left,
  right: node.right,
})

const createReverseIndexNode = (piece: Piece, prioritySeed = 0): PieceTableReverseIndexNode => ({
  buffer: piece.buffer,
  start: piece.start,
  piece,
  order: piece.order,
  priority: priorityForPiece(piece, prioritySeed, 'reverse-index'),
  left: null,
  right: null,
})

const rotateReverseRight = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.left!)
  const newRight = cloneReverseIndexNode(node)
  newRight.left = pivot.right
  pivot.right = newRight
  return pivot
}

const rotateReverseLeft = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.right!)
  const newLeft = cloneReverseIndexNode(node)
  newLeft.right = pivot.left
  pivot.left = newLeft
  return pivot
}

const insertReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  piece: Piece,
  prioritySeed = 0,
): PieceTableReverseIndexNode => {
  if (!root) return createReverseIndexNode(piece, prioritySeed)

  const comparison = compareReverseKeys(piece.buffer, piece.start, root.buffer, root.start)

  if (comparison < 0) {
    const next = cloneReverseIndexNode(root)
    next.left = insertReverseIndexNode(next.left, piece, prioritySeed)
    return next.left.priority < next.priority ? rotateReverseRight(next) : next
  }

  if (comparison > 0) {
    const next = cloneReverseIndexNode(root)
    next.right = insertReverseIndexNode(next.right, piece, prioritySeed)
    return next.right.priority < next.priority ? rotateReverseLeft(next) : next
  }

  return {
    ...root,
    piece,
    order: piece.order,
  }
}

// Every entry is keyed by (buffer, start), and no edit ever moves a piece off
// its key: a split's left half, a tombstone and a coalesced tail all keep it.
// Writing is therefore insert-or-replace, and the index never deletes.
export const applyReverseIndexChanges = (
  root: PieceTableReverseIndexNode | null,
  pieces: readonly Piece[],
  prioritySeed = 0,
): PieceTableReverseIndexNode | null => {
  let next = root

  for (const piece of pieces) {
    if (piece.length === 0) continue
    next = insertReverseIndexNode(next, piece, prioritySeed)
  }

  return next
}

export const buildReverseIndex = (
  root: PieceTableTreeSnapshot['root'],
  prioritySeed = 0,
): PieceTableReverseIndexNode | null => {
  let indexRoot: PieceTableReverseIndexNode | null = null
  const nodes = flattenNodes(root, [])

  for (const node of nodes) {
    if (node.piece.length === 0) continue
    indexRoot = insertReverseIndexNode(indexRoot, node.piece, prioritySeed)
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
