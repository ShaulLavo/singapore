import { ReadBudget, type SourceReader } from './source'
import { PagedSourceError, type PagedOptions, type PagedWindow } from './types'
import {
  alignedOffset,
  clipBytes,
  completePrefix,
  decode,
  joinBytes,
  lastScalarStart,
} from './utf8'

const empty = new Uint8Array()
const unbounded = Number.MAX_SAFE_INTEGER

export type Position = {
  readonly byteOffset: number
  readonly line?: number
  readonly utf16Offset?: number
  readonly lineStart: boolean
  readonly carry?: Uint8Array
}

export type Goal = { readonly kind: 'line' | 'byte'; readonly value: number }

export type Piece = {
  readonly text: string
  readonly start: Position
  readonly end: Position
  readonly lineBreak: '' | '\n'
  readonly continuesAfter: boolean
}

export const origin: Position = { byteOffset: 0, line: 0, utf16Offset: 0, lineStart: true }

function advance(pos: Position, bytes: number, units: number, newline: boolean): Position {
  return {
    byteOffset: pos.byteOffset + bytes,
    ...(pos.line === undefined ? {} : { line: pos.line + Number(newline) }),
    ...(pos.utf16Offset === undefined ? {} : { utf16Offset: pos.utf16Offset + units }),
    lineStart: newline,
  }
}

export function advanceText(pos: Position, bytes: Uint8Array, text: string): Position {
  if (!bytes.length) return { ...pos, carry: undefined }
  return {
    byteOffset: pos.byteOffset + bytes.length,
    line: pos.line === undefined ? undefined : pos.line + text.split('\n').length - 1,
    utf16Offset: pos.utf16Offset === undefined ? undefined : pos.utf16Offset + text.length,
    lineStart: bytes.at(-1) === 10,
  }
}

type VerifyDecoded = (position: Position, bytes: Uint8Array) => Position | undefined

export type ReverseProbe =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'boundary'; readonly pieces: readonly Piece[] }

export function positionBefore(target: number): Position {
  return target <= 3 ? origin : { byteOffset: target - 3, lineStart: false }
}

type Block = { bytes: Uint8Array; carry: Uint8Array; terminal: boolean }

function splitBlock(bytes: Uint8Array, terminal: boolean, offset: number): Block {
  const couldBeUtf16 = offset === 0 && (bytes[0] === 0xff || bytes[0] === 0xfe)
  if (
    couldBeUtf16 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  )
    throw new PagedSourceError('UTF-16 input is unsupported by the UTF-8 paged viewer')
  const complete = terminal
    ? bytes.length
    : couldBeUtf16 && bytes.length === 1
      ? 0
      : completePrefix(bytes)
  return { bytes: bytes.subarray(0, complete), carry: bytes.subarray(complete), terminal }
}

async function readBlock(
  reader: SourceReader,
  pos: Position,
  budget: ReadBudget,
  signal: AbortSignal,
  boundary: number,
): Promise<Block | null> {
  const at = pos.byteOffset + (pos.carry?.length ?? 0)
  const bytes = at === boundary ? empty : await reader.read(at, boundary, budget, signal)
  if (!bytes) return null
  const end = at + bytes.length
  return splitBlock(
    joinBytes(pos.carry ?? empty, bytes),
    reader.eofAt(end) || end === boundary,
    pos.byteOffset,
  )
}

class Pieces {
  readonly items: Piece[] = []
  #start: Position | undefined
  #parts: string[] = []
  #units = 0

  constructor(private readonly maxUnits: number) {}

  append(pos: Position, bytes: Uint8Array, newline: boolean) {
    const text = decode(bytes)
    const room = this.maxUnits - this.#units
    const clipped =
      text.length > room ? clipBytes(bytes, room) : { end: bytes.length, units: text.length }
    const lineBreak = newline && clipped.end === bytes.length && clipped.units < room
    if (!clipped.end && !lineBreak) return { pos, stop: true }
    this.#start ??= pos
    this.#parts.push(text.slice(0, clipped.units))
    this.#units += clipped.units + Number(lineBreak)
    const next = advance(
      pos,
      clipped.end + Number(lineBreak),
      clipped.units + Number(lineBreak),
      lineBreak,
    )
    if (lineBreak) this.finish(next, '\n', false)
    return { pos: next, stop: clipped.end < bytes.length || (newline && !lineBreak) }
  }

  finish(end: Position, lineBreak: '' | '\n', continuesAfter: boolean) {
    this.items.push({
      text: this.#parts.join(''),
      start: this.#start ?? end,
      end,
      lineBreak,
      continuesAfter,
    })
    this.#start = undefined
    this.#parts = []
  }

  get full() {
    return this.#units === this.maxUnits
  }

  get hasText() {
    return this.#start !== undefined
  }
}

export type Scan = {
  readonly pieces: readonly Piece[]
  readonly pos: Position
  readonly goal?: Goal
  readonly stop: PagedWindow['stop']
  readonly atEnd: boolean
}

function skipToward(pos: Position, bytes: Uint8Array, goal: Goal) {
  if (goal.kind === 'byte') {
    const cut = alignedOffset(bytes, goal.value - pos.byteOffset)
    const lf = bytes.subarray(0, cut).indexOf(10)
    const consumed = lf < 0 ? cut : lf + 1
    return {
      pos: advance(pos, consumed, decode(bytes.subarray(0, consumed)).length, lf >= 0),
      consumed,
    }
  }
  const newline = bytes.indexOf(10)
  const consumed = newline < 0 ? bytes.length : newline + 1
  return {
    pos: advance(pos, consumed, decode(bytes.subarray(0, consumed)).length, newline >= 0),
    consumed,
  }
}

function reached(pos: Position, goal: Goal) {
  return (goal.kind === 'byte' ? pos.byteOffset : (pos.line ?? -1)) >= goal.value
}

function consumeBlock(
  block: Block,
  start: Position,
  goal: Goal | undefined,
  pieces: Pieces,
  rows: number,
  visit: (pos: Position) => void,
) {
  let pos = start
  let at = 0
  while (goal && at < block.bytes.length && !reached(pos, goal)) {
    const skipped = skipToward(pos, block.bytes.subarray(at), goal)
    visit(skipped.pos)
    pos = skipped.pos
    at += skipped.consumed
  }
  if (goal && reached(pos, goal)) goal = undefined
  while (at < block.bytes.length) {
    const lf = block.bytes.indexOf(10, at)
    const result = pieces.append(pos, block.bytes.subarray(at, lf < 0 ? undefined : lf), lf >= 0)
    at += result.pos.byteOffset - pos.byteOffset
    visit(result.pos)
    pos = result.pos
    if (result.stop) return { pos, goal, stop: 'text' as const }
    if (pieces.items.length === rows) return { pos, goal, stop: 'rows' as const }
  }
  const carry = block.carry.length ? block.carry.slice() : undefined
  return { pos: { ...pos, carry }, goal, stop: undefined }
}

export async function scanWindow(
  reader: SourceReader,
  options: PagedOptions,
  start: Position,
  rows: number,
  signal: AbortSignal,
  goal: Goal | undefined,
  visit: (pos: Position) => void,
): Promise<Scan> {
  const budget = new ReadBudget(options, start.carry?.length)
  const pieces = new Pieces(options.maxWindowUnits)
  let pos = start
  let stop: PagedWindow['stop'] = 'budget'
  let yieldedAt = start.byteOffset
  while (true) {
    const block = await readBlock(reader, pos, budget, signal, unbounded)
    reader.assertLive(signal)
    if (!block) break
    const next = consumeBlock(block, pos, goal, pieces, rows, visit)
    pos = next.pos
    goal = next.goal
    if (next.stop) {
      stop = next.stop
      break
    }
    if (block.terminal) {
      stop = 'eof'
      break
    }
    if (pieces.full) {
      stop = 'text'
      break
    }
    if (pos.byteOffset - yieldedAt >= 65_536) {
      await yieldToHost()
      yieldedAt = pos.byteOffset
    }
  }
  const atEnd = stop === 'eof' || (reader.eofAt(pos.byteOffset) && !pos.carry?.length)
  const trailingRow = atEnd && pos.lineStart && !goal
  if (pieces.hasText) pieces.finish(pos, '', !atEnd)
  else if (trailingRow && pieces.items.length < rows) pieces.finish(pos, '', false)
  const pendingRow = trailingRow && stop === 'rows'
  return { pieces: pieces.items, pos, stop, atEnd: atEnd && !pendingRow, ...(goal ? { goal } : {}) }
}

function yieldToHost() {
  // @justification A task boundary lets input and cancellation run during cached decoding.
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function readText(
  reader: SourceReader,
  start: Position,
  boundary: number,
  signal: AbortSignal,
  budget: ReadBudget,
  consume: (text: string, end: Position) => boolean,
  verify: VerifyDecoded,
) {
  let pos = start
  let yieldedAt = start.byteOffset
  while (true) {
    const block = await readBlock(reader, pos, budget, signal, boundary)
    reader.assertLive(signal)
    if (!block) return 'budget'
    const text = decode(block.bytes)
    const next = verify(pos, block.bytes) ?? advanceText(pos, block.bytes, text)
    if (consume(text, next)) return 'done'
    if (block.terminal) return next.byteOffset === boundary ? 'done' : 'eof'
    pos = { ...next, carry: block.carry.slice() }
    if (next.byteOffset - yieldedAt >= 65_536) {
      await yieldToHost()
      yieldedAt = next.byteOffset
    }
  }
}

type PreviousScan = {
  readonly pieces: readonly Piece[]
  readonly reverseProbe?: ReverseProbe
}

export async function scanPrevious(
  reader: SourceReader,
  options: PagedOptions,
  end: Position,
  rows: number,
  signal: AbortSignal,
  verify: VerifyDecoded,
  reverseProbe?: ReverseProbe,
  tail = false,
): Promise<PreviousScan> {
  const carried = reverseProbe?.kind === 'bytes' ? reverseProbe.bytes : empty
  const budget = new ReadBudget(options, carried.length)
  if (reverseProbe?.kind === 'boundary')
    return readPreviousBoundary(reader, budget, signal, reverseProbe.pieces)
  const span = Math.min(options.maxWindowUnits, options.maxReadBytes - 3, 65_536)
  const desired = Math.max(0, end.byteOffset - span)
  if (!reverseProbe) {
    const probe = positionBefore(desired).byteOffset
    const buffer = await readSuffix(reader, probe, end.byteOffset, budget, signal)
    if (buffer) {
      const min = alignedOffset(buffer, desired - probe)
      if (min < buffer.length)
        return { pieces: buildPrevious(buffer, min, end, rows, options, reader, tail, verify) }
    }
  }
  const size = Math.min(5, options.maxReadBytes, end.byteOffset)
  const probe = await readReverseProbe(reader, end.byteOffset, size, budget, signal, carried)
  if (probe.length < size) return { pieces: [], reverseProbe: { kind: 'bytes', bytes: probe } }
  const min = lastScalarStart(probe)
  const pieces = buildPrevious(probe, min, end, rows, options, reader, tail, verify)
  if (min === 0 && probe.length < end.byteOffset)
    return readPreviousBoundary(reader, budget, signal, pieces)
  return { pieces }
}

async function readPreviousBoundary(
  reader: SourceReader,
  budget: ReadBudget,
  signal: AbortSignal,
  pieces: readonly Piece[],
): Promise<PreviousScan> {
  const first = pieces[0]!
  const at = first.start.byteOffset
  const bytes = await reader.read(at - 1, at, budget, signal)
  reader.assertLive(signal)
  if (!bytes) return { pieces: [], reverseProbe: { kind: 'boundary', pieces } }
  if (!bytes.length) throw new PagedSourceError('Read content ends before the cursor')
  const withBoundary = { ...first, start: { ...first.start, lineStart: bytes[0] === 10 } }
  return { pieces: [withBoundary].concat(pieces.slice(1)) }
}

async function readSuffix(
  reader: SourceReader,
  start: number,
  end: number,
  budget: ReadBudget,
  signal: AbortSignal,
) {
  const buffer = new Uint8Array(end - start)
  let at = 0
  while (at < buffer.length) {
    const bytes = await reader.read(start + at, end, budget, signal)
    reader.assertLive(signal)
    if (!bytes) return undefined
    if (!bytes.length) throw new PagedSourceError('Read content ends before the cursor')
    buffer.set(bytes, at)
    at += bytes.length
  }
  return buffer
}

async function readReverseProbe(
  reader: SourceReader,
  end: number,
  size: number,
  budget: ReadBudget,
  signal: AbortSignal,
  context: Uint8Array,
) {
  while (context.length < size) {
    const at = end - context.length
    const bytes = await reader.read(at - 1, at, budget, signal)
    reader.assertLive(signal)
    if (!bytes) break
    if (!bytes.length) throw new PagedSourceError('Read content ends before the cursor')
    context = joinBytes(bytes, context)
  }
  return context
}

function buildPrevious(
  buffer: Uint8Array,
  min: number,
  end: Position,
  rows: number,
  options: PagedOptions,
  reader: SourceReader,
  tail: boolean,
  verify: VerifyDecoded,
) {
  const mappedEnd = verifyPreviousBytes(buffer, min, end, verify)
  const trailing = tail && buffer.at(-1) === 10
  const before = rows - Number(trailing)
  const pieces = new Pieces(options.maxWindowUnits)
  let through = mappedEnd
  if (before) {
    const first = previousStart(buffer, min, before)
    const bytes = buffer.subarray(first)
    const start = reversePosition(mappedEnd, bytes, buffer[first - 1] === 10)
    const result = consumeBlock(
      { bytes, carry: empty, terminal: true },
      start,
      undefined,
      pieces,
      before,
      () => {},
    )
    through = result.pos
    if (pieces.hasText) pieces.finish(through, '', !end.lineStart && !reader.eofAt(end.byteOffset))
  }
  if (trailing) pieces.finish({ ...through, lineStart: true }, '', false)
  return pieces.items
}

function verifyPreviousBytes(
  buffer: Uint8Array,
  min: number,
  end: Position,
  verify: VerifyDecoded,
) {
  if (end.byteOffset !== buffer.length) {
    const bytes = buffer.subarray(min)
    return verify(reversePosition(end, bytes, buffer[min - 1] === 10), bytes) ?? end
  }
  splitBlock(buffer, true, 0)
  const mappedEnd = verify(origin, buffer) ?? advanceText(origin, buffer, decode(buffer))
  if (
    (end.line !== undefined && end.line !== mappedEnd.line) ||
    (end.utf16Offset !== undefined && end.utf16Offset !== mappedEnd.utf16Offset)
  )
    throw new PagedSourceError('Read content contradicts the cursor coordinates')
  return mappedEnd
}

function previousStart(bytes: Uint8Array, min: number, rows: number) {
  let at = bytes.length - 1 - Number(bytes.at(-1) === 10)
  while (at >= min) {
    const newline = bytes.lastIndexOf(10, at)
    if (newline < min) break
    rows--
    if (!rows) return newline + 1
    at = newline - 1
  }
  return min
}

function reversePosition(end: Position, bytes: Uint8Array, afterLF: boolean): Position {
  const byteOffset = end.byteOffset - bytes.length
  if (!byteOffset) return origin
  const text = decode(bytes)
  return {
    byteOffset,
    lineStart: afterLF,
    ...(end.line === undefined ? {} : { line: end.line - (text.split('\n').length - 1) }),
    ...(end.utf16Offset === undefined ? {} : { utf16Offset: end.utf16Offset - text.length }),
  }
}
