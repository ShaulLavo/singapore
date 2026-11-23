import { afterEach, beforeEach, expect, it } from 'vitest'

import type { Editor } from '../src/editor/Editor'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'
import { suspiciousCharacterDataLoaded } from '../src/unicodeHighlight'
import { createVisibleEditor } from './factories/visibleEditor'

const CYRILLIC_A = 'а'

const mockRegistry = { delete: () => true, set: () => {} }

class MockHighlight extends Set<Range> {}

let container: HTMLElement
let editor: Editor | null = null

beforeEach(() => {
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight
  setHighlightRegistry(mockRegistry)
  resetEditorInstanceCount()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  editor?.dispose()
  editor = null
  container.remove()
  setHighlightRegistry(undefined)
  Reflect.deleteProperty(globalThis, 'Highlight')
})

function markerKinds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.editor-virtualized-hidden-character-marker'),
    (marker) => marker.dataset.editorHiddenCharacter ?? '',
  )
}

// The order is the point of this file: the plain-ASCII editor runs first, in a module graph where
// nothing has loaded the tables yet, and the editor that needs them runs second.
it('leaves the code point tables unloaded while every row is plain ASCII', () => {
  editor = createVisibleEditor(container)
  editor.setText('const password = 1\nlet other = 2')

  expect(suspiciousCharacterDataLoaded()).toBe(false)
})

it('loads the tables for the first row that needs them and then marks it', async () => {
  editor = createVisibleEditor(container)
  editor.setText(`const p${CYRILLIC_A}ssword = 1`)

  await expect.poll(markerKinds).toEqual(['ambiguous'])
  expect(suspiciousCharacterDataLoaded()).toBe(true)
})
