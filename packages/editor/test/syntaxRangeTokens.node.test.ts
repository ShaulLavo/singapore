import { describe, expect, it } from 'vitest'
import {
  projectSyntaxRangesThroughEdits,
  removeTokensInRanges,
} from '../src/editor/syntaxRangeTokens'
import { EditorTokenStore } from '../src/syntax/tokenStore'

const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex })
const token = (start: number, end: number) => ({ start, end, style: { color: 'fixture' } })
const spans = (store: EditorTokenStore) => store.toTokens().map(({ start, end }) => [start, end])

describe('projectSyntaxRangesThroughEdits', () => {
  it.each([
    ['an insertion before the range', { from: 5, to: 5, text: 'ab' }, [range(12, 22)]],
    ['an insertion inside the range', { from: 15, to: 15, text: 'ab' }, [range(10, 22)]],
    ['an insertion after the range', { from: 25, to: 25, text: 'ab' }, [range(10, 20)]],
    [
      'an insertion at the start, which stays outside',
      { from: 10, to: 10, text: 'ab' },
      [range(12, 22)],
    ],
    [
      'an insertion at the end, which stays outside',
      { from: 20, to: 20, text: 'ab' },
      [range(10, 20)],
    ],
    ['a line break inside the range', { from: 15, to: 15, text: '\n\n' }, [range(10, 22)]],
    ['a deletion inside the range', { from: 12, to: 16, text: '' }, [range(10, 16)]],
    ['a replacement from the start on', { from: 10, to: 14, text: 'a' }, [range(10, 17)]],
    ['a replacement up to the end', { from: 16, to: 20, text: 'a' }, [range(10, 17)]],
    ['a replacement across the start', { from: 8, to: 12, text: 'abc' }, [range(11, 19)]],
    ['a replacement across the end', { from: 18, to: 24, text: 'abc' }, [range(10, 18)]],
    ['a replacement of the whole range', { from: 8, to: 24, text: 'abc' }, []],
  ] as const)('moves a range through %s', (_name, edit, expected) => {
    expect(projectSyntaxRangesThroughEdits([range(10, 20)], [edit])).toEqual(expected)
  })

  it('moves every range through every edit of a change', () => {
    const edits = [
      { from: 30, to: 30, text: 'ccc' },
      { from: 5, to: 5, text: 'a' },
      { from: 15, to: 17, text: '' },
    ]
    expect(projectSyntaxRangesThroughEdits([range(10, 20), range(25, 40)], edits)).toEqual([
      range(11, 19),
      range(24, 42),
    ])
  })
})

describe('removeTokensInRanges', () => {
  it('removes the tokens of a dropped range and keeps the rest', () => {
    const store = EditorTokenStore.fromTokens([
      token(0, 5),
      token(10, 15),
      token(16, 20),
      token(30, 35),
    ])
    const next = removeTokensInRanges(store, [range(10, 20)], [])
    expect(spans(next)).toEqual([
      [0, 5],
      [30, 35],
    ])
  })

  it('keeps a token that also reaches into a kept range', () => {
    const store = EditorTokenStore.fromTokens([token(5, 12), token(12, 18), token(18, 25)])
    expect(spans(removeTokensInRanges(store, [range(10, 20)], [range(0, 10)]))).toEqual([[5, 12]])
    expect(spans(removeTokensInRanges(store, [range(10, 20)], [range(20, 30)]))).toEqual([[18, 25]])
  })

  it('removes a token across the edge of a dropped range that no kept range holds', () => {
    const store = EditorTokenStore.fromTokens([token(5, 12), token(18, 25), token(40, 45)])
    expect(spans(removeTokensInRanges(store, [range(10, 20)], [range(40, 50)]))).toEqual([[40, 45]])
  })

  it('checks nested tokens one by one', () => {
    // The outer token starts before the range and ends after it; the inner ones end inside.
    const store = EditorTokenStore.fromTokens([
      token(0, 40),
      token(2, 4),
      token(12, 14),
      token(15, 30),
      token(16, 18),
    ])
    expect(spans(removeTokensInRanges(store, [range(10, 20)], [range(0, 10)]))).toEqual([
      [0, 40],
      [2, 4],
    ])
  })

  it('returns the same store when nothing is removed', () => {
    const store = EditorTokenStore.fromTokens([token(0, 5), token(8, 12), token(30, 35)])
    expect(removeTokensInRanges(store, [range(10, 20)], [range(0, 10)])).toBe(store)
    expect(removeTokensInRanges(store, [range(40, 50)], [])).toBe(store)
  })
})
