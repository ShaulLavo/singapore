import { afterEach, expect, it, vi } from 'vitest'
import { commands } from 'vitest/browser'
import { Editor } from '../src/editor/Editor'
import { pagedHiddenInputContent } from '../src/editor/input'
import { createPieceTableSnapshot } from '../src/public/document'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofType: (text: string) => Promise<void>
  }
}

// The hidden textarea holds a window of the document around the caret. Writing its `value`
// rebuilds every line in it; typing patches the few characters that changed instead, except in
// WebKit (browser-quirks.md#webkit-textarea-editing-commands-cost-a-value-write).

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  vi.restoreAllMocks()
  editor?.dispose()
  editor = undefined
  host?.remove()
  host = undefined
})

const LINES = Array.from(
  { length: 120 },
  (_, row) => `  export const value_${row} = computeSomething(${row}, 'abc');`,
)

async function open(): Promise<{ instance: Editor; input: HTMLTextAreaElement; caret: number }> {
  host = document.createElement('div')
  host.style.cssText = 'width:600px;height:300px;display:flex;flex-direction:column'
  document.body.append(host)
  const instance = new Editor(host, { lineHeight: 20 })
  editor = instance
  instance.setText(LINES.join('\n'))
  const caret = LINES.slice(0, 60).join('\n').length
  instance.setSelection(caret)
  instance.focus()
  await expect.poll(() => document.activeElement).toBe(instance.getInputElement())
  return { instance, input: instance.getInputElement() as HTMLTextAreaElement, caret }
}

const isWebKit = (): boolean => CSS.supports('-webkit-nbsp-mode', 'space')

it('keeps the hidden input in step with typing without rewriting its value', async () => {
  const { instance, input, caret } = await open()
  const valueWrites = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set')

  await commands.proofType('abc')

  const text = instance.materializeFullText()
  expect(text.split('\n')[59]).toBe(`${LINES[59]}abc`)
  const expected = pagedHiddenInputContent(createPieceTableSnapshot(text), {
    startOffset: caret + 3,
    endOffset: caret + 3,
    reversed: false,
  })
  expect(input.value).toBe(expected.value)
  expect([input.selectionStart, input.selectionEnd]).toEqual([
    expected.selectionStart,
    expected.selectionEnd,
  ])
  if (!isWebKit()) expect(valueWrites).not.toHaveBeenCalled()
})

it('runs a native Undo as the editor undo, not the hidden input history', async () => {
  const { instance, input } = await open()
  await commands.proofType('ab')
  const typed = instance.materializeFullText()

  const undo = new InputEvent('beforeinput', {
    inputType: 'historyUndo',
    bubbles: true,
    cancelable: true,
  })
  input.dispatchEvent(undo)

  expect(undo.defaultPrevented).toBe(true)
  expect(instance.materializeFullText()).not.toBe(typed)
  expect(instance.materializeFullText()).toBe(LINES.join('\n'))
})
