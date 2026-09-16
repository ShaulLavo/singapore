import { describe, expect, test } from 'vitest'
import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  insertIntoPieceTable,
  materializePieceTableFullText,
  snapBatchEditRanges,
} from './index'
import type { PieceTableEdit, PieceTableSnapshot } from './pieceTableTypes'

const HIGH = '\ud83d'
const LOW = '\ude00'

const applyToString = (text: string, edit: PieceTableEdit): string =>
  text.slice(0, edit.from) + edit.text + text.slice(edit.to)

// The batch pipeline is the reference: whatever it would apply for one edit,
// the single-edit path must apply too, or a snapped range differs by caller.
const expectSingleEditMatchesBatch = (snapshot: PieceTableSnapshot, edit: PieceTableEdit): void => {
  const text = materializePieceTableFullText(snapshot)
  const [reference] = snapBatchEditRanges(snapshot, [edit])
  const expected = applyToString(text, reference!)
  const label = `${JSON.stringify(edit)} on ${JSON.stringify(text)}`

  expect(materializePieceTableFullText(applyBatchToPieceTable(snapshot, [edit])), label).toBe(
    expected,
  )
  if (edit.from === edit.to) {
    expect(
      materializePieceTableFullText(insertIntoPieceTable(snapshot, edit.from, edit.text)),
      label,
    ).toBe(expected)
  }
  if (edit.text === '') {
    expect(
      materializePieceTableFullText(deleteFromPieceTable(snapshot, edit.from, edit.to - edit.from)),
      label,
    ).toBe(expected)
  }
}

describe('single-edit path', () => {
  test('snaps a caret inside a pair leftwards like the batch path', () => {
    const snapshot = createPieceTableSnapshot(`a${HIGH}${LOW}b`)
    expectSingleEditMatchesBatch(snapshot, { from: 2, to: 2, text: 'x' })
    expect(materializePieceTableFullText(insertIntoPieceTable(snapshot, 2, 'x'))).toBe(
      `ax${HIGH}${LOW}b`,
    )
  })

  test('widens a range that would orphan a half like the batch path', () => {
    const snapshot = createPieceTableSnapshot(`a${HIGH}${LOW}b`)
    expectSingleEditMatchesBatch(snapshot, { from: 2, to: 3, text: '' })
    expect(materializePieceTableFullText(deleteFromPieceTable(snapshot, 2, 1))).toBe('ab')
    expectSingleEditMatchesBatch(snapshot, { from: 1, to: 2, text: '' })
  })

  test('keeps a whole-code-point replacement of one half as given', () => {
    const snapshot = createPieceTableSnapshot(`a${HIGH}${LOW}b`)
    expectSingleEditMatchesBatch(snapshot, { from: 2, to: 3, text: '\ude01' })
    expectSingleEditMatchesBatch(snapshot, { from: 1, to: 2, text: '\ud83e' })
  })

  test('rejects the same invalid ranges as the batch path', () => {
    const snapshot = createPieceTableSnapshot('abc')
    expect(() => insertIntoPieceTable(snapshot, 4, 'x')).toThrow(RangeError)
    expect(() => deleteFromPieceTable(snapshot, 2, 5)).toThrow(RangeError)
    expect(() => applyBatchToPieceTable(snapshot, [{ from: 2, to: 1, text: '' }])).toThrow(
      RangeError,
    )
  })

  test('matches the batch path across fuzzed edits of a surrogate-rich document', () => {
    let state = 7
    const random = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % limit
    }
    const texts = ['', 'x', '😀', LOW, HIGH, `${LOW}${HIGH}`, 'ab\n', `${HIGH}${LOW}${HIGH}${LOW}`]
    let snapshot = createPieceTableSnapshot('😀ab😀\n'.repeat(6))
    for (let step = 0; step < 300; step++) {
      const length = snapshot.length
      const from = random(length + 1)
      const to = random(2) === 0 ? from : Math.min(length, from + random(5))
      const edit = { from, to, text: texts[random(texts.length)]! }
      expectSingleEditMatchesBatch(snapshot, edit)
      snapshot = applyBatchToPieceTable(snapshot, [edit])
    }
  })
})
