import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VirtualizedTextView, type VirtualizedTextHighlightRegistry } from '../src/virtualization'

class MockHighlight extends Set<Range> {
  priority = 0
}
const highlights = new Map<string, Highlight>()
const registry: VirtualizedTextHighlightRegistry = {
  set: (name, highlight) => {
    highlights.set(name, highlight)
  },
  delete: (name) => highlights.delete(name),
}
let host: HTMLElement
let view: VirtualizedTextView
beforeEach(() => {
  vi.stubGlobal('Highlight', MockHighlight)
  highlights.clear()
  host = document.createElement('div')
  document.body.append(host)
  view = new VirtualizedTextView(host, { rowHeight: 20, highlightRegistry: registry })
  view.setText('abcdefghij')
  view.setScrollMetrics(0, 100, 400)
})
afterEach(() => {
  view.dispose()
  host.remove()
  vi.unstubAllGlobals()
})

it('uses colored base and producer twins at their original priorities', () => {
  view.setRangeHighlight('semantic', [{ start: 0, end: 10 }], { color: '#00ff00', zIndex: 2 })
  view.setRangeHighlight('fade', [{ start: 2, end: 5 }], {
    overlay: { dim: 0.5, textDecoration: 'line-through' },
  })
  expect(highlights.has('fade')).toBe(false)
  expect([...highlights.values()].some((highlight) => highlight.priority === -1)).toBe(true)
  expect(
    [...highlights.entries()].some(
      ([name, highlight]) =>
        name.startsWith('semantic-overlay-') && highlight.priority === 2 && highlight.size > 0,
    ),
  ).toBe(true)
  expect(document.head.textContent).toContain('color-mix(in srgb, #00ff00 50%, transparent)')
  expect(document.head.textContent).toContain('line-through')
})

it('rebuilds token row signatures when a mask moves or clears', () => {
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  view.setRangeHighlight('fade', [{ start: 0, end: 2 }], { overlay: { dim: 0.5 } })
  const faded = () =>
    [...highlights.entries()]
      .filter(([name, highlight]) => name.startsWith('editor-shared-token-') && highlight.size > 0)
      .flatMap(([, highlight]) =>
        [...highlight]
          .filter((range) => range.startOffset !== 0 || range.endOffset !== 10)
          .map((range) => [range.startOffset, range.endOffset]),
      )
  expect(faded()).toContainEqual([0, 2])
  view.setRangeHighlight('fade', [{ start: 4, end: 6 }], { overlay: { dim: 0.5 } })
  expect(faded()).toContainEqual([4, 6])
  expect(faded()).not.toContainEqual([0, 2])
  view.clearRangeHighlight('fade')
  expect(faded()).toEqual([])
})

it('rejects overlays mixed with ordinary paint fields', () => {
  expect(() =>
    view.setRangeHighlight(
      'invalid',
      [{ start: 0, end: 2 }],
      // @ts-expect-error JavaScript callers still receive boundary validation.
      { overlay: { dim: 0.5 }, color: '#ff0000' },
    ),
  ).toThrow()
})

it('keeps opted-out color producers opaque while decorating them', () => {
  view.setRangeHighlight('find', [{ start: 0, end: 10 }], {
    color: '#123456',
    zIndex: 6,
    dimmable: false,
  })
  view.setRangeHighlight('fade', [{ start: 0, end: 10 }], {
    overlay: { dim: 0.4, textDecoration: 'line-through' },
  })
  expect(document.head.textContent).not.toContain('color-mix(in srgb, #123456')
  expect(
    [...highlights.entries()].some(
      ([name, highlight]) => name.startsWith('find-overlay-') && highlight.priority === 6,
    ),
  ).toBe(true)
})

it('releases obsolete token twins when opacity changes', () => {
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  for (let step = 1; step < 10; step++) {
    view.setRangeHighlight('fade', [{ start: 0, end: 5 }], { overlay: { dim: step / 10 } })
    expect(
      [...highlights.keys()].filter((name) => name.startsWith('editor-shared-token-')).length,
    ).toBeLessThanOrEqual(2)
  }
})

it('restores base and range twins when the window resumes', () => {
  view.setRangeHighlight('semantic', [{ start: 0, end: 10 }], { color: '#00ff00', zIndex: 2 })
  view.setRangeHighlight('fade', [{ start: 2, end: 5 }], { overlay: { dim: 0.5 } })
  const entries = [...highlights.entries()]
  highlights.clear()
  window.dispatchEvent(new Event('focus'))
  expect([...highlights.entries()]).toEqual(entries)
})

it('rebuilds surrogate-safe mask edges when text changes under existing overlays', () => {
  view.setRangeHighlight('fade', [{ start: 1, end: 2 }], { overlay: { dim: 0.5 } })
  view.setText('😀abcdefgh')
  const base = [...highlights.entries()].find(([name]) => name.includes('-overlay-base-'))?.[1]
  expect(base).toBeDefined()
  expect([...base!].map((range) => [range.startOffset, range.endOffset])).toEqual([[0, 2]])
})

it('rebuilds the overlay after a same-line edit takes the token reconciliation path', () => {
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  view.setRangeHighlight('fade', [{ start: 1, end: 2 }], { overlay: { dim: 0.5 } })
  view.applyEdit({ from: 0, to: 2, text: '😀' }, '😀cdefghij')
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  const base = [...highlights.entries()].find(([name]) => name.includes('-overlay-base-'))?.[1]
  expect([...base!].map((range) => [range.startOffset, range.endOffset])).toEqual([[0, 2]])
})

it('retains syntax above a multiline edit while overlay twins remain active', () => {
  view.setText('aaaa\nbbbb\ncccc')
  view.setTokens([{ start: 0, end: 14, style: { color: '#ff0000' } }])
  view.setRangeHighlight('fade', [{ start: 0, end: 2 }], { overlay: { dim: 0.5 } })
  view.applyEdit({ from: 7, to: 7, text: '\n' }, 'aaaa\nbb\nbb\ncccc')
  view.setTokens([{ start: 0, end: 15, style: { color: '#ff0000' } }])
  const firstRowInk = [...highlights.entries()]
    .filter(([name]) => name.startsWith('editor-shared-token-'))
    .flatMap(([, highlight]) => [...highlight])
    .filter((range) => range.startContainer.textContent === 'aaaa')
  expect(firstRowInk.map((range) => [range.startOffset, range.endOffset])).toEqual(
    expect.arrayContaining([
      [0, 2],
      [2, 4],
    ]),
  )
})

it('keeps equal-priority range color above syntax after identical token updates', () => {
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  view.setRangeHighlight('color', [{ start: 0, end: 10 }], { color: '#00ff00' })
  view.setRangeHighlight('fade', [{ start: 0, end: 5 }], { overlay: { dim: 0.5 } })
  view.setTokens([{ start: 0, end: 10, style: { color: '#ff0000' } }])
  const winners = [...highlights.entries()].filter(([, highlight]) => highlight.priority === 0)
  expect(winners.at(-1)?.[0]).toBe('color-overlay-0')
})
