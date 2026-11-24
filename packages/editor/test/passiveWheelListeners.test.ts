import { afterEach, describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor'
import { resetEditorInstanceCount } from '../src/public/testing'

// The prototype that actually defines addEventListener for elements in this environment.
function listenerOwner(): EventTarget {
  let prototype: object | null = Object.getPrototypeOf(document.createElement('div'))
  while (prototype && !Object.hasOwn(prototype, 'addEventListener'))
    prototype = Object.getPrototypeOf(prototype)
  if (!prototype) throw new Error('no addEventListener owner')
  return prototype as EventTarget
}

// A wheel listener that is not passive makes the browser wait for script before it can scroll each
// wheel event, which halves how fast wheel input is acknowledged on a large file.
describe('wheel listeners', () => {
  let container: HTMLElement | null = null
  let editor: Editor | null = null

  afterEach(() => {
    editor?.dispose()
    container?.remove()
    vi.restoreAllMocks()
  })

  it('installs no blocking wheel listener on an editor given only text', () => {
    resetEditorInstanceCount()
    const owner = listenerOwner()
    const add = owner.addEventListener
    const wheel: (boolean | AddEventListenerOptions | undefined)[] = []
    vi.spyOn(owner, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'wheel') wheel.push(options)
      add.call(this, type, listener, options)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container)
    editor.setText(Array.from({ length: 200 }, (_value, index) => `line ${index}`).join('\n'))

    expect(wheel.length).toBeGreaterThan(0)
    expect(wheel.filter((options) => typeof options !== 'object' || !options.passive)).toEqual([])
  })
})
