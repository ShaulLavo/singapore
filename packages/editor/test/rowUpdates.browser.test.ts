import { afterEach, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { Editor } from '../src/editor/Editor'
import {
  getRowUpdateCounts,
  resetRowUpdateCounts,
} from '../src/virtualization/virtualizedTextViewRows'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofKeyPress: (key: string) => Promise<void>
    proofType: (text: string) => Promise<void>
  }
}

// An edit rebuilds the rows whose text it changed. Rows it did not reach stay mounted as they are,
// and rows below it whose text only moved keep their DOM and move their offsets.

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  editor?.dispose()
  editor = undefined
  host?.remove()
  host = undefined
})

const LINE_COUNT = 80
const LINES = Array.from({ length: LINE_COUNT }, (_, line) => `line ${line} = value${line}`)

function lineStart(lines: readonly string[], line: number): number {
  return lines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0)
}

/** One token over each line's `valueN`, the word every check below reads back from the paint. */
function valueTokens(lines: readonly string[]) {
  return lines.map((text, line) => {
    const start = lineStart(lines, line) + text.indexOf('value')
    return { start, end: start + `value${line}`.length, style: { color: '#123456' } }
  })
}

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

async function open(options: { wordWrap?: boolean } = {}): Promise<Editor> {
  host = document.createElement('div')
  host.style.cssText = 'width:400px;height:300px;display:flex;flex-direction:column'
  document.body.append(host)
  const instance = new Editor(host, { lineHeight: 20, wordWrap: options.wordWrap ?? false })
  editor = instance
  instance.setText(LINES.join('\n'))
  instance.setTokens(valueTokens(LINES))
  // Put the caret mid-document so mounted rows sit both above and below the edited line.
  instance.setSelection(lineStart(LINES, 40) + 'line 40'.length)
  instance.focus()
  await expect.poll(() => document.activeElement).toBe(instance.getInputElement())
  await frames(3)
  return instance
}

function paintedTokenText(): string[] {
  const text: string[] = []
  for (const [, highlight] of CSS.highlights) {
    for (const range of highlight) {
      if (!host?.contains(range.startContainer)) continue
      const readable = document.createRange()
      readable.setStart(range.startContainer, range.startOffset)
      readable.setEnd(range.endContainer, range.endOffset)
      text.push(readable.toString())
    }
  }
  return text
}

function mountedRows(): { line: number; text: string }[] {
  const rows = host!.querySelectorAll<HTMLElement>('[data-editor-virtual-row]')
  return Array.from(rows, (row) => ({
    line: Number(row.dataset.editorVirtualRow),
    text: row.textContent ?? '',
  })).toSorted((left, right) => left.line - right.line)
}

/** Every mounted row shows its document line, and every token paints exactly its `valueN`. */
function expectPaintMatches(instance: Editor): void {
  const lines = instance.materializeFullText().split('\n')
  const rows = mountedRows()
  expect(rows.length).toBeGreaterThan(10)
  for (const row of rows) expect(row.text).toBe(lines[row.line])
  const expected = rows.flatMap((row) => row.text.match(/value\d+/g) ?? [])
  expect(paintedTokenText().toSorted()).toEqual(expected.toSorted())
}

it('rebuilds only the edited row on each key and shifts the rows below it', async () => {
  const instance = await open()
  resetRowUpdateCounts()

  const typed = 'abc'
  for (const key of typed) {
    await commands.proofType(key)
    await frames(2)
  }

  expect(instance.materializeFullText().split('\n')[40]).toBe('line 40abc = value40')
  const counts = getRowUpdateCounts()
  // On main every mounted row (about 25 here) went through the rebuild path on every key.
  expect(counts.rebuilt).toBeLessThanOrEqual(typed.length)
  expect(counts.shifted).toBeGreaterThan(0)
  expectPaintMatches(instance)
})

it('keeps rows and paint right across a line insert, a delete and undo', async () => {
  const instance = await open()

  await commands.proofKeyPress('Enter')
  await frames(2)
  expect(instance.materializeFullText().split('\n')[41]).toBe(' = value40')
  expectPaintMatches(instance)

  await commands.proofKeyPress('Backspace')
  await commands.proofKeyPress('Backspace')
  await frames(2)
  expect(instance.materializeFullText().split('\n')[40]).toBe('line 4 = value40')
  expectPaintMatches(instance)

  const original = LINES.join('\n')
  for (let step = 0; step < 4 && instance.materializeFullText() !== original; step++) {
    // The command, not a key: WebKit on Linux does not route Control+Z to the editor's undo.
    instance.dispatchCommand('undo')
    await frames(2)
    expectPaintMatches(instance)
  }
  expect(instance.materializeFullText()).toBe(original)
})

it('keeps wrapped rows right while typing', async () => {
  const instance = await open({ wordWrap: true })
  resetRowUpdateCounts()

  await commands.proofType('wrapped text that runs past the edge of the editor ')
  await frames(2)

  const edited = 'line 40wrapped text that runs past the edge of the editor  = value40'
  expect(instance.materializeFullText().split('\n')[40]).toBe(edited)
  // The edited line now spans several display rows; read them back in order.
  const rows = mountedRows()
  expect(rows.length).toBeGreaterThan(10)
  expect(rows.map((row) => row.text).join('')).toContain(edited)
  const painted = paintedTokenText()
  expect(painted.length).toBeGreaterThan(10)
  for (const text of painted) expect(text).toMatch(/^value\d+$/)
})
