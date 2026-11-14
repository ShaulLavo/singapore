import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { createDocumentSession } from '../src/documentSession'
import type { EditorOptions } from '../src/editor/types'

let editor: Editor | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  try {
    editor?.dispose()
  } finally {
    editor = undefined
    host?.remove()
    host = undefined
  }
})

function open(text: string, options?: EditorOptions): Editor {
  host = document.createElement('div')
  document.body.append(host)
  editor = options ? new Editor(host, options) : new Editor(host)
  editor.setText(text)
  return editor
}

it.each([
  { text: 'alpha', start: 0, expected: 'lpha' },
  { text: 'alpha\nbravo', start: 5, expected: 'alphabravo' },
  { text: 'A🙂Z', start: 1, expected: 'AZ' },
  { text: 'Ae\u0301Z', start: 1, expected: 'AZ' },
])(
  'forward Delete removes the next character in $text and restores its caret on undo',
  ({ text, start, expected }) => {
    const instance = open(text)
    instance.setSelection(start)
    instance.dispatchCommand('deleteForward')
    expect(instance.materializeFullText()).toBe(expected)
    expect(instance.getSelections()).toMatchObject([{ anchorOffset: start, headOffset: start }])
    instance.dispatchCommand('undo')
    expect(instance.materializeFullText()).toBe(text)
    expect(instance.getSelections()).toMatchObject([{ anchorOffset: start, headOffset: start }])
    instance.dispatchCommand('redo')
    expect(instance.materializeFullText()).toBe(expected)
  },
)

it('deletes at multiple carets and selected ranges while preserving a caret at EOF', () => {
  const instance = open('abc def ghi')
  const session = createDocumentSession('abc def ghi')
  instance.attachSession(session)
  session.setSelections([
    { anchor: 0, head: 0 },
    { anchor: 4, head: 6 },
    { anchor: 11, head: 11 },
  ])
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('bc f ghi')
  expect(instance.getSelections()).toMatchObject([
    { anchorOffset: 0, headOffset: 0 },
    { anchorOffset: 3, headOffset: 3 },
    { anchorOffset: 8, headOffset: 8 },
  ])
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('abc def ghi')
  expect(instance.getSelections()).toMatchObject([
    { anchorOffset: 0, headOffset: 0 },
    { anchorOffset: 4, headOffset: 6 },
    { anchorOffset: 11, headOffset: 11 },
  ])
})

it('mirrors a forward deletion at a caret into the matching tag name', () => {
  const instance = open('<divx>hi</divx>', { languageId: 'tsx' })
  instance.setSelection(4)
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('<div>hi</div>')
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('<divx>hi</divx>')
})
