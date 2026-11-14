import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { createDocumentSession, createStaticDocumentSession } from '../src/documentSession'
import type { EditorOptions } from '../src/editor/types'
import { resolveSelection } from '../src/selections'

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
  { text: 'A👨‍👩‍👧‍👦Z', start: 1, expected: 'AZ' },
  { text: `Ae${'\u0301'.repeat(100)}Z`, start: 1, expected: 'AZ' },
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
  const instance = open('')
  instance.setText('<divx>hi</divx>', { languageId: 'tsx' })
  instance.setSelection(4)
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('<div>hi</div>')
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('<divx>hi</divx>')
})

it.each([
  { anchor: 1, head: 4 },
  { anchor: 4, head: 1 },
])(
  'deletes a selected range and restores its direction on undo: $anchor to $head',
  ({ anchor, head }) => {
    const instance = open('alpha')
    instance.setSelection(anchor, head)
    instance.dispatchCommand('deleteForward')
    expect(instance.materializeFullText()).toBe('aa')
    expect(instance.getSelections()).toMatchObject([{ anchorOffset: 1, headOffset: 1 }])
    instance.dispatchCommand('undo')
    expect(instance.materializeFullText()).toBe('alpha')
    expect(instance.getSelections()).toMatchObject([{ anchorOffset: anchor, headOffset: head }])
  },
)

it('does not delete from a readonly editor', () => {
  const instance = open('alpha', { editability: 'readonly' })
  instance.setSelection(0)
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('alpha')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
})

it('leaves static document sessions unchanged', () => {
  const session = createStaticDocumentSession('alpha')
  session.setSelection(0)
  expect(session.deleteForward().kind).toBe('none')
  expect(session.materializeFullText()).toBe('alpha')
  expect(session.canUndo()).toBe(false)
})

it('reanchors the caret before newer inserted text through undo, redo, and another Delete', () => {
  const instance = open('ab')
  instance.edit([{ from: 1, to: 1, text: 'XY' }])
  instance.setSelection(0)
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('XYb')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('aXYb')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
  instance.dispatchCommand('redo')
  expect(instance.materializeFullText()).toBe('XYb')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('Yb')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
})

it('groups repeated forward Delete into one keyboard undo and redo', () => {
  const instance = open('abcdef')
  instance.setSelection(0)
  instance.dispatchCommand('deleteForward')
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('cdef')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('abcdef')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
  instance.dispatchCommand('redo')
  expect(instance.materializeFullText()).toBe('cdef')
  expect(instance.getSelections()).toMatchObject([{ anchorOffset: 0, headOffset: 0 }])
})

it('preserves affinity, identity, last-added selection, and EOF carets across merged deletion targets', () => {
  const instance = open('ab cd')
  instance.edit([{ from: 1, to: 1, text: 'XY' }])
  const session = instance.getBufferSession()
  if (!session) throw new Error('Expected a buffer session')
  session.setSelections([
    { anchor: 0, affinity: 'before' },
    { anchor: 4, head: 6, affinity: 'before' },
    { anchor: 7, affinity: 'after' },
    { anchor: 0, affinity: 'after' },
  ])
  const readSelections = () => {
    const set = session.getSelections()
    return {
      lastAddedId: set.selections[set.lastAddedIndex ?? 0]?.id,
      selections: set.selections.map((selection) => {
        const resolved = resolveSelection(session.getSnapshot(), selection)
        return {
          id: resolved.id,
          affinity: resolved.affinity,
          goal: resolved.goal,
          anchor: resolved.anchorOffset,
          head: resolved.headOffset,
        }
      }),
    }
  }
  const before = readSelections()
  instance.dispatchCommand('deleteForward')
  expect(instance.materializeFullText()).toBe('XYbd')
  const after = readSelections()
  expect(after.selections).toEqual(
    before.selections.map((selection, index) => ({
      ...selection,
      anchor: [0, 0, 3, 4][index],
      head: [0, 0, 3, 4][index],
    })),
  )
  expect(after.lastAddedId).toBe(before.lastAddedId)
  instance.dispatchCommand('undo')
  expect(instance.materializeFullText()).toBe('aXYb cd')
  expect(readSelections()).toEqual(before)
  instance.dispatchCommand('redo')
  expect(instance.materializeFullText()).toBe('XYbd')
  expect(readSelections()).toEqual(after)
})
