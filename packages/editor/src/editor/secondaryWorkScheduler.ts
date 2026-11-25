import { EditorWorkScheduler, nextWorkSchedulerScopeId } from './workScheduler'

export type EditorSecondaryWorkOptions = {
  readonly key: string
  readonly delayMs?: number
  readonly maxDelayMs?: number
  readonly version?: number
  isCurrent?(version: number): boolean
  run(): void
}

type ScheduledSecondaryWork = {
  readonly token: number
  isActive(): boolean
  cancel(): void
}

export class EditorSecondaryWorkScheduler {
  private readonly scheduler: EditorWorkScheduler
  readonly #ownsScheduler: boolean
  readonly #keyPrefix: string
  private readonly scheduled = new Map<string, ScheduledSecondaryWork>()
  readonly #keyGenerations = new Map<string, number>()
  private nextVersion = 0
  private disposed = false

  constructor(scheduler?: EditorWorkScheduler) {
    this.scheduler = scheduler ?? new EditorWorkScheduler()
    this.#ownsScheduler = !scheduler
    this.#keyPrefix = scheduler ? `secondary.${nextWorkSchedulerScopeId(scheduler)}:` : ''
  }

  schedule(options: EditorSecondaryWorkOptions): void {
    if (this.disposed) return

    // Deliberately not cancelling first: the underlying scheduler replaces by
    // key and carries the burst's original deadline across the replacement,
    // which is what maxDelayMs is measured from. Cancelling here would reset it
    // on every keystroke.
    const generation = (this.#keyGenerations.get(options.key) ?? 0) + 1
    this.#keyGenerations.set(options.key, generation)
    const version = options.version ?? this.#nextWorkVersion()
    const handle = this.scheduler.schedule({
      key: `${this.#keyPrefix}${options.key}`,
      taskClass: 'background-derived',
      delayMs: normalizeDelayMs(options.delayMs),
      maxDelayMs: normalizeDelayMs(options.maxDelayMs),
      defer: true,
      tags: { version },
      isCurrent: (tags) =>
        !this.disposed &&
        this.#keyGenerations.get(options.key) === generation &&
        (options.isCurrent?.(tags.version ?? version) ?? true),
      run: () => {
        if (this.disposed || this.#keyGenerations.get(options.key) !== generation) return
        options.run()
      },
      apply: (_result, context) => this.#clearScheduledHandle(options.key, context.token),
      fail: (_error, context) => this.#clearScheduledHandle(options.key, context.token),
    })
    if (this.disposed || this.#keyGenerations.get(options.key) !== generation) {
      handle.cancel()
      return
    }
    this.scheduled.set(options.key, handle)
  }

  cancel(key: string): void {
    this.#keyGenerations.set(key, (this.#keyGenerations.get(key) ?? 0) + 1)
    const scheduled = this.scheduled.get(key)
    if (scheduled) {
      this.scheduled.delete(key)
      scheduled.cancel()
    }
    this.scheduler.cancel(`${this.#keyPrefix}${key}`)
  }

  has(key: string): boolean {
    const scheduled = this.scheduled.get(key)
    if (!scheduled) return false
    if (!scheduled.isActive()) {
      this.scheduled.delete(key)
      return false
    }
    return true
  }

  dispose(): void {
    if (this.disposed) return

    this.disposed = true
    for (const key of new Set([...this.scheduled.keys(), ...this.#keyGenerations.keys()])) {
      this.cancel(key)
    }
    this.#keyGenerations.clear()
    if (this.#ownsScheduler) this.scheduler.dispose()
  }

  #clearScheduledHandle(key: string, token: number): void {
    const scheduled = this.scheduled.get(key)
    if (!scheduled || scheduled.token !== token) return

    this.scheduled.delete(key)
  }

  #nextWorkVersion(): number {
    this.nextVersion += 1
    return this.nextVersion
  }
}

function normalizeDelayMs(delayMs: number | undefined): number {
  if (!delayMs || delayMs <= 0) return 0
  return delayMs
}
