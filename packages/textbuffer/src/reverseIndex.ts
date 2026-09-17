import type {
  AnchorBias,
  Piece,
  PieceBufferId,
  PieceTableReverseBranch,
  PieceTableReverseIndex,
  PieceTableReverseSlot,
  PieceTableReverseSplitNode,
  PieceTableReverseTail,
  PieceTreeNode,
} from './pieceTableTypes'
import { ORIGINAL_BUFFER } from './node'

const BITS = 4
const WIDTH = 1 << BITS
const MASK = WIDTH - 1

type Leaf = readonly PieceTableReverseSlot[]

// A literal, so the array holds tagged values from the start: `new Array`
// would begin as small integers and be rewritten on its first order.
const emptySlots = (): PieceTableReverseSlot[] => [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
]

// The one place an index is made, so every one has the same hidden class.
const reverseIndexOf = (
  count: number,
  shift: number,
  root: PieceTableReverseIndex['root'],
  tail: PieceTableReverseTail,
): PieceTableReverseIndex => ({ count, shift, root, tail })

const createReverseIndex = (): PieceTableReverseIndex =>
  reverseIndexOf(0, BITS, null, { slots: emptySlots(), used: 0 })

// Where the tail begins. A full tail stays the tail until the next append.
const tailOffset = (count: number): number => (count < WIDTH ? 0 : ((count - 1) >>> BITS) << BITS)

const splitHeight = (node: PieceTableReverseSplitNode | null): number => (node ? node.height : 0)

const splitNode = (
  start: number,
  order: number,
  left: PieceTableReverseSplitNode | null,
  right: PieceTableReverseSplitNode | null,
): PieceTableReverseSplitNode => {
  const leftHeight = splitHeight(left)
  const rightHeight = splitHeight(right)
  return {
    start,
    order,
    height: (leftHeight > rightHeight ? leftHeight : rightHeight) + 1,
    left,
    right,
  }
}

// AVL repair while rebuilding a node one of whose sides grew by at most one.
const balancedSplitNode = (
  start: number,
  order: number,
  left: PieceTableReverseSplitNode | null,
  right: PieceTableReverseSplitNode | null,
): PieceTableReverseSplitNode => {
  const lean = splitHeight(left) - splitHeight(right)
  if (lean > 1) {
    const pivot = left!
    if (splitHeight(pivot.left) >= splitHeight(pivot.right)) {
      return splitNode(
        pivot.start,
        pivot.order,
        pivot.left,
        splitNode(start, order, pivot.right, right),
      )
    }
    const inner = pivot.right!
    return splitNode(
      inner.start,
      inner.order,
      splitNode(pivot.start, pivot.order, pivot.left, inner.left),
      splitNode(start, order, inner.right, right),
    )
  }
  if (lean < -1) {
    const pivot = right!
    if (splitHeight(pivot.right) >= splitHeight(pivot.left)) {
      return splitNode(
        pivot.start,
        pivot.order,
        splitNode(start, order, left, pivot.left),
        pivot.right,
      )
    }
    const inner = pivot.left!
    return splitNode(
      inner.start,
      inner.order,
      splitNode(start, order, left, inner.left),
      splitNode(pivot.start, pivot.order, inner.right, pivot.right),
    )
  }
  return splitNode(start, order, left, right)
}

const insertSplit = (
  node: PieceTableReverseSplitNode | null,
  start: number,
  order: number,
): PieceTableReverseSplitNode => {
  if (!node) return splitNode(start, order, null, null)
  if (start === node.start) return splitNode(start, order, node.left, node.right)
  if (start < node.start) {
    return balancedSplitNode(
      node.start,
      node.order,
      insertSplit(node.left, start, order),
      node.right,
    )
  }
  return balancedSplitNode(node.start, node.order, node.left, insertSplit(node.right, start, order))
}

// A cut keeps the first part's key and order, so only later parts arrive
// here, and a slot that held one order becomes that piece plus the new one.
const slotWithPiece = (slot: PieceTableReverseSlot, piece: Piece): PieceTableReverseSlot => {
  if (slot === undefined) return piece.order
  const pieces = typeof slot === 'number' ? splitNode(0, slot, null, null) : slot
  return insertSplit(pieces, piece.start, piece.order)
}

// The slot of inserted buffer `at + 1`.
export const reverseIndexSlot = (
  index: PieceTableReverseIndex,
  at: number,
): PieceTableReverseSlot => {
  if (at < 0 || at >= index.count) return undefined
  const offset = tailOffset(index.count)
  if (at >= offset) return index.tail.slots[at - offset]

  let node = index.root as PieceTableReverseBranch
  for (let level = index.shift; level > BITS; level -= BITS) {
    node = node[(at >>> level) & MASK] as PieceTableReverseBranch
  }
  return (node[(at >>> BITS) & MASK] as Leaf)[at & MASK]
}

const privateTail = (index: PieceTableReverseIndex, length: number): PieceTableReverseSlot[] => {
  const slots = emptySlots()
  for (let at = 0; at < length; at += 1) slots[at] = index.tail.slots[at]
  return slots
}

// Every copy of a vector node, so the counters see each one.
const copyBranch = <Node extends readonly unknown[]>(node: Node): Node[number][] => node.slice()

const pathTo = (level: number, leaf: Leaf): PieceTableReverseBranch | Leaf =>
  level === 0 ? leaf : [pathTo(level - BITS, leaf)]

const pushLeaf = (
  parent: PieceTableReverseBranch,
  level: number,
  last: number,
  leaf: Leaf,
): PieceTableReverseBranch => {
  const next = copyBranch(parent)
  const at = (last >>> level) & MASK
  const child = parent[at] as PieceTableReverseBranch | undefined
  if (level === BITS) next[at] = leaf
  else next[at] = child ? pushLeaf(child, level - BITS, last, leaf) : pathTo(level - BITS, leaf)
  return next
}

// The full tail becomes a leaf of the vector and `slot` starts the next tail.
const appendPastFullTail = (
  index: PieceTableReverseIndex,
  slot: PieceTableReverseSlot,
): PieceTableReverseIndex => {
  const leaf = index.tail.slots
  const slots = emptySlots()
  slots[0] = slot
  const tail = { slots, used: 1 }
  const count = index.count + 1
  const root = index.root as PieceTableReverseBranch | null
  if (!root) return reverseIndexOf(count, BITS, [leaf], tail)
  if (index.count >>> BITS > 1 << index.shift) {
    return reverseIndexOf(count, index.shift + BITS, [root, pathTo(index.shift, leaf)], tail)
  }
  return reverseIndexOf(
    count,
    index.shift,
    pushLeaf(root, index.shift, index.count - 1, leaf),
    tail,
  )
}

// The newest buffer always has the next id, so it is an append. The first
// snapshot to append after its parent writes the shared tail's free slot and
// copies nothing; a sibling branch that comes second takes a private tail.
const appendSlot = (
  index: PieceTableReverseIndex,
  slot: PieceTableReverseSlot,
): PieceTableReverseIndex => {
  const length = index.count - tailOffset(index.count)
  if (length === WIDTH) return appendPastFullTail(index, slot)

  const tail =
    index.tail.used === length ? index.tail : { slots: privateTail(index, length), used: length }
  tail.slots[length] = slot
  tail.used = length + 1
  return reverseIndexOf(index.count + 1, index.shift, index.root, tail)
}

const replaceInBranch = (
  node: PieceTableReverseBranch,
  level: number,
  at: number,
  slot: PieceTableReverseSlot,
): PieceTableReverseBranch => {
  const next = copyBranch(node)
  const child = (at >>> level) & MASK
  if (level > BITS) {
    next[child] = replaceInBranch(node[child] as PieceTableReverseBranch, level - BITS, at, slot)
    return next
  }
  const leaf = copyBranch(node[child] as Leaf)
  leaf[at & MASK] = slot
  next[child] = leaf
  return next
}

// A filled slot is visible to older snapshots, so replacing one copies.
const replaceSlot = (
  index: PieceTableReverseIndex,
  at: number,
  slot: PieceTableReverseSlot,
): PieceTableReverseIndex => {
  const offset = tailOffset(index.count)
  if (at >= offset) {
    const length = index.count - offset
    const slots = privateTail(index, length)
    slots[at - offset] = slot
    return reverseIndexOf(index.count, index.shift, index.root, { slots, used: length })
  }
  const root = replaceInBranch(index.root as PieceTableReverseBranch, index.shift, at, slot)
  return reverseIndexOf(index.count, index.shift, root, index.tail)
}

const addPiece = (index: PieceTableReverseIndex, piece: Piece): PieceTableReverseIndex => {
  const at = piece.buffer - 1
  let next = index
  while (next.count < at) next = appendSlot(next, undefined)
  if (next.count === at) return appendSlot(next, piece.order)
  return replaceSlot(next, at, slotWithPiece(reverseIndexSlot(next, at), piece))
}

// `pieces` are the ones an edit gave a new key: inserted text and the later
// parts of a cut. A tombstone, a coalesced tail and a cut's first part keep
// their key and order, and an entry holds nothing else, so they write nothing.
export const applyReverseIndexChanges = (
  index: PieceTableReverseIndex,
  pieces: readonly Piece[],
): PieceTableReverseIndex => {
  let next = index
  for (const piece of pieces) {
    if (piece.buffer === ORIGINAL_BUFFER) continue
    next = addPiece(next, piece)
  }
  return next
}

const balancedSplit = (
  entries: readonly number[],
  from: number,
  to: number,
): PieceTableReverseSplitNode | null => {
  if (from >= to) return null
  const middle = (from + to) >>> 1
  return splitNode(
    middle === 0 ? 0 : entries[middle * 2]!,
    entries[middle * 2 + 1]!,
    balancedSplit(entries, from, middle),
    balancedSplit(entries, middle + 1, to),
  )
}

// Start and order pairs per buffer. A buffer's pieces keep their buffer order
// in the document, so walking the tree in order leaves each list sorted.
const collectEntries = (node: PieceTreeNode | null, buffers: (number[] | undefined)[]): void => {
  if (!node) return
  collectEntries(node.left, buffers)
  const piece = node.piece
  if (piece.buffer !== ORIGINAL_BUFFER) {
    const entries = (buffers[piece.buffer - 1] ??= [])
    entries.push(piece.start, piece.order)
  }
  collectEntries(node.right, buffers)
}

export const buildReverseIndex = (root: PieceTreeNode | null): PieceTableReverseIndex => {
  const buffers: (number[] | undefined)[] = []
  collectEntries(root, buffers)

  let index = createReverseIndex()
  for (let at = 0; at < buffers.length; at += 1) {
    const entries = buffers[at]
    if (!entries) index = appendSlot(index, undefined)
    else if (entries.length === 2) index = appendSlot(index, entries[1])
    else index = appendSlot(index, balancedSplit(entries, 0, entries.length >>> 1)!)
  }
  return index
}

const orderOfPieceStartingAtOrBefore = (
  pieces: PieceTableReverseSplitNode,
  unit: number,
): number => {
  let node: PieceTableReverseSplitNode | null = pieces
  let order = Number.NaN
  while (node) {
    if (node.start <= unit) {
      order = node.order
      node = node.right
      continue
    }
    node = node.left
  }
  return order
}

// The unit an anchor holds on to: the one before it under left bias, which is
// what puts an anchor on a cut into the piece ending there.
export const anchoredUnit = (offset: number, bias: AnchorBias): number =>
  bias === 'left' && offset > 0 ? offset - 1 : offset

// Order of the inserted buffer's piece that holds `unit`, if the buffer is
// indexed. The caller checks the piece it leads to: entries carry no lengths.
export const lookupReverseIndex = (
  index: PieceTableReverseIndex,
  buffer: PieceBufferId,
  unit: number,
): number | undefined => {
  const slot = reverseIndexSlot(index, buffer - 1)
  if (slot === undefined || typeof slot === 'number') return slot
  return orderOfPieceStartingAtOrBefore(slot, unit)
}

export type ReverseIndexEntry = {
  readonly buffer: PieceBufferId
  readonly start: number
  readonly order: number
}

const collectSplitEntries = (
  node: PieceTableReverseSplitNode | null,
  buffer: PieceBufferId,
  entries: ReverseIndexEntry[],
): void => {
  if (!node) return
  collectSplitEntries(node.left, buffer, entries)
  entries.push({ buffer, start: node.start, order: node.order })
  collectSplitEntries(node.right, buffer, entries)
}

// Every entry in key order, for inspection. A buffer's first entry reads
// start 0 whatever its piece's start is.
export const reverseIndexEntries = (index: PieceTableReverseIndex): ReverseIndexEntry[] => {
  const entries: ReverseIndexEntry[] = []
  for (let at = 0; at < index.count; at += 1) {
    const slot = reverseIndexSlot(index, at)
    const buffer = (at + 1) as PieceBufferId
    if (typeof slot === 'number') entries.push({ buffer, start: 0, order: slot })
    else if (slot) collectSplitEntries(slot, buffer, entries)
  }
  return entries
}

export const coversAnchorOffset = (piece: Piece, offset: number): boolean =>
  offset >= piece.start && offset <= piece.start + piece.length
