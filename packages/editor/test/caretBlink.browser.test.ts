import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from '../src/editor/Editor'
import '../src/style.css'

// The caret blinks from a timer, not an infinite CSS animation: a running animation recalculates
// style on every frame, and Chromium then revisits every registered CSS highlight range, which
// held a highlighted 6,000-line document at about 45 ms a frame while scrolling.

const mounted: { editor: Editor; host: HTMLElement }[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const { editor, host } of mounted.splice(0)) {
    editor.dispose()
    host.remove()
  }
})

async function mount(): Promise<{ editor: Editor; host: HTMLElement; layer: HTMLElement }> {
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:500px;height:200px;display:flex'
  document.body.append(host)
  const editor = new Editor(host, { fontFamily: 'monospace' })
  mounted.push({ editor, host })
  editor.setText('first line\nsecond line\nthird line')
  editor.setSelection(3)
  await frames()
  const layer = host.querySelector<HTMLElement>('.editor-virtualized-caret-layer')!
  return { editor, host, layer }
}

const frames = async () => {
  for (let index = 0; index < 3; index++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

const blinkPhase = (layer: HTMLElement) => layer.dataset.editorCaretBlink ?? 'on'

it('runs no CSS animation in the editor', async () => {
  const { editor, host } = await mount()
  editor.focus()
  await frames()

  expect(host.getAnimations({ subtree: true })).toEqual([])
})

it('blinks the caret every 500 ms while the editor has focus', async () => {
  const { editor, layer } = await mount()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  editor.focus()
  editor.setSelection(4)

  expect(blinkPhase(layer)).toBe('on')
  vi.advanceTimersByTime(500)
  expect(blinkPhase(layer)).toBe('off')
  expect(getComputedStyle(layer).opacity).toBe('0')
  vi.advanceTimersByTime(500)
  expect(blinkPhase(layer)).toBe('on')
})

it('restarts the visible phase when the caret moves', async () => {
  const { editor, layer } = await mount()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  editor.focus()
  editor.setSelection(4)
  vi.advanceTimersByTime(500)
  expect(blinkPhase(layer)).toBe('off')

  editor.setSelection(6)

  expect(blinkPhase(layer)).toBe('on')
  vi.advanceTimersByTime(499)
  expect(blinkPhase(layer)).toBe('on')
})

it('keeps an unfocused caret solid without a running timer', async () => {
  const { editor, layer } = await mount()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  editor.focus()
  editor.setSelection(4)
  vi.advanceTimersByTime(500)
  expect(blinkPhase(layer)).toBe('off')

  ;(document.activeElement as HTMLElement).blur()

  expect(blinkPhase(layer)).toBe('on')
  expect(vi.getTimerCount()).toBe(0)
  editor.setSelection(5)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops blinking when disposed', async () => {
  const { editor } = await mount()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  editor.focus()
  editor.setSelection(4)
  expect(vi.getTimerCount()).toBe(1)

  editor.dispose()

  expect(vi.getTimerCount()).toBe(0)
})
