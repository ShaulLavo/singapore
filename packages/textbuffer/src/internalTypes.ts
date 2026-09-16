import type { Piece } from './pieceTableTypes'

// Pieces whose reverse-index entry must be written after the edit. A split's
// left half keeps the original key, so writing it replaces the old entry in
// place and no removal is ever needed.
export type SplitContext = {
  changes: Piece[]
  normalizeOrders: boolean
}
