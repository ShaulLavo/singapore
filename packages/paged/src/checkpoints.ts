import { mergeExact, natural, type SourceReader } from './source'
import {
  PAGED_POSITION_POLICY,
  PagedSourceError,
  type PagedCheckpoint,
  type PagedCoordinate,
  type PagedIndex,
  type PagedTotals,
  type RangeSource,
} from './types'
import { decode } from './utf8'
import { advanceText, origin, type Position } from './window'

export function mergeTotals(left: PagedTotals, right: PagedTotals): PagedTotals {
  const byteLength = mergeExact(left.byteLength, right.byteLength, 'byte length')
  const lineCount = mergeExact(left.lineCount, right.lineCount, 'line count')
  const utf16Length = mergeExact(left.utf16Length, right.utf16Length, 'UTF-16 length')
  if (
    lineCount === 0 ||
    (utf16Length !== undefined && lineCount !== undefined && lineCount - 1 > utf16Length)
  )
    throw new PagedSourceError('The line count contradicts the text length')
  if (
    byteLength !== undefined &&
    ((utf16Length ?? 0) > byteLength || (lineCount ?? 1) - 1 > byteLength)
  )
    throw new PagedSourceError('The supplied totals contradict the byte length')
  return { byteLength, lineCount, utf16Length }
}

function validateCheckpoint(checkpoint: PagedCheckpoint, totals: PagedTotals) {
  const { byteOffset, line, utf16Offset } = checkpoint
  const offset = utf16Offset ?? line
  if (
    !natural(byteOffset) ||
    !natural(line) ||
    !natural(offset) ||
    line > offset ||
    offset > byteOffset
  )
    throw new PagedSourceError('Invalid index checkpoint coordinates')
  if ((byteOffset === 0) !== (line === 0) || (line === 0 && offset !== 0))
    throw new PagedSourceError('Index checkpoints must start at byte zero or after an LF')
  if (
    (totals.byteLength !== undefined && byteOffset > totals.byteLength) ||
    (totals.lineCount !== undefined && line >= totals.lineCount) ||
    (totals.utf16Length !== undefined && offset > totals.utf16Length)
  )
    throw new PagedSourceError('Index checkpoint is outside the supplied totals')
}

function coordinateOf(checkpoint: PagedCheckpoint, kind: PagedCoordinate['kind']) {
  return kind === 'line' ? checkpoint.line : checkpoint.utf16Offset
}

function upperBound(
  checkpoints: readonly PagedCheckpoint[],
  value: number,
  key: (checkpoint: PagedCheckpoint) => number,
) {
  let low = 0
  let high = checkpoints.length
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (key(checkpoints[mid]!) <= value) low = mid + 1
    else high = mid
  }
  return low
}

function preceding(checkpoints: readonly PagedCheckpoint[], target: PagedCoordinate) {
  return checkpoints[
    upperBound(checkpoints, target.value, (checkpoint) => coordinateOf(checkpoint, target.kind)!) -
      1
  ]
}

export class TrustedIndex {
  readonly #checkpoints: readonly PagedCheckpoint[]
  readonly #byOffset: readonly PagedCheckpoint[]
  readonly #atByte: ReadonlyMap<number, PagedCheckpoint>
  readonly #coverage: PagedIndex['coverage']
  readonly #locate:
    | ((coordinate: PagedCoordinate, signal: AbortSignal) => Promise<PagedCheckpoint | null>)
    | undefined

  constructor(index: PagedIndex, source: RangeSource, totals: PagedTotals, limit: number) {
    if (
      index.sourceId !== source.id ||
      index.revision !== source.revision ||
      index.positionPolicy !== PAGED_POSITION_POLICY
    )
      throw new PagedSourceError('The index does not match the source identity and position policy')
    const checkpoints = 'checkpoints' in index ? index.checkpoints : []
    if (checkpoints.length + index.coverage.length > limit)
      throw new PagedSourceError('The inline index exceeds the checkpoint limit. Supply a locator.')
    let prevByte = -1
    let prevLine = -1
    let prevUnits = -1
    for (const checkpoint of checkpoints) {
      validateCheckpoint(checkpoint, totals)
      const { line, byteOffset, utf16Offset } = checkpoint
      if (
        byteOffset <= prevByte ||
        line <= prevLine ||
        (utf16Offset !== undefined && utf16Offset <= prevUnits)
      )
        throw new PagedSourceError('Index checkpoints must be strictly ordered')
      prevByte = byteOffset
      prevLine = line
      prevUnits = utf16Offset ?? prevUnits
    }
    this.#coverage = index.coverage.map((coverage) => {
      if (
        (coverage.kind !== 'line' && coverage.kind !== 'utf16') ||
        !natural(coverage.start) ||
        !natural(coverage.end) ||
        coverage.start >= coverage.end
      )
        throw new PagedSourceError('Invalid index coverage interval')
      return { ...coverage }
    })
    this.#checkpoints = checkpoints.map((checkpoint) => ({ ...checkpoint }))
    this.#byOffset = this.#checkpoints.filter((checkpoint) => checkpoint.utf16Offset !== undefined)
    this.#atByte = new Map(
      this.#checkpoints.map((checkpoint) => [checkpoint.byteOffset, checkpoint]),
    )
    this.#locate = 'locate' in index ? index.locate.bind(index) : undefined
  }

  get size() {
    return this.#checkpoints.length
  }

  async locate(
    target: PagedCoordinate,
    totals: PagedTotals,
    reader: SourceReader,
    signal: AbortSignal,
  ) {
    const covered = this.#coverage.some(
      ({ kind, start, end }) => kind === target.kind && target.value >= start && target.value < end,
    )
    if (!covered) return undefined
    const checkpoints = target.kind === 'line' ? this.#checkpoints : this.#byOffset
    const locate = this.#locate
    const checkpoint = locate
      ? await reader.locate(signal, (active) => locate(target, active))
      : preceding(checkpoints, target)
    signal.throwIfAborted()
    if (!checkpoint) return undefined
    validateCheckpoint(checkpoint, totals)
    const coordinate = coordinateOf(checkpoint, target.kind)
    if (coordinate === undefined || coordinate > target.value)
      throw new PagedSourceError('Index locator did not return a preceding mapped checkpoint')
    return { ...checkpoint, lineStart: true }
  }

  verifyBytes(start: number, bytes: Uint8Array, upperBoundBytes: number | undefined) {
    if (!this.#checkpoints.length) return
    if (upperBoundBytes !== undefined && this.#checkpoints.at(-1)!.byteOffset > upperBoundBytes)
      throw new PagedSourceError('An index checkpoint contradicts the known end of the file')
    const first = upperBound(this.#checkpoints, start, (checkpoint) => checkpoint.byteOffset)
    for (let index = first; index < this.#checkpoints.length; index++) {
      const offset = this.#checkpoints[index]!.byteOffset - start - 1
      if (offset >= bytes.length) break
      if (bytes[offset] !== 10)
        throw new PagedSourceError(
          'Read content passes an index checkpoint without a line boundary',
        )
    }
  }

  verifyDecoded(pos: Position, bytes: Uint8Array): Position | undefined {
    if (!this.#checkpoints.length) return undefined
    if (pos.lineStart) this.verify(pos)
    let mapped = pos
    let start = 0
    const first = upperBound(
      this.#checkpoints,
      pos.byteOffset,
      (checkpoint) => checkpoint.byteOffset,
    )
    for (let index = first; index < this.#checkpoints.length; index++) {
      const checkpoint = this.#checkpoints[index]!
      const end = checkpoint.byteOffset - pos.byteOffset
      if (end > bytes.length) break
      const part = bytes.subarray(start, end)
      mapped = advanceText(mapped, part, decode(part))
      this.verify(mapped)
      mapped = {
        ...mapped,
        line: mapped.line ?? checkpoint.line,
        utf16Offset: mapped.utf16Offset ?? checkpoint.utf16Offset,
      }
      start = end
    }
    if (!start) return undefined
    const tail = bytes.subarray(start)
    return advanceText(mapped, tail, decode(tail))
  }

  verify(pos: Position) {
    const checkpoint = this.#atByte.get(pos.byteOffset)
    if (!checkpoint) return
    if (
      !pos.lineStart ||
      (pos.line !== undefined && pos.line !== checkpoint.line) ||
      (pos.utf16Offset !== undefined &&
        checkpoint.utf16Offset !== undefined &&
        pos.utf16Offset !== checkpoint.utf16Offset)
    )
      throw new PagedSourceError('Read content contradicts an index checkpoint')
  }
}

export class DiscoveredPrefix {
  readonly #checkpoints: (Position & { readonly line: number; readonly utf16Offset: number })[] = [
    { ...origin, line: 0, utf16Offset: 0 },
  ]
  #through = origin
  #stride: number

  constructor(
    private readonly limit: number,
    stride: number,
  ) {
    this.#stride = stride
  }

  get size() {
    return this.#checkpoints.length
  }

  get through() {
    return this.#through
  }

  locate(target: PagedCoordinate) {
    const through = target.kind === 'line' ? this.#through.line : this.#through.utf16Offset
    if (target.value > (through ?? 0)) return undefined
    const checkpoint = preceding(this.#checkpoints, target)
    return checkpoint ? { ...checkpoint, lineStart: true } : undefined
  }

  add(pos: Position) {
    const { line, utf16Offset } = pos
    if (
      pos.byteOffset <= this.#through.byteOffset ||
      line === undefined ||
      utf16Offset === undefined
    )
      return
    this.#through = pos
    const last = this.#checkpoints.at(-1)!
    if (!pos.lineStart || pos.byteOffset - last.byteOffset < this.#stride) return
    if (this.#checkpoints.length >= this.limit) {
      const keep = this.#checkpoints.filter((_checkpoint, index) => index % 2 === 0)
      this.#checkpoints.splice(0, this.#checkpoints.length, ...keep)
      this.#stride *= 2
    }
    this.#checkpoints.push({ ...pos, line, utf16Offset })
  }
}
