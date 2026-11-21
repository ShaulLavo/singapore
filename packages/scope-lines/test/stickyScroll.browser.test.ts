import { Editor } from '@singapore-editor/core/editor'
import { afterEach, expect, test } from 'vitest'
import { createStickyScrollPlugin } from '../src/stickyScroll'
import '@singapore-editor/core/style.css'

const ROW_HEIGHT = 20
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

test.each([
  {
    name: 'a short editor',
    height: 300,
    depth: 7,
    expected: [0, '⋯ 3 scopes', 4, 5, 6],
  },
  {
    name: 'a tall editor',
    height: 1000,
    depth: 18,
    expected: [0, '⋯ 3 scopes'].concat(Array.from({ length: 14 }, (_, level) => level + 4)),
  },
  {
    name: 'an explicit cap smaller than the viewport budget',
    height: 1000,
    depth: 7,
    cap: 3,
    expected: [0, '⋯ 5 scopes', 6],
  },
  {
    name: 'an explicit cap larger than the viewport budget',
    height: 300,
    depth: 7,
    cap: 12,
    expected: [0, '⋯ 3 scopes', 4, 5, 6],
  },
  {
    name: 'a stack that fits without collapsing',
    height: 300,
    depth: 5,
    expected: [0, 1, 2, 3, 4],
  },
])('renders the expected sticky rows for $name', async ({ height, depth, cap, expected }) => {
  const host = mountEditor(height, depth, cap)

  await expect.poll(() => stickyRows(host)).toEqual(expected.map(toStickyText))
  expectStackBounds(host, expected.length)
})

test('recalculates the stack as the editor resizes while scrolled into nested scopes', async () => {
  const host = mountEditor(300, 7)

  await expect.poll(() => stickyRows(host)).toEqual([0, '⋯ 3 scopes', 4, 5, 6].map(toStickyText))

  host.style.height = '120px'
  await expect.poll(() => stickyRows(host)).toEqual([5, 6].map(toStickyText))
  expectStackBounds(host, 2)

  host.style.height = '60px'
  await expect.poll(() => stickyRows(host)).toEqual([6].map(toStickyText))
  expectStackBounds(host, 1)

  host.style.height = '59px'
  await expect.poll(() => stickyRows(host)).toEqual([])

  host.style.height = '600px'
  await expect.poll(() => stickyRows(host)).toEqual(Array.from({ length: 7 }, (_, i) => scope(i)))
  expectStackBounds(host, 7)
})

function mountEditor(height: number, depth: number, maxLineCount?: number): HTMLElement {
  const host = document.createElement('div')
  host.style.height = `${height}px`
  host.style.width = '800px'
  document.body.appendChild(host)
  const editor = new Editor(host, {
    lineHeight: ROW_HEIGHT,
    plugins: [createStickyScrollPlugin({ maxLineCount })],
  })
  cleanup.push(() => {
    editor.dispose()
    host.remove()
  })

  const lines = Array.from({ length: depth }, (_, level) => scope(level)).concat(
    Array.from({ length: 120 }, (_, index) => `${'  '.repeat(depth)}step(${index})`),
    Array.from({ length: depth }, (_, index) => `${'  '.repeat(depth - index - 1)}}`),
  )
  editor.setText(lines.join('\n'))
  editor.setScrollPosition({ top: (depth + 24) * ROW_HEIGHT })
  return host
}

function scope(level: number): string {
  return `${'  '.repeat(level)}if (level${level}) {`
}

function toStickyText(row: number | string): string {
  return typeof row === 'number' ? scope(row) : row
}

function stickyRows(host: HTMLElement): readonly string[] {
  const rows = host.querySelectorAll(
    '.editor-sticky-scroll:not([hidden]) .editor-virtualized-row:not([hidden])',
  )
  return Array.from(rows, (row) => ({
    top: row.getBoundingClientRect().top,
    text: row.textContent ?? '',
  }))
    .sort((left, right) => left.top - right.top)
    .map(({ text }) => text)
}

function expectStackBounds(host: HTMLElement, rowCount: number): void {
  const scrollport = host.querySelector<HTMLElement>('.editor-virtualized')!
  const stack = host.querySelector<HTMLElement>('.editor-sticky-scroll-lines')!
  const stackBounds = stack.getBoundingClientRect()

  expect(stackBounds.height).toBe(rowCount * ROW_HEIGHT)
  expect(stackBounds.height).toBeLessThanOrEqual(scrollport.clientHeight / 3)
  expect(getComputedStyle(stack).pointerEvents).toBe('none')
}
