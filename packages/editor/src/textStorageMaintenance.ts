import type { PieceTableSnapshot } from '@singapore-editor/textbuffer'
import {
  reclaimSnapshotStorage,
  type TextReclamationResult,
} from '@singapore-editor/textbuffer/internal/reclamation'
import { EditorWorkScheduler } from './editor/workScheduler'
import { recordEditorPerformanceDiagnostic } from './editor/performanceDiagnostics'

const DELETED_UNITS_BEFORE_MAINTENANCE = 128 * 1024
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
  maxSliceMs: number
}

export class TextStorageMaintenance {
  private readonly scheduler = new EditorWorkScheduler()
  private job: Generator<void, TextReclamationResult> | null = null
  private runMaxSliceMs = 0
  private deletedUnits = 0
  private due = false
  private stats: TextStorageMaintenanceStats = {
    completed: 0,
    cancelled: 0,
    chunks: 0,
    codeUnits: 0,
    snapshots: 0,
    maxSliceMs: 0,
  }

  constructor(private readonly snapshots: () => Iterable<PieceTableSnapshot>) {}

  // `force` is for events that release retained snapshots without deleting text.
  request(deletedUnits: number, force = false): void {
    if (this.job) {
      this.job = null
      this.stats.cancelled++
    }
    this.deletedUnits += deletedUnits
    this.due ||= force || this.deletedUnits >= DELETED_UNITS_BEFORE_MAINTENANCE
    if (!this.due) return
    this.schedule(QUIET_DELAY_MS)
  }

  resume(): void {
    if (this.due && !this.job) this.schedule(QUIET_DELAY_MS)
  }

  suspend(): void {
    this.scheduler.cancel('text-storage', 'detached')
    if (this.job) this.stats.cancelled++
    this.job = null
  }

  getStats(): Readonly<TextStorageMaintenanceStats> {
    return { ...this.stats }
  }

  private schedule(delayMs: number): void {
    this.scheduler.schedule({
      key: 'text-storage',
      taskClass: 'idle-cache',
      defer: true,
      delayMs,
      maxDelayMs: MAX_DELAY_MS,
      run: () => this.step(),
      apply: (result) => this.settle(result),
      fail: (error) => {
        this.job = null
        this.due = false
        console.error('[editor]', 'editor.buffer.reclamation_failed', error)
        recordEditorPerformanceDiagnostic('buffer.reclamation.failed', { error })
      },
    })
  }

  private step(): TextReclamationResult | null {
    if (!this.job) {
      this.job = reclaimSnapshotStorage(this.snapshots())
      this.runMaxSliceMs = 0
    }
    const start = performance.now()
    for (let step = 0; step < STEPS_PER_SLICE; step++) {
      const result = this.job.next()
      this.recordSlice(performance.now() - start)
      if (result.done) return result.value
      if (performance.now() - start >= SLICE_MS) return null
    }
    return null
  }

  private recordSlice(ms: number): void {
    this.runMaxSliceMs = Math.max(this.runMaxSliceMs, ms)
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, ms)
  }

  private settle(result: TextReclamationResult | null): void {
    if (!result) {
      this.schedule(0)
      return
    }
    this.job = null
    this.due = false
    this.deletedUnits = 0
    this.stats.completed++
    this.stats.chunks += result.chunks
    this.stats.codeUnits += result.codeUnits
    this.stats.snapshots += result.snapshots
    recordEditorPerformanceDiagnostic('buffer.reclamation', {
      ...result,
      maxSliceMs: this.runMaxSliceMs,
    })
  }
}
