import { describe, expect, it } from 'vitest'

import { createPieceTableSnapshot, insertIntoPieceTable } from '@singapore-editor/textbuffer'
import {
  buildReverseIndex,
  compareReverseKeys,
  coversAnchorOffset,
  lookupReverseIndex,
  reversePredecessor,
  reverseSuccessor,
} from '@singapore-editor/textbuffer/internal/reverseIndex'
import { flattenNodes } from '@singapore-editor/textbuffer/internal/tree'

describe('piece table reverse index', () => {
  it('orders reverse keys by buffer then start offset', () => {
    expect(compareReverseKeys('buffer:1' as never, 0, 'buffer:2' as never, 0)).toBeLessThan(0)
    expect(compareReverseKeys('buffer:2' as never, 0, 'buffer:1' as never, 0)).toBeGreaterThan(0)
    expect(compareReverseKeys('buffer:1' as never, 3, 'buffer:1' as never, 8)).toBeLessThan(0)
  })

  it('builds an index that can find containing pieces and neighbors', () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot('ac'), 1, 'b')
    const indexRoot = buildReverseIndex(snapshot.root)
    const pieces = flattenNodes(snapshot.root, []).map((node) => node.piece)
    const inserted = pieces.find((piece) => piece.buffer !== snapshot.buffers.original)!

    expect(indexRoot).not.toBeNull()
    expect(coversAnchorOffset(inserted, 0)).toBe(true)
    expect(
      lookupReverseIndex(
        { ...snapshot, reverseIndexRoot: indexRoot },
        {
          buffer: inserted.buffer,
          offset: 0,
          bias: 'right',
        },
      )?.piece,
    ).toEqual(inserted)
    expect(reversePredecessor(indexRoot, inserted.buffer, inserted.start, false)?.piece).toEqual(
      inserted,
    )
    expect(reverseSuccessor(indexRoot, inserted.buffer, inserted.start)?.piece).toEqual(inserted)
  })
})
