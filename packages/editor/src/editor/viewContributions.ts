import { createError } from '../logging/evlog'
import type { DocumentSessionChange } from '../documentSession'
import type {
  EditorViewContribution,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  EditorViewportSnapshot,
  EditorVisiblePaintLayer,
} from '../plugins'
import {
  beginEditorViewSnapshotPaint,
  finalizeEditorViewSnapshotPaint,
  invalidateEditorViewSnapshotPaint,
} from './viewSnapshot'
import {
  copyEditorVisiblePaintLayer,
  freezeEditorVisiblePaintLayers,
  MAX_VISIBLE_PAINT_LAYERS,
  MAX_VISIBLE_PAINT_RECTANGLES,
} from './visiblePaint'

export type EditorViewContributionFailurePhase =
  | 'dispose'
  | 'initial-update'
  | 'update'
  | 'viewport'
  | 'capture-visible-paint'

export type EditorViewContributionFailureHandler = (
  contribution: EditorViewContribution,
  phase: EditorViewContributionFailurePhase,
  error: unknown,
) => void

type QueuedUpdate = {
  readonly kind: EditorViewContributionUpdateKind
  readonly change: DocumentSessionChange | null
  /** The contribution whose update or viewport callback asked for it, when one did. */
  readonly requester: EditorViewContribution | null
  /** The update whose pass asked for this one; null for a notification from outside. */
  readonly cause: QueuedUpdate | null
  readonly depth: number
}

/**
 * How long a chain of updates, each asked for from inside the last, may grow before it is a loop.
 * A burst asked for from one pass is one step deep however many updates it holds.
 */
const MAX_REENTRANT_DEPTH = 32

export class EditorViewContributionController {
  private notifying = false
  private activeUpdateKind: EditorViewContributionUpdateKind | null = null
  private pendingLayout: QueuedUpdate | null = null
  private readonly pendingUpdates: QueuedUpdate[] = []
  private updatingContribution: EditorViewContribution | null = null
  private deliveringUpdate: QueuedUpdate | null = null
  private currentSnapshot: EditorViewSnapshot | null = null
  private readonly contributions: EditorViewContribution[]
  private readonly initialUpdates = new Set<EditorViewContribution>()
  private readonly viewportContributions = new Set<EditorViewContribution>()

  constructor(
    contributions: readonly EditorViewContribution[],
    private readonly createSnapshot: () => EditorViewSnapshot,
    private readonly onFailure: EditorViewContributionFailureHandler = () => undefined,
    private readonly canPresent: () => boolean = () => true,
  ) {
    this.contributions = Array.from(contributions)
    for (const contribution of contributions) {
      if (contribution.updateViewport) this.viewportContributions.add(contribution)
    }
  }

  captureSnapshot(): EditorViewSnapshot {
    if (this.currentSnapshot && this.contributions.length > 0) return this.currentSnapshot
    const snapshot = this.createSnapshot()
    this.currentSnapshot = snapshot
    finalizeEditorViewSnapshotPaint(snapshot, () => this.captureVisiblePaint(snapshot))
    return snapshot
  }

  finishRestoration(): void {
    const snapshot = this.currentSnapshot
    if (!snapshot) return
    const failed = this.removeUnreadyContributions(snapshot)
    if (!failed) return
    this.currentSnapshot = null
    this.notify('document')
  }

  private removeUnreadyContributions(snapshot: EditorViewSnapshot): boolean {
    let failed = false
    this.notifying = true
    try {
      for (const contribution of Array.from(this.contributions)) {
        failed = this.rejectUnreadyContribution(contribution, snapshot) || failed
      }
    } finally {
      this.notifying = false
      this.clearQueuedUpdates()
    }
    return failed
  }

  private rejectUnreadyContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
  ): boolean {
    if (!contribution.captureVisiblePaint) return false
    try {
      if (contribution.captureVisiblePaint(snapshot).status === 'ready') return false
      throw createError({
        code: 'EDITOR_RESTORE_CONTRIBUTION_PENDING',
        status: 500,
        message: 'A snapshot contribution did not finish its authoritative paint synchronously',
        why: 'Restoration cannot publish a frame with an unfinished required paint layer.',
        fix: 'Finish the contribution in update, or remove snapshot support from its configuration.',
      })
    } catch (error) {
      this.removeFailedContribution(contribution, 'capture-visible-paint', error)
      return true
    }
  }

  paintConfiguration(): string | null {
    const ids: string[] = []
    for (const contribution of this.contributions) {
      if (contribution.captureVisiblePaint && !contribution.snapshotKey) return null
      if (contribution.snapshotKey) ids.push(contribution.snapshotKey)
    }
    return JSON.stringify(ids.sort())
  }

  add(contribution: EditorViewContribution): void {
    this.invalidateCurrentPaint()
    this.contributions.push(contribution)
    if (contribution.updateViewport) this.viewportContributions.add(contribution)
    this.initialUpdates.add(contribution)
    this.notifyMembershipChange()
  }

  remove(contribution: EditorViewContribution): void {
    const index = this.contributions.indexOf(contribution)
    if (index === -1) return

    this.contributions.splice(index, 1)
    this.viewportContributions.delete(contribution)
    this.initialUpdates.delete(contribution)
    this.disposeContribution(contribution)
    this.notifyMembershipChange()
  }

  dispose(): void {
    this.invalidateCurrentPaint()
    this.currentSnapshot = null
    this.initialUpdates.clear()
    this.viewportContributions.clear()
    while (this.contributions.length > 0) {
      const contribution = this.contributions.pop()
      if (contribution) this.disposeContribution(contribution)
    }
  }

  notifyViewport(createViewport: () => EditorViewportSnapshot): void {
    if (!this.canPresent() || this.notifying || this.viewportContributions.size === 0) return
    this.notifying = true
    this.deliveringUpdate = rootUpdate('viewport', null)
    try {
      const viewport = createViewport()
      if (viewport.clientHeight === 0) return
      for (const contribution of this.viewportContributions) {
        this.updateContributionViewport(contribution, viewport)
      }
      this.drainQueuedUpdates()
    } finally {
      this.notifying = false
      this.activeUpdateKind = null
      this.clearQueuedUpdates()
    }
  }

  private updateContributionViewport(
    contribution: EditorViewContribution,
    viewport: EditorViewportSnapshot,
  ): void {
    this.updatingContribution = contribution
    try {
      contribution.updateViewport?.(viewport)
    } catch (error) {
      this.removeFailedContribution(contribution, 'viewport', error)
      this.notifyMembershipChange()
    } finally {
      this.updatingContribution = null
    }
  }

  notify(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null = null,
  ): void {
    if (!this.canPresent() || this.contributions.length === 0) return
    if (this.notifying) {
      this.queueReentrantUpdate(kind, change)
      return
    }

    this.notifying = true
    this.deliveringUpdate = rootUpdate(kind, change)
    try {
      this.update(kind, change)
      this.drainQueuedUpdates()
    } finally {
      this.notifying = false
      this.activeUpdateKind = null
      this.clearQueuedUpdates()
    }
  }

  private queueReentrantUpdate(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    if (kind !== 'layout') {
      this.pendingUpdates.push(this.queuedUpdate(kind, change))
      return
    }
    // A layout pass reads a fresh snapshot anyway, and one asked for from inside a layout pass would
    // re-run every contribution that calls requestViewUpdate() from update() forever.
    if (this.activeUpdateKind === 'layout') return

    this.queueLayout()
  }

  private queueLayout(): void {
    this.pendingLayout ??= this.queuedUpdate('layout', null)
  }

  private queuedUpdate(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): QueuedUpdate {
    const cause = this.deliveringUpdate
    const depth = (cause?.depth ?? 0) + 1
    return { kind, change, requester: this.updatingContribution, cause, depth }
  }

  /** Delivers what arrived during the pass in order, each one after the last has finished. */
  private drainQueuedUpdates(): void {
    for (let next = this.nextQueuedUpdate(); next; next = this.nextQueuedUpdate()) {
      if (next.depth > MAX_REENTRANT_DEPTH) {
        this.stopUpdateLoop(next)
        continue
      }
      this.deliveringUpdate = next
      this.update(next.kind, next.change)
    }
  }

  private nextQueuedUpdate(): QueuedUpdate | null {
    const queued = this.pendingUpdates.shift()
    if (queued) return queued

    const layout = this.pendingLayout
    this.pendingLayout = null
    return layout
  }

  /**
   * A chain that ran this deep repeats itself, so whoever asks more than once along it is the loop.
   * A contribution that asked once, at the end, only reacted to it, and it stays.
   */
  private stopUpdateLoop(update: QueuedUpdate): void {
    const error = reentrantUpdateLoop(update.kind)
    const looping = repeatedRequesters(update)
    if (looping.size === 0) throw error

    for (const contribution of looping) this.removeFailedContribution(contribution, 'update', error)
    this.dropUpdatesFrom(looping)
  }

  private dropUpdatesFrom(removed: ReadonlySet<EditorViewContribution>): void {
    const kept = this.pendingUpdates.filter(
      (queued) => !queued.requester || !removed.has(queued.requester),
    )
    this.pendingUpdates.splice(0, this.pendingUpdates.length, ...kept)
    const layoutRequester = this.pendingLayout?.requester
    if (layoutRequester && removed.has(layoutRequester)) this.pendingLayout = null
  }

  private clearQueuedUpdates(): void {
    this.pendingLayout = null
    this.pendingUpdates.length = 0
    this.deliveringUpdate = null
  }

  private update(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    this.invalidateCurrentPaint()
    const snapshot = this.createSnapshot()
    this.currentSnapshot = snapshot
    beginEditorViewSnapshotPaint(snapshot)
    this.activeUpdateKind = kind
    try {
      for (const contribution of Array.from(this.contributions))
        this.updateContribution(contribution, snapshot, kind, change)
      finalizeEditorViewSnapshotPaint(snapshot, () => this.captureVisiblePaint(snapshot))
    } finally {
      this.activeUpdateKind = null
    }
  }

  private captureVisiblePaint(
    snapshot: EditorViewSnapshot,
  ): readonly EditorVisiblePaintLayer[] | null {
    if (snapshot !== this.currentSnapshot || snapshot.syntaxStatus === 'loading') return null
    const layers: EditorVisiblePaintLayer[] = []
    const ids = new Set<string>()
    let remainingRectangles = MAX_VISIBLE_PAINT_RECTANGLES
    for (const contribution of Array.from(this.contributions)) {
      const layer = this.captureContribution(contribution, snapshot, ids, remainingRectangles)
      if (layer === null) return null
      if (layer === undefined) continue
      layers.push(layer)
      ids.add(layer.id)
      remainingRectangles -= layer.rectangles.length
    }
    if (snapshot !== this.currentSnapshot) return null
    return freezeEditorVisiblePaintLayers(layers)
  }

  private captureContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
    ids: ReadonlySet<string>,
    remainingRectangles: number,
  ): EditorVisiblePaintLayer | null | undefined {
    if (!contribution.captureVisiblePaint || !this.contributions.includes(contribution)) return
    // Capture can run lazily from inside another contribution's update, whose attribution resumes.
    const updating = this.updatingContribution
    this.updatingContribution = contribution
    try {
      const capture = contribution.captureVisiblePaint(snapshot)
      if (capture.status === 'pending') return null
      if (ids.size >= MAX_VISIBLE_PAINT_LAYERS || ids.has(capture.id)) {
        throw new RangeError('Editor snapshot paint layers must have bounded, unique ids')
      }
      return copyEditorVisiblePaintLayer(capture, remainingRectangles)
    } catch (error) {
      this.removeFailedContribution(contribution, 'capture-visible-paint', error)
      this.notifyMembershipChange()
      return null
    } finally {
      this.updatingContribution = updating
    }
  }

  private invalidateCurrentPaint(): void {
    if (this.currentSnapshot) invalidateEditorViewSnapshotPaint(this.currentSnapshot)
  }

  private notifyMembershipChange(): void {
    this.invalidateCurrentPaint()
    if (this.notifying) {
      this.queueLayout()
      return
    }
    this.notify('layout')
  }

  private updateContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.contributions.includes(contribution)) return
    const initialUpdate = this.initialUpdates.delete(contribution)
    this.updatingContribution = contribution
    try {
      contribution.update(
        snapshot,
        initialUpdate ? 'document' : kind,
        initialUpdate ? null : change,
      )
    } catch (error) {
      this.removeFailedContribution(
        contribution,
        initialUpdate ? 'initial-update' : 'update',
        error,
      )
    } finally {
      this.updatingContribution = null
    }
  }

  private removeFailedContribution(
    contribution: EditorViewContribution,
    phase: EditorViewContributionFailurePhase,
    error: unknown,
  ): void {
    this.onFailure(contribution, phase, error)
    const index = this.contributions.indexOf(contribution)
    if (index !== -1) this.contributions.splice(index, 1)
    this.viewportContributions.delete(contribution)
    this.initialUpdates.delete(contribution)
    this.disposeContribution(contribution)
  }

  private disposeContribution(contribution: EditorViewContribution): void {
    try {
      contribution.dispose()
    } catch (error) {
      this.onFailure(contribution, 'dispose', error)
    }
  }
}

function rootUpdate(
  kind: EditorViewContributionUpdateKind,
  change: DocumentSessionChange | null,
): QueuedUpdate {
  return { kind, change, requester: null, cause: null, depth: 0 }
}

function repeatedRequesters(update: QueuedUpdate): ReadonlySet<EditorViewContribution> {
  const seen = new Set<EditorViewContribution>()
  const repeated = new Set<EditorViewContribution>()
  for (let step: QueuedUpdate | null = update; step; step = step.cause) {
    if (!step.requester) continue
    if (seen.has(step.requester)) repeated.add(step.requester)
    seen.add(step.requester)
  }
  return repeated
}

function reentrantUpdateLoop(kind: EditorViewContributionUpdateKind) {
  return createError({
    code: 'EDITOR_VIEW_UPDATE_LOOP',
    message: `View contributions kept re-notifying each other; stopped before another '${kind}' update`,
    why: 'Each update a contribution triggers from update() is delivered after the pass, so one that always triggers another never settles.',
    fix: 'Make the contribution skip the notification when the state it would set is already current.',
    internal: { kind, limit: MAX_REENTRANT_DEPTH },
  })
}
