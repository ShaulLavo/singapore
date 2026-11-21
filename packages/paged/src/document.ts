import { createError } from '@singapore-editor/core/logging/evlog'
import { DiscoveredPrefix, mergeTotals, TrustedIndex } from './checkpoints'
import { natural, ReadBudget, SourceReader } from './source'
import {
  createCursor,
  PAGED_PROOF_OPTIONS,
  PagedSourceError,
  type PagedCoordinate,
  type PagedCopyResult,
  type PagedCursor,
  type PagedEndpoint,
  type PagedFragment,
  type PagedOpenOptions,
  type PagedOptions,
  type PagedTotals,
  type PagedUnavailable,
  type PagedWindow,
  type RangeSource,
} from './types'
import {
  origin,
  positionBefore,
  readText,
  scanPrevious,
  scanWindow,
  type Goal,
  type Piece,
  type Position,
} from './window'

const maxByte = Number.MAX_SAFE_INTEGER
const noMapping: PagedUnavailable = { kind: 'unavailable', reason: 'no-mapping' }
const outsideSource: PagedUnavailable = { kind: 'unavailable', reason: 'outside-source' }

type CursorState = {
  readonly pos: Position
  readonly goal?: Goal
  readonly reverseProbe?: Uint8Array
  readonly tail?: boolean
}

type OpenWindow = PagedWindow | PagedUnavailable

type ViewActions = {
  first(rows: number, signal: AbortSignal): Promise<PagedWindow>
  next(cursor: PagedCursor, rows: number, signal: AbortSignal): Promise<PagedWindow>
  previous(cursor: PagedCursor, rows: number, signal: AbortSignal): Promise<PagedWindow>
  seekByte(offset: number, rows: number, signal: AbortSignal): Promise<OpenWindow>
  seekLine(line: number, rows: number, signal: AbortSignal): Promise<OpenWindow>
  end(rows: number, signal: AbortSignal): Promise<OpenWindow>
  copy(start: PagedEndpoint, end: PagedEndpoint, signal: AbortSignal): Promise<PagedCopyResult>
  copyRange(start: number, end: number, signal: AbortSignal): Promise<PagedCopyResult>
  release(): void
}

export class PagedDocument {
  readonly #reader: SourceReader
  readonly #options: PagedOptions
  readonly #lifetime = new AbortController()
  readonly #cursors = new WeakMap<PagedCursor, CursorState>()
  readonly #fragments = new WeakSet<PagedFragment>()
  #totals: PagedTotals
  #prefix: DiscoveredPrefix
  #index: TrustedIndex | undefined
  #views = 0

  constructor(source: RangeSource, { totals, index, ...limits }: PagedOpenOptions = {}) {
    const options = { ...PAGED_PROOF_OPTIONS, ...limits }
    validateOptions(options)
    this.#totals = mergeTotals(mergeTotals(totals ?? {}, index?.totals ?? {}), {
      byteLength: source.byteLength,
    })
    this.#prefix = new DiscoveredPrefix(options.checkpointLimit, options.checkpointStride)
    this.#index = index && new TrustedIndex(index, source, this.#totals, options.checkpointLimit)
    this.#reader = new SourceReader(source, options, this.#totals.byteLength, () => this.clear())
    this.#options = options
  }

  get stats() {
    const { byteLength, ...source } = this.#reader.stats
    const open = source.state === 'open'
    const totals: PagedTotals = open ? { ...this.#totals, byteLength } : {}
    return {
      ...source,
      totals,
      coverage: {
        prefixBytes: this.#prefix.through.byteOffset,
        lastMappedLine: this.#prefix.through.line ?? 0,
      },
      checkpoints: open ? this.#prefix.size : 0,
      indexCheckpoints: this.#index?.size ?? 0,
      views: this.#views,
    }
  }

  get sourceId() {
    return this.#reader.id
  }

  get revision() {
    return this.#reader.revision
  }

  initialize(): Promise<void> {
    this.#reader.assertLive()
    return Promise.resolve()
  }

  validate(signal = this.#lifetime.signal) {
    return this.#reader.validate(signal)
  }

  createView() {
    this.#reader.assertLive()
    if (this.#views >= this.#options.maxViews)
      throw new PagedSourceError('The paged view limit was reached')
    this.#views++
    return new PagedDocumentView({
      first: (rows, signal) => this.forward({ pos: origin }, rows, signal),
      next: (cursor, rows, signal) => this.forward(this.position(cursor), rows, signal),
      previous: (cursor, rows, signal) => this.backward(this.position(cursor), rows, signal),
      seekByte: (offset, rows, signal) => this.seekByte(offset, rows, signal),
      seekLine: (line, rows, signal) => this.seekLine(line, rows, signal),
      end: (rows, signal) => this.tail(rows, signal),
      copy: (start, end, signal) => this.copy(start, end, signal),
      copyRange: (start, end, signal) => this.copyRange(start, end, signal),
      release: () => {
        this.#views--
      },
    })
  }

  dispose() {
    this.#reader.close('disposed')
  }

  private clear() {
    this.#lifetime.abort()
    this.#index = undefined
    this.#totals = {}
    this.#prefix = new DiscoveredPrefix(
      this.#options.checkpointLimit,
      this.#options.checkpointStride,
    )
  }

  private cursor(state: CursorState) {
    const cursor = createCursor(state.pos.byteOffset)
    this.#cursors.set(cursor, state)
    return cursor
  }

  private position(cursor: PagedCursor) {
    this.#reader.assertLive()
    const state = this.#cursors.get(cursor)
    if (!state) throw new PagedSourceError('The cursor belongs to another paged document')
    return state
  }

  private fragment(piece: Piece) {
    const fragment: PagedFragment = Object.freeze({
      text: piece.text,
      start: this.cursor({ pos: piece.start }),
      end: this.cursor({ pos: piece.end }),
      lineBreak: piece.lineBreak,
      continuesBefore: !piece.start.lineStart,
      continuesAfter: piece.continuesAfter,
      ...(piece.start.line === undefined ? {} : { line: piece.start.line }),
      ...(piece.start.utf16Offset === undefined ? {} : { utf16Offset: piece.start.utf16Offset }),
    })
    this.#fragments.add(fragment)
    return fragment
  }

  private window(
    pieces: readonly Piece[],
    previous: CursorState | null,
    next: CursorState | null,
    stop: PagedWindow['stop'],
  ): PagedWindow {
    return {
      kind: 'window',
      sourceId: this.sourceId,
      revision: this.revision,
      fragments: pieces.map((piece) => this.fragment(piece)),
      previous: previous ? this.cursor(previous) : null,
      next: next ? this.cursor(next) : null,
      atStart: previous === null,
      atEnd: next === null,
      stop,
    }
  }

  private async forward(state: CursorState, rows: number, signal: AbortSignal) {
    this.#reader.assertLive(signal)
    checkRows(rows, this.#options.maxWindowRows)
    const { pos, goal } = state
    const extendsPrefix =
      pos.byteOffset <= this.#prefix.through.byteOffset && pos.utf16Offset !== undefined
    const visit = (position: Position, previous: Position) => {
      this.#index?.verify(position, previous)
      this.checkMappedTotals(position)
      if (extendsPrefix) this.#prefix.add(position)
    }
    const scanned = await scanWindow(this.#reader, this.#options, pos, rows, signal, goal, visit)
    this.#reader.assertLive(signal)
    if (this.#reader.eofAt(scanned.pos.byteOffset)) this.learnTotals(scanned.pos)
    const first = scanned.pieces[0]?.start ?? pos
    const previous = first.byteOffset ? { pos: first } : null
    const next = scanned.atEnd ? null : { pos: scanned.pos, goal: scanned.goal }
    return this.window(scanned.pieces, previous, next, scanned.stop)
  }

  private async backward(state: CursorState, rows: number, signal: AbortSignal) {
    this.#reader.assertLive(signal)
    checkRows(rows, this.#options.maxWindowRows)
    const end = state.pos
    if (!end.byteOffset) return this.forward({ pos: origin }, rows, signal)
    const previous = await scanPrevious(
      this.#reader,
      this.#options,
      end,
      rows,
      signal,
      state.reverseProbe,
      state.tail,
    )
    if (previous.reverseProbe) {
      const retry = { ...state, reverseProbe: previous.reverseProbe }
      return this.window([], retry, state, 'budget')
    }
    return this.beforeWindow(previous.pieces, state)
  }

  private beforeWindow(pieces: readonly Piece[], state: CursorState) {
    const first = pieces[0]?.start
    return this.window(
      pieces,
      first?.byteOffset ? { pos: first } : null,
      state.tail ? null : { pos: state.pos },
      state.tail ? 'eof' : 'boundary',
    )
  }

  private async seekByte(offset: number, rows: number, signal: AbortSignal): Promise<OpenWindow> {
    this.#reader.assertLive(signal)
    if (!natural(offset)) throw new PagedSourceError('Invalid byte offset')
    const exact = this.#reader.byteLength
    if (exact !== undefined && offset > exact) return outsideSource
    const window = await this.forward(
      { pos: positionBefore(offset), goal: { kind: 'byte', value: offset } },
      rows,
      signal,
    )
    if (
      offset > 0 &&
      offset !== this.#reader.byteLength &&
      window.atEnd &&
      !window.fragments.length &&
      this.#reader.eofAt(offset)
    )
      return outsideSource
    return window
  }

  private async seekLine(line: number, rows: number, signal: AbortSignal): Promise<OpenWindow> {
    this.#reader.assertLive(signal)
    if (!natural(line)) throw new PagedSourceError('Invalid line number')
    if (this.#totals.lineCount !== undefined && line >= this.#totals.lineCount) return outsideSource
    const goal = { kind: 'line', value: line } as const
    const pos = await this.locate(goal, signal)
    if (!pos) return noMapping
    const window = await this.forward({ pos, goal }, rows, signal)
    return window.atEnd && !window.fragments.length ? outsideSource : window
  }

  private async tail(rows: number, signal: AbortSignal): Promise<OpenWindow> {
    this.#reader.assertLive(signal)
    const offset = this.#reader.byteLength
    if (offset === undefined) return { kind: 'unavailable', reason: 'unknown-length' }
    if (!offset) return this.forward({ pos: origin }, rows, signal)
    return this.backward(
      {
        pos: {
          byteOffset: offset,
          lineStart: false,
          line: this.#totals.lineCount === undefined ? undefined : this.#totals.lineCount - 1,
          utf16Offset: this.#totals.utf16Length,
        },
        tail: true,
      },
      rows,
      signal,
    )
  }

  private async locate(target: PagedCoordinate, signal: AbortSignal) {
    const discovered = this.#prefix.locate(target)
    if (
      discovered &&
      (target.kind === 'line' ? discovered.line : discovered.utf16Offset) === target.value
    )
      return discovered
    const combined = AbortSignal.any([signal, this.#lifetime.signal])
    let trusted: Position | undefined
    try {
      trusted = await this.#index?.locate(
        target,
        { ...this.#totals, byteLength: this.#reader.byteLength },
        combined,
      )
    } finally {
      this.#reader.assertLive(signal)
    }
    return !trusted || (discovered && discovered.byteOffset > trusted.byteOffset)
      ? discovered
      : trusted
  }

  private checkMappedTotals(pos: Position) {
    const { lineCount, utf16Length } = this.#totals
    if (
      (lineCount !== undefined && pos.line !== undefined && pos.line >= lineCount) ||
      (utf16Length !== undefined && pos.utf16Offset !== undefined && pos.utf16Offset > utf16Length)
    )
      throw new PagedSourceError('Read content contradicts the supplied totals')
  }

  private learnTotals(pos: Position) {
    const exactEnd = this.#reader.byteLength
    if (exactEnd !== pos.byteOffset || pos.carry?.length) return
    this.#totals = mergeTotals(this.#totals, {
      byteLength: exactEnd,
      lineCount: pos.line === undefined ? undefined : pos.line + 1,
      utf16Length: pos.utf16Offset,
    })
  }

  private endpoint({ fragment, column }: PagedEndpoint) {
    if (
      !this.#fragments.has(fragment) ||
      !natural(column) ||
      column > fragment.text.length + fragment.lineBreak.length
    )
      throw new PagedSourceError('Invalid selection endpoint')
    return { column, offset: fragment.start.byteOffset, text: fragment.text + fragment.lineBreak }
  }

  private async copy(
    first: PagedEndpoint,
    second: PagedEndpoint,
    signal: AbortSignal,
  ): Promise<PagedCopyResult> {
    this.#reader.assertLive(signal)
    const start = this.endpoint(first)
    const end = this.endpoint(second)
    const [left, right] = start.offset <= end.offset ? [start, end] : [end, start]
    if (left.offset === right.offset) {
      const text = left.text.length >= right.text.length ? left.text : right.text
      return {
        kind: 'text',
        text: text.slice(Math.min(left.column, right.column), Math.max(left.column, right.column)),
      }
    }
    const parts: string[] = []
    let units = 0
    const result = await readText(
      this.#reader,
      left.offset,
      right.offset,
      signal,
      new ReadBudget(this.#options),
      (text) => {
        parts.push(text.slice(Math.max(0, left.column - units)))
        units += text.length
        return units - left.column > this.#options.maxWindowUnits
      },
    )
    if (units - left.column > this.#options.maxWindowUnits) return { kind: 'limit', reason: 'text' }
    if (result === 'budget') return { kind: 'limit', reason: 'budget' }
    if (result === 'eof') throw new PagedSourceError('Read content ends before the selection')
    const remaining = units - left.column + right.column
    if (Math.abs(remaining) > this.#options.maxWindowUnits) return { kind: 'limit', reason: 'text' }
    if (remaining < 0)
      return { kind: 'text', text: left.text.slice(units + right.column, left.column) }
    parts.push(right.text.slice(Math.max(0, left.column - units), right.column))
    return { kind: 'text', text: parts.join('') }
  }

  private async copyRange(
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<PagedCopyResult> {
    this.#reader.assertLive(signal)
    if (!natural(start) || !natural(end) || end < start)
      throw new PagedSourceError('Invalid UTF-16 copy range')
    if (end - start > this.#options.maxWindowUnits) return { kind: 'limit', reason: 'text' }
    if (this.#totals.utf16Length !== undefined && end > this.#totals.utf16Length)
      return outsideSource
    const pos = await this.locate({ kind: 'utf16', value: start }, signal)
    if (pos?.utf16Offset === undefined) return noMapping
    const parts: string[] = []
    let units = pos.utf16Offset
    const result = await readText(
      this.#reader,
      pos.byteOffset,
      maxByte,
      signal,
      new ReadBudget(this.#options),
      (text) => {
        if (units + text.length > start)
          parts.push(text.slice(Math.max(0, start - units), end - units))
        units += text.length
        return units >= end
      },
    )
    if (result === 'budget') return { kind: 'limit', reason: 'budget' }
    if (units < end) return outsideSource
    return { kind: 'text', text: parts.join('') }
  }
}

function validateOptions(options: PagedOptions) {
  for (const value of Object.values(options)) {
    if (!natural(value) || !value)
      throw new PagedSourceError('Paging limits must be positive safe integers')
  }
  if (
    options.checkpointLimit < 2 ||
    options.pageBytes < 4 ||
    options.cacheBytes < options.pageBytes ||
    options.maxReadBytes < 4 ||
    options.maxWindowUnits < 2
  )
    throw createError({
      code: 'PAGED_DOCUMENT_INVALID',
      status: 422,
      message: 'Paging requires two checkpoints, one cached page, and room for a UTF-8 code point',
    })
}

function checkRows(rows: number, max: number) {
  if (!natural(rows) || !rows || rows > max) throw new PagedSourceError('Invalid window row count')
}

export class PagedDocumentView {
  #request: AbortController | undefined
  #disposed = false

  constructor(private readonly actions: ViewActions) {}

  first(rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.first(rows, operation), signal)
  }

  next(cursor: PagedCursor, rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.next(cursor, rows, operation), signal)
  }

  previous(cursor: PagedCursor, rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.previous(cursor, rows, operation), signal)
  }

  seekByte(offset: number, rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.seekByte(offset, rows, operation), signal)
  }

  seekLine(line: number, rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.seekLine(line, rows, operation), signal)
  }

  end(rows: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.end(rows, operation), signal)
  }

  copy(start: PagedEndpoint, end: PagedEndpoint, signal?: AbortSignal) {
    return this.run((operation) => this.actions.copy(start, end, operation), signal)
  }

  copyRange(start: number, end: number, signal?: AbortSignal) {
    return this.run((operation) => this.actions.copyRange(start, end, operation), signal)
  }

  cancel() {
    this.#request?.abort()
    this.#request = undefined
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.cancel()
    this.actions.release()
  }

  private async run<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (this.#disposed) throw new PagedSourceError('The paged view is disposed')
    this.cancel()
    const request = new AbortController()
    this.#request = request
    const combined = signal ? AbortSignal.any([request.signal, signal]) : request.signal
    try {
      const result = await action(combined)
      combined.throwIfAborted()
      return result
    } finally {
      if (this.#request === request) this.#request = undefined
    }
  }
}
