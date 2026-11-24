import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { CARET_BLINK_OFF_ATTRIBUTE } from '../src/virtualization/caretBlink'
import '../src/style.css'

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  editor?.dispose()
  host?.remove()
})

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const layer = () => host!.querySelector<HTMLElement>('.editor-virtualized-caret-layer')!
const blinkedOff = () => layer().hasAttribute(CARET_BLINK_OFF_ATTRIBUTE)

function mount(text: string, height: number): Editor {
  host = document.createElement('div')
  host.style.cssText = `width:480px;height:${height}px;display:flex;flex-direction:column`
  document.body.append(host)
  editor = new Editor(host)
  editor.setText(text)
  editor.focus()
  editor.setSelection(0)
  return editor
}

it('blinks the caret and shows it solid each time the caret moves', async () => {
  const editor = mount('alpha beta gamma', 200)
  await frame()

  await expect.poll(blinkedOff, { timeout: 5000 }).toBe(true)
  editor.setSelection(6)
  await frame()
  expect(blinkedOff()).toBe(false)

  await expect.poll(blinkedOff, { timeout: 5000 }).toBe(true)
  editor.edit({ from: 6, to: 6, text: 'x' })
  await frame()
  expect(blinkedOff()).toBe(false)
  expect(getComputedStyle(layer()).opacity).toBe('1')
})

it('keeps the blink phase when a repaint leaves the caret where it was', async () => {
  mount('line\n'.repeat(200), 120)
  await frame()

  await expect.poll(blinkedOff, { timeout: 5000 }).toBe(true)
  expect(getComputedStyle(layer()).opacity).toBe('0')
  host!.querySelector<HTMLElement>('.editor-virtualized')!.scrollTop = 40
  await frame()
  await frame()
  expect(blinkedOff()).toBe(true)
})

it('restyles nothing between blinks while a caret is on screen', async () => {
  mount('line\n'.repeat(200), 120)
  await frame()
  await frame()
  // Any restyle makes Chromium re-validate every CSS highlight and repaint the highlighted rows, so
  // an animated caret cost a full repaint in every frame anything else rendered.
  expect(layer().getAnimations()).toEqual([])
  expect(getComputedStyle(layer()).animationName).toBe('none')
})
