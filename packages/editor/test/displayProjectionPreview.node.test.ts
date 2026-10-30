import { describe, expect, test } from 'vitest'
import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  type PieceTableEdit,
} from '@singapore-editor/textbuffer'
import { createDocumentTextSnapshot } from '../src/documentTextSnapshot'
import {
  DisplayProjection,
  type DisplayProjectionConfig,
} from '../src/virtualization/displayProjection'

// previewRowCount lets the content-layout limit check an edit by rebuilding only the edited lines.
// It must agree with a projection built from scratch for the edited text, and leave its own
// projection untouched.

const WORDS = [
  'const',
  'value',
  '=',
  'compute(',
  ')',
  '\t',
  '中文',
  'x',
  'longwordwithoutbreaks',
  ' ',
]

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function line(random: () => number): string {
  const count = Math.floor(random() * 14)
  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')
}

function text(random: () => number, lines: number): string {
  return Array.from({ length: lines }, () => line(random)).join('\n')
}

function randomEdit(random: () => number, length: number): PieceTableEdit {
  const from = Math.floor(random() * (length + 1))
  const to = Math.min(length, from + Math.floor(random() * 3) * Math.floor(random() * 40))
  const inserted = random() < 0.3 ? '' : random() < 0.5 ? '\n' + line(random) : line(random)
  return { from, to, text: inserted }
}

const configs: readonly (Pick<DisplayProjectionConfig, 'wrapColumn' | 'wrapBreak'> & {
  readonly name: string
})[] = [
  { name: 'character wrap', wrapColumn: 12, wrapBreak: 'character' },
  { name: 'word wrap', wrapColumn: 16, wrapBreak: 'word' },
  { name: 'no wrap', wrapColumn: null, wrapBreak: 'character' },
]

describe.each(configs)('previewRowCount with $name', ({ wrapColumn, wrapBreak }) => {
  const config = {
    foldMap: null,
    inlineMap: null,
    injectedTextRows: [],
    wrapColumn,
    wrapBreak,
    tabSize: 4,
  }

  test('matches a fresh projection of the edited text, one or several edits at a time', () => {
    const random = seeded(wrapColumn ?? 7)
    let pieceTable = createPieceTableSnapshot(text(random, 60))
    let before = createDocumentTextSnapshot(pieceTable)
    const projection = new DisplayProjection({ ...config, textSnapshot: before })

    for (let step = 0; step < 150; step += 1) {
      const edits =
        step % 3 === 0
          ? [randomEdit(random, pieceTable.length)]
          : [randomEdit(random, pieceTable.length), randomEdit(random, pieceTable.length)]
              .sort((left, right) => left.from - right.from)
              .filter((edit, index, sorted) => index === 0 || edit.from >= sorted[index - 1]!.to)
      const nextTable = applyBatchToPieceTable(pieceTable, edits)
      const after = createDocumentTextSnapshot(nextTable)
      const rowsBefore = projection.rowCount
      const revisionBefore = projection.revision

      const previewed = projection.previewRowCount({ before, after, edits })

      expect(previewed).toBe(new DisplayProjection({ ...config, textSnapshot: after }).rowCount)
      expect(projection.rowCount).toBe(rowsBefore)
      expect(projection.revision).toBe(revisionBefore)
      expect(projection.textSnapshot).toBe(before)

      projection.update({ before, after, edits })
      expect(projection.rowCount).toBe(previewed)
      pieceTable = nextTable
      before = after
    }
  })

  test('accepts another snapshot object over the current piece tree as the starting text', () => {
    const pieceTable = createPieceTableSnapshot(text(seeded(3), 20))
    const projection = new DisplayProjection({
      ...config,
      textSnapshot: createDocumentTextSnapshot(pieceTable),
    })
    const edits = [{ from: 0, to: 0, text: 'inserted words at the start\n' }]
    const after = createDocumentTextSnapshot(applyBatchToPieceTable(pieceTable, edits))

    const previewed = projection.previewRowCount({
      before: createDocumentTextSnapshot(pieceTable),
      after,
      edits,
    })

    expect(previewed).toBe(new DisplayProjection({ ...config, textSnapshot: after }).rowCount)
  })

  test('counts from scratch when the edit does not start from the projected text', () => {
    const projection = new DisplayProjection({
      ...config,
      textSnapshot: createDocumentTextSnapshot(createPieceTableSnapshot('unrelated text')),
    })
    const pieceTable = createPieceTableSnapshot(text(seeded(5), 30))
    const edits = [{ from: 4, to: 9, text: '\nreplacement line\n' }]
    const after = createDocumentTextSnapshot(applyBatchToPieceTable(pieceTable, edits))

    const previewed = projection.previewRowCount({
      before: createDocumentTextSnapshot(pieceTable),
      after,
      edits,
    })

    expect(previewed).toBe(new DisplayProjection({ ...config, textSnapshot: after }).rowCount)
  })
})
