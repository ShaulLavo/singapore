import type { PieceTableSnapshot } from '@singapore-editor/textbuffer'
import type { StorageMaintenanceResult, maintainStorage } from './textStorageMaintainer'
import { EditorWorkScheduler } from './editor/workScheduler'
import { recordEditorPerformanceDiagnostic } from './editor/performanceDiagnostics'

const DELETED_UNITS_BEFORE_MAINTENANCE = 128 * 1024
// A tombstone costs a tree node however few units it hid, and backspacing
// makes one per unit, so piece growth is a trigger of its own. Growth by a
// quarter as well keeps each pass's walk of the tree paid for by the edits.
const PIECES_BEFORE_MAINTENANCE = 4096
const PIECE_GROWTH_BEFORE_MAINTENANCE = 0.25
const QUIET_DELAY_MS = 300
const MAX_DELAY_MS = 2000
const SLICE_MS = 2
const STEPS_PER_SLICE = 32

export type TextStorageMaintenanceStats = {
  completed: number
  cancelled: number
  chunks: number
  codeUnits: number
  snapshots: number
  // Tombstones compacted away from the current tree.
  tombstones: number
  maxSliceMs: number
}

type Maintainer = typeof maintainStorage
const RETRY_MS = 1000
const MAX_RETRY_MS = 60_000

// Loaded for the first pass rather than with the editor: most documents never delete enough text
// to need one. One load serves the page. Buffers waiting for it are weakly listed rather than
// captured by the promise, so a load that never settles keeps no closed buffer or history alive.
// A failed load leaves every request outstanding; the next request after a doubling backoff tries
// again, so an unavailable chunk costs one attempt per backoff, never a loop.
let maintainer: Maintainer | null = null
let loading = false
let failures = 0
let retryAt = 0
const waiting = new Set<WeakRef<TextStorageMaintenance>>()

function maintainerLoaded(loaded: Maintainer | null, error: unknown): void {
  loading = false
  if (!loaded) {
    failures++
    retryAt = Date.now() + Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** failures)
    console.error('[editor]', 'editor.buffer.reclamation_failed', error)
    recordEditorPerformanceDiagnostic('buffer.reclamation.failed', { error })
    return
  }
  maintainer = loaded
  const owners = Array.from(waiting, (ref) => ref.deref())
  waiting.clear()
  for (const owner of owners) owner?.resume()
}

let nextMaintenanceId = 0

export class TextStorageMaintenance {
  private readonly scheduler: EditorWorkScheduler
  readonly #key: string
  #job: Generator<void, StorageMaintenanceResult> | null = null
  #waitRef: WeakRef<TextStorageMaintenance> | null = null
  #runMaxSliceMs = 0
  #deletedUnits = 0
  #piecesAfterPass = 0
  #due = false
  private stats: TextStorageMaintenanceStats = {
    completed: 0,
    cancelled: 0,
    chunks: 0,
    codeUnits: 0,
    snapshots: 0,
    tombstones: 0,
    maxSliceMs: 0,
  }

  constructor(
    private readonly snapshots: () => Iterable<PieceTableSnapshot>,
    private readonly current: () => PieceTableSnapshot,
    scheduler?: EditorWorkScheduler,
  ) {
    this.scheduler = scheduler ?? new EditorWorkScheduler()
    this.#key = scheduler ? `text-storage:${++nextMaintenanceId}` : 'text-storage'
  }

  // `force` is for events that release retained snapshots without deleting text.
  request(deletedUnits: number, force = false): void {
    if (this.#job) {
      this.#job = null
      this.stats.cancelled++
    }
    this.#deletedUnits += deletedUnits
    this.#due ||=
      force || this.#deletedUnits >= DELETED_UNITS_BEFORE_MAINTENANCE || this.#piecesGrew()
    if (!this.#due) return
    this.schedule(QUIET_DELAY_MS)
  }

  #piecesGrew(): boolean {
    const growth = this.current().pieceCount - this.#piecesAfterPass
    return (
      growth >= PIECES_BEFORE_MAINTENANCE &&
      growth >= this.#piecesAfterPass * PIECE_GROWTH_BEFORE_MAINTENANCE
    )
  }

  resume(): void {
    if (this.#due && !this.#job) this.schedule(QUIET_DELAY_MS)
  }

  suspend(): void {
    this.scheduler.cancel(this.#key, 'detached')
    if (this.#waitRef) waiting.delete(this.#waitRef)
    this.#waitRef = null
    if (this.#job) this.stats.cancelled++
    this.#job = null
  }

  getStats(): Readonly<TextStorageMaintenanceStats> {
    return { ...this.stats }
  }

  private schedule(delayMs: number): void {
    if (!maintainer) {
      this.#awaitMaintainer()
      return
    }
    this.scheduler.schedule({
      key: this.#key,
      taskClass: 'idle-cache',
      defer: true,
      delayMs,
      maxDelayMs: MAX_DELAY_MS,
      run: () => this.step(),
      apply: (result) => this.settle(result),
      fail: (error) => this.#fail(error),
    })
  }

  #awaitMaintainer(): void {
    if (!this.#waitRef) {
      this.#waitRef = new WeakRef(this)
      waiting.add(this.#waitRef)
    }
    if (loading || Date.now() < retryAt) return
    loading = true
    // A canceled `vite:preloadError` resolves the import with nothing: a failure like any other.
    import('./textStorageMaintainer').then(
      (module) => maintainerLoaded(module?.maintainStorage ?? null, 'maintainer unavailable'),
      (error: unknown) => maintainerLoaded(null, error),
    )
  }

  #fail(error: unknown): void {
    this.#job = null
    this.#due = false
    console.error('[editor]', 'editor.buffer.reclamation_failed', error)
    recordEditorPerformanceDiagnostic('buffer.reclamation.failed', { error })
  }

  private step(): StorageMaintenanceResult | null {
    if (!maintainer) return null
    if (!this.#job) {
      this.#job = maintainer(this.current(), this.snapshots)
      this.#runMaxSliceMs = 0
    }
    const start = performance.now()
    for (let step = 0; step < STEPS_PER_SLICE; step++) {
      const result = this.#job.next()
      this.#recordSlice(performance.now() - start)
      if (result.done) return result.value
      if (performance.now() - start >= SLICE_MS) return null
    }
    return null
  }

  #recordSlice(ms: number): void {
    this.#runMaxSliceMs = Math.max(this.#runMaxSliceMs, ms)
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, ms)
  }

  private settle(result: StorageMaintenanceResult | null): void {
    if (!result) {
      this.schedule(0)
      return
    }
    this.#job = null
    this.#due = false
    this.#deletedUnits = 0
    this.#piecesAfterPass = this.current().pieceCount
    this.stats.completed++
    this.stats.chunks += result.chunks
    this.stats.codeUnits += result.codeUnits
    this.stats.snapshots += result.snapshots
    this.stats.tombstones += result.tombstones
    recordEditorPerformanceDiagnostic('buffer.reclamation', {
      ...result,
      maxSliceMs: this.#runMaxSliceMs,
    })
  }
}
