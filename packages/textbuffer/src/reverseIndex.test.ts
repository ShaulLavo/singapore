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
import type { PieceTableReverseIndexNode, PieceTableSnapshot } from './pieceTableTypes'
import { flattenPieces } from './tree'

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
