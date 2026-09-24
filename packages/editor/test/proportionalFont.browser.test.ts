import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'
import { VirtualizedTextView } from '../src/virtualization'
import { clearBrowserTextMetricsCache } from '../src/virtualization/browserMetrics'

// Narrow and wide glyphs side by side: in a proportional face their advances differ by a factor of
// three or more, so column arithmetic drifts by whole characters within a few columns.
const LINE = 'iiii WWWW llll mmmm .... 0000 ||||'

function rangeReads(run: () => void): number {
  const rects = Range.prototype.getClientRects
  const bounding = Range.prototype.getBoundingClientRect
  let reads = 0
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    reads += 1
    return rects.call(this)
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(this: Range) {
    reads += 1
    return bounding.call(this)
  }
  try {
    run()
  } finally {
    Range.prototype.getClientRects = rects
    Range.prototype.getBoundingClientRect = bounding
  }
  return reads
}

describe('font advances', () => {
  let host: HTMLDivElement
  let style: HTMLStyleElement
  let view: VirtualizedTextView | null = null

  function open(fontFamily: string): HTMLElement {
    style.textContent = `.font-under-test * { font-family: ${fontFamily} !important; }`
    clearBrowserTextMetricsCache()
    view = new VirtualizedTextView(host, { rowHeight: 20 })
    view.setScrollMetrics(0, 160, 600)
    view.setText(LINE)
    return view.getState().mountedRows[0]!.element
  }

  /** The column the view reports under the left edge of each character, read from the DOM. */
  function hitColumns(row: HTMLElement): { expected: number[]; actual: number[] } {
    const node = Array.from(row.childNodes).find((child) => child.nodeType === Node.TEXT_NODE)!
    const rowRect = row.getBoundingClientRect()
    const range = document.createRange()
    const expected: number[] = []
    const actual: number[] = []
    for (let column = 0; column < LINE.length; column++) {
      range.setStart(node, column)
      range.setEnd(node, column + 1)
      const hit = view!.rowAtPoint(range.getBoundingClientRect().left + 1, rowRect.top + 10)
      expected.push(column)
      actual.push(hit?.offset ?? -1)
    }
    return { expected, actual }
  }

  beforeEach(() => {
    style = document.createElement('style')
    document.head.append(style)
    host = document.createElement('div')
    host.className = 'font-under-test'
    host.style.cssText = 'width: 600px; height: 160px'
    document.body.append(host)
  })

  afterEach(() => {
    view?.dispose()
    view = null
    host.remove()
    style.remove()
    clearBrowserTextMetricsCache()
  })

  it('hit-tests every column of a proportional font where the glyph is drawn', () => {
    const { expected, actual } = hitColumns(open('sans-serif'))
    expect(actual).toEqual(expected)
  })

  it('keeps monospace rows on arithmetic geometry, with no range reads', () => {
    const row = open('monospace')
    let result: ReturnType<typeof hitColumns> | null = null
    const reads = rangeReads(() => {
      const rowRect = row.getBoundingClientRect()
      for (let x = 2; x < 200; x += 7) view!.rowAtPoint(rowRect.left + x, rowRect.top + 10)
    })
    result = hitColumns(row)
    expect(reads).toBe(0)
    expect(result.actual).toEqual(result.expected)
  })
})
