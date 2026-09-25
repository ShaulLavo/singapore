import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Editor } from '@singapore-editor/core/editor'
import type { EditorPlugin } from '@singapore-editor/core/extensions'
import { createDiffEditorOptions, createDiffPlugin, createTextDiff, joinRenderLines } from '../src'
import type { DiffFile, DiffPlugin } from '../src'
import { installHighlightPolyfill } from './support/highlightPolyfill'
import { createVisibleEditor } from './support/visibleEditor'

/**
 * An editor built from `createDiffEditorOptions()` plus the host's own typography, pushed the way
 * the README's recipe pushes. Each case fails if the preset loses the option it names.
 */

beforeAll(() => {
  installHighlightPolyfill()
})

const mounted: { editor: Editor; host: HTMLElement }[] = []

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.editor.dispose()
    entry.host.remove()
  }
})

describe('createDiffEditorOptions', () => {
  it('keeps the host tab width on every push', () => {
    const { plugin, tabSizes } = mountDiff(indentedDiff('  '))
    plugin.setFile(indentedDiff('    '))

    expect(tabSizes.length).toBeGreaterThan(0)
    expect(new Set(tabSizes)).toEqual(new Set([8]))
  })

  it('paints no cursor line over the diff tint', () => {
    const { editor, host } = mountDiff(indentedDiff('  '))
    editor.setSelection(1)

    expect(host.querySelector('.editor-virtualized-cursor-line-row')).toBeNull()
    expect(host.querySelector('.editor-virtualized-cursor-line-gutter')).toBeNull()
  })

  it('leaves the interleaved buffer without a language', () => {
    const { editor, plugin } = mountDiff(indentedDiff('  '))

    expect(plugin.getRows().some((row) => row.type === 'deletion')).toBe(true)
    expect(editor.getState().languageId).toBeNull()
    expect(editor.getState().syntaxStatus).toBe('plain')
  })

  it('keeps reading keys and drops folding and editing keys', () => {
    const { editor, host } = mountDiff(indentedDiff('  '))
    editor.setSelection(0)

    press(host, 'ArrowDown', { shift: true })
    expect(editor.getState().cursor.row).toBe(1)

    const text = visibleText(host)
    press(host, 'k', { mod: true })
    press(host, '0', { mod: true })
    press(host, 'Backspace')
    press(host, 'z', { mod: true })
    expect(visibleText(host)).toBe(text)
  })
})

function mountDiff(file: DiffFile): {
  editor: Editor
  host: HTMLElement
  plugin: DiffPlugin
  tabSizes: number[]
} {
  const host = document.createElement('div')
  host.className = 'editor-diff-view'
  document.body.appendChild(host)

  const tabSizes: number[] = []
  const plugin = createDiffPlugin({ mode: 'document', side: 'stacked', syntaxHighlight: false })
  const editor = createVisibleEditor(host, {
    ...createDiffEditorOptions(),
    plugins: [plugin, tabSizeProbe(tabSizes)],
    tabSize: 8,
  })
  mounted.push({ editor, host })

  plugin.onDidChangeRows(() => {
    editor.setText(joinRenderLines(plugin.getRows()), { tokens: plugin.getTokens() })
  })
  plugin.setFile(file)
  return { editor, host, plugin, tabSizes }
}

/** A block whose body changes, indented by `indent`, so an indentation guess has one to find. */
function indentedDiff(indent: string): DiffFile {
  const body = (value: string) =>
    `function f() {\n${indent}if (a) {\n${indent}${indent}${value}\n${indent}}\n}\n`
  return createTextDiff({
    oldFile: { path: 'note.ts', text: body('old()'), languageId: 'typescript' },
    newFile: { path: 'note.ts', text: body('new()'), languageId: 'typescript' },
  })
}

function tabSizeProbe(record: number[]): EditorPlugin {
  return {
    name: 'test.tab-size-probe',
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          dispose: () => undefined,
          update: (snapshot) => {
            if (snapshot.lineCount > 1) record.push(snapshot.tabSize)
          },
        }),
      }),
  }
}

/** The rows on screen; retired rows keep their last text, so the container itself is not enough. */
function visibleText(host: HTMLElement): string {
  const rows = host.querySelectorAll('.editor-virtualized-row[data-editor-virtual-row]')
  return [...rows].map((row) => row.textContent ?? '').join('\n')
}

function press(
  host: HTMLElement,
  key: string,
  chord: { readonly mod?: boolean; readonly shift?: boolean } = {},
): void {
  const mac = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`)
  host.querySelector('.editor-virtualized')?.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      ctrlKey: chord.mod === true && !mac,
      metaKey: chord.mod === true && mac,
      shiftKey: chord.shift === true,
    }),
  )
}
