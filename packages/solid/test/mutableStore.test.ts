import { createMutable } from 'solid-js/store'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Editor } from '@singapore-editor/core/editor'

class MockHighlight extends Set<Range> {}

beforeEach(() => {
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Highlight')
  document.body.replaceChildren()
})

// A Solid store proxies the editor and calls its methods with the proxy as `this`, so the editor
// cannot use ECMAScript `#private` members: the proxy would fail their brand check.
it('drives an editor wrapped in a mutable store', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const raw = new Editor(host)
  const editor = createMutable(raw)
  expect(editor).not.toBe(raw)

  editor.setText('xyz')
  editor.edit({ from: 3, to: 3, text: '!' })
  expect(editor.materializeFullText()).toBe('xyz!')
  editor.setSelection(0, 1)
  expect(editor.getSelections()).toHaveLength(1)
  editor.dispose()
})
