import { afterEach, describe, expect, it, vi } from 'vitest'
import * as textbuffer from '@singapore-editor/textbuffer'
import {
  EMPTY_HIDDEN_INPUT_STATE,
  SCREEN_READER_PAGE_ROWS,
  SCREEN_READER_TRIM_CHARS,
  deduceHiddenInputEdit,
  hiddenInputOffsetToDocument,
  isEmptyDeducedInput,
  isIncompleteDeducedInput,
  pagedHiddenInputContent,
  type HiddenInputState,
} from '../src/editor/input'
import { createDocumentSession } from '../src/public/document'
import { resolveSelection } from '../src/selections'

function hiddenInputState(value: string, selectionStart: number, selectionEnd = selectionStart) {
  return { selectionEnd, selectionStart, value } satisfies HiddenInputState
}

/** Rows wide enough to be told apart by name, so a page boundary can be asserted on directly. */
function numberedRows(count: number): string {
  return Array.from({ length: count }, (_, index) => `row${String(index).padStart(2, '0')}`).join(
    '\n',
  )
}

function windowFor(
  text: string,
  startOffset: number,
  endOffset = startOffset,
  options?: { readonly rowsPerPage?: number; readonly trimChars?: number },
) {
  const session = createDocumentSession(text)
  session.setSelection(startOffset, endOffset)
  const snapshot = session.getSnapshot()
  const selection = resolveSelection(snapshot, session.getSelections().selections[0]!)
  return pagedHiddenInputContent(snapshot, selection, options ?? {})
}

describe('deducing an edit from the hidden input', () => {
  it('reads a typed character out of the value the browser left behind', () => {
    const previous = hiddenInputState('abc', 3)
    const deduced = deduceHiddenInputEdit(previous, hiddenInputState('abcX', 4))

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 0, text: 'X' })
    expect(isEmptyDeducedInput(deduced, previous)).toBe(false)
  })

  it('clamps the shared prefix by the caret, so a repeated character is not absorbed into it', () => {
    const deduced = deduceHiddenInputEdit(
      hiddenInputState('hello', 3),
      hiddenInputState('helllo', 4),
    )

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 0, text: 'l' })
  })

  it('counts back over the characters an autocorrection rewrote', () => {
    const deduced = deduceHiddenInputEdit(hiddenInputState('teh', 3), hiddenInputState('the', 3))

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 2, text: 'he' })
  })

  it('counts forward over the characters a word-level suggestion swallowed', () => {
    const deduced = deduceHiddenInputEdit(
      hiddenInputState('Micosoft', 3),
      hiddenInputState('Microsoft', 9),
    )

    expect(deduced).toEqual({ replaceNextCharCnt: 5, replacePrevCharCnt: 0, text: 'rosoft' })
  })

  it('reads a deletion the same way as an insertion', () => {
    const deduced = deduceHiddenInputEdit(hiddenInputState('abc', 3), hiddenInputState('ab', 2))

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 1, text: '' })
  })

  it('spans the text a selection replaced when the browser typed over one', () => {
    const deduced = deduceHiddenInputEdit(
      hiddenInputState('alpha beta', 6, 10),
      hiddenInputState('alpha gamma', 11),
    )

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 0, text: 'gamma' })
  })

  it('reports no edit when nothing about the value moved', () => {
    const moved = hiddenInputState('abc', 1)
    expect(
      isEmptyDeducedInput(deduceHiddenInputEdit(moved, hiddenInputState('abc', 2)), moved),
    ).toBe(true)
    expect(
      isEmptyDeducedInput(
        deduceHiddenInputEdit(EMPTY_HIDDEN_INPUT_STATE, EMPTY_HIDDEN_INPUT_STATE),
        EMPTY_HIDDEN_INPUT_STATE,
      ),
    ).toBe(true)
  })

  it('does not read a selection the browser deleted as nothing having happened', () => {
    const previous = hiddenInputState('abcd', 1, 3)
    const deduced = deduceHiddenInputEdit(previous, hiddenInputState('ad', 1))

    expect(deduced).toEqual({ replaceNextCharCnt: 0, replacePrevCharCnt: 0, text: '' })
    expect(isEmptyDeducedInput(deduced, previous)).toBe(false)
  })

  it('holds back a lone surrogate and the delete control code', () => {
    const half = deduceHiddenInputEdit(hiddenInputState('a', 1), hiddenInputState('a\ud83d', 2))
    expect(isIncompleteDeducedInput(half)).toBe(true)

    const del = deduceHiddenInputEdit(hiddenInputState('a', 1), hiddenInputState('a', 2))
    expect(isIncompleteDeducedInput(del)).toBe(true)

    const pair = deduceHiddenInputEdit(hiddenInputState('a', 1), hiddenInputState('a😀', 3))
    expect(isIncompleteDeducedInput(pair)).toBe(false)
    expect(pair.text).toBe('😀')
  })
})

describe('the document window the hidden input carries', () => {
  it('carries the text around a collapsed caret, with the caret in the same place', () => {
    const content = windowFor('alpha\nbeta\ngamma', 8)

    expect(content.value).toBe('alpha\nbeta\ngamma')
    expect(content.selectionStart).toBe(8)
    expect(content.selectionEnd).toBe(8)
    expect(content.direction).toBe('forward')
  })

  it('reports which end of a selection the caret is on', () => {
    const forward = windowFor('alpha beta', 0, 5)
    const backward = windowFor('alpha beta', 5, 0)

    expect([forward.selectionStart, forward.selectionEnd]).toEqual([0, 5])
    expect(forward.direction).toBe('forward')
    expect([backward.selectionStart, backward.selectionEnd]).toEqual([0, 5])
    expect(backward.direction).toBe('backward')
  })

  it('carries a page either side of the caret rather than the whole document', () => {
    const text = numberedRows(60)
    const caret = text.indexOf('row25')

    const content = windowFor(text, caret, caret, { rowsPerPage: 10 })

    expect(content.value.startsWith('row10\n')).toBe(true)
    expect(content.value.endsWith('row39\n')).toBe(true)
    expect(content.value).not.toContain('row09')
    expect(content.value).not.toContain('row40')
    expect(content.value.slice(0, content.selectionStart)).toMatch(/row24\n$/)
  })

  // A reader standing on the first character of a page is the case the pages either side are for:
  // with the window starting where the caret is, the element holds nothing to delete backwards over
  // and the browser raises no event at all, so the keystroke is lost rather than merely unread.
  it('keeps text in front of the caret where a page begins', () => {
    const text = numberedRows(60)
    const caret = text.indexOf('row20')

    const content = windowFor(text, caret, caret, { rowsPerPage: 10 })

    expect(content.selectionStart).toBeGreaterThan(0)
    expect(content.value.slice(0, content.selectionStart)).toMatch(/row19\n$/)
  })

  it('clamps a page whose rows are long enough to stall the accessible value', () => {
    const text = `${'x'.repeat(4000)}\n${'y'.repeat(4000)}`
    const caret = 4001

    const content = windowFor(text, caret, caret, { rowsPerPage: 10, trimChars: 500 })

    expect(content.selectionStart).toBe(500)
    expect(content.value.length).toBe(1000)
    expect(content.value.slice(0, 500)).toBe('x'.repeat(499) + '\n')
  })

  it('splices a selection reaching past the two pages rather than reading all of it', () => {
    const text = numberedRows(60)
    const start = text.indexOf('row02')
    const end = text.indexOf('row48')

    const content = windowFor(text, start, end, { rowsPerPage: 10, trimChars: 0 })
    const selected = content.value.slice(content.selectionStart, content.selectionEnd)

    expect(selected).toContain('…')
    expect(selected.startsWith('row02')).toBe(true)
    expect(selected.endsWith('row47\n')).toBe(true)
    expect(selected).not.toContain('row25')
  })

  it('reads the whole document when it is smaller than a page', () => {
    const content = windowFor('a\nb', 3)

    expect(content.value).toBe('a\nb')
    expect(content.selectionStart).toBe(3)
  })

  it('defaults to a page either side and a five-hundred-character clamp', () => {
    expect(SCREEN_READER_PAGE_ROWS).toBe(10)
    expect(SCREEN_READER_TRIM_CHARS).toBe(500)
  })
})

function observeRangeReads() {
  const read = textbuffer.readPieceTableTextRange
  const spy = vi.spyOn(textbuffer, 'readPieceTableTextRange').mockImplementation(read)
  const calibration = createDocumentSession('calibrate').getSnapshot()
  expect(textbuffer.readPieceTableTextRange(calibration, 1, 5)).toBe('alib')
  expect(spy.mock.calls.map(([, start, end]) => end - start)).toEqual([4])
  spy.mockClear()
  expect(
    pagedHiddenInputContent(calibration, { startOffset: 0, endOffset: 9, reversed: false }).value,
  ).toBe('calibrate')
  expect(spy.mock.calls.reduce((sum, [, start, end]) => sum + end - start, 0)).toBe(9)
  spy.mockClear()
  return spy
}

function requestedUnits(spy: ReturnType<typeof observeRangeReads>) {
  const lengths = spy.mock.calls.map(([, start, end]) => end - start)
  return {
    total: lengths.reduce((sum, length) => sum + length, 0),
    largest: Math.max(0, ...lengths),
  }
}

function expectBoundedReads(counts: ReturnType<typeof requestedUnits>) {
  expect.soft(counts.largest).toBeLessThanOrEqual(2 * SCREEN_READER_TRIM_CHARS + 2)
  expect.soft(counts.total).toBeLessThanOrEqual(4 * SCREEN_READER_TRIM_CHARS + 256)
}

describe('hidden-input requested source units', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([999, 1000, 1001])('bounds retained source at the %s unit trim threshold', (units) => {
    const text = 'p'.repeat(700) + 's'.repeat(units) + 't'.repeat(700)
    const selection = { startOffset: 700, endOffset: 700 + units, reversed: false }
    const snapshot = createDocumentSession(text).getSnapshot()
    const spy = observeRangeReads()
    const written = pagedHiddenInputContent(snapshot, selection)
    expect(written.value).toBe(
      'p'.repeat(500) +
        (units <= 1000 ? 's'.repeat(units) : 's'.repeat(500) + '…' + 's'.repeat(500)) +
        't'.repeat(500),
    )
    expectBoundedReads(requestedUnits(spy))
    spy.mockClear()
    expect(
      hiddenInputOffsetToDocument(snapshot, selection, written, written.selectionEnd - 1),
    ).toBe(selection.endOffset - 1)
    expectBoundedReads(requestedUnits(spy))
  })

  it.each([
    { units: 100_000, pages: false },
    { units: 1_000_000, pages: false },
    { units: 100_000, pages: true },
    { units: 1_000_000, pages: true },
  ])(
    'bounds writer and interior inverse reads for $units endpoint units, pages=$pages',
    ({ units, pages }) => {
      const head = 'H'.repeat(500)
      const tail = 'T'.repeat(500)
      const middle = pages ? '\n'.repeat(30) : ''
      const endpoint = units / 2
      const text =
        'pre' +
        head +
        'a'.repeat(endpoint - 500) +
        middle +
        'b'.repeat(endpoint - 500) +
        tail +
        'post'
      const snapshot = createDocumentSession(text).getSnapshot()
      const selection = { startOffset: 3, endOffset: text.length - 4, reversed: true }
      const spy = observeRangeReads()

      const written = pagedHiddenInputContent(snapshot, selection)
      const writer = requestedUnits(spy)
      expect(written).toEqual({
        value: 'pre' + head + '…' + tail + 'post',
        selectionStart: 3,
        selectionEnd: 1004,
        direction: 'backward',
      })
      expect(written.value.length).toBeLessThanOrEqual(4 * SCREEN_READER_TRIM_CHARS + 1)
      spy.mockClear()
      const mapped = hiddenInputOffsetToDocument(
        snapshot,
        selection,
        written,
        written.selectionEnd - 17,
      )
      const inverse = requestedUnits(spy)
      expect(mapped).toBe(selection.endOffset - 17)
      console.info(
        'hidden-input source units',
        JSON.stringify({
          units,
          pages,
          writer,
          inverse,
          windowLength: written.value.length,
          mapped,
        }),
      )
      expectBoundedReads(writer)
      expectBoundedReads(inverse)
    },
  )
})

type WindowSelection = Parameters<typeof pagedHiddenInputContent>[1]
type WindowOptions = Parameters<typeof pagedHiddenInputContent>[2]

// This string-based oracle preserves the pre-optimization omission and tie rules.
function legacyWindow(text: string, selection: WindowSelection, options: WindowOptions = {}) {
  const rows = Math.max(1, options.rowsPerPage ?? SCREEN_READER_PAGE_ROWS)
  const trim = Math.max(0, options.trimChars ?? SCREEN_READER_TRIM_CHARS)
  const start = Math.max(0, Math.min(text.length, selection.startOffset))
  const end = Math.max(start, Math.min(text.length, selection.endOffset))
  const rowAt = (offset: number) => text.slice(0, offset).split('\n').length - 1
  const starts = [0]
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === '\n') starts.push(offset + 1)
  }
  const pageStart = (page: number) => starts[Math.max(0, page * rows)] ?? text.length
  const startPage = Math.floor(rowAt(start) / rows)
  const endPage = Math.floor(rowAt(end) / rows)
  const spliced = endPage - startPage > 1
  const headEnd = spliced ? Math.max(start, Math.min(end, pageStart(startPage + 1))) : end
  const tailStart = spliced ? Math.max(headEnd, Math.min(end, pageStart(endPage))) : end
  const virtual = spliced
    ? text.slice(start, headEnd) + '…' + text.slice(tailStart, end)
    : text.slice(start, end)
  const head = trim > 0 && virtual.length > 2 * trim ? legacySlice(virtual, 0, trim) : virtual
  const tail =
    trim > 0 && virtual.length > 2 * trim
      ? legacySlice(virtual, virtual.length - trim, virtual.length)
      : ''
  const selected = head.length === virtual.length ? head : head + '…' + tail
  let prefixStart = pageStart(startPage - 1)
  let suffixEnd = pageStart(endPage + 2)
  if (trim > 0 && start - prefixStart > trim) {
    prefixStart = start - trim
    if (legacySplitsPair(text, prefixStart)) prefixStart += 1
  }
  if (trim > 0 && suffixEnd - end > trim) {
    suffixEnd = end + trim
    if (legacySplitsPair(text, suffixEnd)) suffixEnd -= 1
  }
  const prefix = text.slice(prefixStart, start)
  const content = {
    value: prefix + selected + text.slice(end, suffixEnd),
    selectionStart: prefix.length,
    selectionEnd: prefix.length + selected.length,
    direction: selection.reversed ? 'backward' : 'forward',
  }
  return { content, virtual, head, tail, headEnd, tailStart, spliced, start, end }
}

function legacyLowAt(text: string, index: number) {
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff
}

function legacySplitsPair(text: string, index: number) {
  const before = text.charCodeAt(index - 1)
  return before >= 0xd800 && before <= 0xdbff && legacyLowAt(text, index)
}

function legacySlice(text: string, start: number, end: number) {
  const from = start > 0 && legacyLowAt(text, start) ? start + 1 : start
  const to = end < text.length && legacyLowAt(text, end) ? end - 1 : end
  return text.slice(from, Math.max(from, to))
}

function legacyMap(reference: ReturnType<typeof legacyWindow>, offset: number) {
  const { content, start, end, head, tail, virtual, headEnd, tailStart, spliced } = reference
  if (offset <= content.selectionStart) return start + offset - content.selectionStart
  if (offset >= content.selectionEnd) return end + offset - content.selectionEnd
  let selectedOffset = offset - content.selectionStart
  if (virtual.length > 2 * SCREEN_READER_TRIM_CHARS && selectedOffset > head.length) {
    selectedOffset += virtual.length - tail.length - head.length - 1
  }
  if (!spliced || selectedOffset <= headEnd - start) return start + selectedOffset
  return tailStart + selectedOffset - (headEnd - start) - 1
}

function checkLegacyBoundaries(text: string, selection: WindowSelection) {
  const session = createDocumentSession(text.slice(0, 1))
  for (let offset = 1; offset < text.length; offset += 37) {
    session.applyEdits([{ from: offset, to: offset, text: text.slice(offset, offset + 37) }])
  }
  const snapshot = session.getSnapshot()
  const reference = legacyWindow(text, selection)
  const written = pagedHiddenInputContent(snapshot, selection)
  expect(written).toEqual(reference.content)
  for (let offset = 0; offset <= written.value.length; offset += 1) {
    expect(
      hiddenInputOffsetToDocument(snapshot, selection, written, offset),
      `native boundary ${offset}`,
    ).toBe(legacyMap(reference, offset))
  }
}

const boundaryFixtures = [
  {
    name: 'cut on page marker then low surrogate',
    text: 'a'.repeat(490) + '\n'.repeat(30) + '\udc00' + 'z'.repeat(499),
    start: 0,
    end: 1020,
  },
  { name: 'empty document', text: '', start: 0, end: 0 },
  { name: 'collapsed nonzero caret', text: 'alpha\nbeta', start: 8, end: 8 },
  { name: 'trim threshold 999', text: 'pre' + 'x'.repeat(999) + 'post', start: 3, end: 1002 },
  { name: 'trim threshold 1000', text: 'pre' + 'x'.repeat(1000) + 'post', start: 3, end: 1003 },
  { name: 'trim threshold 1001', text: 'pre' + 'x'.repeat(1001) + 'post', start: 3, end: 1004 },
  { name: 'adjacent pages', text: numberedRows(25), start: 5, end: 100 },
  { name: 'page gap and literal ellipses', text: '…\n'.repeat(40), start: 1, end: 79 },
  { name: 'empty endpoint tail', text: numberedRows(40), start: 0, end: 180 },
  {
    name: 'both omissions with page marker in tail',
    text: 'x'.repeat(1600) + '\n'.repeat(30) + '…tail',
    start: 0,
    end: 1635,
  },
  {
    name: 'both omissions with page marker in head',
    text: 'head…' + '\n'.repeat(30) + 'y'.repeat(1600),
    start: 0,
    end: 1635,
  },
  { name: 'astral head cut', text: 'a'.repeat(499) + '😀' + 'b'.repeat(600), start: 0, end: 1101 },
  { name: 'astral tail cut', text: 'a'.repeat(600) + '😀' + 'b'.repeat(499), start: 0, end: 1101 },
  {
    name: 'lone low at head cut',
    text: 'a'.repeat(500) + '\udc00' + 'b'.repeat(600),
    start: 0,
    end: 1101,
  },
  {
    name: 'lone low at tail cut',
    text: 'a'.repeat(601) + '\udc00' + 'b'.repeat(499),
    start: 0,
    end: 1101,
  },
  {
    name: 'astral surrounding window cuts',
    text: 'a'.repeat(100) + '😀' + 'b'.repeat(998) + '😀' + 'c'.repeat(100),
    start: 601,
    end: 601,
  },
  {
    name: 'surrogate after synthetic page marker',
    text: 'x'.repeat(499) + '\n'.repeat(30) + '\udc00' + 'z'.repeat(999),
    start: 0,
    end: 1529,
  },
]

describe('hidden-input legacy boundaries', () => {
  it.each(boundaryFixtures)(
    'preserves every forward boundary for $name',
    ({ text, start, end }) => {
      checkLegacyBoundaries(text, { startOffset: start, endOffset: end, reversed: false })
    },
  )

  it.each(boundaryFixtures)(
    'preserves every backward boundary for $name',
    ({ text, start, end }) => {
      checkLegacyBoundaries(text, { startOffset: start, endOffset: end, reversed: true })
    },
  )

  it.each([0, 1, 2, 4, 0.5])(
    'preserves custom writer output at trim %s without changing the inverse contract',
    (trimChars) => {
      const text = 'a😀…\nb\nc\nd\n\udc00tail'
      const selection = { startOffset: 1, endOffset: text.length - 1, reversed: true }
      const snapshot = createDocumentSession(text).getSnapshot()
      const options = { rowsPerPage: 1, trimChars }
      expect(pagedHiddenInputContent(snapshot, selection, options)).toEqual(
        legacyWindow(text, selection, options).content,
      )
    },
  )
})

function checkSmallWriterCuts(trimChars: number) {
  const text = 'a😀…\nb\n\udc00c\nd\n😀e'
  const snapshot = createDocumentSession(text).getSnapshot()
  const options = { rowsPerPage: 1, trimChars }
  for (let startOffset = 0; startOffset <= text.length; startOffset += 1) {
    checkSmallWriterEnds(snapshot, text, startOffset, options)
  }
}

function checkSmallWriterEnds(
  snapshot: textbuffer.PieceTableSnapshot,
  text: string,
  startOffset: number,
  options: WindowOptions,
) {
  for (let endOffset = startOffset; endOffset <= text.length; endOffset += 1) {
    const selection = { startOffset, endOffset, reversed: false }
    expect(pagedHiddenInputContent(snapshot, selection, options)).toEqual(
      legacyWindow(text, selection, options).content,
    )
  }
}

it.each([0, 1, 2, 3])(
  'matches every small writer interval at trim %s around page and surrogate cuts',
  checkSmallWriterCuts,
)
