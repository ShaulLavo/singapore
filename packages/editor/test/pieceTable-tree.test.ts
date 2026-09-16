import { describe, expect, it } from 'vitest'

import {
  createInitialBuffers,
  createOriginalPiece,
} from '@singapore-editor/textbuffer/internal/buffers'
import { PIECE_ORDER_STEP } from '@singapore-editor/textbuffer/internal/orders'
import type { SplitContext } from '@singapore-editor/textbuffer/internal/internalTypes'
import {
  collectTextInRange,
  createNode,
  createTreeFromPieces,
  findVisiblePieceContainingOffset,
  flattenPieces,
  getSubtreeVisibleLength,
  markTreeInvisible,
  normalizePieceOrders,
  splitByVisibleOffset,
  visibleLengthBetweenOrders,
  visiblePrefixBeforeOrder,
} from '@singapore-editor/textbuffer/internal/tree'

describe('piece table tree', () => {
  it('assigns deterministic node priorities from piece identity and seed', () => {
    const firstBuffers = createInitialBuffers('abc', { prioritySeed: 7 })
    const secondBuffers = createInitialBuffers('abc', { prioritySeed: 7 })
    const thirdBuffers = createInitialBuffers('abc', { prioritySeed: 8 })
    const first = createTreeFromPieces(
      [createOriginalPiece(firstBuffers)!],
      firstBuffers.prioritySeed,
    )
    const second = createTreeFromPieces(
      [createOriginalPiece(secondBuffers)!],
      secondBuffers.prioritySeed,
    )
    const third = createTreeFromPieces(
      [createOriginalPiece(thirdBuffers)!],
      thirdBuffers.prioritySeed,
    )

    expect(first?.priority).toBe(second?.priority)
    expect(first?.priority).not.toBe(third?.priority)
  })

  it('builds trees, collects ranges, and finds visible pieces', () => {
    const buffers = createInitialBuffers('abcdef')
    const piece = createOriginalPiece(buffers)!
    const tree = createTreeFromPieces([piece])
    const chunks: string[] = []

    collectTextInRange(tree, buffers, 1, 5, chunks)

    expect(getSubtreeVisibleLength(tree)).toBe(6)
    expect(chunks.join('')).toBe('bcde')
    expect(findVisiblePieceContainingOffset(tree, 3)?.piece).toEqual(piece)
    expect(visiblePrefixBeforeOrder(tree, piece.order)).toBe(0)
    expect(
      visibleLengthBetweenOrders(tree, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY),
    ).toBe(6)
  })

  it('splits pieces by visible offset and records reverse-index changes', () => {
    const buffers = createInitialBuffers('abcdef')
    const tree = createNode(createOriginalPiece(buffers)!)
    const context: SplitContext = { changes: [], normalizeOrders: false }
    const { left, right } = splitByVisibleOffset(tree, 2, buffers, context)

    expect(flattenPieces(left, []).map((piece) => piece.length)).toEqual([2])
    expect(flattenPieces(right, []).map((piece) => piece.length)).toEqual([4])
    expect(context.changes).toHaveLength(3)
  })

  it('marks trees invisible and normalizes orders without mutating the source tree', () => {
    const buffers = createInitialBuffers('abc')
    const tree = createNode({ ...createOriginalPiece(buffers)!, order: 1 })
    const changes: SplitContext['changes'] = []
    const invisible = markTreeInvisible(tree, changes)
    const normalized = normalizePieceOrders(invisible, { value: PIECE_ORDER_STEP })

    expect(tree.piece.visible).toBe(true)
    expect(invisible?.piece.visible).toBe(false)
    expect(changes).toHaveLength(1)
    expect(normalized?.piece.order).toBe(PIECE_ORDER_STEP)
  })
})
