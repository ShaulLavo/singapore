import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import '../src/style.css'
import { Editor } from '../src/editor/Editor'
import type { EditorInputRoute } from '../src/virtualization'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofKeyPress: (key: string) => Promise<void>
    proofType: (text: string) => Promise<void>
    proofImeComposition: (
      text: string,
      replacement?: readonly [number, number] | null,
    ) => Promise<void>
    proofInsertText: (text: string) => Promise<void>
  }
}

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

// Each case runs on both routes: the textarea is the control the EditContext route must match.
describe.each<EditorInputRoute>(['edit-context', 'textarea'])('%s input route', (route) => {
  let host: HTMLDivElement
  let editor: Editor

  async function open(text: string, caret: number) {
    editor = new Editor(host, { defaultText: text, inputRoute: route })
    await frames()
    editor.focus()
    editor.setSelection(caret, caret)
    await frames()
  }

  beforeEach(() => {
    host = document.createElement('div')
    host.style.cssText = 'width: 600px; height: 200px; display: flex'
    document.body.append(host)
  })

  afterEach(() => {
    editor.dispose()
    host.remove()
  })

  it('mounts the element the route names', async () => {
    await open('hello world', 5)
    const input = editor.getInputElement()
    expect(input.tagName).toBe(route === 'edit-context' ? 'DIV' : 'TEXTAREA')
    expect(document.activeElement).toBe(input)
  })

  it('types, deletes and breaks lines', async () => {
    await open('hello world', 5)
    await commands.proofType('ab')
    await commands.proofKeyPress('Backspace')
    await commands.proofKeyPress('Enter')
    await frames()
    expect(editor.materializeFullText()).toBe('helloa\n world')
  })

  it('commits a composition once, as its final candidate', async () => {
    await open('hello world', 5)
    await commands.proofImeComposition('に')
    await commands.proofImeComposition('にほ')
    await frames()
    expect(editor.materializeFullText()).toBe('hello world')
    await commands.proofInsertText('日本')
    await frames()
    expect(editor.materializeFullText()).toBe('hello日本 world')
    await commands.proofType('x')
    await frames()
    expect(editor.materializeFullText()).toBe('hello日本x world')
  })

  it('leaves the document alone when a composition is abandoned', async () => {
    await open('hello world', 5)
    await commands.proofImeComposition('か')
    await commands.proofImeComposition('')
    await frames()
    expect(editor.materializeFullText()).toBe('hello world')
  })

  // A textarea's insertFromComposition carries only the text and no target range, so that route
  // inserts the correction beside the word it was meant to replace.
  const replacing = route === 'textarea' ? it.fails : it
  replacing('replaces the word a correction reaches back over', async () => {
    await open('hello world', 5)
    await commands.proofImeComposition('Hello', [0, 5])
    await commands.proofInsertText('Hello')
    await frames()
    expect(editor.materializeFullText()).toBe('Hello world')
  })

  it('inserts text that arrives with no key behind it', async () => {
    await open('hello world', 5)
    await commands.proofInsertText(' there')
    await frames()
    expect(editor.materializeFullText()).toBe('hello there world')
  })
})
