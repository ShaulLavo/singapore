import type { DocumentSessionChange } from '../documentSession'
import type { TextReadSnapshot } from '../documentTextSnapshot'
import { MAX_BOUNDARY_WINDOW } from '../graphemes'
import type { ResolvedSelection } from '../selections'
import { isWholeWordRange, wordRangeAtOffset } from '../textRanges'
import { rangeInRowWindow } from './rowWindow'

export type ExactOccurrenceRange = {
  readonly start: number
  readonly end: number
}

export type OccurrenceSelectionChange = {
  readonly change: DocumentSessionChange
  readonly revealOffset: number
}

export type OccurrenceQuery = {
  readonly query: string
  readonly range: ExactOccurrenceRange
}

/** How much of the document a search reads at once: small first, since a match is usually near. */
export type OccurrenceScanWindows = {
  readonly first: number
  readonly max: number
}

const SCAN_WINDOWS: OccurrenceScanWindows = { first: 1_024, max: 262_144 }

/** A read the matches starting in [`from`, `to`) are found and judged in. */
type ScanWindow = {
  readonly text: string
  readonly start: number
}

type ScanOptions = {
  readonly overlapping: boolean
  /** Units read ahead of each window, so a whole-word check sees what the full text shows it. */
  readonly lead: number
  readonly windows: OccurrenceScanWindows
}

export function occurrenceQueryForSelection(
  source: TextReadSnapshot,
  selection: ResolvedSelection,
): OccurrenceQuery | null {
  if (!selection.collapsed) {
    const query = source.readRange(selection.startOffset, selection.endOffset)
    if (query.length === 0) return null
    return { query, range: { start: selection.startOffset, end: selection.endOffset } }
  }

  const range = wordRangeAt(source, selection.headOffset)
  if (range.start === range.end) return null
  return { query: source.readRange(range.start, range.end), range }
}

/** The word at `offset`, read from its row. */
export function wordRangeAt(source: TextReadSnapshot, offset: number): ExactOccurrenceRange {
  return rangeInRowWindow(source, offset, wordRangeAtOffset)
}

export function findAllExactOccurrences(
  source: TextReadSnapshot,
  query: string,
  windows: OccurrenceScanWindows = SCAN_WINDOWS,
): readonly ExactOccurrenceRange[] {
  if (query.length === 0) return []

  const ranges: ExactOccurrenceRange[] = []
  const options = { overlapping: false, lead: 0, windows }
  scanMatches(source, query, 0, source.length, options, (range) => {
    ranges.push(range)
    return false
  })
  return ranges
}

/** The first free match after `range`, wrapping once to the document's start. */
export function findNextExactOccurrenceFromRange(
  source: TextReadSnapshot,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  range: ExactOccurrenceRange,
  wholeWord = false,
  windows: OccurrenceScanWindows = SCAN_WINDOWS,
): ExactOccurrenceRange | null {
  if (query.length === 0) return null

  // The grapheme search behind a word boundary reads back at most this far.
  const lead = wholeWord ? MAX_BOUNDARY_WINDOW : 0
  const options = { overlapping: true, lead, windows }
  const accepts = (match: ExactOccurrenceRange, window: ScanWindow): boolean => {
    if (selected.some((selection) => rangesOverlap(selection, match))) return false
    return !wholeWord || isWholeWordInWindow(window, match)
  }

  return (
    firstMatch(source, query, range.end, source.length, options, accepts) ??
    firstMatch(source, query, 0, range.end, options, accepts)
  )
}

export function occurrenceSelectTimingName(
  command: 'editor.action.selectHighlights' | 'editor.action.changeAll',
): string {
  if (command === 'editor.action.selectHighlights') return 'input.selectHighlights'
  return 'input.changeAll'
}

function firstMatch(
  source: TextReadSnapshot,
  query: string,
  from: number,
  to: number,
  options: ScanOptions,
  accepts: (match: ExactOccurrenceRange, window: ScanWindow) => boolean,
): ExactOccurrenceRange | null {
  let found: ExactOccurrenceRange | null = null
  scanMatches(source, query, from, to, options, (match, window) => {
    if (!accepts(match, window)) return false
    found = match
    return true
  })
  return found
}

/**
 * Visits each match starting in [`from`, `to`) in document order until `visit` returns true.
 *
 * Windows tile the range; each read runs `query.length + 1` units past its window, so a match that
 * starts inside it is found whole with the code point after it, and `lead` units before it.
 */
function scanMatches(
  source: TextReadSnapshot,
  query: string,
  from: number,
  to: number,
  options: ScanOptions,
  visit: (match: ExactOccurrenceRange, window: ScanWindow) => boolean,
): void {
  let next = from
  let size = Math.max(options.windows.first, query.length)

  for (let start = from; start < to; ) {
    const end = Math.min(to, start + size)
    const readStart = Math.max(0, start - options.lead)
    const window = {
      text: source.readRange(readStart, Math.min(source.length, end + query.length + 1)),
      start: readStart,
    }
    let index = window.text.indexOf(query, Math.max(next, start) - readStart)
    while (index !== -1 && readStart + index < end) {
      const match = { start: readStart + index, end: readStart + index + query.length }
      if (visit(match, window)) return

      next = options.overlapping ? match.start + 1 : match.end
      index = window.text.indexOf(query, next - readStart)
    }
    start = end
    size = Math.max(Math.min(options.windows.max, size * 2), query.length)
  }
}

function isWholeWordInWindow(window: ScanWindow, match: ExactOccurrenceRange): boolean {
  return isWholeWordRange(window.text, {
    start: match.start - window.start,
    end: match.end - window.start,
  })
}

function rangesOverlap(left: ExactOccurrenceRange, right: ExactOccurrenceRange): boolean {
  return left.start < right.end && right.start < left.end
}
