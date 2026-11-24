import { describe, expect, it } from 'vitest'
import { pagedHiddenInputContent } from '../src/editor/input'
import { applyInputWindowEdits, inputWindowEdits } from '../src/editor/inputWindowEdits'
import { createPieceTableSnapshot } from '../src/public/document'

const LINES = Array.from(
  { length: 200 },
  (_, row) => `  export const value_${row} = computeSomething(${row}, 'abc');`,
)
const TEXT = LINES.join('\n')

function windowAt(text: string, caret: number): string {
  const snapshot = createPieceTableSnapshot(text)
  return pagedHiddenInputContent(snapshot, {
    startOffset: caret,
    endOffset: caret,
    reversed: false,
  }).value
}

function changedCharacters(edits: readonly { start: number; end: number; text: string }[]): number {
  return edits.reduce((total, edit) => total + edit.end - edit.start + edit.text.length, 0)
}

describe('inputWindowEdits', () => {
  it('returns no edits for the same window', () => {
    const window = windowAt(TEXT, 4000)
    expect(inputWindowEdits(window, window)).toEqual([])
  })

  it('turns each typed character into a few single-character edits, ends included', () => {
    let text = TEXT
    let caret = LINES.slice(0, 100).join('\n').length
    let previous = windowAt(text, caret)
    for (const character of 'const value = 42; ') {
      text = text.slice(0, caret) + character + text.slice(caret)
      caret += 1
      const next = windowAt(text, caret)
      const edits = inputWindowEdits(previous, next)

      expect(edits).not.toBeNull()
      expect(applyInputWindowEdits(previous, edits!)).toBe(next)
      // The typed character, plus at most one character sliding off or onto each trimmed end.
      expect(edits!.length).toBeLessThanOrEqual(3)
      expect(changedCharacters(edits!)).toBeLessThanOrEqual(3)
      previous = next
    }
  })

  it('patches a deletion and a line break', () => {
    const caret = LINES.slice(0, 50).join('\n').length
    const previous = windowAt(TEXT, caret)
    const deleted = TEXT.slice(0, caret - 1) + TEXT.slice(caret)
    const afterDelete = windowAt(deleted, caret - 1)
    const deleteEdits = inputWindowEdits(previous, afterDelete)
    expect(applyInputWindowEdits(previous, deleteEdits!)).toBe(afterDelete)

    const broken = TEXT.slice(0, caret) + '\n' + TEXT.slice(caret)
    const afterBreak = windowAt(broken, caret + 1)
    const breakEdits = inputWindowEdits(previous, afterBreak)
    expect(applyInputWindowEdits(previous, breakEdits!)).toBe(afterBreak)
  })

  it('gives up on windows that share nothing', () => {
    const previous = windowAt(TEXT, 1000)
    const next = windowAt(TEXT, TEXT.length - 1000)
    expect(inputWindowEdits(previous, next)).toBeNull()
  })

  it('keeps both halves of a surrogate pair in one edit', () => {
    const previous = `before ${'\u{1F600}'} after`
    const next = `before ${'\u{1F601}'} after`
    const edits = inputWindowEdits(previous, next)!

    expect(edits).toEqual([{ start: 7, end: 9, text: '\u{1F601}' }])
  })

  it('reproduces the next window for random edits, or declines', () => {
    let seed = 7
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    let text = TEXT
    let caret = 3000
    let previous = windowAt(text, caret)
    let edited = 0
    let patched = 0
    for (let step = 0; step < 300; step++) {
      const kind = random(4)
      if (kind < 2) edited += 1
      if (kind === 0) {
        text = text.slice(0, caret) + 'xy\n'.slice(0, 1 + random(3)) + text.slice(caret)
      } else if (kind === 1 && caret > 0) {
        text = text.slice(0, caret - 1) + text.slice(caret)
        caret -= 1
      } else {
        caret = Math.max(0, Math.min(text.length, caret + random(41) - 20))
      }
      const next = windowAt(text, caret)
      const edits = inputWindowEdits(previous, next)
      if (edits) expect(applyInputWindowEdits(previous, edits)).toBe(next)
      if (edits && kind < 2) patched += 1
      previous = next
    }
    // Typing and deleting at the caret are what the patch is for.
    expect(patched / edited).toBeGreaterThan(0.9)
  })
})
