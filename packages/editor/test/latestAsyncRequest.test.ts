import { afterEach, describe, expect, it, vi } from 'vitest'

import { LatestAsyncRequest, SingleFlightAsyncRequest } from '../src/editor/latestAsyncRequest'

type Deferred<T> = {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function flushSchedulerTicks(count = 4): void {
  for (let index = 0; index < count; index += 1) vi.runOnlyPendingTimers()
}

describe('LatestAsyncRequest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards independent scheduler cancellation to each started request', async () => {
    vi.useFakeTimers()
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const signals: AbortSignal[] = []
    const request = new LatestAsyncRequest<string>()
    request.schedule({
      run: (signal) => {
        signals.push(signal)
        return first.promise
      },
      apply: () => undefined,
    })
    flushSchedulerTicks()
    expect(signals[0]?.aborted).toBe(false)
    request.schedule({
      run: (signal) => {
        signals.push(signal)
        return second.promise
      },
      apply: () => undefined,
    })
    expect(signals[0]?.aborted).toBe(true)
    flushSchedulerTicks()
    expect(signals[1]?.aborted).toBe(false)
    request.dispose()
    expect(signals[1]?.aborted).toBe(true)
    first.resolve('first')
    second.resolve('second')
    await flushMicrotasks()
  })

  it('applies only the latest request result', async () => {
    vi.useFakeTimers()
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const applied: string[] = []
    const request = new LatestAsyncRequest<string>()

    request.schedule({ run: () => first.promise, apply: (result) => applied.push(result) })
    request.schedule({ run: () => second.promise, apply: (result) => applied.push(result) })
    flushSchedulerTicks()

    first.resolve('first')
    await flushMicrotasks()
    expect(applied).toEqual([])

    second.resolve('second')
    await flushMicrotasks()
    expect(applied).toEqual(['second'])
  })

  it('replaces delayed requests before they start', async () => {
    vi.useFakeTimers()
    const started: string[] = []
    const applied: string[] = []
    const request = new LatestAsyncRequest<string>()

    request.schedule({
      delayMs: 75,
      run: async () => {
        started.push('first')
        return 'first'
      },
      apply: (result) => applied.push(result),
    })
    vi.advanceTimersByTime(50)
    request.schedule({
      delayMs: 75,
      run: async () => {
        started.push('second')
        return 'second'
      },
      apply: (result) => applied.push(result),
    })

    vi.advanceTimersByTime(74)
    expect(started).toEqual([])

    vi.advanceTimersByTime(1)
    flushSchedulerTicks()
    await flushMicrotasks()
    expect(started).toEqual(['second'])
    expect(applied).toEqual(['second'])
  })

  it('ignores stale request errors', async () => {
    vi.useFakeTimers()
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const failed: unknown[] = []
    const applied: string[] = []
    const request = new LatestAsyncRequest<string>()

    request.schedule({
      run: () => first.promise,
      apply: (result) => applied.push(result),
      fail: (error) => failed.push(error),
    })
    flushSchedulerTicks(1)
    request.schedule({
      run: () => second.promise,
      apply: (result) => applied.push(result),
      fail: (error) => failed.push(error),
    })
    flushSchedulerTicks(1)

    first.reject(new Error('stale'))
    second.resolve('second')
    await flushMicrotasks()

    expect(failed).toEqual([])
    expect(applied).toEqual(['second'])
  })

  it('clears delayed work on dispose', async () => {
    vi.useFakeTimers()
    const started: string[] = []
    const request = new LatestAsyncRequest<string>()

    request.schedule({
      delayMs: 75,
      run: async () => {
        started.push('started')
        return 'done'
      },
      apply: () => undefined,
    })
    request.dispose()

    vi.advanceTimersByTime(75)
    expect(started).toEqual([])
  })
})

describe('SingleFlightAsyncRequest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces same-turn deferred schedules into one flight', async () => {
    vi.useFakeTimers()
    const started: string[] = []
    const applied: string[] = []
    const request = new SingleFlightAsyncRequest<string>()

    request.schedule({
      defer: true,
      run: async () => {
        started.push('first')
        return 'first'
      },
      apply: (result) => applied.push(result),
    })
    request.schedule({
      defer: true,
      run: async () => {
        started.push('second')
        return 'second'
      },
      apply: (result) => applied.push(result),
    })
    request.schedule({
      defer: true,
      run: async () => {
        started.push('third')
        return 'third'
      },
      apply: (result) => applied.push(result),
    })

    expect(started).toEqual([])
    vi.advanceTimersByTime(0)
    await flushMicrotasks()
    expect(started).toEqual(['third'])
    expect(applied).toEqual(['third'])
  })

  it('keeps at most one flight active and flushes only the latest trailing edit on resolve or reject', async () => {
    vi.useFakeTimers()
    const first = createDeferred<string>()
    const last = createDeferred<string>()
    const signals: AbortSignal[] = []
    const started: string[] = []
    const applied: string[] = []
    const failed: unknown[] = []
    const request = new SingleFlightAsyncRequest<string>()

    request.schedule({
      defer: true,
      run: (signal) => {
        signals.push(signal)
        started.push('first')
        return first.promise
      },
      apply: (result) => applied.push(result),
      fail: (error) => failed.push(error),
    })
    vi.advanceTimersByTime(0)
    expect(started).toEqual(['first'])
    expect(request.isInFlight()).toBe(true)

    // Burst while flight 1 is active: never abort flight 1; keep only the newest trailing slot.
    request.schedule({
      defer: true,
      run: async () => {
        started.push('middle')
        return 'middle'
      },
      apply: (result) => applied.push(result),
    })
    request.schedule({
      defer: true,
      run: (signal) => {
        signals.push(signal)
        started.push('last')
        return last.promise
      },
      apply: (result) => applied.push(result),
    })
    expect(signals[0]?.aborted).toBe(false)
    expect(started).toEqual(['first'])

    // Superseded flight 1 rejecting still flushes the trailing flight without invoking stale fail.
    first.reject(new Error('superseded failure'))
    await flushMicrotasks()
    expect(failed).toEqual([])
    expect(started).toEqual(['first', 'last'])

    last.resolve('last')
    await flushMicrotasks()
    expect(applied).toEqual(['last'])
    expect(request.isActive()).toBe(false)
  })

  it('aborts the active flight immediately when replaceInFlight is true', async () => {
    vi.useFakeTimers()
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const signals: AbortSignal[] = []
    const applied: string[] = []
    const request = new SingleFlightAsyncRequest<string>()

    request.schedule({
      run: (signal) => {
        signals.push(signal)
        return first.promise
      },
      apply: (result) => applied.push(result),
    })
    expect(signals[0]?.aborted).toBe(false)

    request.schedule({
      replaceInFlight: true,
      run: (signal) => {
        signals.push(signal)
        return second.promise
      },
      apply: (result) => applied.push(result),
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    first.resolve('first')
    second.resolve('second')
    await flushMicrotasks()
    expect(applied).toEqual(['second'])
  })

  it('aborts active and queued work on cancel/dispose and supports re-entrant schedule in apply', async () => {
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const applied: string[] = []
    const signals: AbortSignal[] = []
    const request = new SingleFlightAsyncRequest<string>()

    request.schedule({
      run: (signal) => {
        signals.push(signal)
        return first.promise
      },
      apply: (result) => {
        applied.push(result)
        request.schedule({
          run: (signal) => {
            signals.push(signal)
            return second.promise
          },
          apply: (next) => applied.push(next),
        })
      },
    })
    first.resolve('first')
    await flushMicrotasks()
    expect(applied).toEqual(['first'])
    expect(request.isInFlight()).toBe(true)

    request.cancel()
    expect(signals[1]?.aborted).toBe(true)
    expect(request.isActive()).toBe(false)
    second.resolve('second')
    await flushMicrotasks()
    expect(applied).toEqual(['first'])
    request.dispose()
  })
})
