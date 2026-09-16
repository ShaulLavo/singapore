import type { DocumentLineEnding } from './lineEndings'

declare const pieceBufferIdBrand: unique symbol

// The sequence number of one contiguous span of inserted text (or the original
// text, id 0). Several ids can share a chunk string once inserts fill it, but
// an id never spans two chunks, so `(buffer, start)` stays an insertion
// identity. A number, not a string, so the hot paths never parse or hash text.
export type PieceBufferId = number & {
  readonly [pieceBufferIdBrand]: true
}

export type Point = {
  readonly row: number
  readonly column: number
}

export type AnchorBias = 'left' | 'right'

export type AnchorLiveness = 'live' | 'deleted'

export type RealAnchor = {
  readonly kind: 'anchor'
  readonly buffer: PieceBufferId
  readonly offset: number
  readonly bias: AnchorBias
}

type SentinelAnchor = { kind: 'min' } | { kind: 'max' }

export type Anchor = RealAnchor | SentinelAnchor

export type ResolvedAnchor = {
  readonly offset: number
  readonly liveness: AnchorLiveness
}

export type Piece = {
  readonly buffer: PieceBufferId
  readonly start: number
  readonly length: number
  readonly order: number
  readonly lineBreaks: number
  readonly visible: boolean
}

export type PieceTableBuffers = {
  // Shared across this document lineage, including divergent persistent versions.
  // Hosts can key WeakMap sidecars by this identity without putting UI caches in storage.
  readonly identity: object
  readonly original: PieceBufferId
  readonly chunks: PieceBufferChunks
  readonly nextBufferSequence: number
  readonly prioritySeed: number
  // Stored text is always LF-only; these record what the document arrived with
  // so a host can round-trip it on save. See pieceTable/lineEndings.ts.
  readonly lineEnding: DocumentLineEnding
  readonly byteOrderMark: string
  // Ingestion folded U+2028/U+2029 into real line breaks, so the document is no
  // longer byte-identical to the one the host handed us. Recorded rather than
  // acted on: the fold is not reversible, and only the host can decide whether
  // a warning is owed. See pieceTable/lineEndings.ts.
  readonly containsUnusualLineTerminators: boolean
  // One index per chunk string, keyed by chunk sequence and shared by every
  // snapshot on the same log. Original-piece counting builds chunk 0's index;
  // append indexes remain lazy.
  readonly lineIndexes: Map<number, PieceBufferLineIndex>
}

export type PieceBufferLineIndex = {
  // Grown by doubling, so `offsets.length` is capacity and `count` is the only
  // safe bound to read or search within.
  offsets: Uint32Array
  count: number
  scannedLength: number
  // The chunk string as scanned, `scannedLength` long. The inspector checks the
  // offsets against it; the store itself trusts the log's append-only contract.
  text: string
}

// Read view of a snapshot's chunk store: `size` counts chunk strings, `get`
// resolves a buffer id to the chunk text it lives in.
export type PieceBufferChunks = {
  readonly size: number
  get(buffer: PieceBufferId): string | undefined
  keys(): IterableIterator<PieceBufferId>
  [Symbol.iterator](): IterableIterator<[PieceBufferId, string]>
}

export type PieceTreeNode = {
  piece: Piece
  left: PieceTreeNode | null
  right: PieceTreeNode | null
  priority: number
  subtreeLength: number
  subtreeVisibleLength: number
  subtreePieces: number
  subtreeLineBreaks: number
  subtreeMinOrder: number
  subtreeMaxOrder: number
}

export type PieceTableReverseIndexNode = {
  buffer: PieceBufferId
  start: number
  piece: Piece
  order: number
  priority: number
  left: PieceTableReverseIndexNode | null
  right: PieceTableReverseIndexNode | null
}

export type PieceTableTreeSnapshot = {
  readonly buffers: PieceTableBuffers
  readonly root: PieceTreeNode | null
  readonly reverseIndexRoot: PieceTableReverseIndexNode | null
  readonly length: number
  readonly pieceCount: number
}

export type PieceTableEdit = {
  readonly from: number
  readonly to: number
  readonly text: string
}

export type PieceTableSnapshot = PieceTableTreeSnapshot
