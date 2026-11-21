import {
  PagedSourceError,
  PagedSourceInvalidatedError,
  type PagedOptions,
  type RangeRead,
  type RangeSource,
} from './types'

const empty = new Uint8Array()

export function natural(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

export function mergeExact(left: number | undefined, right: number | undefined, name: string) {
  if (right === undefined) return left
  if (!natural(right) || (left !== undefined && left !== right))
    throw new PagedSourceError(`Contradictory ${name}`)
  return right
}

export class ReadBudget {
  remaining: number
  requests: number

  constructor(options: PagedOptions, overlap = 0) {
    this.remaining = options.maxReadBytes - overlap
    this.requests = options.maxReadRequests
  }
}

type Interval = { start: number; bytes: Uint8Array }

type Flight = {
  controller: AbortController
  result: Promise<Interval>
  readers: number
}

function observe<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

type Slot = { start(): void }

type SourceEvents = {
  close(): void
  inspect(start: number, bytes: Uint8Array, upperBound: number | undefined): void
}

export class SourceReader {
  readonly #lifetime = new AbortController()
  readonly #cache = new Map<number, Interval>()
  readonly #flights = new Map<string, Flight>()
  readonly #queue = new Set<Slot>()
  readonly #maxEntries: number
  #state: 'open' | 'stale' | 'disposed' = 'open'
  #cachedBytes = 0
  #peakCachedBytes = 0
  #inFlight = 0
  #peakInFlight = 0
  #requestedBytes = 0
  #deliveredBytes = 0
  #sourceRequests = 0
  #cacheHits = 0
  #cancelledReads = 0
  #confirmedEnd = 0
  #eofUpper: number | undefined
  #byteLength: number | undefined

  readonly id: string
  readonly revision: string

  constructor(
    private readonly source: RangeSource,
    private readonly options: PagedOptions,
    byteLength: number | undefined,
    private readonly events: SourceEvents,
  ) {
    if (!source.id || !source.revision)
      throw new PagedSourceError('A source needs an id and revision')
    this.id = source.id
    this.revision = source.revision
    this.#byteLength = mergeExact(byteLength, source.byteLength, 'byte length')
    this.#maxEntries = Math.ceil(options.cacheBytes / options.pageBytes) * 2
  }

  get stats() {
    return {
      state: this.#state,
      byteLength: this.#byteLength,
      cachedBytes: this.#cachedBytes,
      peakCachedBytes: this.#peakCachedBytes,
      inFlight: this.#inFlight,
      peakInFlight: this.#peakInFlight,
      requestedBytes: this.#requestedBytes,
      deliveredBytes: this.#deliveredBytes,
      sourceRequests: this.#sourceRequests,
      cacheHits: this.#cacheHits,
      cancelledReads: this.#cancelledReads,
    }
  }

  get byteLength() {
    return this.#byteLength
  }

  eofAt(offset: number) {
    const end = this.#byteLength ?? this.#eofUpper
    return end !== undefined && offset >= end
  }

  assertLive(signal?: AbortSignal) {
    if (this.#state === 'stale') throw new PagedSourceInvalidatedError()
    if (this.#state === 'disposed') throw new PagedSourceError('The paged document is disposed')
    signal?.throwIfAborted()
  }

  close(state: 'stale' | 'disposed') {
    if (this.#state === state || this.#state === 'disposed') return
    this.#state = state
    this.#cancelledReads += this.#flights.size
    this.#flights.clear()
    this.#lifetime.abort()
    this.#cache.clear()
    this.#cachedBytes = 0
    this.events.close()
  }

  async validate(signal?: AbortSignal) {
    this.assertLive(signal)
    const validate = this.source.validate
    if (!validate) return false
    const result = await this.run(signal, (active) => validate.call(this.source, active))
    this.assertLive(signal)
    if (result.revision !== this.revision) this.rethrow(new PagedSourceInvalidatedError(), signal)
    return true
  }

  async run<T>(signal: AbortSignal | undefined, use: (active: AbortSignal) => Promise<T>) {
    this.assertLive(signal)
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal
    try {
      const result = await observe(
        this.schedule(combined, () => use(combined)),
        combined,
      )
      this.assertLive(signal)
      return result
    } catch (error) {
      return this.rethrow(error, signal)
    }
  }

  async read(start: number, limit: number, budget: ReadBudget, signal: AbortSignal) {
    this.assertLive(signal)
    if (this.eofAt(start)) return empty
    let end = Math.min(
      start + Math.min(this.options.pageBytes, budget.remaining, 65_536),
      limit,
      this.#byteLength ?? this.#eofUpper ?? Number.MAX_SAFE_INTEGER,
    )
    if (end <= start) return null
    for (const interval of this.#cache.values()) {
      if (interval.start > start) end = Math.min(end, interval.start)
      if (interval.start > start || interval.start + interval.bytes.length <= start) continue
      this.#cacheHits++
      this.#cache.delete(interval.start)
      this.#cache.set(interval.start, interval)
      const offset = start - interval.start
      const bytes = interval.bytes.subarray(offset, offset + end - start)
      budget.remaining -= bytes.length
      return bytes
    }
    if (!budget.requests) return null
    budget.requests--
    budget.remaining -= end - start
    const key = `${start}:${end}`
    const flight = this.#flights.get(key) ?? this.startFlight(key, start, end)
    flight.readers++
    try {
      const interval = await observe(
        flight.result,
        AbortSignal.any([signal, this.#lifetime.signal]),
      )
      this.assertLive(signal)
      return interval.bytes
    } catch (error) {
      return this.rethrow(error, signal)
    } finally {
      this.releaseFlight(key, flight)
    }
  }

  private startFlight(key: string, start: number, end: number) {
    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal, this.#lifetime.signal])
    const flight = {
      controller,
      readers: 0,
      result: this.schedule(combined, () => this.fetch(start, end, combined)),
    }
    this.#flights.set(key, flight)
    void flight.result.finally(() => this.removeFlight(key, flight)).catch(() => {})
    return flight
  }

  private releaseFlight(key: string, flight: Flight) {
    flight.readers--
    if (flight.readers || !this.removeFlight(key, flight)) return
    this.#cancelledReads++
    flight.controller.abort()
  }

  private removeFlight(key: string, flight: Flight) {
    if (this.#flights.get(key) !== flight) return false
    return this.#flights.delete(key)
  }

  private async fetch(start: number, end: number, signal: AbortSignal) {
    this.#sourceRequests++
    this.#requestedBytes += end - start
    try {
      const result = await this.source.readBytes(start, end, signal)
      if (!(result.bytes instanceof Uint8Array) || typeof result.eof !== 'boolean')
        throw new PagedSourceError('Invalid source response')
      this.#deliveredBytes += result.bytes.length
      this.assertLive(signal)
      this.checkRevision(result.revision)
      this.accept(start, end, result)
      const bytes =
        result.bytes.length === result.bytes.buffer.byteLength ? result.bytes : result.bytes.slice()
      const interval = { start, bytes }
      if (bytes.length) this.remember(interval)
      return interval
    } catch (error) {
      return this.rethrow(error, signal)
    }
  }

  private accept(start: number, end: number, result: RangeRead) {
    const count = result.bytes.length
    if (count > end - start) throw new PagedSourceError('The source returned too many bytes')
    if (!count && !result.eof) throw new PagedSourceError('The source made no progress')
    const through = start + count
    let exact = mergeExact(this.#byteLength, result.byteLength, 'byte length')
    let upper = this.#eofUpper
    if (result.eof) {
      upper = upper === undefined ? through : Math.min(upper, through)
      if (count || start === this.#confirmedEnd)
        exact = mergeExact(exact, through, 'terminal byte length')
    }
    const confirmedEnd = count ? Math.max(this.#confirmedEnd, through) : this.#confirmedEnd
    const knownEnd = exact ?? upper
    if (
      (knownEnd !== undefined && confirmedEnd > knownEnd) ||
      (exact !== undefined && upper !== undefined && exact > upper)
    )
      throw new PagedSourceError('The source response contradicts the known end of the file')
    this.events.inspect(start, result.bytes, knownEnd)
    this.#confirmedEnd = confirmedEnd
    this.#eofUpper = upper
    this.#byteLength = exact
  }

  private remember(interval: Interval) {
    this.removeCached(interval.start)
    while (
      this.#cachedBytes + interval.bytes.length > this.options.cacheBytes ||
      this.#cache.size >= this.#maxEntries
    ) {
      this.removeCached(this.#cache.keys().next().value!)
    }
    this.#cache.set(interval.start, interval)
    this.#cachedBytes += interval.bytes.length
    this.#peakCachedBytes = Math.max(this.#peakCachedBytes, this.#cachedBytes)
  }

  private removeCached(start: number) {
    const interval = this.#cache.get(start)
    if (!interval) return
    this.#cachedBytes -= interval.bytes.length
    this.#cache.delete(start)
  }

  private checkRevision(revision: string) {
    if (revision !== this.revision) throw new PagedSourceInvalidatedError()
  }

  private rethrow(error: unknown, signal?: AbortSignal): never {
    this.assertLive(signal)
    if (error instanceof PagedSourceInvalidatedError) this.close('stale')
    throw error
  }

  private async schedule<T>(signal: AbortSignal, run: () => Promise<T>) {
    await this.acquire(signal)
    try {
      signal.throwIfAborted()
      return await run()
    } finally {
      this.#inFlight--
      this.#queue.values().next().value?.start()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.#inFlight < this.options.maxInFlight) {
      this.takeSlot()
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const remove = () => {
        this.#queue.delete(slot)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        remove()
        reject(signal.reason)
      }
      const slot = {
        start: () => {
          remove()
          this.takeSlot()
          resolve()
        },
      }
      this.#queue.add(slot)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  private takeSlot() {
    this.#inFlight++
    this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight)
  }
}
