/**
 * Soft-wrap breaks placed at word boundaries, one line at a time, fed one code unit at a time.
 *
 * A row may break before the first non-space after spaces, on either side of a CJK character, and
 * on either edge of an unbreakable run (a replacement painted as one node). Spaces never start a row:
 * they hang past the edge, as `white-space: pre-wrap` lets them. A word wider than the row breaks at
 * the column that overflows; an unbreakable run wider than the row overflows instead.
 */
export type WordWrapLine = {
  length: number
  visual: number
  segmentStart: number
  segmentVisual: number
  breakAt: number
  breakVisual: number
  previousSpace: boolean
  previousCjk: boolean
  readonly ends: number[]
}

/** Display ranges no break may fall inside, sorted and disjoint. */
export type UnbreakableRuns = readonly (readonly [start: number, end: number])[]

const NO_RUNS: UnbreakableRuns = []

export function createWordWrapLine(): WordWrapLine {
  return {
    length: 0,
    visual: 0,
    segmentStart: 0,
    segmentVisual: 0,
    breakAt: 0,
    breakVisual: 0,
    previousSpace: false,
    previousCjk: false,
    ends: [],
  }
}

export function resetWordWrapLine(line: WordWrapLine): void {
  line.length = 0
  line.visual = 0
  line.segmentStart = 0
  line.segmentVisual = 0
  line.breakAt = 0
  line.breakVisual = 0
  line.previousSpace = false
  line.previousCjk = false
  line.ends.length = 0
}

/**
 * Appends `text[from, to)`, which holds no line break. The plain-text loop keeps the state in locals:
 * a whole-document wrap feeds every character of the file through here.
 */
export function appendWordWrapText(
  line: WordWrapLine,
  text: string,
  from: number,
  to: number,
  width: number,
  tabSize: number,
  runs: UnbreakableRuns = NO_RUNS,
): void {
  if (runs.length > 0) {
    for (let index = from; index < to; index += 1) {
      appendWordWrapCodeUnit(line, text.charCodeAt(index), width, tabSize, runs)
    }
    return
  }

  let { length, visual, segmentStart, segmentVisual, breakAt, breakVisual } = line
  let previousSpace = line.previousSpace
  let previousCjk = line.previousCjk
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index)
    const space = code === 32 || code === 9
    const cjk = code >= 0x2e80 && isCjkCodeUnit(code)
    if (!space && length > 0 && (previousSpace || cjk || previousCjk)) {
      breakAt = length
      breakVisual = visual
    }
    const cells = code === 9 ? tabSize - (visual % tabSize) : 1
    if (!space && segmentVisual > 0 && segmentVisual + cells > width) {
      const at = breakAt > segmentStart ? breakAt : length
      line.ends.push(at)
      segmentVisual = at === length ? 0 : visual - breakVisual
      segmentStart = at
    }
    visual += cells
    segmentVisual += cells
    length += 1
    previousSpace = space
    previousCjk = cjk
  }
  line.length = length
  line.visual = visual
  line.segmentStart = segmentStart
  line.segmentVisual = segmentVisual
  line.breakAt = breakAt
  line.breakVisual = breakVisual
  line.previousSpace = previousSpace
  line.previousCjk = previousCjk
}

/** Appends one code unit; `runs` are consulted by index, so pass them for inline rows only. */
function appendWordWrapCodeUnit(
  line: WordWrapLine,
  code: number,
  width: number,
  tabSize: number,
  runs: UnbreakableRuns = NO_RUNS,
): void {
  const index = line.length
  const space = code === 32 || code === 9
  const cjk = isCjkCodeUnit(code)
  const interior = insideRun(runs, index)
  if (!interior && index > 0 && isBreakOpportunity(line, runs, index, space, cjk)) {
    line.breakAt = index
    line.breakVisual = line.visual
  }

  const cells = code === 9 ? tabSize - (line.visual % tabSize) : 1
  if (!space && line.segmentVisual > 0 && line.segmentVisual + cells > width) {
    breakBefore(line, index, interior)
  }

  line.visual += cells
  line.segmentVisual += cells
  line.length += 1
  line.previousSpace = space
  line.previousCjk = cjk
}

function isBreakOpportunity(
  line: WordWrapLine,
  runs: UnbreakableRuns,
  index: number,
  space: boolean,
  cjk: boolean,
): boolean {
  if (space) return false
  if (line.previousSpace || cjk || line.previousCjk) return true
  return runs.length > 0 && isRunEdge(runs, index)
}

function breakBefore(line: WordWrapLine, index: number, interior: boolean): void {
  if (line.breakAt > line.segmentStart) {
    line.ends.push(line.breakAt)
    line.segmentStart = line.breakAt
    line.segmentVisual = line.visual - line.breakVisual
    return
  }
  if (interior) return

  line.ends.push(index)
  line.segmentStart = index
  line.segmentVisual = 0
}

function insideRun(runs: UnbreakableRuns, index: number): boolean {
  for (const [start, end] of runs) {
    if (index <= start) return false
    if (index < end) return true
  }
  return false
}

function isRunEdge(runs: UnbreakableRuns, index: number): boolean {
  return runs.some(([start, end]) => index === start || index === end)
}

/** Han, kana, Hangul and full-width forms: scripts that break between any two characters. */
function isCjkCodeUnit(code: number): boolean {
  if (code < 0x2e80) return false
  if (code <= 0x9fff) return true
  if (code >= 0xac00 && code <= 0xd7af) return true
  if (code >= 0xf900 && code <= 0xfaff) return true
  return code >= 0xff00 && code <= 0xffef
}
