import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createPlugin,
  derive,
  selectionInput,
  textInput,
  type EditorViewScope,
} from './createPlugin'
import { setHighlightRegistry } from './editor/runtime'
import { Editor } from './editor/Editor'

type TestWindow = Window & typeof globalThis

let restore: (() => void) | null = null
const editors: Editor[] = []

beforeEach(() => {
  const previous = { ...globalThis } as Record<string, unknown>
  const window = new Window() as unknown as TestWindow
  Object.assign(window, { SyntaxError })
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLDivElement: window.HTMLDivElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
    DOMRect: window.DOMRect,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  })
  Object.defineProperty(globalThis, 'Highlight', {
    configurable: true,
    value: class Highlight extends Set<Range> {},
  })
  setHighlightRegistry({ set: () => undefined, delete: () => true } as never)
  restore = () => {
    setHighlightRegistry(undefined)
    for (const key of [
      'window',
      'document',
      'HTMLElement',
      'HTMLDivElement',
      'HTMLTextAreaElement',
    ]) {
      ;(globalThis as Record<string, unknown>)[key] = previous[key]
    }
  }
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
  restore?.()
  restore = null
})

function createEditor(view: (scope: EditorViewScope) => void, text = 'alpha beta alpha'): Editor {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editor = new Editor(container, {
    defaultText: text,
    plugins: [createPlugin({ name: 'test.scope', view })],
  })
  editors.push(editor)
  return editor
}

describe('createPlugin view scope', () => {
  test('watches an input once now and again only when its value changes', () => {
    const heads: (number | null)[] = []
    const head = derive([selectionInput], (selections) => selections[0]?.headOffset ?? null)
    const editor = createEditor((scope) => {
      scope.watch(head, (value) => heads.push(value))
    })
    const initial = heads.length

    editor.setSelection(3)
    editor.setSelection(3)
    editor.setSelection(5)

    expect(heads.slice(initial)).toEqual([3, 5])
  })

  test('a selection watcher hears nothing from a scroll or a token change', () => {
    let calls = 0
    const editor = createEditor((scope) => {
      scope.watch(selectionInput, () => void (calls += 1))
    })
    calls = 0

    editor.setScrollPosition({ top: 40 })
    expect(calls).toBe(0)
  })

  test('state notifies its watchers on set and stays quiet on the same value', () => {
    const seen: string[] = []
    let setMode: ((mode: string) => void) | null = null
    createEditor((scope) => {
      const mode = scope.state('normal')
      setMode = mode.set
      scope.watch(mode.input, (value) => seen.push(value))
    })

    setMode!('insert')
    setMode!('insert')

    expect(seen).toEqual(['normal', 'insert'])
  })

  test('handles a command for its own editor and releases it with the plugin', () => {
    let jumps = 0
    const editor = createEditor((scope) => {
      scope.handle('goToDefinition', () => {
        jumps += 1
        return true
      })
    })

    expect(editor.dispatchCommand('goToDefinition')).toBe(true)
    editor.setPlugins([])

    expect(editor.dispatchCommand('goToDefinition')).toBe(false)
    expect(jumps).toBe(1)
  })

  test('releases watchers, owned disposables and cleanups when the plugin goes', () => {
    const released: string[] = []
    let texts = 0
    const editor = createEditor((scope) => {
      scope.watch(textInput, () => void (texts += 1))
      scope.own({ dispose: () => released.push('own') })
      scope.onDispose(() => released.push('cleanup'))
    })
    editor.setPlugins([])
    texts = 0

    editor.edit({ from: 0, to: 0, text: 'x' })

    expect(released.toSorted()).toEqual(['cleanup', 'own'])
    expect(texts).toBe(0)
  })

  test('a command-only plugin is never updated by edits, selections or scrolls', () => {
    const counts = { updates: 0 }
    const editor = createEditor((scope) => {
      scope.handle('goToDefinition', () => true)
    })
    const contributions = Reflect.get(editor, 'viewContributions') as {
      readonly contributions: readonly { update: (...args: unknown[]) => void }[]
    }
    for (const contribution of contributions.contributions) {
      const update = contribution.update
      contribution.update = (...args) => {
        counts.updates += 1
        update(...args)
      }
    }

    editor.edit({ from: 0, to: 0, text: 'x' })
    editor.setSelection(2)
    editor.setScrollPosition({ top: 20 })

    expect(counts.updates).toBe(0)
  })
})
