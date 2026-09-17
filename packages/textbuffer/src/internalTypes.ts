import type { Piece, PieceTableBuffers, PieceTreeNode } from './pieceTableTypes'

// An insert's landing answers two questions so the insert descends once:
// whether the offset cuts a surrogate pair, in which case it moves one unit
// left (or asks for a retry when the pair straddles two pieces), and whether
// the text can extend the piece ending there instead of adding one.
export type InsertProbe = {
  readonly text: string
  readonly snap: boolean
  // Nodes the descent turned left at, innermost last: the in-order successor
  // of a landing with no right subtree is the nearest visible one of these.
  readonly leftTurns: PieceTreeNode[]
  outcome: 'insert' | 'coalesce' | 'retry'
}

// Pieces the edit gave a new reverse-index key: inserted text and the later
// parts of a cut. A cut's first part, a tombstone and a coalesced tail keep
// their key and order, which is all an entry holds.
export type EditContext = {
  changes: Piece[]
  normalizeOrders: boolean
}

// A one-descent insert makes its pieces at the landing, so the buffers that
// hold their text come back through the context.
export type InsertContext = EditContext & {
  probe: InsertProbe
  appendedBuffers: PieceTableBuffers | null
}
