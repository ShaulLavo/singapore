import { describe, expect, it } from 'vitest'

import {
  createPieceTableSnapshot,
  forEachPieceTableTextChunk,
  getPieceTableLength,
  insertIntoPieceTable,
  materializePieceTableFullText,
  readPieceTableTextRange,
  streamPieceTablePieces,
} from '@singapore-editor/textbuffer'
import {
  ensureValidRange,
  getPieceTableOriginalText,
} from '@singapore-editor/textbuffer/internal/reads'

describe('piece table reads', () => {
  it('reads snapshot length, original text, full text, and ranges', () => {
    const initial = createPieceTableSnapshot('abcdef')
    const edited = insertIntoPieceTable(initial, 3, 'XX')

    expect(getPieceTableLength(edited)).toBe(8)
    expect(getPieceTableOriginalText(edited)).toBe('abcdef')
    expect(materializePieceTableFullText(edited)).toBe('abcXXdef')
    expect(materializePieceTableFullText(edited)).toBe('abcXXdef')
    expect(readPieceTableTextRange(edited, 2, 6)).toBe('cXXd')
    expect(readPieceTableTextRange(edited, 2, 6)).toBe('cXXd')
    expect(readPieceTableTextRange(edited, 2, 2)).toBe('')
  })

  it('visits visible text chunks without materializing the joined range', () => {
    const initial = createPieceTableSnapshot('abcdef')
    const edited = insertIntoPieceTable(initial, 3, 'XX')
    const chunks: string[] = []

    forEachPieceTableTextChunk(edited, (text, start, end) => {
      chunks.push(`${start}:${end}:${text}`)
    })

    expect(chunks.join('|')).toBe('0:3:abc|3:5:XX|5:8:def')
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('streams visible pieces with document offsets', () => {
    const initial = createPieceTableSnapshot('abcdef')
    const edited = insertIntoPieceTable(initial, 3, 'XX')
    const entries: string[] = []

    streamPieceTablePieces(edited, (entry) => {
      entries.push(`${entry.start}:${entry.end}:${entry.text}`)
    })

    expect(entries).toEqual(['0:3:abc', '3:5:XX', '5:8:def'])
  })

  it('validates read ranges', () => {
    const snapshot = createPieceTableSnapshot('abc')

    expect(() => ensureValidRange(snapshot, 0, 3)).not.toThrow()
    expect(() => ensureValidRange(snapshot, -1, 1)).toThrow(RangeError)
    expect(() => ensureValidRange(snapshot, 2, 1)).toThrow(RangeError)
    expect(() => readPieceTableTextRange(snapshot, 0, 4)).toThrow(RangeError)
  })
})
