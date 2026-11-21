import { EditorTokenStore } from '@singapore-editor/core/syntax'
import {
  resolveTreeSitterLanguageContribution,
  type TreeSitterLanguageContribution,
  type TreeSitterLanguageDescriptor,
} from './treeSitter/registry'
import { SLICE_TEXT_LIMIT } from './treeSitter/sliceLimits'
import type { TreeSitterSliceTimings } from './treeSitter/types'
import {
  createTreeSitterWorkerOwner,
  treeSitterBackendForOwner,
  type TreeSitterWorkerOwner,
} from './treeSitter/workerClient'

export type TreeSitterHighlightSlice = {
  readonly sourceId: string
  readonly revision: string
  /** Stable identity for this range at its actual source location. */
  readonly location: string
  /** Exact submitted text, including any surrounding context that is already loaded. */
  readonly text: string
  readonly startsAtSourceStart: boolean
  readonly endsAtSourceEnd: boolean
}

export type TreeSitterSliceHighlightResult =
  | TreeSitterHighlightedSlice
  | {
      readonly kind: 'plain'
      readonly reason:
        | 'unsupported-language'
        | 'unavailable'
        | 'over-budget'
        | 'superseded'
        | 'disposed'
    }

export type TreeSitterHighlightedSlice = {
  readonly kind: 'highlighted'
  readonly quality: 'known-start' | 'provisional'
  readonly endsAtSourceEnd: boolean
  /** UTF-16 offsets relative to the submitted text. */
  readonly tokens: EditorTokenStore
  readonly timings: TreeSitterSliceTimings & { readonly roundTripMs: number }
}

export type TreeSitterSliceHighlightLimits = {
  readonly maxTextUnits: number
  readonly cacheEntries: number
  readonly cacheTextUnits: number
  readonly cacheTokens: number
}

export type TreeSitterSliceHighlighterOptions = {
  /** Fixed for this highlighter's lifetime. Use a new highlighter for a new query generation. */
  readonly language?: TreeSitterLanguageContribution | null
  readonly workerOwner?: TreeSitterWorkerOwner
  readonly limits?: Partial<TreeSitterSliceHighlightLimits>
}

type SliceSource = Pick<TreeSitterHighlightSlice, 'sourceId' | 'revision'>
type PlainReason = Extract<TreeSitterSliceHighlightResult, { kind: 'plain' }>['reason']
type CacheEntry = { readonly text: string; readonly result: TreeSitterHighlightedSlice }
type HighlightJob = {
  readonly slice: TreeSitterHighlightSlice
  readonly key: string
  readonly controller: AbortController
  readonly promise: Promise<TreeSitterSliceHighlightResult>
  readonly resolve: (result: TreeSitterSliceHighlightResult) => void
}

const DEFAULT_LIMITS: TreeSitterSliceHighlightLimits = {
  maxTextUnits: SLICE_TEXT_LIMIT,
  cacheEntries: 32,
  cacheTextUnits: 256 * 1024,
  cacheTokens: 24 * 1024,
}
const MAX_IDENTITY_UNITS = 1024

export function createTreeSitterSliceHighlighter(
  options: TreeSitterSliceHighlighterOptions,
): TreeSitterSliceHighlighter {
  return new TreeSitterSliceHighlighter(options)
}

export class TreeSitterSliceHighlighter {
  private readonly owner: TreeSitterWorkerOwner
  private readonly ownsWorker: boolean
  private readonly backend: ReturnType<typeof treeSitterBackendForOwner>
  private readonly limits: TreeSitterSliceHighlightLimits
  private readonly contribution: TreeSitterLanguageContribution | null
  private descriptor: Promise<TreeSitterLanguageDescriptor> | null = null
  private readonly cache = new Map<string, CacheEntry>()
  private source: SliceSource | null = null
  private active: HighlightJob | null = null
  private waiting: HighlightJob | null = null
  private disposed = false
  private retainedTextUnits = 0
  private retainedTokens = 0
  private cacheHits = 0

  constructor(options: TreeSitterSliceHighlighterOptions) {
    this.limits = resolveLimits(options.limits)
    this.ownsWorker = !options.workerOwner
    this.owner = options.workerOwner ?? createTreeSitterWorkerOwner()
    this.backend = treeSitterBackendForOwner(this.owner)
    this.contribution = options.language ? { ...options.language } : null
  }

  /** Starts and warms the worker without supplying text. */
  async prewarm(): Promise<void> {
    if (this.disposed) return
    try {
      const descriptor = await this.language()
      if (!this.disposed && descriptor?.highlightQuerySource?.trim())
        await this.backend.warmLanguages([descriptor])
    } catch {
      // The next highlight still reports an unavailable result if grammar loading fails.
    }
  }

  /** Returns colors for this exact slice immediately if they are still cached. */
  lookup(slice: TreeSitterHighlightSlice): TreeSitterHighlightedSlice | null {
    if (!sameSource(this.source, slice) || slice.location.length > MAX_IDENTITY_UNITS) return null
    return this.readCache(sliceKey(slice), slice.text)
  }

  /** Selects the current slice. A newer request supersedes unfinished work. */
  highlight(slice: TreeSitterHighlightSlice): Promise<TreeSitterSliceHighlightResult> {
    if (this.disposed) return Promise.resolve(plain('disposed'))
    if (this.resetForSource(slice) || slice.text.length > this.limits.maxTextUnits) {
      this.cancel()
      return Promise.resolve(plain('over-budget'))
    }
    if (!this.contribution) return Promise.resolve(plain('unsupported-language'))

    const key = sliceKey(slice)
    const cached = this.readCache(key, slice.text)
    if (cached) {
      this.cacheHits++
      this.cancel()
      return Promise.resolve(cached)
    }

    const latest = this.waiting ?? this.active
    if (latest && matchesJob(latest, slice, key)) return latest.promise
    this.cancel()
    let resolve!: HighlightJob['resolve']
    const promise = new Promise<TreeSitterSliceHighlightResult>((done) => {
      resolve = done
    })
    this.waiting = { slice: { ...slice }, key, promise, resolve, controller: new AbortController() }
    this.startWaiting()
    return promise
  }

  cancel(): void {
    this.cancelJobs('superseded')
  }

  inspect() {
    return {
      cacheHits: this.cacheHits,
      cacheEntries: this.cache.size,
      retainedTextUnits: this.retainedTextUnits,
      retainedTokens: this.retainedTokens,
      inFlightTextUnits: this.active?.slice.text.length ?? 0,
      queuedTextUnits: this.waiting?.slice.text.length ?? 0,
      tokenBufferBytes: this.retainedTokens * 3 * Uint32Array.BYTES_PER_ELEMENT,
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelJobs('disposed')
    this.source = null
    this.clearCache()
    if (this.ownsWorker) await this.owner.dispose()
  }

  private language(): Promise<TreeSitterLanguageDescriptor | null> {
    if (!this.contribution) return Promise.resolve(null)
    this.descriptor ??= resolveTreeSitterLanguageContribution(this.contribution)
    return this.descriptor
  }

  private resetForSource(slice: TreeSitterHighlightSlice): boolean {
    if (sameSource(this.source, slice)) return slice.location.length > MAX_IDENTITY_UNITS
    this.cancel()
    this.clearCache()
    const { sourceId, revision, location } = slice
    const oversized = [sourceId, revision, location].some((id) => id.length > MAX_IDENTITY_UNITS)
    this.source = oversized ? null : { sourceId, revision }
    return oversized
  }

  private cancelJobs(reason: 'superseded' | 'disposed'): void {
    cancelJob(this.active, reason)
    cancelJob(this.waiting, reason)
    this.waiting = null
  }

  private startWaiting(): void {
    const job = this.waiting
    if (this.active || !job) return
    this.active = job
    this.waiting = null
    void this.analyze(job).then((result) => {
      this.active = null
      if (!job.controller.signal.aborted) {
        if (result.kind === 'highlighted') this.retain(job, result)
        job.resolve(result)
      }
      this.startWaiting()
    })
  }

  private async analyze(job: HighlightJob): Promise<TreeSitterSliceHighlightResult> {
    const { signal } = job.controller
    const started = performance.now()
    try {
      const descriptor = await this.language()
      if (!descriptor?.highlightQuerySource?.trim()) return plain('unsupported-language')
      if (signal.aborted) return plain('superseded')
      const result = await this.backend.highlightSlice(descriptor, job.slice.text, signal)
      if (signal.aborted) return plain('superseded')
      if (!result) return plain('unavailable')
      if (result.sliceStatus !== 'highlighted') return plain(result.sliceStatus)
      return {
        kind: 'highlighted',
        quality: job.slice.startsAtSourceStart ? 'known-start' : 'provisional',
        endsAtSourceEnd: job.slice.endsAtSourceEnd,
        tokens: EditorTokenStore.fromPacked(result.tokensPacked),
        timings: { ...result.timings, roundTripMs: performance.now() - started },
      }
    } catch {
      return plain('unavailable')
    }
  }

  private readCache(key: string, text: string): TreeSitterHighlightedSlice | null {
    const entry = this.cache.get(key)
    if (!entry || entry.text !== text) return null
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.result
  }

  private retain(job: HighlightJob, result: TreeSitterHighlightedSlice): void {
    const { cacheEntries, cacheTextUnits, cacheTokens } = this.limits
    const { text } = job.slice
    if (!cacheEntries || text.length > cacheTextUnits || result.tokens.length > cacheTokens) return
    this.evict(job.key)
    this.cache.set(job.key, { text, result })
    this.retainedTextUnits += text.length
    this.retainedTokens += result.tokens.length
    for (const key of this.cache.keys()) {
      if (
        this.cache.size <= cacheEntries &&
        this.retainedTextUnits <= cacheTextUnits &&
        this.retainedTokens <= cacheTokens
      )
        break
      this.evict(key)
    }
  }

  private evict(key: string): void {
    const entry = this.cache.get(key)
    if (!entry) return
    this.cache.delete(key)
    this.retainedTextUnits -= entry.text.length
    this.retainedTokens -= entry.result.tokens.length
  }

  private clearCache(): void {
    this.cache.clear()
    this.retainedTextUnits = 0
    this.retainedTokens = 0
  }
}

function plain(reason: PlainReason): TreeSitterSliceHighlightResult {
  return { kind: 'plain', reason }
}

function sameSource(source: SliceSource | null, slice: SliceSource): boolean {
  return source?.sourceId === slice.sourceId && source.revision === slice.revision
}

function sliceKey(slice: TreeSitterHighlightSlice): string {
  return JSON.stringify([slice.location, slice.startsAtSourceStart, slice.endsAtSourceEnd])
}

function matchesJob(job: HighlightJob, slice: TreeSitterHighlightSlice, key: string): boolean {
  return (
    !job.controller.signal.aborted &&
    sameSource(job.slice, slice) &&
    job.key === key &&
    job.slice.text === slice.text
  )
}

function cancelJob(job: HighlightJob | null, reason: 'superseded' | 'disposed'): void {
  if (!job || job.controller.signal.aborted) return
  job.controller.abort()
  job.resolve(plain(reason))
}

function resolveLimits(
  limits?: Partial<TreeSitterSliceHighlightLimits>,
): TreeSitterSliceHighlightLimits {
  return {
    maxTextUnits: boundedLimit(limits?.maxTextUnits, DEFAULT_LIMITS.maxTextUnits),
    cacheEntries: boundedLimit(limits?.cacheEntries, DEFAULT_LIMITS.cacheEntries),
    cacheTextUnits: boundedLimit(limits?.cacheTextUnits, DEFAULT_LIMITS.cacheTextUnits),
    cacheTokens: boundedLimit(limits?.cacheTokens, DEFAULT_LIMITS.cacheTokens),
  }
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (Number.isInteger(value) && value >= 0 && value <= maximum) return value
  throw new RangeError(`Slice highlight limit must be an integer between 0 and ${maximum}`)
}
