import type { Piece, PieceTreeNode } from './pieceTableTypes'

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
  height: node.height,
  epoch,
  subtreeLength: node.subtreeLength,
  subtreeVisibleLength: node.subtreeVisibleLength,
  subtreePieces: node.subtreePieces,
  subtreeLineBreaks: node.subtreeLineBreaks,
  subtreeMinOrder: node.subtreeMinOrder,
  subtreeMaxOrder: node.subtreeMaxOrder,
})

export const own = (node: PieceTreeNode, epoch: number): PieceTreeNode =>
  node.epoch === epoch ? node : cloneNode(node, epoch)

// One pass over the two children for the height and all six summaries. This
// runs on every node an edit touches, so the children are read once each and
// the bounds are compared inline rather than through Math.min.
export const summarize = (node: PieceTreeNode): PieceTreeNode => {
  const piece = node.piece
  const left = node.left
  const right = node.right
  let height = 0
  let length = piece.length
  let visible = piece.visible ? piece.length : 0
  let lineBreaks = piece.visible ? piece.lineBreaks : 0
  let pieces = 1
  let minOrder = piece.order
  let maxOrder = piece.order
  if (left) {
    height = left.height
    length += left.subtreeLength
    visible += left.subtreeVisibleLength
    lineBreaks += left.subtreeLineBreaks
    pieces += left.subtreePieces
    if (left.subtreeMinOrder < minOrder) minOrder = left.subtreeMinOrder
    if (left.subtreeMaxOrder > maxOrder) maxOrder = left.subtreeMaxOrder
  }
  if (right) {
    if (right.height > height) height = right.height
    length += right.subtreeLength
    visible += right.subtreeVisibleLength
    lineBreaks += right.subtreeLineBreaks
    pieces += right.subtreePieces
    if (right.subtreeMinOrder < minOrder) minOrder = right.subtreeMinOrder
    if (right.subtreeMaxOrder > maxOrder) maxOrder = right.subtreeMaxOrder
  }
  node.height = height + 1
  node.subtreeLength = length
  node.subtreeVisibleLength = visible
  node.subtreePieces = pieces
  node.subtreeLineBreaks = lineBreaks
  node.subtreeMinOrder = minOrder
  node.subtreeMaxOrder = maxOrder
  return node
}

export const createNode = (
  piece: Piece,
  left: PieceTreeNode | null = null,
  right: PieceTreeNode | null = null,
  epoch = PERSISTENT_EPOCH,
): PieceTreeNode =>
  summarize({
    piece,
    left,
    right,
    height: 1,
    epoch,
    subtreeLength: 0,
    subtreeVisibleLength: 0,
    subtreePieces: 0,
    subtreeLineBreaks: 0,
    subtreeMinOrder: 0,
    subtreeMaxOrder: 0,
  })
