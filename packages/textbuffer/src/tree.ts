import type { Piece, PieceTableBuffers, PieceTreeNode } from './pieceTableTypes'
import type { SplitContext } from './internalTypes'
import { bufferForPiece, countBufferLineBreaks } from './buffers'
import { allocateOrderBetween, PIECE_ORDER_MIN_GAP, PIECE_ORDER_STEP } from './orders'
import { priorityForPiece } from './priority'

const getSubtreeLength = (node: PieceTreeNode | null): number => (node ? node.subtreeLength : 0)

export const getSubtreeVisibleLength = (node: PieceTreeNode | null): number =>
  node ? node.subtreeVisibleLength : 0

export const getSubtreePieces = (node: PieceTreeNode | null): number =>
  node ? node.subtreePieces : 0

export const getSubtreeLineBreaks = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLineBreaks : 0

export const getSubtreeMinOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMinOrder : Number.POSITIVE_INFINITY

export const getSubtreeMaxOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMaxOrder : Number.NEGATIVE_INFINITY

export const getPieceVisibleLength = (piece: Piece): number => (piece.visible ? piece.length : 0)

export const getPieceVisibleLineBreaks = (piece: Piece): number =>
  piece.visible ? piece.lineBreaks : 0

// NaN never equals itself, so a caller without a lineage clones every node it
// touches and stamps the copies unownable. That is plain path copying.
export const PERSISTENT_EPOCH = Number.NaN

const cloneNode = (node: PieceTreeNode, epoch: number): PieceTreeNode => ({
  piece: node.piece,
  left: node.left,
  right: node.right,
  priority: node.priority,
  epoch,
  subtreeLength: node.subtreeLength,
  subtreeVisibleLength: node.subtreeVisibleLength,
  subtreePieces: node.subtreePieces,
  subtreeLineBreaks: node.subtreeLineBreaks,
  subtreeMinOrder: node.subtreeMinOrder,
  subtreeMaxOrder: node.subtreeMaxOrder,
})

const own = (node: PieceTreeNode, epoch: number): PieceTreeNode =>
  node.epoch === epoch ? node : cloneNode(node, epoch)

const computeSubtreeLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => piece.length + getSubtreeLength(left) + getSubtreeLength(right)

const computeSubtreeVisibleLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLength(piece) + getSubtreeVisibleLength(left) + getSubtreeVisibleLength(right)

const computeSubtreePieces = (left: PieceTreeNode | null, right: PieceTreeNode | null): number =>
  1 + getSubtreePieces(left) + getSubtreePieces(right)

const computeSubtreeLineBreaks = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLineBreaks(piece) + getSubtreeLineBreaks(left) + getSubtreeLineBreaks(right)

const computeSubtreeMinOrder = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => Math.min(piece.order, getSubtreeMinOrder(left), getSubtreeMinOrder(right))

const computeSubtreeMaxOrder = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => Math.max(piece.order, getSubtreeMaxOrder(left), getSubtreeMaxOrder(right))

export const createNode = (
  piece: Piece,
  left: PieceTreeNode | null = null,
  right: PieceTreeNode | null = null,
  priority = priorityForPiece(piece),
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode => ({
  piece,
  left,
  right,
  priority,
  epoch,
  subtreeLength: computeSubtreeLength(piece, left, right),
  subtreeVisibleLength: computeSubtreeVisibleLength(piece, left, right),
  subtreePieces: computeSubtreePieces(left, right),
  subtreeLineBreaks: computeSubtreeLineBreaks(piece, left, right),
  subtreeMinOrder: computeSubtreeMinOrder(piece, left, right),
  subtreeMaxOrder: computeSubtreeMaxOrder(piece, left, right),
})

const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return node
  node.subtreeLength = computeSubtreeLength(node.piece, node.left, node.right)
  node.subtreeVisibleLength = computeSubtreeVisibleLength(node.piece, node.left, node.right)
  node.subtreePieces = computeSubtreePieces(node.left, node.right)
  node.subtreeLineBreaks = computeSubtreeLineBreaks(node.piece, node.left, node.right)
  node.subtreeMinOrder = computeSubtreeMinOrder(node.piece, node.left, node.right)
  node.subtreeMaxOrder = computeSubtreeMaxOrder(node.piece, node.left, node.right)
  return node
}

export const merge = (
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode | null => {
  if (!left) return right
  if (!right) return left

  if (left.priority < right.priority) {
    const newLeft = own(left, epoch)
    newLeft.right = merge(newLeft.right, right, epoch)
    return updateNode(newLeft)
  }

  const newRight = own(right, epoch)
  newRight.left = merge(left, newRight.left, epoch)
  return updateNode(newRight)
}

export const splitByVisibleOffset = (
  node: PieceTreeNode | null,
  offset: number,
  buffers: PieceTableBuffers,
  context: SplitContext,
  epoch = PERSISTENT_EPOCH,
  upperOrder: number | null = null,
): { left: PieceTreeNode | null; right: PieceTreeNode | null } => {
  if (!node) return { left: null, right: null }

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)

  if (offset < leftLen) {
    const newNode = own(node, epoch)
    const { left, right } = splitByVisibleOffset(
      newNode.left,
      offset,
      buffers,
      context,
      epoch,
      node.piece.order,
    )
    newNode.left = right
    if (!right || right.priority >= newNode.priority) return { left, right: updateNode(newNode) }
    // A fresh split priority can move the remainder above this ancestor.
    newNode.left = null
    return { left, right: merge(right, updateNode(newNode), epoch) }
  }

  if (offset > leftLen + nodeLen) {
    const newNode = own(node, epoch)
    const { left, right } = splitByVisibleOffset(
      newNode.right,
      offset - leftLen - nodeLen,
      buffers,
      context,
      epoch,
      upperOrder,
    )
    newNode.right = left
    if (!left || left.priority >= newNode.priority) return { left: updateNode(newNode), right }
    newNode.right = null
    return { left: merge(updateNode(newNode), left, epoch), right }
  }

  if (nodeLen === 0) {
    const newNode = own(node, epoch)
    const rightTree = newNode.right
    newNode.right = null
    return { left: updateNode(newNode), right: rightTree }
  }

  if (offset === leftLen) {
    const newNode = own(node, epoch)
    const leftTree = newNode.left
    newNode.left = null
    return { left: leftTree, right: updateNode(newNode) }
  }

  if (offset === leftLen + nodeLen) {
    const newNode = own(node, epoch)
    const rightTree = newNode.right
    newNode.right = null
    return { left: updateNode(newNode), right: rightTree }
  }

  const localOffset = offset - leftLen
  const rightUpperOrder = node.right ? getSubtreeMinOrder(node.right) : upperOrder
  const allocated = allocateOrderBetween(node.piece.order, rightUpperOrder)
  const rightOrder = allocated ?? node.piece.order + PIECE_ORDER_MIN_GAP
  context.normalizeOrders ||= allocated === null
  // The piece already knows its total; one count for the left half gives both.
  const piece = node.piece
  const leftLineBreaks = countBufferLineBreaks(
    buffers,
    piece.buffer,
    piece.start,
    piece.start + localOffset,
  )
  const leftPiece: Piece = {
    buffer: piece.buffer,
    start: piece.start,
    length: localOffset,
    order: piece.order,
    lineBreaks: leftLineBreaks,
    visible: piece.visible,
  }
  const rightPiece: Piece = {
    buffer: piece.buffer,
    start: piece.start + localOffset,
    length: nodeLen - localOffset,
    order: rightOrder,
    lineBreaks: piece.lineBreaks - leftLineBreaks,
    visible: piece.visible,
  }

  const prioritySeed = buffers.prioritySeed
  const leftNode = createNode(
    leftPiece,
    null,
    null,
    priorityForPiece(leftPiece, prioritySeed),
    epoch,
  )
  const rightNode = createNode(
    rightPiece,
    null,
    null,
    priorityForPiece(rightPiece, prioritySeed),
    epoch,
  )
  const leftTree = merge(node.left, leftNode, epoch)
  const rightTree = merge(rightNode, node.right, epoch)

  context.changes.push(leftNode.piece, rightNode.piece)

  return { left: leftTree, right: rightTree }
}

export const createTreeFromPieces = (
  pieces: readonly Piece[],
  prioritySeed = 0,
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode | null => {
  let tree: PieceTreeNode | null = null

  for (const piece of pieces) {
    const node = createNode(piece, null, null, priorityForPiece(piece, prioritySeed), epoch)
    tree = merge(tree, node, epoch)
  }

  return tree
}

export const collectTextInRange = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  start: number,
  end: number,
  acc: string[],
  baseOffset = 0,
) => {
  if (!node || baseOffset >= end) return

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (start < nodeStart) collectTextInRange(node.left, buffers, start, end, acc, baseOffset)

  if (node.piece.visible && nodeEnd > start && nodeStart < end) {
    const pieceStart = Math.max(0, start - nodeStart)
    const pieceEnd = Math.min(node.piece.length, end - nodeStart)
    if (pieceEnd > pieceStart) {
      const buf = bufferForPiece(buffers, node.piece)
      acc.push(buf.slice(node.piece.start + pieceStart, node.piece.start + pieceEnd))
    }
  }

  if (end > nodeEnd) collectTextInRange(node.right, buffers, start, end, acc, nodeEnd)
}

export const forEachTextInRange = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  start: number,
  end: number,
  visit: (text: string, start: number, end: number, buffer: Piece['buffer']) => void,
  baseOffset = 0,
) => {
  if (!node || baseOffset >= end) return

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (start < nodeStart) forEachTextInRange(node.left, buffers, start, end, visit, baseOffset)

  if (node.piece.visible && nodeEnd > start && nodeStart < end) {
    const pieceStart = Math.max(0, start - nodeStart)
    const pieceEnd = Math.min(node.piece.length, end - nodeStart)
    if (pieceEnd > pieceStart) {
      const buffer = bufferForPiece(buffers, node.piece)
      visit(buffer, node.piece.start + pieceStart, node.piece.start + pieceEnd, node.piece.buffer)
    }
  }

  if (end > nodeEnd) forEachTextInRange(node.right, buffers, start, end, visit, nodeEnd)
}

export const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
  if (!node) return acc
  flattenPieces(node.left, acc)
  acc.push({ ...node.piece })
  flattenPieces(node.right, acc)
  return acc
}

export type AnchorLocation = {
  piece: Piece
  visibleStart: number
}

export const findVisiblePieceEndingAt = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (offset <= nodeStart) return findVisiblePieceEndingAt(node.left, offset, baseOffset)
  if (nodeLen > 0 && offset === nodeEnd) return { piece: node.piece, visibleStart: nodeStart }

  return findVisiblePieceEndingAt(node.right, offset, nodeEnd)
}

// An owned child comes back as the same object, so identity cannot mean
// unchanged; only a null child means the piece was not on that side.
export const replacePieceEndingAt = (
  node: PieceTreeNode | null,
  offset: number,
  newPiece: Piece,
  epoch = PERSISTENT_EPOCH,
  baseOffset = 0,
): PieceTreeNode | null => {
  if (!node) return null

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (offset <= nodeStart) {
    const left = replacePieceEndingAt(node.left, offset, newPiece, epoch, baseOffset)
    if (left === null) return node

    const next = own(node, epoch)
    next.left = left
    return updateNode(next)
  }

  if (nodeLen > 0 && offset === nodeEnd) {
    const next = own(node, epoch)
    next.piece = newPiece
    return updateNode(next)
  }

  const right = replacePieceEndingAt(node.right, offset, newPiece, epoch, nodeEnd)
  if (right === null) return node

  const next = own(node, epoch)
  next.right = right
  return updateNode(next)
}

export const findVisiblePieceStartingAt = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (offset < nodeStart) return findVisiblePieceStartingAt(node.left, offset, baseOffset)
  if (nodeLen > 0 && offset === nodeStart) return { piece: node.piece, visibleStart: nodeStart }

  return findVisiblePieceStartingAt(node.right, offset, nodeEnd)
}

export const findVisiblePieceContainingOffset = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeStart = baseOffset + leftLen
  const nodeEnd = nodeStart + nodeLen

  if (offset < nodeStart) return findVisiblePieceContainingOffset(node.left, offset, baseOffset)
  if (nodeLen > 0 && offset > nodeStart && offset < nodeEnd) {
    return { piece: node.piece, visibleStart: nodeStart }
  }

  return findVisiblePieceContainingOffset(node.right, offset, nodeEnd)
}

export const flattenNodes = (node: PieceTreeNode | null, acc: PieceTreeNode[]): PieceTreeNode[] => {
  if (!node) return acc
  flattenNodes(node.left, acc)
  acc.push(node)
  flattenNodes(node.right, acc)
  return acc
}

export const markTreeInvisible = (
  node: PieceTreeNode | null,
  changes: Piece[],
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode | null => {
  if (!node) return null

  const next = own(node, epoch)
  next.left = markTreeInvisible(next.left, changes, epoch)
  next.right = markTreeInvisible(next.right, changes, epoch)
  next.piece = {
    ...next.piece,
    visible: false,
  }
  changes.push(next.piece)

  return updateNode(next)
}

export const visiblePrefixBeforeOrder = (
  node: PieceTreeNode | null,
  order: number,
  baseOffset = 0,
): number | null => {
  if (!node) return null

  const leftLength = getSubtreeVisibleLength(node.left)
  const nodeStart = baseOffset + leftLength

  if (order === node.piece.order) return nodeStart
  if (order < node.piece.order) return visiblePrefixBeforeOrder(node.left, order, baseOffset)

  return visiblePrefixBeforeOrder(node.right, order, nodeStart + getPieceVisibleLength(node.piece))
}

export const visibleLengthBetweenOrders = (
  node: PieceTreeNode | null,
  lowExclusive: number,
  highExclusive: number,
): number => {
  if (!node || lowExclusive >= highExclusive) return 0
  if (getSubtreeMaxOrder(node) <= lowExclusive) return 0
  if (getSubtreeMinOrder(node) >= highExclusive) return 0

  if (getSubtreeMinOrder(node) > lowExclusive && getSubtreeMaxOrder(node) < highExclusive) {
    return getSubtreeVisibleLength(node)
  }

  const nodeLength =
    node.piece.order > lowExclusive && node.piece.order < highExclusive
      ? getPieceVisibleLength(node.piece)
      : 0

  return (
    visibleLengthBetweenOrders(node.left, lowExclusive, highExclusive) +
    nodeLength +
    visibleLengthBetweenOrders(node.right, lowExclusive, highExclusive)
  )
}

export const normalizePieceOrders = (
  node: PieceTreeNode | null,
  nextOrder: { value: number },
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode | null => {
  if (!node) return null

  const next = own(node, epoch)
  next.left = normalizePieceOrders(next.left, nextOrder, epoch)
  next.piece = {
    ...next.piece,
    order: nextOrder.value,
  }
  nextOrder.value += PIECE_ORDER_STEP
  next.right = normalizePieceOrders(next.right, nextOrder, epoch)
  return updateNode(next)
}
