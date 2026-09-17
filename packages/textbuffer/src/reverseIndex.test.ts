import { describe, expect, test } from 'vitest'
import {
  createPieceTableSnapshot,
  deleteFromPieceTable,
  insertIntoPieceTable,
  resolveAnchor,
  resolveAnchorLinear,
  anchorAt,
} from './index'
import { validatePieceTreeInvariants } from './debug'
import type { Piece, PieceTableReverseIndexNode, PieceTableSnapshot } from './pieceTableTypes'
import { buildReverseIndex, relabelReverseIndex } from './reverseIndex'
import { flattenPieces, normalizePieceOrders } from './tree'

const reverseKeys = (node: PieceTableReverseIndexNode | null, keys: string[] = []): string[] => {
  if (!node) return keys
  reverseKeys(node.left, keys)
  keys.push(`${node.buffer}:${node.start}`)
  reverseKeys(node.right, keys)
  return keys
}

// A split rewrites the left half onto the original key and adds the right
// half on a new one; a pairing that dropped either add would leave a piece
// the index cannot find, and a leftover entry would make a key appear twice.
const expectOneEntryPerPiece = (snapshot: PieceTableSnapshot): void => {
  const pieces = flattenPieces(snapshot.root, [])
    .filter((piece) => piece.length > 0)
    .map((piece) => `${piece.buffer}:${piece.start}`)
    .sort()
  const entries = reverseKeys(snapshot.reverseIndexRoot)
  expect(entries).toEqual(entries.toSorted())
  expect(new Set(entries).size).toBe(entries.length)
  expect(entries.toSorted()).toEqual(pieces)
  expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
}

describe('reverse index maintenance', () => {
  test('keeps one entry per key when a piece splits', () => {
    const initial = createPieceTableSnapshot('alpha beta gamma')
    const split = insertIntoPieceTable(initial, 6, 'X')
    expect(split.pieceCount).toBe(3)
    expectOneEntryPerPiece(split)
    expectOneEntryPerPiece(initial)
  })

  test('keeps one entry per key through splits, deletions and coalescing', () => {
    let snapshot = createPieceTableSnapshot('alpha\nbeta\ngamma')
    const anchors = [anchorAt(snapshot, 3, 'left'), anchorAt(snapshot, 8, 'right')]
    snapshot = insertIntoPieceTable(snapshot, 8, 'one')
    snapshot = insertIntoPieceTable(snapshot, 11, 'two')
    snapshot = deleteFromPieceTable(snapshot, 2, 9)
    snapshot = insertIntoPieceTable(snapshot, 2, 'three')
    snapshot = deleteFromPieceTable(snapshot, 0, 1)
    expectOneEntryPerPiece(snapshot)
    for (const anchor of anchors) {
      expect(resolveAnchor(snapshot, anchor)).toEqual(resolveAnchorLinear(snapshot, anchor))
    }
  })
})

describe('relabelling after order normalization', () => {
  const orders = (node: PieceTableReverseIndexNode | null, out: string[] = []): string[] => {
    if (!node) return out
    orders(node.left, out)
    out.push(`${node.buffer}:${node.start}=${node.order}/${node.piece.order}`)
    orders(node.right, out)
    return out
  }

  // A miss would silently fall back to the rebuild and hide a broken fast path.
  test('carries every entry over without a rebuild and matches one', () => {
    let snapshot = createPieceTableSnapshot('abcdefghij\nklmnop')
    for (let edit = 0; edit < 40; edit += 1) {
      snapshot = insertIntoPieceTable(snapshot, 1 + (edit % 9), `${edit % 10}`)
      if (edit % 3 === 0) snapshot = deleteFromPieceTable(snapshot, 2, 1)
    }

    const relabeled = new Map<Piece, Piece>()
    const root = normalizePieceOrders(snapshot.root, { value: 1024 }, Number.NaN, relabeled)
    const carried = relabelReverseIndex(snapshot.reverseIndexRoot, relabeled, Number.NaN)

    expect(carried).not.toBeUndefined()
    expect(orders(carried!)).toEqual(orders(buildReverseIndex(root)))
    expect(relabelReverseIndex(snapshot.reverseIndexRoot, new Map(), Number.NaN)).toBeUndefined()
  })

  test('an edit that runs out of orders leaves a valid, fully indexed snapshot', () => {
    let snapshot = createPieceTableSnapshot('ab')
    const anchor = anchorAt(snapshot, 1, 'right')
    for (let edit = 0; edit < 120; edit += 1)
      snapshot = insertIntoPieceTable(snapshot, 1, `${edit % 10}`)

    expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
    expect(reverseKeys(snapshot.reverseIndexRoot)).toHaveLength(snapshot.pieceCount)
    expect(resolveAnchor(snapshot, anchor)).toEqual(resolveAnchorLinear(snapshot, anchor))
  })
})
