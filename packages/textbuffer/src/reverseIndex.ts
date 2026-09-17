import type {
  Piece,
  PieceBufferId,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
} from './pieceTableTypes'
import { flattenNodes } from './tree'
import { PERSISTENT_EPOCH } from './node'

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
  leftHeight: node.leftHeight,
  rightHeight: node.rightHeight,
  epoch,
  left: node.left,
  right: node.right,
})

const ownReverseIndexNode = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => (node.epoch === epoch ? node : cloneReverseIndexNode(node, epoch))

// A node carries its children's heights rather than its own, so a rebalance
// reads only nodes already on the insert's path. Reading a sibling for its
// height would load a node the insert otherwise never touches, once a level.
export const reverseHeight = (node: PieceTableReverseIndexNode | null): number => {
  if (!node) return 0
  return (node.leftHeight > node.rightHeight ? node.leftHeight : node.rightHeight) + 1
}

const createReverseIndexNode = (
  piece: Piece,
  epoch: number,
  left: PieceTableReverseIndexNode | null = null,
  right: PieceTableReverseIndexNode | null = null,
): PieceTableReverseIndexNode => ({
  buffer: piece.buffer,
  start: piece.start,
  piece,
  order: piece.order,
  leftHeight: reverseHeight(left),
  rightHeight: reverseHeight(right),
  epoch,
  left,
  right,
})

// Both rotations take an owned node and own the pivot they lift.
const rotateReverseRight = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => {
  const pivot = ownReverseIndexNode(node.left!, epoch)
  node.left = pivot.right
  node.leftHeight = pivot.rightHeight
  pivot.right = node
  pivot.rightHeight = reverseHeight(node)
  return pivot
}

const rotateReverseLeft = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => {
  const pivot = ownReverseIndexNode(node.right!, epoch)
  node.right = pivot.left
  node.rightHeight = pivot.leftHeight
  pivot.left = node
  pivot.leftHeight = reverseHeight(node)
  return pivot
}

// AVL repair of an owned node one of whose subtrees grew by at most one level.
const rebalanceReverse = (
  node: PieceTableReverseIndexNode,
  epoch: number,
): PieceTableReverseIndexNode => {
  const lean = node.leftHeight - node.rightHeight
  if (lean > 1) {
    const left = node.left!
    if (left.rightHeight > left.leftHeight) {
      node.left = rotateReverseLeft(ownReverseIndexNode(left, epoch), epoch)
    }
    return rotateReverseRight(node, epoch)
  }
  if (lean < -1) {
    const right = node.right!
    if (right.leftHeight > right.rightHeight) {
      node.right = rotateReverseRight(ownReverseIndexNode(right, epoch), epoch)
    }
    return rotateReverseLeft(node, epoch)
  }
  return node
}

const insertReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  piece: Piece,
  epoch: number,
): PieceTableReverseIndexNode => {
  if (!root) return createReverseIndexNode(piece, epoch)

  const comparison = compareReverseKeys(piece.buffer, piece.start, root.buffer, root.start)
  if (comparison === 0) {
    const replaced = ownReverseIndexNode(root, epoch)
    replaced.piece = piece
    replaced.order = piece.order
    return replaced
  }

  const next = ownReverseIndexNode(root, epoch)
  if (comparison < 0) {
    next.left = insertReverseIndexNode(next.left, piece, epoch)
    next.leftHeight = reverseHeight(next.left)
  } else {
    next.right = insertReverseIndexNode(next.right, piece, epoch)
    next.rightHeight = reverseHeight(next.right)
  }
  return rebalanceReverse(next, epoch)
}

// Every entry is keyed by (buffer, start), and no edit ever moves a piece off
// its key: a split's left half, a tombstone and a coalesced tail all keep it.
// Writing is therefore insert-or-replace, and the index never deletes.
export const applyReverseIndexChanges = (
  root: PieceTableReverseIndexNode | null,
  pieces: readonly Piece[],
  epoch = PERSISTENT_EPOCH,
): PieceTableReverseIndexNode | null => {
  let next = root

  for (const piece of pieces) {
    if (piece.length === 0) continue
    next = insertReverseIndexNode(next, piece, epoch)
  }

  return next
}

// Relabelling orders moves no key, so the index keeps its shape and only
// swaps pieces. Returns undefined when an entry's piece is not in the map,
// which sends the caller to a full rebuild.
export const relabelReverseIndex = (
  node: PieceTableReverseIndexNode | null,
  relabeled: ReadonlyMap<Piece, Piece>,
  epoch: number,
): PieceTableReverseIndexNode | null | undefined => {
  if (!node) return null
  const piece = relabeled.get(node.piece)
  if (!piece) return undefined
  const left = relabelReverseIndex(node.left, relabeled, epoch)
  if (left === undefined) return undefined
  const right = relabelReverseIndex(node.right, relabeled, epoch)
  if (right === undefined) return undefined

  const next = ownReverseIndexNode(node, epoch)
  next.piece = piece
  next.order = piece.order
  next.left = left
  next.right = right
  return next
}

const buildBalancedReverse = (
  pieces: readonly Piece[],
  from: number,
  to: number,
  epoch: number,
): PieceTableReverseIndexNode | null => {
  if (from >= to) return null
  const middle = (from + to) >>> 1
  return createReverseIndexNode(
    pieces[middle]!,
    epoch,
    buildBalancedReverse(pieces, from, middle, epoch),
    buildBalancedReverse(pieces, middle + 1, to, epoch),
  )
}

export const buildReverseIndex = (
  root: PieceTableTreeSnapshot['root'],
  epoch = PERSISTENT_EPOCH,
): PieceTableReverseIndexNode | null => {
  const pieces = flattenNodes(root, [])
    .map((node) => node.piece)
    .filter((piece) => piece.length > 0)
    .sort((left, right) => compareReverseKeys(left.buffer, left.start, right.buffer, right.start))
  return buildBalancedReverse(pieces, 0, pieces.length, epoch)
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
