import type {
  Piece,
  PieceBufferChunks,
  PieceBufferId,
  PieceBufferLineIndex,
  PieceTableBuffers,
} from './pieceTableTypes'
import { PIECE_ORDER_STEP } from './orders'
import { DEFAULT_DOCUMENT_LINE_ENDING, type DocumentLineEnding } from './lineEndings'
import { recordTextBufferDiagnostic } from './diagnostics'

export const BUFFER_CHUNK_SIZE = 16 * 1024
const LINE_INDEX_MIN_CAPACITY = 64
const CARRIAGE_RETURN = 0x0d
const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

// One log per lineage. Only the snapshot whose extent matches the log exactly
// may append to it in place; every other snapshot reads through its own extent
// and forks the log before it writes. Chunk 0 is the original text and is
// never extended; inserted text fills the newest chunk before opening another.
type PieceBufferLog = {
  readonly chunks: string[]
  // Buffer id → chunk sequence. Several buffers share a chunk once inserts fill it.
  readonly chunkOfBuffer: number[]
  readonly lineIndexes: Map<number, PieceBufferLineIndex>
  // The tail chunk's last code unit. The tail is a fresh concatenation after
  // every keystroke and charCodeAt would flatten it; the insert probe reads
  // this unit on every keystroke, so it is remembered from the appended text.
  tailLastUnit: number
}

export type PieceBufferStoreExtent = {
  readonly chunkCount: number
  readonly bufferCount: number
  readonly tailLength: number
  readonly overflowingChunk: number | null
}

class PieceBufferChunkView implements PieceBufferChunks {
  public readonly [Symbol.toStringTag] = 'PieceBufferChunkView'

  public constructor(
    private readonly log: PieceBufferLog,
    public readonly size: number,
    public readonly tailLength: number,
    public readonly bufferCount: number,
  ) {}

  public static from(original: string): PieceBufferChunkView {
    const log = {
      chunks: [original],
      chunkOfBuffer: [0],
      lineIndexes: new Map(),
      tailLastUnit: original.charCodeAt(original.length - 1),
    }
    return new PieceBufferChunkView(log, 1, original.length, 1)
  }

  public get lineIndexes(): Map<number, PieceBufferLineIndex> {
    return this.log.lineIndexes
  }

  public chunkOf(buffer: PieceBufferId): number | undefined {
    return buffer < this.bufferCount ? this.log.chunkOfBuffer[buffer] : undefined
  }

  public chunkText(chunk: number): string {
    const text = this.log.chunks[chunk]!
    if (chunk !== this.size - 1 || text.length === this.tailLength) return text
    // A newer snapshot grew the tail after this one; the extent is the truth.
    return text.slice(0, this.tailLength)
  }

  public get(buffer: PieceBufferId): string | undefined {
    const chunk = this.chunkOf(buffer)
    return chunk === undefined ? undefined : this.chunkText(chunk)
  }

  // A code unit of a buffer's chunk without flattening the tail: the unit
  // this view's tail ends on is served from the log's record of it.
  public unitAt(buffer: PieceBufferId, index: number): number {
    const chunk = this.chunkOf(buffer)
    if (chunk === undefined) return -1
    const text = this.log.chunks[chunk]!
    // An older view's tail is not the log's once a newer view opened a chunk.
    if (
      chunk === this.log.chunks.length - 1 &&
      index === this.tailLength - 1 &&
      text.length === this.tailLength
    ) {
      return this.log.tailLastUnit
    }
    return text.charCodeAt(index)
  }

  public *entries(): IterableIterator<[PieceBufferId, string]> {
    for (let sequence = 0; sequence < this.bufferCount; sequence += 1) {
      const buffer = createBufferId(sequence)
      yield [buffer, this.get(buffer)!]
    }
  }

  public *keys(): IterableIterator<PieceBufferId> {
    for (const [key] of this.entries()) yield key
  }

  public [Symbol.iterator](): IterableIterator<[PieceBufferId, string]> {
    return this.entries()
  }

  public extent(): PieceBufferStoreExtent {
    let overflowingChunk: number | null = null
    for (let chunk = 1; chunk < this.size; chunk += 1) {
      if (this.chunkText(chunk).length <= BUFFER_CHUNK_SIZE) continue
      overflowingChunk = chunk
      break
    }
    return {
      chunkCount: this.size,
      bufferCount: this.bufferCount,
      tailLength: this.tailLength,
      overflowingChunk,
    }
  }

  // True only for the view that last wrote the log: a longer log means another
  // branch, or an undone one re-minting the same ids, appended after this view.
  public isCurrent(): boolean {
    const { chunks, chunkOfBuffer } = this.log
    return (
      chunks.length === this.size &&
      chunkOfBuffer.length === this.bufferCount &&
      chunks[this.size - 1]!.length === this.tailLength
    )
  }

  public fork(): PieceBufferChunkView {
    const chunks = this.log.chunks.slice(0, this.size)
    chunks[this.size - 1] = this.chunkText(this.size - 1)
    const lineIndexes = new Map<number, PieceBufferLineIndex>()
    for (const [chunk, index] of this.log.lineIndexes) {
      if (chunk >= this.size) continue
      lineIndexes.set(chunk, shareOrCopyLineIndex(index, chunks[chunk]!))
    }
    const log = {
      chunks,
      chunkOfBuffer: this.log.chunkOfBuffer.slice(0, this.bufferCount),
      lineIndexes,
      tailLastUnit: chunks[this.size - 1]!.charCodeAt(this.tailLength - 1),
    }
    return new PieceBufferChunkView(log, this.size, this.tailLength, this.bufferCount)
  }

  public extendTail(text: string): PieceBufferChunkView {
    this.log.chunks[this.size - 1] += text
    this.log.tailLastUnit = text.charCodeAt(text.length - 1)
    return new PieceBufferChunkView(
      this.log,
      this.size,
      this.tailLength + text.length,
      this.bufferCount,
    )
  }

  public fill(text: string): PieceBufferChunkView {
    this.log.chunks[this.size - 1] += text
    this.log.chunkOfBuffer.push(this.size - 1)
    this.log.tailLastUnit = text.charCodeAt(text.length - 1)
    return new PieceBufferChunkView(
      this.log,
      this.size,
      this.tailLength + text.length,
      this.bufferCount + 1,
    )
  }

  public open(text: string): PieceBufferChunkView {
    this.log.chunks.push(text)
    this.log.chunkOfBuffer.push(this.size)
    this.log.tailLastUnit = text.charCodeAt(text.length - 1)
    return new PieceBufferChunkView(this.log, this.size + 1, text.length, this.bufferCount + 1)
  }
}

// An index is shared across a fork only when nothing can grow it again: the
// chunk string is final in both logs and the index has scanned all of it.
// Anything else is copied, trimmed to what the forking view can see.
const shareOrCopyLineIndex = (index: PieceBufferLineIndex, text: string): PieceBufferLineIndex => {
  if (index.text === text && index.scannedLength === text.length) return index

  const count = firstLineBreakAtOrAfter(index, text.length)
  return {
    offsets: index.offsets.slice(0, count),
    count,
    scannedLength: Math.min(index.scannedLength, text.length),
    text: text.slice(0, Math.min(index.scannedLength, text.length)),
  }
}

export type PieceTableBufferOptions = {
  // Recorded, not applied: `original` is expected to already be LF-normalized
  // by the caller (see createPieceTableSnapshot).
  readonly lineEnding?: DocumentLineEnding
  readonly byteOrderMark?: string
  // For callers that ingested the text themselves: the folded text no longer
  // carries the evidence, so their own finding is the only source left.
  readonly containsUnusualLineTerminators?: boolean
  // Edits mutate in place between explicit retains instead of cloning every
  // path. The caller then owns the retain points; see retainPieceTableSnapshot.
  readonly transient?: boolean
}

export type AppendChunksToBuffersResult = {
  readonly buffers: PieceTableBuffers
  readonly pieces: readonly Piece[]
}

const createBufferId = (sequence: number): PieceBufferId => sequence as PieceBufferId

const storeOf = (chunks: PieceBufferChunks): PieceBufferChunkView => {
  if (chunks instanceof PieceBufferChunkView) return chunks
  throw new Error('piece buffer store expected')
}

const writableStore = (chunks: PieceBufferChunks): PieceBufferChunkView => {
  const store = storeOf(chunks)
  return store.isCurrent() ? store : store.fork()
}

const withStore = (
  buffers: PieceTableBuffers,
  chunks: PieceBufferChunkView,
  nextBufferSequence: number,
): PieceTableBuffers => ({
  ...buffers,
  chunks,
  lineIndexes: chunks.lineIndexes,
  nextBufferSequence,
})

export const bufferStoreExtent = (buffers: PieceTableBuffers): PieceBufferStoreExtent | null =>
  buffers.chunks instanceof PieceBufferChunkView ? buffers.chunks.extent() : null

export const chunkOfBuffer = (buffers: PieceTableBuffers, buffer: PieceBufferId): number => {
  const chunk = storeOf(buffers.chunks).chunkOf(buffer)
  if (chunk !== undefined) return chunk
  throw new Error('piece buffer not found')
}

export const isNewestBuffer = (buffers: PieceTableBuffers, buffer: PieceBufferId): boolean =>
  buffer === buffers.nextBufferSequence - 1

export const countLineBreaks = (text: string, start = 0, end = text.length): number => {
  let count = 0
  let index = text.indexOf('\n', start)

  while (index !== -1 && index < end) {
    count++
    index = text.indexOf('\n', index + 1)
  }

  return count
}

// One index per chunk string, shared by every snapshot on the log. A chunk only
// ever grows at its end, so an index scanned for a shorter version stays a
// valid prefix and a longer one serves shorter extents through clamping.
const bufferLineIndex = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  text: string,
): PieceBufferLineIndex => {
  const chunk = chunkOfBuffer(buffers, buffer)
  const indexes = buffers.lineIndexes
  let index = indexes.get(chunk)
  if (!index) {
    index = { offsets: new Uint32Array(0), count: 0, scannedLength: 0, text }
    indexes.set(chunk, index)
  }
  if (index.scannedLength < text.length) extendBufferLineIndex(index, text)

  return index
}

const extendBufferLineIndex = (index: PieceBufferLineIndex, text: string): void => {
  const scannedCodeUnits = text.length - index.scannedLength
  let at = text.indexOf('\n', index.scannedLength)
  while (at !== -1) {
    pushLineBreakOffset(index, at)
    at = text.indexOf('\n', at + 1)
  }

  index.scannedLength = text.length
  index.text = text
  recordTextBufferDiagnostic('sourceIndex', () => ({
    source: 'piece-buffer',
    sourceBytesRead: scannedCodeUnits * 2,
    scannedCodeUnits,
    retainedIndexBytes: index.offsets.byteLength,
  }))
}

// Four bytes per offset: a 5M-line document costs 20MB of index here, and the
// binary search above stays cache-local. Growth doubles so filling the index one
// break at a time stays linear overall. Offsets cannot overflow 32 bits — V8 caps
// strings near 2^29 code units — so the width needs no widening path.
const pushLineBreakOffset = (index: PieceBufferLineIndex, offset: number): void => {
  if (index.count === index.offsets.length) {
    const grown = new Uint32Array(Math.max(index.offsets.length * 2, LINE_INDEX_MIN_CAPACITY))
    grown.set(index.offsets)
    index.offsets = grown
  }

  index.offsets[index.count] = offset
  index.count += 1
}

const firstLineBreakAtOrAfter = (index: PieceBufferLineIndex, target: number): number => {
  const offsets = index.offsets
  let low = 0
  let high = index.count
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle]! < target) low = middle + 1
    else high = middle
  }

  return low
}

export const countBufferLineBreaks = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  end: number,
): number => {
  if (end <= start) return 0

  const text = getBufferText(buffers, buffer)
  const index = bufferLineIndex(buffers, buffer, text)
  return (
    firstLineBreakAtOrAfter(index, Math.min(end, text.length)) -
    firstLineBreakAtOrAfter(index, Math.min(start, text.length))
  )
}

// Absolute buffer offset of the ordinal-th (1-based) '\n' at or after start.
export const findBufferLineBreakOffset = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  ordinal: number,
): number | null => {
  const text = getBufferText(buffers, buffer)
  const index = bufferLineIndex(buffers, buffer, text)
  const at = firstLineBreakAtOrAfter(index, start) + ordinal - 1
  if (at >= index.count) return null
  const offset = index.offsets[at]!
  return offset < text.length ? offset : null
}

export const bufferUnitAt = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  index: number,
): number => storeOf(buffers.chunks).unitAt(buffer, index)

export const getBufferText = (buffers: PieceTableBuffers, buffer: PieceBufferId): string => {
  const text = buffers.chunks.get(buffer)
  if (text !== undefined) return text
  throw new Error('piece buffer not found')
}

export const createPiece = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  length: number,
  order: number,
  visible = true,
): Piece => {
  return {
    buffer,
    start,
    length,
    order,
    lineBreaks: countBufferLineBreaks(buffers, buffer, start, start + length),
    visible,
  }
}

export const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece): string =>
  getBufferText(buffers, piece.buffer)

// The walker rejoins code points across piece boundaries, but everything that
// reads a chunk directly (getBufferText and every slice taken from it) would
// see a lone surrogate or a stray CR if a split landed inside a pair. Hold the
// trailing unit back so it starts the next chunk instead. Holding one unit back
// from a full chunk always leaves room to advance; holding it back from a
// one-unit fill leaves nothing, and the caller opens a new chunk instead.
const chunkEndFor = (text: string, start: number, capacity: number): number => {
  const end = start + capacity
  if (end >= text.length) return text.length

  const last = text.charCodeAt(end - 1)
  const splitsPair =
    last === CARRIAGE_RETURN || (last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST)
  return splitsPair ? end - 1 : end
}

const createAppendedPiece = (sequence: number, start: number, text: string): Piece => ({
  buffer: createBufferId(sequence),
  start,
  length: text.length,
  order: 0,
  lineBreaks: countLineBreaks(text),
  visible: true,
})

// Each buffer id names one contiguous span of one chunk, so `(buffer, start)`
// stays the insertion identity the reverse index and anchors are keyed by.
// A fill that lands in the newest chunk and the chunks opened after it are
// therefore separate buffers even when they come from one insert.
export const appendChunksToBuffers = (
  buffers: PieceTableBuffers,
  text: string,
): AppendChunksToBuffersResult => {
  let store = writableStore(buffers.chunks)
  let nextBufferSequence = buffers.nextBufferSequence
  const pieces: Piece[] = []
  let offset = 0

  // Chunk 0 is the original text and never grows.
  const room = store.size > 1 ? BUFFER_CHUNK_SIZE - store.tailLength : 0
  const fillEnd = room > 0 ? chunkEndFor(text, 0, room) : 0
  if (fillEnd > 0) {
    const fill = text.slice(0, fillEnd)
    const previousLength = store.tailLength
    pieces.push(createAppendedPiece(nextBufferSequence, previousLength, fill))
    store = store.fill(fill)
    growTailLineIndex(store, previousLength, fill)
    nextBufferSequence += 1
    offset = fillEnd
  }

  while (offset < text.length) {
    const chunkText = text.slice(offset, chunkEndFor(text, offset, BUFFER_CHUNK_SIZE))
    pieces.push(createAppendedPiece(nextBufferSequence, 0, chunkText))
    store = store.open(chunkText)
    nextBufferSequence += 1
    offset += chunkText.length
  }

  return { buffers: withStore(buffers, store, nextBufferSequence), pieces }
}

export const extendTailChunk = (buffers: PieceTableBuffers, text: string): PieceTableBuffers => {
  if (text.length === 0) return buffers
  if (buffers.chunks.size < 2) throw new Error('piece buffer tail not found')

  const store = writableStore(buffers.chunks)
  const previousLength = store.tailLength
  const grown = store.extendTail(text)
  growTailLineIndex(grown, previousLength, text)
  return withStore(buffers, grown, buffers.nextBufferSequence)
}

// The tail's index, when one exists and is up to date, grows from the appended
// text alone. The grown chunk is a fresh concatenation: scanning it would
// flatten it, and that would happen once per keystroke.
const growTailLineIndex = (
  store: PieceBufferChunkView,
  previousLength: number,
  text: string,
): void => {
  const chunk = store.size - 1
  const index = store.lineIndexes.get(chunk)
  if (!index || index.scannedLength !== previousLength) return

  let at = text.indexOf('\n')
  while (at !== -1) {
    pushLineBreakOffset(index, previousLength + at)
    at = text.indexOf('\n', at + 1)
  }

  index.scannedLength = previousLength + text.length
  index.text = store.chunkText(chunk)
  recordTextBufferDiagnostic('sourceIndex', () => ({
    source: 'piece-buffer',
    sourceBytesRead: text.length * 2,
    scannedCodeUnits: text.length,
    retainedIndexBytes: index.offsets.byteLength,
  }))
}

export const createInitialBuffers = (
  original: string,
  options: PieceTableBufferOptions = {},
): PieceTableBuffers => {
  const originalBuffer = createBufferId(0)
  const chunks = PieceBufferChunkView.from(original)
  return {
    original: originalBuffer,
    identity: {},
    lineage: { epoch: 0, autoRetain: !options.transient },
    lineIndexes: chunks.lineIndexes,
    chunks,
    nextBufferSequence: 1,
    lineEnding: options.lineEnding ?? DEFAULT_DOCUMENT_LINE_ENDING,
    byteOrderMark: options.byteOrderMark ?? '',
    containsUnusualLineTerminators: options.containsUnusualLineTerminators ?? false,
  }
}

export const createOriginalPiece = (buffers: PieceTableBuffers): Piece | null => {
  const original = getBufferText(buffers, buffers.original)
  if (original.length === 0) return null

  return {
    buffer: buffers.original,
    start: 0,
    length: original.length,
    order: PIECE_ORDER_STEP,
    lineBreaks: bufferLineIndex(buffers, buffers.original, original).count,
    visible: true,
  }
}
