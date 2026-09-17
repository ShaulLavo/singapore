import type {
  Piece,
  PieceBufferLineIndex,
  PieceTableReverseSplitNode,
  PieceTableSnapshot,
  PieceTreeNode,
} from './pieceTableTypes'
import { createInspectionLabels, walkInspectionTree } from './inspectionWalk'
import { reverseIndexEntries, reverseIndexSlot } from './reverseIndex'
import { bufferStoreExtent } from './buffers'
import { ORIGINAL_BUFFER } from './node'

export type PieceTreeIssueKind =
  | 'cycle'
  | 'structure'
  | 'ordering'
  | 'aggregate'
  | 'buffer-bounds'
  | 'line-breaks'
  | 'balance'
  | 'snapshot'
  | 'reverse-index'
  | 'line-index'
export type PieceTreeIssue = {
  readonly kind: PieceTreeIssueKind
  readonly node: string
  readonly field: string
  readonly expected: number | string | boolean
  readonly actual: number | string | boolean | undefined
}
export type PieceTreeValidation = {
  readonly issues: readonly PieceTreeIssue[]
  readonly counts: {
    readonly nodes: number
    readonly visible: number
    readonly invisible: number
    readonly reverseEntries: number
    readonly lineIndexes: number
  }
}

type Report = (
  kind: PieceTreeIssueKind,
  node: string,
  field: string,
  expected: PieceTreeIssue['expected'],
  actual: PieceTreeIssue['actual'],
) => void
type Totals = Pick<
  PieceTreeNode,
  | 'subtreeOriginalLength'
  | 'subtreeVisibleLength'
  | 'subtreePieces'
  | 'subtreeLineBreaks'
  | 'subtreeMinOrder'
  | 'subtreeMaxOrder'
  | 'subtreeMinBuffer'
>
const empty: Totals = {
  subtreeOriginalLength: 0,
  subtreeVisibleLength: 0,
  subtreePieces: 0,
  subtreeLineBreaks: 0,
  subtreeMinOrder: Infinity,
  subtreeMaxOrder: -Infinity,
  subtreeMinBuffer: Infinity,
}
export const inspectionPieceFields = [
  'buffer',
  'start',
  'length',
  'order',
  'lineBreaks',
  'visible',
] as const
export const inspectionPieceKey = (piece: Pick<Piece, 'buffer' | 'start'>): string =>
  JSON.stringify([piece.buffer, piece.start])

function rawLineBreaks(text: string, start: number, end: number): number {
  let count = 0
  for (let at = start; at < end; at++) if (text.charCodeAt(at) === 10) count++
  return count
}

function checkPiece(
  snapshot: PieceTableSnapshot,
  node: PieceTreeNode,
  id: string,
  report: Report,
): number {
  const piece = node.piece
  const text = snapshot.buffers.chunks.get(piece.buffer)
  if (text === undefined)
    report('buffer-bounds', id, 'piece.buffer', 'existing buffer', piece.buffer)
  const validStart =
    Number.isSafeInteger(piece.start) && piece.start >= 0 && piece.start <= (text?.length ?? 0)
  const validLength =
    Number.isSafeInteger(piece.length) &&
    piece.length > 0 &&
    piece.start + piece.length <= (text?.length ?? 0)
  if (!validStart)
    report('buffer-bounds', id, 'piece.start', `integer in [0, ${text?.length ?? 0}]`, piece.start)
  if (!validLength)
    report(
      'buffer-bounds',
      id,
      'piece.length',
      `positive integer with end <= ${text?.length ?? 0}`,
      piece.length,
    )
  if (!Number.isFinite(piece.order))
    report('ordering', id, 'piece.order', 'finite order', piece.order)
  if (text === undefined || !validStart || !validLength) return NaN
  const breaks = rawLineBreaks(text, piece.start, piece.start + piece.length)
  report('line-breaks', id, 'piece.lineBreaks', breaks, piece.lineBreaks)
  return breaks
}

function checkTotals(
  node: PieceTreeNode,
  left: Totals,
  right: Totals,
  breaks: number,
  id: string,
  report: Report,
): Totals {
  const p = node.piece
  const result: Totals = {
    subtreeOriginalLength:
      left.subtreeOriginalLength +
      (p.buffer === ORIGINAL_BUFFER ? p.length : 0) +
      right.subtreeOriginalLength,
    subtreeVisibleLength:
      left.subtreeVisibleLength + (p.visible ? p.length : 0) + right.subtreeVisibleLength,
    subtreePieces: left.subtreePieces + 1 + right.subtreePieces,
    subtreeLineBreaks: left.subtreeLineBreaks + (p.visible ? breaks : 0) + right.subtreeLineBreaks,
    subtreeMinOrder: Math.min(left.subtreeMinOrder, p.order, right.subtreeMinOrder),
    subtreeMaxOrder: Math.max(left.subtreeMaxOrder, p.order, right.subtreeMaxOrder),
    subtreeMinBuffer: Math.min(left.subtreeMinBuffer, p.buffer, right.subtreeMinBuffer),
  }
  for (const field of Object.keys(empty) as Array<keyof Totals>)
    report('aggregate', id, field, result[field], node[field])
  if (left.subtreeMaxOrder >= p.order)
    report('ordering', id, 'left.order', `< ${p.order}`, left.subtreeMaxOrder)
  if (right.subtreeMinOrder <= p.order)
    report('ordering', id, 'right.order', `> ${p.order}`, right.subtreeMinOrder)
  return result
}

// Sibling heights at most one apart, in both trees.
function checkBalance(node: PieceTreeNode, id: string, report: Report): void {
  const left = node.left?.height ?? 0
  const right = node.right?.height ?? 0
  report('balance', id, 'height', 1 + Math.max(left, right), node.height)
  if (Math.abs(left - right) > 1) {
    report('balance', id, 'children', 'balanced subtrees', 'unbalanced')
  }
}

function checkSplitBalance(
  node: PieceTableReverseSplitNode | null,
  id: string,
  report: Report,
): number {
  if (!node) return 0
  const left = checkSplitBalance(node.left, id, report)
  const right = checkSplitBalance(node.right, id, report)
  report('balance', id, `height@${node.start}`, 1 + Math.max(left, right), node.height)
  if (Math.abs(left - right) > 1)
    report('balance', id, `children@${node.start}`, 'balanced subtrees', 'unbalanced')
  return node.height
}

function checkLineIndex(index: PieceBufferLineIndex, id: string, report: Report): void {
  report('line-index', id, 'scannedLength', index.text.length, index.scannedLength)
  const countValid =
    Number.isSafeInteger(index.count) && index.count >= 0 && index.count <= index.offsets.length
  if (!countValid)
    report('line-index', id, 'count', `integer in [0, ${index.offsets.length}]`, index.count)
  let count = 0
  for (let at = 0; at < index.text.length; at++) {
    if (index.text.charCodeAt(at) !== 10) continue
    report(
      'line-index',
      id,
      `offsets[${count}]`,
      at,
      count < index.count ? index.offsets[count] : undefined,
    )
    count++
  }
  report('line-index', id, 'count', count, index.count)
}

// The store is shared with newer snapshots; the extent is what this snapshot
// may see of it, and it must agree with the id sequence the snapshot mints from.
function checkStoreExtent(snapshot: PieceTableSnapshot, report: Report): void {
  const extent = bufferStoreExtent(snapshot.buffers)
  if (!extent) return
  const buffers = snapshot.buffers
  report(
    'buffer-bounds',
    'buffers',
    'nextBufferSequence',
    extent.bufferCount,
    buffers.nextBufferSequence,
  )
  report('buffer-bounds', 'buffers', 'chunks.size', extent.chunkCount, buffers.chunks.size)
  report('buffer-bounds', 'buffers', 'chunkWithinLimit', true, extent.overflowingChunk === null)
}

// What anchor resolution takes for granted about the document order: a
// buffer's pieces appear in buffer order with nothing missing between them,
// and whatever sits between two of them is newer than they are.
function checkBufferOrder(
  pieces: readonly PieceTreeNode[],
  label: (node: PieceTreeNode) => string,
  report: Report,
): void {
  const ends = new Map<number, number>()
  const open: number[] = []
  const closed = new Set<number>()
  for (const node of pieces) {
    const { buffer, start, length } = node.piece
    const expected = ends.get(buffer) ?? (buffer === ORIGINAL_BUFFER ? 0 : start)
    report('ordering', label(node), 'piece.start', expected, start)
    ends.set(buffer, start + length)

    while (open.length > 0 && open[open.length - 1]! > buffer) closed.add(open.pop()!)
    if (closed.has(buffer))
      report('ordering', label(node), 'piece.buffer', 'no older piece inside a buffer', buffer)
    if (open[open.length - 1] !== buffer) open.push(buffer)
  }
}

// One entry per inserted piece, keyed by its start, or by 0 for a buffer's
// first piece, and holding its order.
function checkReverseIndex(
  snapshot: PieceTableSnapshot,
  pieces: readonly PieceTreeNode[],
  label: (node: PieceTreeNode) => string,
  report: Report,
): number {
  const entries = reverseIndexEntries(snapshot.reverseIndex)
  const orders = new Map<string, number>()
  for (const entry of entries) orders.set(inspectionPieceKey(entry), entry.order)
  if (orders.size !== entries.length)
    report('reverse-index', 'reverse', 'keys', 'unique buffer/start', 'duplicate')

  const seen = new Set<number>()
  let expected = 0
  for (const node of pieces) {
    const piece = node.piece
    if (piece.buffer === ORIGINAL_BUFFER) continue
    expected++
    const key = inspectionPieceKey({
      buffer: piece.buffer,
      start: seen.has(piece.buffer) ? piece.start : 0,
    })
    seen.add(piece.buffer)
    report('reverse-index', label(node), `reverseEntry ${key}`, piece.order, orders.get(key))
  }
  report('reverse-index', 'reverse', 'entries', expected, entries.length)

  for (let at = 0; at < snapshot.reverseIndex.count; at++) {
    const slot = reverseIndexSlot(snapshot.reverseIndex, at)
    if (typeof slot === 'object') checkSplitBalance(slot, `reverse buffer ${at + 1}`, report)
  }
  return entries.length
}

export function validatePieceTreeInvariants(
  snapshot: PieceTableSnapshot,
  label = createInspectionLabels(),
): PieceTreeValidation {
  const issues: PieceTreeIssue[] = []
  const report: Report = (kind, node, field, expected, actual) => {
    if (Object.is(expected, actual)) return
    issues.push(Object.freeze({ kind, node, field, expected, actual }))
  }
  const totals = new Map<PieceTreeNode, Totals>()
  const breaks = new Map<PieceTreeNode, number>()
  const pieces = new Map<string, PieceTreeNode>()
  const visited: PieceTreeNode[] = []
  const counts = { nodes: 0, visible: 0, invisible: 0, reverseEntries: 0, lineIndexes: 0 }
  walkInspectionTree(
    snapshot.root,
    ({ node }) => {
      counts.nodes++
      visited.push(node)
      if (node.piece.visible) counts.visible++
      else counts.invisible++
      const id = label(node)
      breaks.set(node, checkPiece(snapshot, node, id, report))
      checkBalance(node, id, report)
      const key = inspectionPieceKey(node.piece)
      if (pieces.has(key)) report('structure', id, 'piece.key', 'unique buffer/start', key)
      pieces.set(key, node)
    },
    (node) => {
      const left = node.left ? totals.get(node.left) : empty
      const right = node.right ? totals.get(node.right) : empty
      if (!left || !right) return
      totals.set(node, checkTotals(node, left, right, breaks.get(node) ?? NaN, label(node), report))
    },
    ({ node, parent, edge }, cycle) =>
      report(
        cycle ? 'cycle' : 'structure',
        parent ? label(parent) : label(node),
        edge,
        'tree child',
        label(node),
      ),
  )
  const rootTotals = snapshot.root ? totals.get(snapshot.root) : empty
  if (rootTotals) {
    report('snapshot', 'snapshot', 'length', rootTotals.subtreeVisibleLength, snapshot.length)
    report('snapshot', 'snapshot', 'pieceCount', rootTotals.subtreePieces, snapshot.pieceCount)
  }
  // Document order is the order of the orders; a cyclic tree cannot be walked for it.
  const ordered = visited.toSorted((a, b) => a.piece.order - b.piece.order)
  checkBufferOrder(ordered, label, report)
  counts.reverseEntries = checkReverseIndex(snapshot, ordered, label, report)
  for (const [chunk, index] of snapshot.buffers.lineIndexes) {
    counts.lineIndexes++
    checkLineIndex(index, `chunk ${chunk}`, report)
  }
  checkStoreExtent(snapshot, report)
  return Object.freeze({ issues: Object.freeze(issues), counts: Object.freeze(counts) })
}
