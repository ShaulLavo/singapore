import type { TextReadSnapshot } from '@singapore-editor/core/document'

/** Half-open `[start, end)` offset range into the editor text buffer. */
export type OffsetRange = {
  readonly start: number
  readonly end: number
}

export function sameOffsetRange(left: OffsetRange | null, right: OffsetRange): boolean {
  return left?.start === right.start && left.end === right.end
}

/** The smallest range covering every range given, or null for none. */
export function unionOffsetRange(ranges: readonly OffsetRange[]): OffsetRange | null {
  let union: OffsetRange | null = null
  for (const range of ranges) {
    if (!union) {
      union = range
      continue
    }
    union = { start: Math.min(union.start, range.start), end: Math.max(union.end, range.end) }
  }
  return union
}

const UNICODE_IDENTIFIER_CHARACTER = /^[\p{ID_Start}\p{ID_Continue}$_]$/u

/**
 * The identifier under `offset`, or null when the offset does not sit on an identifier character.
 * Uses Unicode identifier characters (`ID_Start`, `ID_Continue`, `$`, `_`), matching JavaScript
 * and TypeScript names; an offset one past the last character still counts, so a caret right after
 * a name asks about that name.
 */
export function identifierRangeAtOffset(text: string, offset: number): OffsetRange | null {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const initial = identifierSpanAtOffset(text, clamped)
  if (!initial) return null

  let start = initial.start
  for (
    let prev = codePointSpanAt(text, start - 1);
    isIdentifierSpan(text, prev);
    prev = codePointSpanAt(text, start - 1)
  ) {
    start = prev!.start
  }

  let end = initial.end
  for (
    let next = codePointSpanAt(text, end);
    isIdentifierSpan(text, next);
    next = codePointSpanAt(text, end)
  ) {
    end = next!.end
  }

  if (end <= start) return null
  return { start, end }
}

/** The identifier at `offset`, else the single visible code point there. */
export function hoverTargetRange(text: string, offset: number): OffsetRange {
  const identifier = identifierRangeAtOffset(text, offset)
  if (identifier) return identifier
  if (text.length === 0) return { start: 0, end: 0 }

  const index = Math.max(0, Math.min(offset, text.length - 1))
  return codePointSpanAt(text, index) ?? { start: index, end: Math.min(text.length, index + 1) }
}

const HOVER_WINDOW_RADIUS = 256

/**
 * `hoverTargetRange` over a document source, reading a window of the offset's line rather than the
 * document. The window widens only while an identifier runs into its edge.
 */
export function hoverTargetRangeInSource(source: TextReadSnapshot, offset: number): OffsetRange {
  const line = source.lineRange(source.lineAt(Math.min(offset, Math.max(0, source.length - 1))))
  // One past the break, so a caret on the line break targets it as the string search did.
  const lineEnd = Math.min(source.length, line.end + 1)
  for (let radius = HOVER_WINDOW_RADIUS; ; radius *= 2) {
    const from = Math.max(line.start, offset - radius)
    const to = Math.min(lineEnd, Math.max(from, offset + radius))
    const local = hoverTargetRange(source.readRange(from, to), offset - from)
    const range = { start: from + local.start, end: from + local.end }
    const clippedLeft = range.start <= from + 1 && from > line.start
    const clippedRight = range.end >= to - 1 && to < lineEnd
    if (!clippedLeft && !clippedRight) return range
  }
}

function identifierSpanAtOffset(text: string, offset: number): OffsetRange | null {
  const at = codePointSpanAt(text, offset)
  if (isIdentifierSpan(text, at)) return at
  if (offset <= 0) return null
  const before = codePointSpanAt(text, offset - 1)
  return isIdentifierSpan(text, before) ? before : null
}

function codePointSpanAt(text: string, index: number): OffsetRange | null {
  if (index < 0 || index >= text.length) return null
  const code = text.charCodeAt(index)
  if (isLowSurrogate(code) && index > 0 && isHighSurrogate(text.charCodeAt(index - 1))) {
    return { start: index - 1, end: index + 1 }
  }
  if (
    isHighSurrogate(code) &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return { start: index, end: index + 2 }
  }
  return { start: index, end: index + 1 }
}

function isIdentifierSpan(text: string, span: OffsetRange | null): boolean {
  if (!span) return false
  return UNICODE_IDENTIFIER_CHARACTER.test(text.slice(span.start, span.end))
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
