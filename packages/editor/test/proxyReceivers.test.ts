import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { setHighlightRegistry } from '../src/public/testing'

// Reactive stores (Solid's createMutable, Vue's reactive, MobX) wrap objects in a Proxy and call
// their methods with the proxy as `this`. The editor is handed to user code, so it must keep
// working that way, which rules out ECMAScript `#private` members on it: a proxy fails the
// private brand check and the call throws a TypeError.
const forward = <T extends object>(target: T): T => new Proxy(target, {})

const editors: Editor[] = []
beforeEach(() => {
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  setHighlightRegistry({ set() {}, delete: () => true } as never)
})
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
  document.body.replaceChildren()
  setHighlightRegistry(undefined)
  vi.unstubAllGlobals()
})

test('an editor behind a forwarding proxy edits, selects, undoes and disposes', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor(host)
  editors.push(editor)
  const proxied = forward(editor)

  proxied.setText('xyz')
  expect(proxied.materializeFullText()).toBe('xyz')
  proxied.edit({ from: 1, to: 2, text: 'AB' })
  expect(proxied.materializeFullText()).toBe('xABz')
  proxied.setSelection(1, 3)
  expect(proxied.getSelections()).toHaveLength(1)
  expect(proxied.getState().length).toBe(4)
  expect(proxied.dispatchCommand('undo')).toBe(true)
  expect(editor.materializeFullText()).toBe('xyz')
  expect(proxied.getTextSnapshot().length).toBe(3)
  proxied.dispose()
})
