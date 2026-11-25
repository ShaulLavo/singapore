import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor/Editor'
import { createVisibleEditor } from './factories/visibleEditor'

function dispatchBeforeInput(input: HTMLElement, data: string, inputType = 'insertText'): void {
  input.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data,
      inputType,
    }),
  )
}

function compositionEvent(type: string, data = ''): CompositionEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as CompositionEvent
  Object.defineProperty(event, 'data', { value: data })
  return event
}

function mockElementRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      bottom: rect.top + rect.height,
      height: rect.height,
      left: rect.left,
      right: rect.left + rect.width,
      toJSON: () => rect,
      top: rect.top,
      width: rect.width,
      x: rect.left,
      y: rect.top,
    }) as DOMRect
}

function spyTextareaWrites(input: HTMLTextAreaElement): {
  readonly counts: { setSelectionRange: number; valueWrites: number }
  reset(): void
  restore(): void
} {
  const counts = { setSelectionRange: 0, valueWrites: 0 }
  const selectionSpy = vi.spyOn(input, 'setSelectionRange').mockImplementation(function (
    this: HTMLTextAreaElement,
    start: number | null,
    end: number | null,
    direction?: 'forward' | 'backward' | 'none',
  ) {
    counts.setSelectionRange += 1
    HTMLTextAreaElement.prototype.setSelectionRange.call(this, start, end, direction)
  })
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return descriptor.get!.call(this) as string
    },
    set(next: string) {
      counts.valueWrites += 1
      descriptor.set!.call(this, next)
    },
  })
  return {
    counts,
    reset() {
      counts.setSelectionRange = 0
      counts.valueWrites = 0
    },
    restore() {
      selectionSpy.mockRestore()
      delete (input as { value?: string }).value
    },
  }
}

describe('hidden textarea lazy sync and pointer-drag suppression', () => {
  let host: HTMLDivElement
  let editor: Editor

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    editor = createVisibleEditor(host, {
      defaultText: 'alpha beta gamma',
      inputRoute: 'textarea',
      textMetrics: { characterWidth: 8, rowHeight: 20 },
    })
    const scroll = host.querySelector<HTMLElement>('.editor-virtualized')!
    mockElementRect(scroll, { left: 0, top: 0, width: 400, height: 200 })
    const row = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
    mockElementRect(row, { left: 0, top: 0, width: 400, height: 20 })
  })

  afterEach(() => {
    vi.useRealTimers()
    editor.dispose()
    host.remove()
  })

  it('skips hidden textarea rewrites during mouse-drag mousemove and syncs once on mouseup', () => {
    editor.setSelection(0, 0)
    editor.focus()
    const input = editor.getInputElement() as HTMLTextAreaElement
    const row = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
    const writes = spyTextareaWrites(input)

    try {
      row.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX: 0,
          clientY: 5,
        }),
      )
      writes.reset()

      for (let step = 1; step <= 8; step += 1) {
        document.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            buttons: 1,
            clientX: step * 8,
            clientY: 5,
          }),
        )
      }

      expect(writes.counts).toEqual({ setSelectionRange: 0, valueWrites: 0 })

      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 64,
          clientY: 5,
        }),
      )

      expect(writes.counts.setSelectionRange).toBe(1)
      expect(input.selectionEnd).toBeGreaterThan(input.selectionStart)
    } finally {
      writes.restore()
    }
  })

  it('flushes the hidden textarea on beforecopy during an active mouse drag', () => {
    editor.setSelection(0, 0)
    editor.focus()
    const input = editor.getInputElement() as HTMLTextAreaElement
    const row = host.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
    const writes = spyTextareaWrites(input)

    try {
      row.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX: 0,
          clientY: 5,
        }),
      )
      writes.reset()
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          buttons: 1,
          clientX: 40,
          clientY: 5,
        }),
      )
      expect(writes.counts).toEqual({ setSelectionRange: 0, valueWrites: 0 })

      host
        .querySelector('.editor-virtualized')!
        .dispatchEvent(new Event('beforecopy', { bubbles: true, cancelable: true }))
      expect(writes.counts.setSelectionRange).toBe(1)
      expect(input.selectionEnd).toBeGreaterThan(input.selectionStart)

      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 40,
          clientY: 5,
        }),
      )
    } finally {
      writes.restore()
    }
  })

  it('defers hidden textarea writes across plain sequential typing and flushes on idle, jump, or copy', () => {
    vi.useFakeTimers()
    editor.setSelection(6, 6)
    editor.focus()
    const input = editor.getInputElement() as HTMLTextAreaElement
    const writes = spyTextareaWrites(input)

    try {
      writes.reset()
      for (const ch of '12345') {
        dispatchBeforeInput(input, ch)
      }

      expect(editor.materializeFullText()).toBe('alpha 12345beta gamma')
      expect(writes.counts).toEqual({ setSelectionRange: 0, valueWrites: 0 })
      expect(input.value).toBe('alpha beta gamma')
      expect(input.selectionStart).toBe(6)

      // Idle timer flushes the accessible window after typing stops.
      vi.advanceTimersByTime(500)
      expect(writes.counts.valueWrites).toBe(1)
      expect(writes.counts.setSelectionRange).toBe(1)
      expect(input.value).toBe('alpha 12345beta gamma')
      expect(input.selectionStart).toBe(11)

      // Typing again defers until a cursor jump or copy triggers a flush.
      writes.reset()
      dispatchBeforeInput(input, 'X')
      dispatchBeforeInput(input, 'Y')
      expect(writes.counts).toEqual({ setSelectionRange: 0, valueWrites: 0 })

      host
        .querySelector('.editor-virtualized')!
        .dispatchEvent(new Event('beforecopy', { bubbles: true, cancelable: true }))
      expect(writes.counts.valueWrites).toBe(1)
      expect(input.value).toBe('alpha 12345XYbeta gamma')
      expect(input.selectionStart).toBe(13)
    } finally {
      writes.restore()
    }
  })

  it('flushes once sequential lazy typing exhausts the 128-character deferral window', () => {
    editor.setSelection(6, 6)
    editor.focus()
    const input = editor.getInputElement() as HTMLTextAreaElement
    const writes = spyTextareaWrites(input)

    try {
      writes.reset()
      for (let i = 0; i < 128; i += 1) dispatchBeforeInput(input, 'a')
      expect(writes.counts).toEqual({ setSelectionRange: 0, valueWrites: 0 })

      dispatchBeforeInput(input, 'b')
      expect(writes.counts.valueWrites).toBe(1)
      expect(writes.counts.setSelectionRange).toBe(1)
      expect(input.value).toContain(`${'a'.repeat(128)}b`)
    } finally {
      writes.restore()
    }
  })

  it('preserves IME composition, deduced native input, and platform selection moves after lazy typing', () => {
    editor.setSelection(6, 6)
    editor.focus()
    const input = editor.getInputElement() as HTMLTextAreaElement

    // Type lazily: textarea still holds 'alpha beta gamma' at caret 6.
    dispatchBeforeInput(input, 'X')
    dispatchBeforeInput(input, 'Y')
    expect(editor.materializeFullText()).toBe('alpha XYbeta gamma')
    expect(input.value).toBe('alpha beta gamma')

    // Start and commit an IME composition immediately before any idle flush.
    input.dispatchEvent(compositionEvent('compositionstart'))
    input.dispatchEvent(compositionEvent('compositionupdate', '日本'))
    input.dispatchEvent(compositionEvent('compositionend', '日本'))
    expect(editor.materializeFullText()).toBe('alpha XY日本beta gamma')
    expect(input.value).toBe('alpha XY日本beta gamma')
    expect(input.selectionStart).toBe(10)

    // Type lazily again, then receive a browser-mutated native input event (dead key / dictation).
    dispatchBeforeInput(input, 'Z')
    expect(input.value).toBe('alpha XY日本beta gamma')
    const caret = input.selectionStart
    input.value = `${input.value.slice(0, caret)}!${input.value.slice(caret)}`
    input.setSelectionRange(caret + 1, caret + 1)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    expect(editor.materializeFullText()).toBe('alpha XY日本Z!beta gamma')
    expect(input.value).toBe('alpha XY日本Z!beta gamma')

    // Type lazily again, then move the native selection directly in the textarea.
    dispatchBeforeInput(input, 'Q')
    expect(editor.materializeFullText()).toBe('alpha XY日本Z!Qbeta gamma')
    input.setSelectionRange(0, 5)
    input.dispatchEvent(new Event('select', { bubbles: true }))
    expect(editor.getSelections()[0]).toMatchObject({ anchorOffset: 0, headOffset: 5 })
    expect(input.value).toBe('alpha XY日本Z!Qbeta gamma')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
  })
})
