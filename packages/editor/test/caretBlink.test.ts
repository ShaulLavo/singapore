import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CARET_BLINK_OFF_ATTRIBUTE, CaretBlink } from '../src/virtualization/caretBlink'

let layer: HTMLElement
let blink: CaretBlink

beforeEach(() => {
  vi.useFakeTimers()
  layer = document.createElement('div')
  blink = new CaretBlink(layer)
})

afterEach(() => {
  blink.stop()
  vi.useRealTimers()
})

const off = () => layer.hasAttribute(CARET_BLINK_OFF_ATTRIBUTE)

it('blinks twice a second and shows the caret solid on restart', () => {
  blink.run()
  expect(off()).toBe(false)
  vi.advanceTimersByTime(500)
  expect(off()).toBe(true)
  vi.advanceTimersByTime(500)
  expect(off()).toBe(false)
  vi.advanceTimersByTime(500)
  expect(off()).toBe(true)

  blink.restart()
  expect(off()).toBe(false)
  vi.advanceTimersByTime(499)
  expect(off()).toBe(false)
})

it('keeps the phase of a running blink', () => {
  blink.run()
  vi.advanceTimersByTime(500)
  blink.run()
  expect(off()).toBe(true)
  vi.advanceTimersByTime(500)
  expect(off()).toBe(false)
})

it('stops after ten idle seconds with the caret drawn and no timer left', () => {
  blink.run()
  vi.runAllTimers()
  expect(off()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)

  // A repaint of a caret that did not move leaves it solid; a move blinks again.
  blink.run()
  expect(vi.getTimerCount()).toBe(0)
  blink.restart()
  vi.advanceTimersByTime(500)
  expect(off()).toBe(true)
})

it('stops with the caret drawn when no caret is on screen', () => {
  blink.run()
  vi.advanceTimersByTime(500)
  blink.stop()
  expect(off()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
