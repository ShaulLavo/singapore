import type { Piece } from './pieceTableTypes'

export const DEFAULT_PIECE_TABLE_PRIORITY_SEED = 0

type PriorityKind = 'piece' | 'reverse-index'

const HASH_BASIS = 0x811c9dc5 | 0
const UINT32_RANGE = 0x100000000
const KIND_WORD: Record<PriorityKind, number> = { piece: 0, 'reverse-index': 1 }

// One MurmurHash3 round per word. Everything stays a signed 32-bit integer so
// V8 keeps it a Smi: an unsigned word above 2^31 would be boxed on every return.
const mixWord = (hash: number, word: number): number => {
  let key = Math.imul(word, 0xcc9e2d51)
  key = (key << 15) | (key >>> 17)
  key = Math.imul(key, 0x1b873593)
  let next = hash ^ key
  next = (next << 13) | (next >>> 19)
  return (Math.imul(next, 5) + 0xe6546b64) | 0
}

// Orders are doubles: a split allocates fractions between two neighbours, so
// the integer part alone would hash both halves of a busy gap the same. Most
// orders are still small integers, and those never touch float arithmetic.
const mixNumber = (hash: number, value: number): number => {
  if ((value | 0) === value) return mixWord(mixWord(mixWord(hash, value), value < 0 ? -1 : 0), 0)
  if (!Number.isFinite(value)) return mixWord(mixWord(mixWord(hash, 0), 0), 0)

  const whole = Math.trunc(value)
  const low = whole | 0
  const high = Math.floor(whole / UINT32_RANGE) | 0
  const fraction = ((value - whole) * UINT32_RANGE) | 0
  return mixWord(mixWord(mixWord(hash, low), high), fraction)
}

const avalanche = (hash: number): number => {
  let next = hash ^ (hash >>> 16)
  next = Math.imul(next, 0x85ebca6b)
  next ^= next >>> 13
  next = Math.imul(next, 0xc2b2ae35)
  return next ^ (next >>> 16)
}

// A signed 32-bit integer: only the order between priorities matters, and an
// integer compares as a Smi where a fraction would be a boxed double.
export const priorityForPiece = (
  piece: Piece,
  seed = DEFAULT_PIECE_TABLE_PRIORITY_SEED,
  kind: PriorityKind = 'piece',
): number => {
  let hash = mixNumber(HASH_BASIS, seed)
  hash = mixWord(hash, KIND_WORD[kind])
  hash = mixWord(hash, piece.buffer)
  hash = mixWord(hash, piece.start)
  hash = mixWord(hash, piece.length)
  hash = mixNumber(hash, piece.order)
  hash = mixWord(hash, piece.visible ? 1 : 0)
  return avalanche(hash)
}
