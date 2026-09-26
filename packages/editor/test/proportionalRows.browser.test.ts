import { afterEach, expect, test } from 'vitest'

import { Editor } from '../src/editor/Editor'
import '../src/style.css'

/**
 * A long unwrapped row in a proportional face: the window mounted at a scroll offset, the spacer in
 * front of it and the horizontal extent all come from measured advances.
 */

const FACE = 'Noto Sans'
const LONG = Array.from({ length: 2500 }, (_, index) =>
  index % 2 === 0 ? 'WWWWWWW ' : 'iiiiiii ',
).join('')

const editors: Editor[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
  for (const container of containers.splice(0)) container.remove()
})

async function mount() {
  await document.fonts.load(`13px "${FACE}"`)
  const container = document.createElement('div')
  container.style.cssText = 'display:flex;flex-direction:column;width:500px;height:200px'
  document.body.append(container)
  containers.push(container)
  const editor = new Editor(container, { fontFamily: `"${FACE}"` })
  editors.push(editor)
  editor.setText(`${LONG}\nshort`)
  const scroller = container.querySelector<HTMLElement>('.editor-virtualized')!
  await expect.poll(() => scroller.scrollWidth).toBeGreaterThan(1000)
  return { container, editor, scroller }
}

function textWidth(text: string): number {
  const probe = document.createElement('span')
  probe.style.cssText = `font:13px "${FACE}";white-space:pre;position:absolute`
  probe.textContent = text
  document.body.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width
}

function characterAt(x: number, y: number): string {
  const position = document.caretPositionFromPoint(x, y)
  if (!position || position.offsetNode.nodeType !== Node.TEXT_NODE) return ''
  return position.offsetNode.textContent?.charAt(position.offset) ?? ''
}

test('reaches the end of the widest line and no further', async () => {
  const { scroller } = await mount()
  const gutter = scroller.querySelector<HTMLElement>('.editor-virtualized-gutter')
  const gutterWidth = gutter?.getBoundingClientRect().width ?? 0

  const full = textWidth(LONG)
  const extent = scroller.scrollWidth - gutterWidth
  expect(extent).toBeGreaterThanOrEqual(full)
  expect(extent - full).toBeLessThan(textWidth('W') * 2)
})

test('mounts the text a scroll offset reaches, under the spacer that stands for the rest', async () => {
  const { container, scroller } = await mount()
  const row = container.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
  const rect = row.getBoundingClientRect()
  const y = rect.top + rect.height / 2
  const gutter = scroller.querySelector<HTMLElement>('.editor-virtualized-gutter')
  const gutterWidth = gutter?.getBoundingClientRect().width ?? 0

  for (const target of [30_000, 60_000, 90_000]) {
    scroller.scrollLeft = target
    await expect.poll(() => Number(row.dataset.editorVirtualWindowStart ?? '0')).toBeGreaterThan(0)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const x = scroller.getBoundingClientRect().left + gutterWidth + scroller.clientWidth / 2
    const expected = columnAtWidth(scroller.scrollLeft + scroller.clientWidth / 2)
    const nearby = new Set([LONG[expected - 1], LONG[expected], LONG[expected + 1]])
    expect(nearby.has(characterAt(x, y))).toBe(true)
    expect((row.textContent ?? '').length).toBeLessThan(LONG.length)
  }
})

/** The column a full-width layout of the line puts at `width`, by bisecting measured prefixes. */
function columnAtWidth(width: number): number {
  let low = 0
  let high = LONG.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textWidth(LONG.slice(0, middle)) <= width) low = middle
    else high = middle - 1
  }
  return low
}
