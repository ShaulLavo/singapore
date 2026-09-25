import {
  anchorAt,
  resolveAnchor,
  type PieceTableAnchor,
  type PieceTableSnapshot,
} from '@singapore-editor/textbuffer'
import type { CursorHistoryEntry } from './cursorHistory'
import { sameCursorSelections } from './cursorHistory'

export type JumpCause = 'pointer' | 'find' | 'go-to-line' | 'provider'

type AnchoredSelection = {
  readonly anchor: PieceTableAnchor
  readonly head: PieceTableAnchor
  readonly affinity: 'before' | 'after'
}

export type JumpLocation = {
  readonly selections: readonly AnchoredSelection[]
  readonly lastAddedIndex: number
  readonly viewport: PieceTableAnchor
  readonly topDelta: number
  readonly scrollLeft: number
}

export type ResolvedJumpLocation = CursorHistoryEntry & {
  readonly viewportOffset: number
  readonly topDelta: number
}

export function captureJumpLocation(
  snapshot: PieceTableSnapshot,
  cursor: CursorHistoryEntry,
  viewportOffset: number,
  topDelta: number,
): JumpLocation {
  return {
    selections: cursor.selections.map((selection) => ({
      anchor: anchorAt(snapshot, selection.anchor, 'right'),
      head: anchorAt(snapshot, selection.head, 'right'),
      affinity: selection.affinity ?? 'after',
    })),
    lastAddedIndex: cursor.lastAddedIndex,
    viewport: anchorAt(snapshot, viewportOffset, 'right'),
    topDelta,
    scrollLeft: cursor.scrollLeft,
  }
}

export function resolveJumpLocation(
  snapshot: PieceTableSnapshot,
  location: JumpLocation,
): ResolvedJumpLocation | null {
  const primary = location.selections[0]
  if (
    !primary ||
    resolveAnchor(snapshot, primary.head).liveness === 'deleted' ||
    resolveAnchor(snapshot, primary.anchor).liveness === 'deleted'
  )
    return null
  const selections: CursorHistoryEntry['selections'][number][] = []
  let lastAddedIndex = 0
  for (const [index, selection] of location.selections.entries()) {
    const anchor = resolveAnchor(snapshot, selection.anchor)
    const head = resolveAnchor(snapshot, selection.head)
    if (anchor.liveness === 'deleted' || head.liveness === 'deleted') continue
    if (index === location.lastAddedIndex) lastAddedIndex = selections.length
    selections.push({ anchor: anchor.offset, head: head.offset, affinity: selection.affinity })
  }
  if (selections.length === 0) return null
  return {
    selections,
    lastAddedIndex,
    scrollLeft: location.scrollLeft,
    scrollTop: 0,
    viewportOffset: resolveAnchor(snapshot, location.viewport).offset,
    topDelta: location.topDelta,
  }
}

export class JumpHistory {
  private entries: JumpLocation[] = []
  private index = -1
  private walking = false

  clear(): void {
    this.entries = []
    this.index = -1
    this.walking = false
  }

  record(snapshot: PieceTableSnapshot, origin: JumpLocation, destination: JumpLocation): void {
    if (sameLocations(snapshot, origin, destination)) return
    this.entries.splice(this.index + 1)
    const last = this.entries.at(-1)
    if (!last || !sameLocations(snapshot, last, origin)) this.entries.push(origin)
    this.entries.push(destination)
    if (this.entries.length > 50) this.entries.splice(0, this.entries.length - 50)
    this.index = this.entries.length - 1
    this.walking = false
  }

  move(
    snapshot: PieceTableSnapshot,
    direction: 'back' | 'forward',
    current: JumpLocation,
  ): ResolvedJumpLocation | null {
    if (this.index < 0) return null
    if (!this.walking || !sameLocations(snapshot, this.entries[this.index]!, current))
      this.entries[this.index] = current
    const step = direction === 'back' ? -1 : 1
    for (let index = this.index + step; index >= 0 && index < this.entries.length; index += step) {
      const location = this.entries[index]!
      const resolved = resolveJumpLocation(snapshot, location)
      if (!resolved || sameLocations(snapshot, location, current)) continue
      this.index = index
      this.walking = true
      return resolved
    }
    return null
  }
}

function sameLocations(
  snapshot: PieceTableSnapshot,
  left: JumpLocation,
  right: JumpLocation,
): boolean {
  const a = resolveJumpLocation(snapshot, left)
  const b = resolveJumpLocation(snapshot, right)
  return a !== null && b !== null && sameCursorSelections(a, b)
}
