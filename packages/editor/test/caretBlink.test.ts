import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CARET_BLINK_OFF_ATTRIBUTE, CaretBlink } from '../src/virtualization/caretBlink'

let layer: HTMLElement
let blink: CaretBlink
let clock = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  clock = 0
  layer = document.createElement('div')
  blink = new CaretBlink(layer, () => clock)
})

afterEach(() => {
  blink.stop()
  vi.useRealTimers()
})

const off = () => layer.hasAttribute(CARET_BLINK_OFF_ATTRIBUTE)
function advance(ms: number): void {
  for (let step = 0; step < ms; step += 100) {
    clock += 100
    vi.advanceTimersByTime(100)
  }
}

it('blinks twice a second and shows the caret solid when a caret moves', () => {
  blink.update('0,0')
  expect(off()).toBe(false)
  advance(500)
  expect(off()).toBe(true)
  advance(500)
  expect(off()).toBe(false)
  advance(500)
  expect(off()).toBe(true)

  blink.update('8,0')
  expect(off()).toBe(false)
  advance(400)
  expect(off()).toBe(false)
})

it('keeps the phase when the carets are drawn again where they were', () => {
  blink.update('0,0')
  advance(500)
  blink.update('0,0')
  expect(off()).toBe(true)
  advance(500)
  expect(off()).toBe(false)
})

it('stops ten seconds after the carets last changed, with the caret drawn and no timer left', () => {
  blink.update('0,0')
  advance(10_000)
  expect(off()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)

  blink.update('0,0')
  expect(vi.getTimerCount()).toBe(0)
})

it('ends the blink when a throttled callback runs after the deadline', () => {
  blink.update('0,0')
  // A suspended page: fifteen seconds pass before the first callback runs.
  clock += 15_000
  vi.advanceTimersByTime(500)
  expect(off()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('blinks again after it ended when the text changes, a caret moves or one comes back', () => {
  blink.update('0,0 0,40')
  advance(10_000)

  blink.requestRestart()
  blink.update('0,0 0,40')
  advance(500)
  expect(off()).toBe(true)
  advance(10_000)

  // The second caret moved while the first stayed.
  blink.update('0,0 8,40')
  advance(500)
  expect(off()).toBe(true)
  advance(10_000)

  // The first caret left the mounted rows and came back.
  blink.update('8,40')
  blink.update('0,0 8,40')
  advance(500)
  expect(off()).toBe(true)
})

it('stops with the caret drawn when no caret is on screen', () => {
  blink.update('0,0')
  advance(500)
  blink.update(null)
  expect(off()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
