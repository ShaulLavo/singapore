import type { Piece, PieceTableBuffers, PieceTreeNode } from './pieceTableTypes'

// An insert's split answers two questions on the way down so the insert
// descends once: whether the offset splits a surrogate pair, in which case
// the split moves one unit left (or asks for a retry when the pair straddles
// two pieces), and whether the text can extend the piece ending there, in
// which case the split replaces that piece instead and returns the new root
// as `left`.
export type InsertProbe = {
  readonly text: string
  readonly snap: boolean
  // Nodes the descent turned left at, innermost last: the in-order successor
  // of a landing with no right subtree is the nearest visible one of these.
  readonly leftTurns: PieceTreeNode[]
  outcome: 'split' | 'coalesce' | 'retry'
  coalesced: Piece | null
}

// Pieces whose reverse-index entry must be written after the edit. A split's
// left half keeps the original key, so writing it replaces the old entry in
// place and no removal is ever needed.
export type SplitContext = {
  changes: Piece[]
  normalizeOrders: boolean
  probe?: InsertProbe
}

// A one-descent insert makes its pieces at the landing, so the buffers that
// hold their text come back through the context.
export type InsertContext = SplitContext & {
  probe: InsertProbe
  appendedBuffers: PieceTableBuffers | null
}
