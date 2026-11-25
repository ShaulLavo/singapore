import {
  EditorWorkScheduler,
  nextWorkSchedulerScopeId,
  type EditorScheduledWorkHandle,
  type EditorWorkPriority,
  type EditorWorkTags,
  type EditorWorkTaskClass,
} from './workScheduler'
import { nowMs } from './timing'

export type LatestAsyncRequestOptions<T> = {
  readonly delayMs?: number
  readonly maxDelayMs?: number
  readonly budgetMs?: number
  readonly defer?: boolean
  readonly taskClass?: EditorWorkTaskClass
  readonly priority?: EditorWorkPriority
  readonly tags?: EditorWorkTags
  readonly run: (signal: AbortSignal) => Promise<T>
  readonly apply: (result: T, startedAt: number) => void
  readonly fail?: (error: unknown, startedAt: number) => void
}

export type SingleFlightAsyncRequestOptions<T> = {
  readonly delayMs?: number
  readonly defer?: boolean
  readonly replaceInFlight?: boolean
  readonly taskClass?: EditorWorkTaskClass
  readonly priority?: EditorWorkPriority
  readonly tags?: EditorWorkTags
  readonly run: (signal: AbortSignal) => Promise<T>
  readonly apply: (result: T, startedAt: number) => void
  readonly fail?: (error: unknown, startedAt: number) => void
}

export type LatestAsyncRequestControllerOptions = {
  readonly key?: string
  readonly taskClass?: EditorWorkTaskClass
  readonly scheduler?: EditorWorkScheduler
}

export class LatestAsyncRequest<T> {
  private readonly key: string
  readonly #taskClass: EditorWorkTaskClass
  private readonly scheduler: EditorWorkScheduler
  readonly #ownsScheduler: boolean
  private handle: EditorScheduledWorkHandle | null = null
  #scheduleGeneration = 0
  private disposed = false

  constructor(options: LatestAsyncRequestControllerOptions = {}) {
    this.key =
      options.key ??
      (options.scheduler
        ? `editor.latestAsyncRequest:${nextWorkSchedulerScopeId(options.scheduler)}`
        : 'editor.latestAsyncRequest')
    this.#taskClass = options.taskClass ?? 'background-derived'
    this.scheduler = options.scheduler ?? new EditorWorkScheduler()
    this.#ownsScheduler = !options.scheduler
  }

  public isActive(): boolean {
    return this.handle?.isActive() ?? false
  }

  public schedule(options: LatestAsyncRequestOptions<T>): void {
    if (this.disposed) return

    // No explicit cancel first: scheduling the same key already replaces the
    // pending work, and cancelling would drop the burst deadline that
    // maxDelayMs relies on.
    const generation = ++this.#scheduleGeneration
    const delayMs = normalizeDelay(options.delayMs)
    const handle = this.scheduler.schedule({
      key: this.key,
      taskClass: options.taskClass ?? this.#taskClass,
      priority: options.priority,
      delayMs,
      maxDelayMs: normalizeDelay(options.maxDelayMs),
      budgetMs: options.budgetMs,
      defer: delayMs === 0 && options.defer === true,
      tags: options.tags,
      isCurrent: () => !this.disposed && this.#scheduleGeneration === generation,
      run: (context) => {
        if (this.disposed || this.#scheduleGeneration !== generation) {
          return Promise.resolve(undefined as T)
        }
        return options.run(context.signal)
      },
      apply: (result, context) => {
        if (this.disposed || this.#scheduleGeneration !== generation) return
        this.apply(result as T, options, context.token, context.startedAt)
      },
      fail: (error, context) => {
        if (this.disposed || this.#scheduleGeneration !== generation) return
        this.fail(error, options, context.token, context.startedAt)
      },
    })
    if (this.disposed || this.#scheduleGeneration !== generation) {
      handle.cancel()
      return
    }
    this.handle = handle
  }

  public cancel(): void {
    this.#scheduleGeneration += 1
    const handle = this.handle
    this.handle = null
    handle?.cancel()
    this.scheduler.cancel(this.key)
  }

  public dispose(): void {
    this.disposed = true
    this.cancel()
    if (this.#ownsScheduler) this.scheduler.dispose()
  }

  private apply(
    result: T,
    options: LatestAsyncRequestOptions<T>,
    token: number,
    startedAt: number,
  ) {
    this.#clearHandle(token)
    options.apply(result, startedAt)
  }

  private fail(
    error: unknown,
    options: LatestAsyncRequestOptions<T>,
    token: number,
    startedAt: number,
  ): void {
    this.#clearHandle(token)
    options.fail?.(error, startedAt)
  }

  #clearHandle(token: number): void {
    if (this.handle?.token !== token) return

    this.handle = null
  }
}

type ActiveSingleFlight = {
  readonly token: number
  readonly controller: AbortController
  superseded: boolean
}

/**
 * Single-flight async request slot: dispatches immediately when idle (optionally deferred off the
 * caller's synchronous turn to coalesce same-turn bursts) and buffers at most one trailing request
 * while a flight is active, flushing it the moment the active flight settles.
 */
export class SingleFlightAsyncRequest<T> {
  readonly #key: string
  readonly #taskClass: EditorWorkTaskClass
  readonly #scheduler: EditorWorkScheduler
  readonly #ownsScheduler: boolean
  #pendingHandle: EditorScheduledWorkHandle | null = null
  #scheduleGeneration = 0
  #inFlight: ActiveSingleFlight | null = null
  #queued: SingleFlightAsyncRequestOptions<T> | null = null
  #nextToken = 0
  #disposed = false

  constructor(options: LatestAsyncRequestControllerOptions = {}) {
    this.#key =
      options.key ??
      (options.scheduler
        ? `editor.singleFlightAsyncRequest:${nextWorkSchedulerScopeId(options.scheduler)}`
        : 'editor.singleFlightAsyncRequest')
    this.#taskClass = options.taskClass ?? 'background-derived'
    this.#scheduler = options.scheduler ?? new EditorWorkScheduler()
    this.#ownsScheduler = !options.scheduler
  }

  public isActive(): boolean {
    return (
      this.#inFlight !== null || this.#queued !== null || (this.#pendingHandle?.isActive() ?? false)
    )
  }

  public isInFlight(): boolean {
    return this.#inFlight !== null
  }

  public schedule(options: SingleFlightAsyncRequestOptions<T>): void {
    if (this.#disposed) return

    if (this.#inFlight !== null) {
      if (options.replaceInFlight === true) {
        const active = this.#inFlight
        this.#inFlight = null
        this.#queued = null
        active.controller.abort('replaced')
      } else {
        this.#inFlight.superseded = true
        this.#queued = options
        return
      }
    }

    const generation = ++this.#scheduleGeneration
    const delayMs = normalizeDelay(options.delayMs)
    const handle = this.#scheduler.schedule({
      key: this.#key,
      taskClass: options.taskClass ?? this.#taskClass,
      priority: options.priority,
      delayMs,
      defer: delayMs === 0 && options.defer === true,
      tags: options.tags,
      isCurrent: () => !this.#disposed && this.#scheduleGeneration === generation,
      run: () => {
        if (this.#disposed || this.#scheduleGeneration !== generation) return
        this.#launch(options)
      },
    })
    if (this.#disposed || this.#scheduleGeneration !== generation) {
      handle.cancel()
      return
    }
    this.#pendingHandle = handle.isActive() ? handle : null
  }

  public cancel(): void {
    this.#scheduleGeneration += 1
    const pending = this.#pendingHandle
    this.#pendingHandle = null
    pending?.cancel()
    this.#scheduler.cancel(this.#key)
    this.#queued = null
    const active = this.#inFlight
    if (!active) return
    this.#inFlight = null
    active.controller.abort('cancelled')
  }

  public dispose(): void {
    this.#disposed = true
    this.cancel()
    if (this.#ownsScheduler) this.#scheduler.dispose()
  }

  #launch(options: SingleFlightAsyncRequestOptions<T>): void {
    if (this.#disposed) return
    this.#pendingHandle = null
    const token = ++this.#nextToken
    const controller = new AbortController()
    const flight: ActiveSingleFlight = { token, controller, superseded: false }
    this.#inFlight = flight
    const startedAt = nowMs()

    let promise: Promise<T>
    try {
      promise = Promise.resolve(options.run(controller.signal))
    } catch (error) {
      this.#settleRejected(flight, options, error, startedAt)
      return
    }

    void promise.then(
      (result) => this.#settleFulfilled(flight, options, result, startedAt),
      (error) => this.#settleRejected(flight, options, error, startedAt),
    )
  }

  #settleFulfilled(
    flight: ActiveSingleFlight,
    options: SingleFlightAsyncRequestOptions<T>,
    result: T,
    startedAt: number,
  ): void {
    if (this.#disposed || this.#inFlight !== flight) return
    this.#inFlight = null
    const next = this.#queued
    this.#queued = null

    if (!flight.superseded && !flight.controller.signal.aborted) {
      try {
        options.apply(result, startedAt)
      } catch (error) {
        options.fail?.(error, startedAt)
      }
    }

    this.#flushQueued(next)
  }

  #settleRejected(
    flight: ActiveSingleFlight,
    options: SingleFlightAsyncRequestOptions<T>,
    error: unknown,
    startedAt: number,
  ): void {
    if (this.#disposed || this.#inFlight !== flight) return
    this.#inFlight = null
    const next = this.#queued
    this.#queued = null

    if (!flight.superseded && !flight.controller.signal.aborted) {
      options.fail?.(error, startedAt)
    }

    this.#flushQueued(next)
  }

  #flushQueued(next: SingleFlightAsyncRequestOptions<T> | null): void {
    if (!next || this.#disposed || this.#inFlight !== null || this.#pendingHandle?.isActive()) {
      return
    }
    if (normalizeDelay(next.delayMs) > 0) {
      this.schedule(next)
      return
    }
    this.#launch(next)
  }
}

const normalizeDelay = (delayMs: number | undefined): number => {
  if (!delayMs || delayMs <= 0) return 0
  return delayMs
}
