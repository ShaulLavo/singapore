import { ReadBudget, type SourceReader } from './source'
import { PagedSourceError, type PagedOptions, type PagedWindow } from './types'
import { alignedOffset, clipBytes, completePrefix, decode, joinBytes } from './utf8'

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

export function advance(pos: Position, bytes: number, units: number, newline: boolean): Position {
  return {
    byteOffset: pos.byteOffset + bytes,
    ...(pos.line === undefined ? {} : { line: pos.line + Number(newline) }),
    ...(pos.utf16Offset === undefined ? {} : { utf16Offset: pos.utf16Offset + units }),
    lineStart: newline,
  }
}

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
    const prefix = bytes.subarray(0, cut)
    const text = decode(prefix)
    const lineFeeds = text.split('\n').length - 1
    const through = advance(pos, cut, text.length, prefix.at(-1) === 10)
    return {
      pos: { ...through, ...(pos.line === undefined ? {} : { line: pos.line + lineFeeds }) },
      consumed: cut,
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
    pos = skipped.pos
    at += skipped.consumed
    visit(pos)
  }
  if (goal && reached(pos, goal)) goal = undefined
  while (at < block.bytes.length) {
    const lf = block.bytes.indexOf(10, at)
    const result = pieces.append(pos, block.bytes.subarray(at, lf < 0 ? undefined : lf), lf >= 0)
    at += result.pos.byteOffset - pos.byteOffset
    pos = result.pos
    visit(pos)
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
  boundary = unbounded,
  budget = new ReadBudget(options),
): Promise<Scan> {
  const pieces = new Pieces(options.maxWindowUnits)
  let pos = start
  let stop: PagedWindow['stop'] = 'budget'
  let yieldedAt = start.byteOffset
  while (true) {
    const block = await readBlock(reader, pos, budget, signal, boundary)
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
      stop = reader.eofAt(pos.byteOffset) ? 'eof' : 'boundary'
      break
    }
    if (pos.byteOffset - yieldedAt >= 65_536) {
      await yieldToHost()
      yieldedAt = pos.byteOffset
    }
  }
  const atEnd = stop === 'eof' || (reader.eofAt(pos.byteOffset) && !pos.carry?.length)
  const trailingRow = atEnd && pos.lineStart && !goal && boundary === unbounded
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
  start: number,
  boundary: number,
  signal: AbortSignal,
  budget: ReadBudget,
  consume: (text: string, end: number) => boolean,
) {
  let pos: Position = { byteOffset: start, lineStart: start === 0 }
  let yieldedAt = start
  while (true) {
    const block = await readBlock(reader, pos, budget, signal, boundary)
    reader.assertLive(signal)
    if (!block) return 'budget'
    const at = pos.byteOffset + block.bytes.length
    if (consume(decode(block.bytes), at)) return 'done'
    if (block.terminal) return at === boundary ? 'done' : 'eof'
    pos = { ...pos, byteOffset: at, carry: block.carry.slice() }
    if (at - yieldedAt >= 65_536) {
      await yieldToHost()
      yieldedAt = at
    }
  }
}

export async function scanPrevious(
  reader: SourceReader,
  options: PagedOptions,
  end: Position,
  rows: number,
  signal: AbortSignal,
  retryAt?: number,
) {
  const span = Math.min(options.maxWindowUnits, options.maxReadBytes - 3, 65_536)
  const desired = retryAt ?? Math.max(0, end.byteOffset - span)
  const probe = positionBefore(desired).byteOffset
  const buffer = new Uint8Array(end.byteOffset - probe)
  const budget = new ReadBudget(options)
  let filled = 0
  while (filled < buffer.length) {
    const bytes = await reader.read(probe + filled, end.byteOffset, budget, signal)
    reader.assertLive(signal)
    if (!bytes) {
      const nextRetry = desired + Math.max(1, Math.floor((end.byteOffset - desired) / 2))
      return { pieces: [], retryAt: Math.min(end.byteOffset, nextRetry) }
    }
    if (!bytes.length) throw new PagedSourceError('Read content ends before the cursor')
    buffer.set(bytes, filled)
    filled += bytes.length
  }
  const aligned = alignedOffset(buffer, desired - probe)
  const first = previousStart(buffer, aligned, rows)
  const tail = buffer.subarray(first)
  const start = reversePosition(end, tail, buffer[first - 1] === 10)
  const pieces = new Pieces(options.maxWindowUnits)
  const result = consumeBlock(
    { bytes: tail, carry: empty, terminal: true },
    start,
    undefined,
    pieces,
    rows,
    () => {},
  )
  if (pieces.hasText) pieces.finish(result.pos, '', !end.lineStart && !reader.eofAt(end.byteOffset))
  return { pieces: pieces.items, retryAt: undefined }
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
