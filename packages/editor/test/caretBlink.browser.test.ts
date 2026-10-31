import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import '../src/style.css'

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  editor?.dispose()
  host?.remove()
})

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function blink(): Animation {
  const layer = host!.querySelector<HTMLElement>('.editor-virtualized-caret-layer')!
  const [animation] = layer.getAnimations()
  expect(animation, 'the caret layer runs its blink animation').toBeDefined()
  return animation!
}

it('restarts the caret blink in its visible half each time the caret moves', async () => {
  host = document.createElement('div')
  host.style.cssText = 'width:480px;height:200px;display:flex;flex-direction:column'
  document.body.append(host)
  editor = new Editor(host)
  editor.setText('alpha beta gamma')
  editor.focus()
  editor.setSelection(0)
  await frame()

  // Halfway through a period the caret is hidden; a move must show it again at once.
  blink().currentTime = 600
  editor.setSelection(6)
  await frame()
  expect(Number(blink().currentTime)).toBeLessThan(500)

  blink().currentTime = 600
  editor.edit({ from: 6, to: 6, text: 'x' })
  await frame()
  expect(Number(blink().currentTime)).toBeLessThan(500)
})

it('keeps blinking when a repaint leaves the caret where it was', async () => {
  host = document.createElement('div')
  host.style.cssText = 'width:480px;height:120px;display:flex;flex-direction:column'
  document.body.append(host)
  editor = new Editor(host)
  editor.setText('line\n'.repeat(200))
  editor.focus()
  editor.setSelection(0)
  await frame()

  blink().currentTime = 600
  host.querySelector<HTMLElement>('.editor-virtualized')!.scrollTop = 40
  await frame()
  await frame()
  expect(Number(blink().currentTime)).toBeGreaterThanOrEqual(600)
})
