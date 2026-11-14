import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { detectPlatform } from '@fregat/hotkeys'
import { Editor } from '../src/editor/Editor'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofType: (text: string) => Promise<void>
    proofKeyPress: (key: string) => Promise<void>
  }
}

describe.each(['default', 'edit-context'] as const)('%s editor basic editing', (route) => {
  let host: HTMLDivElement
  let editor: Editor | undefined

  beforeEach(() => {
    host = document.createElement('div')
    host.style.cssText = 'width:100%;max-width:600px;height:200px;display:flex'
    document.body.append(host)
    editor = route === 'default' ? new Editor(host) : new Editor(host, { inputRoute: route })
  })

  afterEach(() => {
    try {
      editor?.dispose()
    } finally {
      editor = undefined
      host.remove()
      document.getSelection()?.removeAllRanges()
    }
  })

  async function open(text: string, caret = text.length): Promise<Editor> {
    if (!editor) throw new Error('Editor fixture has not mounted')
    editor.setText(text)
    editor.setSelection(caret)
    editor.focus()
    await expect.poll(() => document.activeElement).toBe(editor.getInputElement())
    return editor
  }

  function expectSelection(instance: Editor, anchor: number, head = anchor): void {
    expect(instance.getSelections()).toMatchObject([{ anchorOffset: anchor, headOffset: head }])
  }

  it('renders setText and accepts typing without a document session', async () => {
    const instance = await open('first\nsecond')
    await expect
      .poll(() => host.querySelector('[data-editor-virtual-row="1"]')?.textContent)
      .toBe('second')
    await commands.proofType('!')
    expect(instance.materializeFullText()).toBe('first\nsecond!')
    expectSelection(instance, 13)
    await expect
      .poll(() => host.querySelector('[data-editor-virtual-row="1"]')?.textContent)
      .toBe('second!')
  })

  it('types a line break and inserts at the new caret', async () => {
    const instance = await open('alpha bravo', 5)
    await commands.proofKeyPress('Enter')
    await commands.proofType('new')
    expect(instance.materializeFullText()).toBe('alpha\nnew bravo')
    expectSelection(instance, 9)
  })

  it.each([
    { direction: 'forward', caret: 6, key: 'Shift+ArrowRight', anchor: 6, head: 11 },
    { direction: 'backward', caret: 11, key: 'Shift+ArrowLeft', anchor: 11, head: 6 },
  ])('replaces a $direction keyboard selection', async ({ caret, key, anchor, head }) => {
    const instance = await open('alpha bravo charlie', caret)
    for (let press = 0; press < 5; press += 1) await commands.proofKeyPress(key)
    expectSelection(instance, anchor, head)
    await commands.proofType('DELTA')
    expect(instance.materializeFullText()).toBe('alpha DELTA charlie')
    expectSelection(instance, 11)
  })

  it('deletes a selected range with the keyboard', async () => {
    const instance = await open('alpha bravo', 6)
    for (let press = 0; press < 5; press += 1) await commands.proofKeyPress('Shift+ArrowRight')
    expectSelection(instance, 6, 11)
    await commands.proofKeyPress('Backspace')
    expect(instance.materializeFullText()).toBe('alpha ')
    expectSelection(instance, 6)
  })

  it('backspaces accents and emoji without splitting a surrogate pair, then deletes forward', async () => {
    const instance = await open('A🙂e\u0301Z', 5)
    await commands.proofKeyPress('Backspace')
    expect(instance.materializeFullText()).toBe('A🙂eZ')
    expectSelection(instance, 4)
    await commands.proofKeyPress('Backspace')
    expect(instance.materializeFullText()).toBe('A🙂Z')
    expectSelection(instance, 3)
    await commands.proofKeyPress('Backspace')
    expect(instance.materializeFullText()).toBe('AZ')
    expectSelection(instance, 1)
    await commands.proofKeyPress('Delete')
    expect(instance.materializeFullText()).toBe('A')
    expectSelection(instance, 1)
  })

  it.each([
    { key: 'Backspace', caret: 6 },
    { key: 'Delete', caret: 5 },
  ])('joins lines with $key', async ({ key, caret }) => {
    const instance = await open('alpha\nbravo', caret)
    const keydowns: KeyboardEvent[] = []
    const beforeInputs: string[] = []
    host.addEventListener('keydown', (event) => keydowns.push(event))
    host.addEventListener('beforeinput', (event) => beforeInputs.push(event.inputType))
    await commands.proofKeyPress(key)
    expect(
      keydowns.map((event) => ({
        key: event.key,
        trusted: event.isTrusted,
        prevented: event.defaultPrevented,
      })),
    ).toEqual([{ key, trusted: true, prevented: true }])
    expect(beforeInputs).toEqual([])
    expect(instance.materializeFullText()).toBe('alphabravo')
    expectSelection(instance, 5)
    const modifier = detectPlatform() === 'mac' ? 'Meta' : 'Control'
    await commands.proofKeyPress(`${modifier}+z`)
    expect(instance.materializeFullText()).toBe('alpha\nbravo')
    expectSelection(instance, caret)
    await commands.proofKeyPress(`${modifier}+Shift+z`)
    expect(instance.materializeFullText()).toBe('alphabravo')
    expectSelection(instance, 5)
  })

  it('leaves the text and caret unchanged when deleting at the end', async () => {
    const instance = await open('alpha')
    await commands.proofKeyPress('Delete')
    expect(instance.materializeFullText()).toBe('alpha')
    expectSelection(instance, 5)
  })

  it('keeps forward Delete at its intended caret in a buffer with newer inserted text', async () => {
    const instance = await open('ab', 0)
    instance.edit([{ from: 1, to: 1, text: 'XY' }])
    instance.setSelection(0)
    await commands.proofKeyPress('Delete')
    expect(instance.materializeFullText()).toBe('XYb')
    expectSelection(instance, 0)
    const modifier = detectPlatform() === 'mac' ? 'Meta' : 'Control'
    await commands.proofKeyPress(`${modifier}+z`)
    expect(instance.materializeFullText()).toBe('aXYb')
    expectSelection(instance, 0)
    await commands.proofKeyPress(`${modifier}+Shift+z`)
    expect(instance.materializeFullText()).toBe('XYb')
    expectSelection(instance, 0)
    await commands.proofKeyPress('Delete')
    expect(instance.materializeFullText()).toBe('Yb')
    expectSelection(instance, 0)
  })

  it('undoes and redoes repeated Delete as one keyboard run', async () => {
    const instance = await open('abcdef', 0)
    await commands.proofKeyPress('Delete')
    await commands.proofKeyPress('Delete')
    expect(instance.materializeFullText()).toBe('cdef')
    expectSelection(instance, 0)
    const modifier = detectPlatform() === 'mac' ? 'Meta' : 'Control'
    await commands.proofKeyPress(`${modifier}+z`)
    expect(instance.materializeFullText()).toBe('abcdef')
    expectSelection(instance, 0)
    await commands.proofKeyPress(`${modifier}+Shift+z`)
    expect(instance.materializeFullText()).toBe('cdef')
    expectSelection(instance, 0)
  })

  it('undoes and redoes a typed replacement with keyboard shortcuts', async () => {
    const instance = await open('alpha bravo', 6)
    const modifier = detectPlatform() === 'mac' ? 'Meta' : 'Control'
    for (let press = 0; press < 5; press += 1) await commands.proofKeyPress('Shift+ArrowRight')
    expectSelection(instance, 6, 11)
    await commands.proofType('X')
    expect(instance.materializeFullText()).toBe('alpha X')
    expectSelection(instance, 7)
    await commands.proofKeyPress(`${modifier}+z`)
    expect(instance.materializeFullText()).toBe('alpha bravo')
    expectSelection(instance, 6, 11)
    await commands.proofKeyPress(`${modifier}+Shift+z`)
    expect(instance.materializeFullText()).toBe('alpha X')
    expectSelection(instance, 7)
  })

  it('selects all, deletes, and can type into the empty editor', async () => {
    const instance = await open('alpha\nbravo', 2)
    const modifier = detectPlatform() === 'mac' ? 'Meta' : 'Control'
    await commands.proofKeyPress(`${modifier}+a`)
    expectSelection(instance, 0, 11)
    await commands.proofKeyPress('Backspace')
    expect(instance.materializeFullText()).toBe('')
    expectSelection(instance, 0)
    await commands.proofType('fresh')
    expect(instance.materializeFullText()).toBe('fresh')
    expectSelection(instance, 5)
  })
})
