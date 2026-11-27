import { afterEach, assert, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { Editor } from '../src/editor/Editor'
import type { RenderTraceAction, RenderTraceMetrics } from './renderPerformanceCommands'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofCompositorLayerCount: () => Promise<number>
    proofRenderTrace: (action: RenderTraceAction) => Promise<RenderTraceMetrics>
  }
}

// Deterministic Chromium rendering invariants that guard against CSS and DOM performance
// regressions (per-row GPU layer explosion, broken Blink relayout boundaries, CSS-animated
// caret restyles, and scroll layout thrashing) without flaky wall-clock millisecond thresholds.

const mounted: { editor: Editor; host: HTMLElement; style?: HTMLStyleElement }[] = []

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.editor.dispose()
    entry.host.remove()
    entry.style?.remove()
  }
})

const LINE_COUNT = 2000
const LINES = Array.from(
  { length: LINE_COUNT },
  (_, line) => `const value${line} = compute(${line}, "hello")`,
)
const SOURCE = LINES.join('\n')

function sampleTokens() {
  const tokens: { start: number; end: number; style: { color: string } }[] = []
  let offset = 0
  for (let line = 0; line < 200; line += 1) {
    const text = LINES[line]!
    tokens.push({ start: offset, end: offset + 5, style: { color: '#569cd6' } })
    tokens.push({ start: offset + 6, end: offset + 11, style: { color: '#dcdcaa' } })
    offset += text.length + 1
  }
  return tokens
}

async function waitFrames(count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function mountEditor(
  id: string,
  height: number,
): Promise<{ editor: Editor; host: HTMLElement }> {
  const host = document.createElement('div')
  host.id = id
  host.style.cssText = `width:760px;height:${height}px;display:flex;flex-direction:column`
  document.body.append(host)
  const editor = new Editor(host, {
    fontSize: 13,
    lineHeight: 20,
    theme: {
      type: 'dark',
      backgroundColor: '#1e1e1e',
      foregroundColor: '#d4d4d4',
      selectionColor: '#1f3b5c',
    },
  })
  mounted.push({ editor, host })
  editor.setText(SOURCE)
  editor.setTokens(sampleTokens())
  editor.focus()
  editor.setSelection(10)
  await expect.poll(() => document.activeElement).toBe(editor.getInputElement())
  await waitFrames(3)
  return { editor, host }
}

it('keeps compositor layers constant as mounted rows grow and preserves Chromium row CSS guardrails', async () => {
  const { host } = await mountEditor('perf-layers', 160)
  const shortRows = host.querySelectorAll('.editor-virtualized-row').length
  const shortLayers = await commands.proofCompositorLayerCount()
  expect(shortRows).toBeGreaterThan(0)
  expect(shortLayers).toBeGreaterThan(0)

  host.style.height = '560px'
  await expect
    .poll(() => host.querySelectorAll('.editor-virtualized-row').length)
    .toBeGreaterThanOrEqual(shortRows + 15)
  await waitFrames(2)

  const tallRows = host.querySelectorAll('.editor-virtualized-row').length
  const tallLayers = await commands.proofCompositorLayerCount()
  expect(tallLayers - shortLayers).toBeLessThanOrEqual(2)

  const row = host.querySelector<HTMLElement>('.editor-virtualized-row')
  assert(row)
  expect(getComputedStyle(row).willChange).toBe('auto')
  expect(getComputedStyle(row).contain).toBe('strict')
  expect(getComputedStyle(row).isolation).toBe('auto')

  // Self-check: verify the CDP layer counter actually catches per-row layer promotion.
  const probeStyle = document.createElement('style')
  probeStyle.textContent =
    '#perf-layers .editor-virtualized-row { will-change: transform !important; }'
  document.head.append(probeStyle)
  mounted.at(-1)!.style = probeStyle
  await waitFrames(2)
  const promotedLayers = await commands.proofCompositorLayerCount()
  expect(promotedLayers - tallLayers).toBeGreaterThanOrEqual(tallRows - 4)
})

it('contains single-keystroke layout and style recalculation inside the edited row', async () => {
  const { host } = await mountEditor('perf-edit-boundary', 560)
  const rowCount = host.querySelectorAll('.editor-virtualized-row').length
  expect(rowCount).toBeGreaterThanOrEqual(25)

  const trace = await commands.proofRenderTrace({ kind: 'type', text: 'x' })
  expect(trace.layoutCount).toBeGreaterThanOrEqual(1)
  expect(trace.layoutCount).toBeLessThanOrEqual(2)
  // With `contain: layout paint style size`, editing one row lays out only that row (~2 boxes),
  // not a document-rooted pass over every mounted row (100+ boxes).
  expect(trace.maxTotalLayoutObjects).toBeLessThan(rowCount)
  expect(trace.maxStyleRecalcElements).toBeLessThan(rowCount)
})

it('avoids per-frame style recalculation and paint while idle with a focused caret', async () => {
  const { editor, host } = await mountEditor('perf-idle-caret', 400)
  const caretLayer = host.querySelector<HTMLElement>('.editor-virtualized-caret-layer')
  const caret = host.querySelector<HTMLElement>('.editor-virtualized-caret')
  assert(caretLayer)
  assert(caret)
  expect(getComputedStyle(caretLayer).animationName).toBe('none')
  expect(getComputedStyle(caret).animationName).toBe('none')

  // Restart the 500ms solid blink phase and measure 6 idle animation frames (~100ms).
  editor.setSelection(12)
  await waitFrames(2)
  const trace = await commands.proofRenderTrace({ kind: 'idle', frames: 6 })
  expect(trace.styleRecalcCount).toBe(0)
  expect(trace.layoutCount).toBe(0)
  expect(trace.paintCount).toBe(0)
})

it('recycles rows on scroll without per-row layout thrashing', async () => {
  const { host } = await mountEditor('perf-scroll-recycle', 560)
  const beforeFirstRow = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')
  assert(beforeFirstRow)

  const trace = await commands.proofRenderTrace({
    kind: 'scroll',
    selector: '#perf-scroll-recycle .editor-virtualized',
    top: 400,
  })
  expect(host.querySelector('[data-editor-virtual-row="0"]')).toBeNull()
  expect(host.querySelector('[data-editor-virtual-row="25"]')).not.toBeNull()
  expect(trace.layoutCount).toBeLessThanOrEqual(3)
})
