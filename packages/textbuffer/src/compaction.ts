import type { Piece, PieceBufferId, PieceTableSnapshot, PieceTreeNode } from './pieceTableTypes'
import { join } from './join'
import { createNode, ORIGINAL_BUFFER, own } from './node'
import { remapReverseIndex } from './reverseIndex'
import { publishSnapshotPositions, retainPieceTableSnapshot } from './snapshot'

// Tombstones matter only to deleted anchors, which read only where a gap scan
// stops (tree.ts). Text never lands between two tombstones, so a scan can stop
// in few ways any later edit tells apart: in its own run, at a visible piece,
// in another run, or past an end. Tombstones alike both ways share a stand-in.
const SEALED = -2
const FRONT = -1
const END = -3

// A stand-in sealed on both sides by its neighbours; it must stop no one else.
const TRANSPARENT = Number.MAX_SAFE_INTEGER as PieceBufferId

type Layout = {
  readonly pieces: readonly Piece[]
  // The nearest piece before (after) each one whose buffer is no newer.
  readonly previousAtMost: Int32Array
  readonly nextAtMost: Int32Array
  // For a tombstone, where its run of tombstones starts.
  readonly runStart: Int32Array
}

type Run = { readonly start: number; readonly end: number }

type Group = {
  readonly left: number
  readonly right: number
  readonly inserted: number[]
  threshold: number
  originalStart: number
  originalEnd: number
  originalBreaks: number
  firstLineBreak: number
  contiguous: boolean
}

type RunPlan = {
  readonly run: Run
  readonly pieces: readonly Piece[]
}

export type TombstoneCompactionResult = {
  // Runs replaced, and the tombstones that took with them.
  runs: number
  tombstones: number
  // Runs whose arrangement failed its check and were left as they were. Any
  // is a gap in the reasoning above, which the tests hold at zero.
  unverified: number
}

function* piecesInOrder(root: PieceTreeNode | null): Generator<void, Piece[]> {
  const pieces: Piece[] = []
  const path: PieceTreeNode[] = []
  let node = root
  while (node || path.length > 0) {
    for (; node; node = node.left) path.push(node)
    const next = path.pop()!
    pieces.push(next.piece)
    node = next.right
    if (pieces.length % 1024 === 0) yield
  }
  return pieces
}

function* readLayout(root: PieceTreeNode | null): Generator<void, Layout> {
  const pieces = yield* piecesInOrder(root)
  const count = pieces.length
  const previousAtMost = new Int32Array(count)
  const nextAtMost = new Int32Array(count)
  const runStart = new Int32Array(count)
  const stack: number[] = []
  for (let at = 0; at < count; at++) {
    while (stack.length > 0 && pieces[stack[stack.length - 1]!]!.buffer > pieces[at]!.buffer)
      stack.pop()
    previousAtMost[at] = stack.length > 0 ? stack[stack.length - 1]! : -1
    stack.push(at)
    runStart[at] = at > 0 && !pieces[at - 1]!.visible ? runStart[at - 1]! : at
    if (at % 1024 === 1023) yield
  }
  stack.length = 0
  for (let at = count - 1; at >= 0; at--) {
    while (stack.length > 0 && pieces[stack[stack.length - 1]!]!.buffer > pieces[at]!.buffer)
      stack.pop()
    nextAtMost[at] = stack.length > 0 ? stack[stack.length - 1]! : count
    stack.push(at)
    if (at % 1024 === 0) yield
  }
  return { pieces, previousAtMost, nextAtMost, runStart }
}

// A visible piece and a run are told apart by parity.
const blockerKey = (layout: Layout, at: number): number =>
  layout.pieces[at]!.visible ? 2 * at : 2 * layout.runStart[at]! + 1

const leftKey = (layout: Layout, blocker: number, run: Run): number => {
  if (blocker >= run.start) return SEALED
  if (blocker < 0) return FRONT
  return blockerKey(layout, blocker)
}

// Nothing lands after the last visible piece, so a scan off the end of a
// trailing run stops as if inside it.
const rightKey = (layout: Layout, blocker: number, run: Run): number => {
  if (blocker <= run.end) return SEALED
  const count = layout.pieces.length
  if (blocker < count) return blockerKey(layout, blocker)
  const last = count - 1
  if (layout.pieces[last]!.visible) return END
  return layout.runStart[last] === run.start ? SEALED : blockerKey(layout, last)
}

// Where a scan with `threshold` stops once it leaves the run. The chains of
// nearest no-newer pieces skip everything newer than the piece they start at.
const leftBlocker = (layout: Layout, threshold: number, run: Run): number => {
  let at = run.start - 1
  while (at >= 0 && layout.pieces[at]!.buffer > threshold) at = layout.previousAtMost[at]!
  return at
}

const rightBlocker = (layout: Layout, threshold: number, run: Run): number => {
  let at = run.end + 1
  const count = layout.pieces.length
  while (at < count && layout.pieces[at]!.buffer > threshold) at = layout.nextAtMost[at]!
  return at
}

const createGroup = (left: number, right: number): Group => ({
  left,
  right,
  inserted: [],
  threshold: Infinity,
  originalStart: -1,
  originalEnd: -1,
  originalBreaks: 0,
  firstLineBreak: 0,
  contiguous: true,
})

// Original tombstones stay pieces: original anchors are found by summing their lengths.
const addOriginal = (group: Group, piece: Piece): void => {
  if (group.originalStart < 0) {
    group.originalStart = piece.start
    group.firstLineBreak = piece.firstLineBreak
  } else if (group.originalEnd !== piece.start) {
    group.contiguous = false
  }
  group.originalEnd = piece.start + piece.length
  group.originalBreaks += piece.lineBreaks
}

const groupMembers = (layout: Layout, run: Run): Map<string, Group> => {
  const groups = new Map<string, Group>()
  for (let at = run.start; at <= run.end; at++) {
    const left = leftKey(layout, layout.previousAtMost[at]!, run)
    const right = rightKey(layout, layout.nextAtMost[at]!, run)
    const key = `${left} ${right}`
    const group = groups.get(key) ?? createGroup(left, right)
    groups.set(key, group)
    const piece = layout.pieces[at]!
    group.threshold = Math.min(group.threshold, piece.buffer)
    if (piece.buffer === ORIGINAL_BUFFER) addOriginal(group, piece)
    else group.inserted.push(at)
  }
  return groups
}

type Slot = { readonly group: Group; readonly threshold: number; readonly original: boolean }

// Within a group the stand-in goes where it keeps the group's open side open:
// before the original tombstone on the left, after it on the right.
const groupSlots = (layout: Layout, group: Group, transparent: boolean): Slot[] => {
  const slots: Slot[] = []
  if (group.originalStart >= 0) slots.push({ group, threshold: ORIGINAL_BUFFER, original: true })
  if (group.inserted.length === 0) return slots
  let threshold = TRANSPARENT as number
  if (!transparent) {
    for (const at of group.inserted) threshold = Math.min(threshold, layout.pieces[at]!.buffer)
  }
  const standIn = { group, threshold, original: false }
  if (group.left !== SEALED && group.right === SEALED) slots.unshift(standIn)
  else slots.push(standIn)
  return slots
}

// Left-open groups by falling threshold, the both-open one, right-open groups
// by rising threshold; the sealed group sits where it has neighbours both ways.
const arrange = (layout: Layout, groups: Iterable<Group>): Slot[] => {
  const leftOpen: Group[] = []
  const bothOpen: Group[] = []
  const rightOpen: Group[] = []
  let sealed: Group | null = null
  for (const group of groups) {
    if (group.left === SEALED && group.right === SEALED) sealed = group
    else if (group.right === SEALED) leftOpen.push(group)
    else if (group.left === SEALED) rightOpen.push(group)
    else bothOpen.push(group)
  }
  leftOpen.sort((a, b) => b.threshold - a.threshold)
  rightOpen.sort((a, b) => a.threshold - b.threshold)
  const middle = sealed ? groupSlots(layout, sealed, true) : []
  const slots = leftOpen.flatMap((group) => groupSlots(layout, group, false))
  if (leftOpen.length > 0) slots.push(...middle)
  for (const group of bothOpen) slots.push(...groupSlots(layout, group, false))
  if (leftOpen.length === 0) slots.push(...middle)
  for (const group of rightOpen) slots.push(...groupSlots(layout, group, false))
  return slots
}

const sealedBy = (slots: readonly Slot[], from: number, to: number, threshold: number): boolean => {
  for (let at = from; at < to; at++) if (slots[at]!.threshold <= threshold) return true
  return false
}

// Every slot must end both scans where its group's tombstones did. This is the
// proof the arrangement needs, checked per run rather than trusted.
const scansMatch = (layout: Layout, run: Run, slots: readonly Slot[]): boolean => {
  for (let at = 0; at < slots.length; at++) {
    const { group, threshold } = slots[at]!
    const left = sealedBy(slots, 0, at, threshold)
      ? SEALED
      : leftKey(layout, leftBlocker(layout, threshold, run), run)
    const right = sealedBy(slots, at + 1, slots.length, threshold)
      ? SEALED
      : rightKey(layout, rightBlocker(layout, threshold, run), run)
    if (left !== group.left || right !== group.right) return false
  }
  return true
}

// Scans from outside stop at a run's oldest piece, and original offsets are a
// prefix sum, so both must come through unchanged.
const outsideMatches = (layout: Layout, run: Run, slots: readonly Slot[]): boolean => {
  let oldest = Infinity
  let originalStart = -1
  let originalEnd = -1
  for (let at = run.start; at <= run.end; at++) {
    const piece = layout.pieces[at]!
    oldest = Math.min(oldest, piece.buffer)
    if (piece.buffer !== ORIGINAL_BUFFER) continue
    if (originalStart < 0) originalStart = piece.start
    originalEnd = piece.start + piece.length
  }
  let placed = Infinity
  let cursor = originalStart
  for (const slot of slots) {
    placed = Math.min(placed, slot.threshold)
    if (!slot.original) continue
    if (!slot.group.contiguous || slot.group.originalStart !== cursor) return false
    cursor = slot.group.originalEnd
  }
  return placed === oldest && cursor === originalEnd
}

const slotPiece = (slot: Slot, order: number): Piece => {
  const group = slot.group
  if (slot.original) {
    return {
      buffer: ORIGINAL_BUFFER,
      start: group.originalStart,
      length: group.originalEnd - group.originalStart,
      order,
      lineBreaks: group.originalBreaks,
      firstLineBreak: group.firstLineBreak,
      visible: false,
    }
  }
  return {
    buffer: slot.threshold as PieceBufferId,
    start: 0,
    length: 0,
    order,
    lineBreaks: 0,
    firstLineBreak: 0,
    visible: false,
  }
}

// The stand-ins take the orders of the run's first pieces, which already sit
// between the run's neighbours. Each inserted tombstone's entries, and those of
// any stand-in it replaces, follow its group's stand-in.
const planRun = (
  layout: Layout,
  run: Run,
  remap: Map<number, number>,
): RunPlan | 'kept' | 'unverified' => {
  const slots = arrange(layout, groupMembers(layout, run).values())
  if (slots.length > run.end - run.start) return 'kept'
  if (!scansMatch(layout, run, slots) || !outsideMatches(layout, run, slots)) return 'unverified'
  const pieces = slots.map((slot, at) => slotPiece(slot, layout.pieces[run.start + at]!.order))
  for (let at = 0; at < slots.length; at++) {
    if (slots[at]!.original) continue
    const order = pieces[at]!.order
    for (const member of slots[at]!.group.inserted) remap.set(layout.pieces[member]!.order, order)
  }
  return { run, pieces }
}

function* runsOf(layout: Layout): Generator<Run> {
  const count = layout.pieces.length
  for (let at = 0; at < count; at++) {
    if (layout.pieces[at]!.visible) continue
    const start = at
    while (at + 1 < count && !layout.pieces[at + 1]!.visible) at++
    if (at > start) yield { start, end: at }
  }
}

// Nodes with an order below `order`, and the rest.
const splitBelow = (
  node: PieceTreeNode | null,
  order: number,
  epoch: number,
): [PieceTreeNode | null, PieceTreeNode | null] => {
  if (!node) return [null, null]
  if (node.piece.order < order) {
    const [lower, upper] = splitBelow(node.right, order, epoch)
    return [join(node.left, own(node, epoch), lower, epoch), upper]
  }
  const [lower, upper] = splitBelow(node.left, order, epoch)
  return [lower, join(upper, own(node, epoch), node.right, epoch)]
}

const replaceRun = (
  root: PieceTreeNode | null,
  layout: Layout,
  plan: RunPlan,
  epoch: number,
): PieceTreeNode => {
  const { run, pieces } = plan
  const following = layout.pieces[run.end + 1]
  const [before, rest] = splitBelow(root, layout.pieces[run.start]!.order, epoch)
  const [, after] = splitBelow(rest, following ? following.order : Infinity, epoch)
  let left = before
  for (let at = 0; at < pieces.length - 1; at++) {
    left = join(left, createNode(pieces[at]!, null, null, epoch), null, epoch)
  }
  return join(left, createNode(pieces[pieces.length - 1]!, null, null, epoch), after, epoch)
}

// Rebuilt nodes carry an epoch no lineage ever reaches, so every later edit
// copies them like any retained node.
let compactionEpoch = 0

// Compacts every run of tombstones in `snapshot` and republishes it in place.
// Each deleted anchor resolves to the same offset as before, in this snapshot
// and in every snapshot edited from it.
export function* compactTombstones(
  snapshot: PieceTableSnapshot,
): Generator<void, TombstoneCompactionResult> {
  const result: TombstoneCompactionResult = { runs: 0, tombstones: 0, unverified: 0 }
  if (snapshot.consumed || !snapshot.root) return result
  retainPieceTableSnapshot(snapshot)
  const root = snapshot.root
  const layout = yield* readLayout(root)
  const remap = new Map<number, number>()
  const plans: RunPlan[] = []
  for (const run of runsOf(layout)) {
    const plan = planRun(layout, run, remap)
    if (plan === 'unverified') result.unverified++
    else if (plan !== 'kept') plans.push(plan)
    yield
  }
  if (plans.length === 0) return result

  const epoch = --compactionEpoch
  let next: PieceTreeNode | null = root
  for (const plan of plans) {
    next = replaceRun(next, layout, plan, epoch)
    result.runs++
    result.tombstones += plan.run.end - plan.run.start + 1 - plan.pieces.length
    yield
  }
  const reverseIndex = yield* remapReverseIndex(snapshot.reverseIndex, remap)
  if (!publishSnapshotPositions(snapshot, root, next, reverseIndex)) {
    return { runs: 0, tombstones: 0, unverified: result.unverified }
  }
  return result
}

// A standalone caller drains the same incremental pass.
export function compactPieceTableTombstones(
  snapshot: PieceTableSnapshot,
): TombstoneCompactionResult {
  const job = compactTombstones(snapshot)
  for (;;) {
    const step = job.next()
    if (step.done) return step.value
  }
}
