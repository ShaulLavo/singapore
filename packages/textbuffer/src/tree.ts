import type { Piece, PieceTableBuffers, PieceTreeNode } from './pieceTableTypes'
import type { EditContext, InsertContext, InsertProbe } from './internalTypes'
import {
  appendChunksToBuffers,
  BUFFER_CHUNK_SIZE,
  bufferForPiece,
  bufferUnitAt,
  countBufferLineBreaks,
  countLineBreaks,
  getBufferText,
  isNewestBuffer,
} from './buffers'
import { isHighSurrogate, isLowSurrogate } from './surrogates'
import {
  allocateOrderBetween,
  assignPieceOrders,
  PIECE_ORDER_MIN_GAP,
  PIECE_ORDER_STEP,
} from './orders'
import { join } from './join'
import {
  createNode,
  getPieceVisibleLength,
  getSubtreeMaxOrder,
  getSubtreeMinOrder,
  getSubtreeVisibleLength,
  own,
  PERSISTENT_EPOCH,
  summarize,
} from './node'

// The piece extended by the probe's text, or null when it cannot take it:
// only the newest buffer's piece, ending at its chunk's end, with room left.
const coalescedPiece = (
  buffers: PieceTableBuffers,
  piece: Piece,
  probe: InsertProbe,
): Piece | null => {
  if (piece.buffer === buffers.original) return null
  if (!isNewestBuffer(buffers, piece.buffer)) return null
  const chunkText = getBufferText(buffers, piece.buffer)
  if (piece.start + piece.length !== chunkText.length) return null
  if (chunkText.length + probe.text.length > BUFFER_CHUNK_SIZE) return null
  return {
    ...piece,
    length: piece.length + probe.text.length,
    lineBreaks: piece.lineBreaks + countLineBreaks(probe.text),
  }
}

// The collapsed-edit rule of snapEditToCodePoints: inserting between the
// halves of a pair moves before it unless the text starts with a low half
// and ends with a high one, so that both cuts are mended.
const insertSplitsPair = (before: number, after: number, probe: InsertProbe): boolean => {
  if (!isLowSurrogate(after) || !isHighSurrogate(before)) return false
  const text = probe.text
  return !isLowSurrogate(text.charCodeAt(0)) || !isHighSurrogate(text.charCodeAt(text.length - 1))
}

const firstUnitOf = (piece: Piece, buffers: PieceTableBuffers): number =>
  bufferUnitAt(buffers, piece.buffer, piece.start)

const lastUnitOf = (piece: Piece, buffers: PieceTableBuffers): number =>
  bufferUnitAt(buffers, piece.buffer, piece.start + piece.length - 1)

const firstVisibleUnit = (node: PieceTreeNode | null, buffers: PieceTableBuffers): number => {
  const location = findVisiblePieceStartingAt(node, 0)
  return location ? firstUnitOf(location.piece, buffers) : -1
}

// The first visible unit after a landing: in its right subtree, else in the
// nearest ancestor the descent turned left at, or that ancestor's right side.
const successorUnit = (
  right: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  probe: InsertProbe,
): number => {
  const below = firstVisibleUnit(right, buffers)
  if (below >= 0) return below
  for (let index = probe.leftTurns.length - 1; index >= 0; index -= 1) {
    const ancestor = probe.leftTurns[index]!
    if (getPieceVisibleLength(ancestor.piece) > 0) return firstUnitOf(ancestor.piece, buffers)
    const beside = firstVisibleUnit(ancestor.right, buffers)
    if (beside >= 0) return beside
  }
  return -1
}

// Each landing probe returns a finished subtree, or null to insert here.
// Landing with the offset at this node's start (or on a tombstone): the piece
// ending here, if any, is the rightmost visible one in the left subtree.
const probeAtStart = (
  node: PieceTreeNode,
  offset: number,
  buffers: PieceTableBuffers,
  epoch: number,
  probe: InsertProbe,
): PieceTreeNode | null => {
  const ending = findVisiblePieceEndingAt(node.left, offset)
  if (probe.snap && ending) {
    // The unit after first: the one before may be the tail's last unit.
    const after =
      getPieceVisibleLength(node.piece) > 0
        ? firstUnitOf(node.piece, buffers)
        : successorUnit(node.right, buffers, probe)
    if (
      isLowSurrogate(after) &&
      insertSplitsPair(lastUnitOf(ending.piece, buffers), after, probe)
    ) {
      probe.outcome = 'retry'
      return node
    }
  }

  const tail = ending ? coalescedPiece(buffers, ending.piece, probe) : null
  if (!tail) return null

  probe.outcome = 'coalesce'
  probe.coalesced = tail
  const next = own(node, epoch)
  next.left = replacePieceEndingAt(next.left, offset, tail, epoch)
  return summarize(next)
}

// Landing with the offset at this node's end: this piece is the one ending here.
const probeAtEnd = (
  node: PieceTreeNode,
  buffers: PieceTableBuffers,
  epoch: number,
  probe: InsertProbe,
): PieceTreeNode | null => {
  if (probe.snap) {
    const after = successorUnit(node.right, buffers, probe)
    if (isLowSurrogate(after) && insertSplitsPair(lastUnitOf(node.piece, buffers), after, probe)) {
      probe.outcome = 'retry'
      return node
    }
  }

  const tail = coalescedPiece(buffers, node.piece, probe)
  if (!tail) return null

  probe.outcome = 'coalesce'
  probe.coalesced = tail
  const next = own(node, epoch)
  next.piece = tail
  return summarize(next)
}

// Landing strictly inside this piece: both units are in its chunk, and a
// pair split moves the offset one unit left within the same piece.
const probeInside = (
  node: PieceTreeNode,
  localOffset: number,
  buffers: PieceTableBuffers,
  probe: InsertProbe,
): number => {
  if (!probe.snap) return localOffset
  const at = node.piece.start + localOffset
  const after = bufferUnitAt(buffers, node.piece.buffer, at)
  if (!isLowSurrogate(after)) return localOffset
  const before = bufferUnitAt(buffers, node.piece.buffer, at - 1)
  return insertSplitsPair(before, after, probe) ? localOffset - 1 : localOffset
}

// What a landing's probe decided: a finished subtree (a coalesce, or the
// node untouched with the outcome set to retry), or the offset to cut at.
const probeLanding = (
  node: PieceTreeNode,
  offset: number,
  leftLen: number,
  nodeLen: number,
  buffers: PieceTableBuffers,
  epoch: number,
  probe: InsertProbe,
): PieceTreeNode | number => {
  if (nodeLen === 0 || offset === leftLen) {
    const probed = probeAtStart(node, offset, buffers, epoch, probe)
    if (probed) return probed
  }
  if (nodeLen > 0 && offset === leftLen + nodeLen) {
    const probed = probeAtEnd(node, buffers, epoch, probe)
    if (probed) return probed
  }
  if (nodeLen > 0 && offset > leftLen && offset < leftLen + nodeLen) {
    return leftLen + probeInside(node, offset - leftLen, buffers, probe)
  }
  return offset
}

// The right-hand piece of a cut, ordered between the piece it came from and
// whatever follows it. The piece already knows its total line breaks, so one
// count for the left half gives both.
const orderAfter = (order: number, upper: number | null, context: EditContext): number => {
  const allocated = allocateOrderBetween(order, upper)
  context.normalizeOrders ||= allocated === null
  return allocated ?? order + PIECE_ORDER_MIN_GAP
}

const slicePiece = (
  piece: Piece,
  from: number,
  to: number,
  order: number,
  lineBreaks: number,
  visible: boolean,
): Piece => ({
  buffer: piece.buffer,
  start: piece.start + from,
  length: to - from,
  order,
  lineBreaks,
  visible,
})

const appendRun = (
  tree: PieceTreeNode | null,
  pieces: readonly Piece[],
  epoch: number,
): PieceTreeNode | null => {
  let next = tree
  for (const piece of pieces) next = join(next, createNode(piece, null, null, epoch), null, epoch)
  return next
}

const prependRun = (
  pieces: readonly Piece[],
  tree: PieceTreeNode | null,
  epoch: number,
): PieceTreeNode | null => {
  let next = tree
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    next = join(null, createNode(pieces[index]!, null, null, epoch), next, epoch)
  }
  return next
}

// The pieces for an insert's text, made once the landing rules out a
// coalesce, ordered between the landing's neighbours.
const piecesForInsert = (
  buffers: PieceTableBuffers,
  context: InsertContext,
  lower: number | null,
  upper: number | null,
): readonly Piece[] => {
  const appended = appendChunksToBuffers(buffers, context.probe.text)
  const ordered = assignPieceOrders(appended.pieces, lower, upper)
  context.appendedBuffers = appended.buffers
  context.normalizeOrders ||= ordered.normalizeOrders
  return ordered.pieces
}

const finite = (order: number): number | null => (Number.isFinite(order) ? order : null)

// Insert in one descent: no split and no merge. The landing places the new
// pieces beside or inside its piece and every ancestor rejoins once, which
// rebalances in constant work per level.
export const insertAtVisibleOffset = (
  node: PieceTreeNode | null,
  offset: number,
  buffers: PieceTableBuffers,
  context: InsertContext,
  epoch: number,
  lowerOrder: number | null = null,
  upperOrder: number | null = null,
): PieceTreeNode | null => {
  if (!node) {
    const pieces = piecesForInsert(buffers, context, lowerOrder, upperOrder)
    for (const piece of pieces) context.changes.push(piece)
    return appendRun(null, pieces, epoch)
  }

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)

  if (offset < leftLen) {
    context.probe.leftTurns.push(node)
    const left = insertAtVisibleOffset(
      node.left,
      offset,
      buffers,
      context,
      epoch,
      lowerOrder,
      node.piece.order,
    )
    return rejoinAfterInsert(node, 'left', left, context.probe, epoch)
  }

  if (offset > leftLen + nodeLen) {
    const right = insertAtVisibleOffset(
      node.right,
      offset - leftLen - nodeLen,
      buffers,
      context,
      epoch,
      node.piece.order,
      upperOrder,
    )
    return rejoinAfterInsert(node, 'right', right, context.probe, epoch)
  }

  const probed = probeLanding(node, offset, leftLen, nodeLen, buffers, epoch, context.probe)
  if (typeof probed !== 'number') return probed
  return insertAtLanding(node, probed - leftLen, nodeLen, buffers, context, epoch, [
    lowerOrder,
    upperOrder,
  ])
}

const rejoinAfterInsert = (
  node: PieceTreeNode,
  side: 'left' | 'right',
  subtree: PieceTreeNode | null,
  probe: InsertProbe,
  epoch: number,
): PieceTreeNode => {
  if (probe.outcome === 'retry') return node
  const next = own(node, epoch)
  if (probe.outcome === 'coalesce') {
    next[side] = subtree
    return summarize(next)
  }
  if (side === 'left') return join(subtree, next, next.right, epoch)
  return join(next.left, next, subtree, epoch)
}

const insertAtLanding = (
  node: PieceTreeNode,
  localOffset: number,
  nodeLen: number,
  buffers: PieceTableBuffers,
  context: InsertContext,
  epoch: number,
  bounds: readonly [number | null, number | null],
): PieceTreeNode => {
  const next = own(node, epoch)
  const piece = next.piece
  const before = nodeLen > 0 && localOffset === 0

  if (before) {
    const lower = next.left ? finite(getSubtreeMaxOrder(next.left)) : bounds[0]
    const pieces = piecesForInsert(buffers, context, lower, piece.order)
    for (const added of pieces) context.changes.push(added)
    return join(appendRun(next.left, pieces, epoch), next, next.right, epoch)
  }

  const upper = next.right ? finite(getSubtreeMinOrder(next.right)) : bounds[1]
  if (nodeLen === 0 || localOffset === nodeLen) {
    const pieces = piecesForInsert(buffers, context, piece.order, upper)
    for (const added of pieces) context.changes.push(added)
    return join(next.left, next, prependRun(pieces, next.right, epoch), epoch)
  }

  const leftLineBreaks = countBufferLineBreaks(
    buffers,
    piece.buffer,
    piece.start,
    piece.start + localOffset,
  )
  const leftPiece = slicePiece(piece, 0, localOffset, piece.order, leftLineBreaks, piece.visible)
  const rightPiece = slicePiece(
    piece,
    localOffset,
    nodeLen,
    orderAfter(piece.order, upper, context),
    piece.lineBreaks - leftLineBreaks,
    piece.visible,
  )
  const pieces = piecesForInsert(buffers, context, piece.order, rightPiece.order)
  next.piece = leftPiece
  context.changes.push(leftPiece, rightPiece)
  for (const added of pieces) context.changes.push(added)
  const right = prependRun(pieces, prependRun([rightPiece], next.right, epoch), epoch)
  return join(next.left, next, right, epoch)
}

const hideTree = (
  node: PieceTreeNode | null,
  changes: Piece[],
  epoch: number,
): PieceTreeNode | null => {
  if (!node || node.subtreeVisibleLength === 0) return node

  const next = own(node, epoch)
  next.left = hideTree(next.left, changes, epoch)
  next.right = hideTree(next.right, changes, epoch)
  if (next.piece.visible) {
    next.piece = { ...next.piece, visible: false }
    changes.push(next.piece)
  }
  return summarize(next)
}

// Hides [from, to) of an owned node's visible piece. The node keeps the first
// part, so its reverse-index key stands; later parts become its successors.
const hidePieceRange = (
  next: PieceTreeNode,
  from: number,
  to: number,
  right: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  context: EditContext,
  epoch: number,
  upperOrder: number | null,
): PieceTreeNode | null => {
  const piece = next.piece
  const length = piece.length
  if (from === 0 && to === length) {
    next.piece = { ...piece, visible: false }
    context.changes.push(next.piece)
    return right
  }

  const upper = right ? finite(getSubtreeMinOrder(right)) : upperOrder
  const count = (start: number, end: number): number =>
    countBufferLineBreaks(buffers, piece.buffer, piece.start + start, piece.start + end)
  const tail: Piece[] = []
  if (from === 0) {
    const hidden = slicePiece(piece, 0, to, piece.order, count(0, to), false)
    next.piece = hidden
    tail.push(
      slicePiece(
        piece,
        to,
        length,
        orderAfter(piece.order, upper, context),
        piece.lineBreaks - hidden.lineBreaks,
        true,
      ),
    )
  } else {
    const kept = slicePiece(piece, 0, from, piece.order, count(0, from), true)
    const hiddenOrder = orderAfter(piece.order, upper, context)
    const hiddenBreaks = to === length ? piece.lineBreaks - kept.lineBreaks : count(from, to)
    next.piece = kept
    tail.push(slicePiece(piece, from, to, hiddenOrder, hiddenBreaks, false))
    if (to < length) {
      tail.push(
        slicePiece(
          piece,
          to,
          length,
          orderAfter(hiddenOrder, upper, context),
          piece.lineBreaks - kept.lineBreaks - hiddenBreaks,
          true,
        ),
      )
    }
  }

  context.changes.push(next.piece)
  for (const added of tail) context.changes.push(added)
  return prependRun(tail, right, epoch)
}

// Delete in one descent: tombstone the visible range [from, to) in place,
// cutting only the pieces its two ends fall inside.
export const hideVisibleRange = (
  node: PieceTreeNode | null,
  from: number,
  to: number,
  buffers: PieceTableBuffers,
  context: EditContext,
  epoch: number,
  upperOrder: number | null = null,
): PieceTreeNode | null => {
  if (!node || from >= to) return node
  if (from <= 0 && to >= node.subtreeVisibleLength) return hideTree(node, context.changes, epoch)

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeEnd = leftLen + getPieceVisibleLength(node.piece)
  const next = own(node, epoch)
  let left = next.left
  let right = next.right
  if (from < leftLen) {
    left = hideVisibleRange(
      left,
      from,
      Math.min(to, leftLen),
      buffers,
      context,
      epoch,
      node.piece.order,
    )
  }
  if (to > nodeEnd) {
    right = hideVisibleRange(
      right,
      Math.max(from - nodeEnd, 0),
      to - nodeEnd,
      buffers,
      context,
      epoch,
      upperOrder,
    )
  }

  const cutFrom = Math.max(from, leftLen) - leftLen
  const cutTo = Math.min(to, nodeEnd) - leftLen
  if (cutFrom < cutTo) {
    right = hidePieceRange(next, cutFrom, cutTo, right, buffers, context, epoch, upperOrder)
  }
  return join(left, next, right, epoch)
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
    return summarize(next)
  }

  if (nodeLen > 0 && offset === nodeEnd) {
    const next = own(node, epoch)
    next.piece = newPiece
    return summarize(next)
  }

  const right = replacePieceEndingAt(node.right, offset, newPiece, epoch, nodeEnd)
  if (right === null) return node

  const next = own(node, epoch)
  next.right = right
  return summarize(next)
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
  return summarize(next)
}
