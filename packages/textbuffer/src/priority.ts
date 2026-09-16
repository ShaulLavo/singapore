import type { Piece } from './pieceTableTypes'

export const DEFAULT_PIECE_TABLE_PRIORITY_SEED = 0

type PriorityKind = 'piece' | 'reverse-index'

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const UINT32_RANGE = 0x100000000

const mixString = (hash: number, text: string): number => {
  let next = hash >>> 0

  for (let index = 0; index < text.length; index += 1) {
    next ^= text.charCodeAt(index)
    next = Math.imul(next, FNV_PRIME) >>> 0
  }

  return next
}

const mixNumber = (hash: number, value: number): number => {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0
  return mixString(hash, normalized.toString(36))
}

const avalanche = (hash: number): number => {
  let next = hash >>> 0
  next ^= next >>> 16
  next = Math.imul(next, 0x85ebca6b) >>> 0
  next ^= next >>> 13
  next = Math.imul(next, 0xc2b2ae35) >>> 0
  next ^= next >>> 16
  return next >>> 0
}

export const priorityForPiece = (
  piece: Piece,
  seed = DEFAULT_PIECE_TABLE_PRIORITY_SEED,
  kind: PriorityKind = 'piece',
): number => {
  let hash = mixNumber(FNV_OFFSET_BASIS, seed)
  hash = mixString(hash, kind)
  hash = mixString(hash, piece.buffer)
  hash = mixNumber(hash, piece.start)
  hash = mixNumber(hash, piece.length)
  hash = mixNumber(hash, piece.order)
  hash = mixString(hash, piece.visible ? 'visible' : 'hidden')
  return avalanche(hash) / UINT32_RANGE
}
