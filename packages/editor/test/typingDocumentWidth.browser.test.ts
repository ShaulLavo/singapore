import { afterEach, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { Editor } from '../src/editor/Editor'
import { createEmptySyntaxResult, type FoldRange } from '../src/syntax/session'
import { createSyntaxPlugin } from './factories/syntaxRuntime'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofType: (text: string) => Promise<void>
  }
}

// Every mounted row is sized by the document width, so a width write resizes, re-lays out and
// repaints all of them. Typing must write it only when the widest line actually grows.

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  editor?.dispose()
  editor = undefined
  host?.remove()
  host = undefined
})

const LONG_LINE = 'x'.repeat(160)

/** One fold per `section` line over the three lines under it. */
function sectionFolds(text: string): FoldRange[] {
  const lines = text.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const folds: FoldRange[] = []
  for (let row = 0; row + 3 < lines.length; row++) {
    if (!lines[row]!.startsWith('section')) continue
    const startIndex = starts[row]! + lines[row]!.length
    const endIndex = starts[row + 3]! + lines[row + 3]!.length
    folds.push({ startIndex, endIndex, startLine: row, endLine: row + 3, type: 'block' })
  }
  return folds
}

// Syntax folds move with every edit below them, and moving them during the edit is what defers the
// render to the pass that used to rewrite the width from a reset scan.
function foldingSyntax(text: () => string) {
  const result = () => ({ ...createEmptySyntaxResult(), folds: sectionFolds(text()) })
  return createSyntaxPlugin(() => ({
    foldingSupport: 'supported',
    analyze: async () => result(),
    getResult: result,
    getTokens: () => [],
    getSnapshotVersion: () => 0,
    dispose: () => undefined,
  }))
}

async function open(caretLine: number): Promise<{ instance: Editor; extent: HTMLElement }> {
  host = document.createElement('div')
  host.style.cssText = 'width:400px;height:300px;display:flex;flex-direction:column'
  document.body.append(host)
  const instance: Editor = new Editor(host, {
    lineHeight: 20,
    wordWrap: false,
    plugins: [foldingSyntax(() => instance.materializeFullText())],
  })
  editor = instance
  const sections = Array.from({ length: 10 }, (_, section) =>
    [`section ${section}`].concat([0, 1, 2].map((item) => `  value ${section}.${item}`)),
  )
  const lines = [LONG_LINE].concat(sections.flat())
  instance.setText(lines.join('\n'), { languageId: 'sections' })
  await expect.poll(() => instance.getState().syntaxStatus).toBe('ready')
  instance.setSelection(lines.slice(0, caretLine + 1).join('\n').length)
  instance.focus()
  await expect.poll(() => document.activeElement).toBe(instance.getInputElement())
  for (let frame = 0; frame < 3; frame++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  const extent = host.querySelector<HTMLElement>('.editor-virtualized-extent')!
  return { instance, extent }
}

/** Every width the element's inline style held, in order, including ones overwritten in-task. */
function recordWidths(element: HTMLElement): () => number[] {
  const styles: string[] = []
  const observer = new MutationObserver((records) => {
    for (const record of records) styles.push(record.oldValue ?? '')
  })
  observer.observe(element, {
    attributes: true,
    attributeFilter: ['style'],
    attributeOldValue: true,
  })
  return () => {
    observer.disconnect()
    for (const record of observer.takeRecords()) styles.push(record.oldValue ?? '')
    if (styles.length > 0) styles.push(element.getAttribute('style') ?? '')
    return styles.map((style) =>
      Number.parseFloat(/(?:^|;)\s*width:\s*([\d.]+)px/.exec(style)?.[1] ?? 'NaN'),
    )
  }
}

it('leaves the document width alone while typing on a line that is not the widest', async () => {
  const { instance, extent } = await open(10)
  const stop = recordWidths(extent)

  await commands.proofType('abc')
  await new Promise((resolve) => requestAnimationFrame(resolve))

  expect(instance.materializeFullText().split('\n')[10]).toBe('  value 2.0abc')
  expect(stop()).toEqual([])
})

it('only grows the document width while typing on the widest line', async () => {
  const { instance, extent } = await open(0)
  const stop = recordWidths(extent)

  await commands.proofType('ab')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const widths = stop()

  expect(instance.materializeFullText().split('\n')[0]).toBe(`${LONG_LINE}ab`)
  // The starting width, then one growth per key at most.
  expect(widths.length).toBeLessThanOrEqual(3)
  for (let index = 1; index < widths.length; index++)
    expect(widths[index]).toBeGreaterThan(widths[index - 1]!)
  const scroller = host!.querySelector<HTMLElement>('.editor-virtualized')!
  expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth)
})
