import type { PieceTreeNode } from './pieceTableTypes'
import { ALPHA, BALANCE } from './bakeoff'
import { own, summarize } from './node'

// Join-based balancing after Blelloch, Ferizovic and Sun, "Just Join for
// Parallel Ordered Sets". `join(left, middle, right)` is the only function
// that knows the balance rule; split, merge and insert are derived from it.

const heightOf = (node: PieceTreeNode | null): number => (node ? node.height : 0)
const weightOf = (node: PieceTreeNode | null): number => (node ? node.subtreePieces + 1 : 1)

const link = (
  middle: PieceTreeNode,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): PieceTreeNode => {
  middle.left = left
  middle.right = right
  return summarize(middle)
}

// Both rotations take an owned node and own the pivot they lift.
const rotateLeft = (node: PieceTreeNode, epoch: number): PieceTreeNode => {
  const pivot = own(node.right!, epoch)
  node.right = pivot.left
  summarize(node)
  pivot.left = node
  return summarize(pivot)
}

const rotateRight = (node: PieceTreeNode, epoch: number): PieceTreeNode => {
  const pivot = own(node.left!, epoch)
  node.left = pivot.right
  summarize(node)
  pivot.right = node
  return summarize(pivot)
}

const joinRightAvl = (
  left: PieceTreeNode,
  middle: PieceTreeNode,
  right: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode => {
  const top = own(left, epoch)
  const inner = top.right
  if (heightOf(inner) > heightOf(right) + 1) {
    top.right = joinRightAvl(inner!, middle, right, epoch)
    if (top.right.height <= heightOf(top.left) + 1) return summarize(top)
    return rotateLeft(top, epoch)
  }

  link(middle, inner, right)
  if (middle.height <= heightOf(top.left) + 1) {
    top.right = middle
    return summarize(top)
  }
  top.right = rotateRight(middle, epoch)
  return rotateLeft(top, epoch)
}

const joinLeftAvl = (
  left: PieceTreeNode | null,
  middle: PieceTreeNode,
  right: PieceTreeNode,
  epoch: number,
): PieceTreeNode => {
  const top = own(right, epoch)
  const inner = top.left
  if (heightOf(inner) > heightOf(left) + 1) {
    top.left = joinLeftAvl(left, middle, inner!, epoch)
    if (top.left.height <= heightOf(top.right) + 1) return summarize(top)
    return rotateRight(top, epoch)
  }

  link(middle, left, inner)
  if (middle.height <= heightOf(top.right) + 1) {
    top.left = middle
    return summarize(top)
  }
  top.left = rotateLeft(middle, epoch)
  return rotateRight(top, epoch)
}

const joinAvl = (
  left: PieceTreeNode | null,
  middle: PieceTreeNode,
  right: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode => {
  const difference = heightOf(left) - heightOf(right)
  if (difference > 1) return joinRightAvl(left!, middle, right, epoch)
  if (difference < -1) return joinLeftAvl(left, middle, right!, epoch)
  return link(middle, left, right)
}

const weightsBalance = (left: number, right: number): boolean => {
  const floor = ALPHA * (left + right)
  return left >= floor && right >= floor
}

const joinRightWeight = (
  left: PieceTreeNode,
  middle: PieceTreeNode,
  right: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode => {
  if (weightsBalance(weightOf(left), weightOf(right))) return link(middle, left, right)

  const top = own(left, epoch)
  const joined = top.right
    ? joinRightWeight(top.right, middle, right, epoch)
    : link(middle, null, right)
  top.right = joined
  const outer = weightOf(top.left)
  if (weightsBalance(outer, weightOf(joined))) return summarize(top)

  const single =
    weightsBalance(outer, weightOf(joined.left)) &&
    weightsBalance(outer + weightOf(joined.left), weightOf(joined.right))
  if (!single) top.right = rotateRight(own(joined, epoch), epoch)
  return rotateLeft(top, epoch)
}

const joinLeftWeight = (
  left: PieceTreeNode | null,
  middle: PieceTreeNode,
  right: PieceTreeNode,
  epoch: number,
): PieceTreeNode => {
  if (weightsBalance(weightOf(left), weightOf(right))) return link(middle, left, right)

  const top = own(right, epoch)
  const joined = top.left ? joinLeftWeight(left, middle, top.left, epoch) : link(middle, left, null)
  top.left = joined
  const outer = weightOf(top.right)
  if (weightsBalance(weightOf(joined), outer)) return summarize(top)

  const single =
    weightsBalance(weightOf(joined.right), outer) &&
    weightsBalance(weightOf(joined.left), weightOf(joined.right) + outer)
  if (!single) top.left = rotateLeft(own(joined, epoch), epoch)
  return rotateRight(top, epoch)
}

const joinWeight = (
  left: PieceTreeNode | null,
  middle: PieceTreeNode,
  right: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode => {
  const leftWeight = weightOf(left)
  const rightWeight = weightOf(right)
  if (weightsBalance(leftWeight, rightWeight)) return link(middle, left, right)
  if (leftWeight > rightWeight) return joinRightWeight(left!, middle, right, epoch)
  return joinLeftWeight(left, middle, right!, epoch)
}

// `middle` must be owned by the caller: a fresh node or the result of `own`.
export const join: (
  left: PieceTreeNode | null,
  middle: PieceTreeNode,
  right: PieceTreeNode | null,
  epoch: number,
) => PieceTreeNode = BALANCE === 'wb' ? joinWeight : joinAvl

let removedLast: PieceTreeNode | null = null

const removeLast = (node: PieceTreeNode, epoch: number): PieceTreeNode | null => {
  const top = own(node, epoch)
  if (!top.right) {
    removedLast = top
    return top.left
  }
  return join(top.left, top, removeLast(top.right, epoch), epoch)
}

export const join2 = (
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode | null => {
  if (!left) return right
  if (!right) return left
  const rest = removeLast(left, epoch)
  return join(rest, removedLast!, right, epoch)
}

export const balanceHolds = (node: PieceTreeNode): boolean => {
  if (BALANCE === 'wb') return weightsBalance(weightOf(node.left), weightOf(node.right))
  return Math.abs(heightOf(node.left) - heightOf(node.right)) <= 1
}
