import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@singapore-editor/core/editor'
import {
  createEditor,
  type SolidEditorController,
  type SolidEditorDocument,
  type SolidEditorSelection,
} from '../src'

class MockHighlight extends Set<Range> {}

type MountedEditor = {
  readonly controller: SolidEditorController
  readonly host: HTMLElement
  dispose(): void
}

type Diagnostic = {
  readonly name: string
  readonly detail?: { readonly fullTextReads?: number }
}

type DiagnosticGlobal = typeof globalThis & {
  __EDITOR_PERFORMANCE_DIAGNOSTICS__?: ((diagnostic: Diagnostic) => void) | null
}

beforeEach(() => {
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Highlight')
  Reflect.deleteProperty(globalThis, '__EDITOR_PERFORMANCE_DIAGNOSTICS__')
})

describe('createEditor', () => {
  it('accepts a ref callback and waits until its host is attached', () => {
    const container = document.createElement('div')
    document.body.append(container)
    let controller!: SolidEditorController
    let connectedAtActivation = false
    const dispose = render(() => {
      const host = document.createElement('div')
      controller = createEditor({
        document: { defaultText: 'alpha' },
        plugins: [
          {
            name: 'attachment-check',
            activate: () => {
              connectedAtActivation = host.isConnected
            },
          },
        ],
      })
      controller.ref(host)
      expect(controller.editor()).toBeNull()
      expect(host.childElementCount).toBe(0)
      return host
    }, container)

    expect(connectedAtActivation).toBe(true)
    expect(controller.materializeFullText()).toBe('alpha')
    dispose()
    expect(controller.editor()).toBeNull()
    container.remove()
  })

  it('cancels a pending mount when explicitly disposed', () => {
    const host = document.createElement('div')
    let disposeRoot!: () => void
    createRoot((dispose) => {
      disposeRoot = dispose
      const controller = createEditor()
      controller.ref(host)
      controller.dispose()
    })
    expect(host.childElementCount).toBe(0)
    disposeRoot()
  })

  it('never mounts after its Solid owner is disposed', () => {
    const host = document.createElement('div')
    let controller!: SolidEditorController
    createRoot((dispose) => {
      controller = createEditor()
      controller.ref(host)
      dispose()
    })
    controller.ref(host)
    expect(controller.editor()).toBeNull()
    expect(host.childElementCount).toBe(0)
  })

  it('mounts, initializes signals, and disposes with the Solid owner', () => {
    const mounted = mountInRoot({
      document: () => ({ defaultText: 'alpha', documentId: 'a.ts' }),
    })

    expect(mounted.controller.editor()).not.toBeNull()
    expect(mounted.controller.materializeFullText()).toBe('alpha')
    expect(mounted.controller.state()?.length).toBe(5)
    expect(viewText(mounted.controller)).toBe('alpha')

    mounted.dispose()

    expect(mounted.controller.editor()).toBeNull()
    expect(mounted.controller.state()).toBeNull()
    expect(mounted.controller.snapshot()).toBeNull()
    expect(mounted.controller.materializeFullText()).toBe('')
  })

  it('syncs state and last change after editor commands', () => {
    const mounted = mountInRoot({
      document: () => ({ defaultText: 'alpha', documentId: 'a.ts' }),
    })

    mounted.controller.commands.edit({ from: 5, to: 5, text: '!' })

    expect(mounted.controller.materializeFullText()).toBe('alpha!')
    expect(mounted.controller.state()?.length).toBe(6)
    expect(mounted.controller.lastChange()?.kind).toBe('edit')
    expect(viewText(mounted.controller)).toBe('alpha!')

    mounted.dispose()
  })

  it('does not materialize full text during signal sync until text is read', () => {
    const diagnostics = collectDiagnostics()
    const mounted = mountInRoot({
      document: () => ({ defaultText: 'alpha', documentId: 'a.ts' }),
    })
    diagnostics.length = 0

    mounted.controller.commands.edit({ from: 5, to: 5, text: '!' })

    expect(fullTextReads(diagnostics)).toHaveLength(0)
    expect(mounted.controller.textSnapshot()?.length).toBe(6)
    expect({ ...mounted.controller.snapshot() }.textSnapshot?.length).toBe(6)
    JSON.stringify(mounted.controller.snapshot())
    expect(fullTextReads(diagnostics)).toHaveLength(0)
    expect(mounted.controller.materializeFullText()).toBe('alpha!')
    expect(mounted.controller.materializeFullText()).toBe('alpha!')
    expect(fullTextReads(diagnostics)).toHaveLength(1)

    mounted.dispose()
  })

  it('syncs full view snapshots on selection updates', () => {
    const mounted = mountInRoot({
      document: () => ({ defaultText: 'alpha', documentId: 'a.ts' }),
    })

    mounted.controller.commands.setSelection(2, 2, {
      affinity: 'before',
      reveal: false,
    })

    expect(mounted.controller.updateKind()).toBe('selection')
    expect(mounted.controller.snapshot()?.selections[0]).toMatchObject({
      affinity: 'before',
      anchorOffset: 2,
      headOffset: 2,
      startOffset: 2,
      endOffset: 2,
    })

    mounted.dispose()
  })

  it.each([
    ['replaced', { defaultText: 'beta', documentId: 'b.ts' }],
    ['closed', null],
  ] as const)('lets go of a %s document once its text was read', async (_, next) => {
    let setDocument!: (document: SolidEditorDocument | null) => void
    const mounted = mountInRoot(() => {
      const [document, nextDocument] = createSignal<SolidEditorDocument | null>({
        defaultText: 'alpha '.repeat(10_000),
        documentId: 'a.ts',
      })
      setDocument = nextDocument
      return createEditor({ document })
    })
    let source: WeakRef<object> | null = new WeakRef(mounted.controller.textSnapshot()!)
    expect(mounted.controller.materializeFullText()).toHaveLength(60_000)

    setDocument(next)
    await flushEffects()
    await expectCollected(source)
    source = null

    expect(mounted.controller.materializeFullText()).toBe(next?.defaultText ?? '')
    mounted.dispose()
  })

  it('keeps local edits when defaultText changes and opens a new documentId', async () => {
    let setDocument!: (document: SolidEditorDocument) => void
    const mounted = mountInRoot(() => {
      const [document, nextDocument] = createSignal<SolidEditorDocument>({
        defaultText: 'alpha',
        documentId: 'a.ts',
      })
      setDocument = nextDocument
      return createEditor({ document })
    })

    mounted.controller.commands.edit({ from: 5, to: 5, text: '!' })
    setDocument({ defaultText: 'server alpha', documentId: 'a.ts' })
    await flushEffects()

    expect(mounted.controller.materializeFullText()).toBe('alpha!')

    setDocument({ defaultText: 'beta', documentId: 'b.ts' })
    await flushEffects()

    expect(mounted.controller.materializeFullText()).toBe('beta')
    expect(mounted.controller.snapshot()?.documentId).toBe('b.ts')

    mounted.dispose()
  })

  it('applies controlled text as an edit and reports only user edits', async () => {
    const onTextChange = vi.fn()
    let setText!: (text: string) => void
    const mounted = mountInRoot(() => {
      const [text, nextText] = createSignal('alpha')
      setText = nextText
      return createEditor({ document: () => ({ documentId: 'a.ts', text: text() }), onTextChange })
    })
    const syncSpy = vi.spyOn(mounted.controller.editor() as Editor, 'syncText')

    setText('alpha beta')
    await flushEffects()

    expect(mounted.controller.materializeFullText()).toBe('alpha beta')
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(onTextChange).not.toHaveBeenCalled()

    mounted.controller.commands.edit({ from: 10, to: 10, text: '!' })
    expect(onTextChange).toHaveBeenLastCalledWith('alpha beta!')

    setText('alpha beta!')
    await flushEffects()
    expect(syncSpy).toHaveBeenCalledTimes(1)

    mounted.dispose()
  })

  it('warns once when controlled text is edited without onTextChange', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const mounted = mountInRoot(() =>
      createEditor({ document: { documentId: 'a.ts', text: 'alpha' } }),
    )

    mounted.controller.commands.edit({ from: 5, to: 5, text: '!' })
    mounted.controller.commands.edit({ from: 6, to: 6, text: '?' })

    expect(warn).toHaveBeenCalledTimes(1)
    mounted.dispose()
  })

  it('applies targeted reactive options without recreating the editor', async () => {
    let setTheme!: (theme: { readonly backgroundColor: string }) => void
    let setHiddenCharacters!: (mode: 'hidden' | 'show') => void
    let setSelection!: (selection: SolidEditorSelection) => void
    let setScrollPosition!: (scrollPosition: {
      readonly top: number
      readonly left: number
    }) => void
    const mounted = mountInRoot(() => {
      const [theme, nextTheme] = createSignal({ backgroundColor: '#111111' })
      const [hiddenCharacters, nextHiddenCharacters] = createSignal<'hidden' | 'show'>('hidden')
      const [selection, nextSelection] = createSignal<SolidEditorSelection>({
        anchor: 0,
        head: 0,
      })
      const [scrollPosition, nextScrollPosition] = createSignal({ top: 0, left: 0 })
      setTheme = nextTheme
      setHiddenCharacters = nextHiddenCharacters
      setSelection = nextSelection
      setScrollPosition = nextScrollPosition
      return createEditor({
        document: () => ({ defaultText: 'alpha', documentId: 'a.ts' }),
        hiddenCharacters,
        scrollPosition,
        selection,
        theme,
      })
    })
    const instance = mounted.controller.editor()
    expect(instance).not.toBeNull()
    const setHiddenSpy = vi.spyOn(instance as Editor, 'setHiddenCharacters')

    setTheme({ backgroundColor: '#222222' })
    setHiddenCharacters('show')
    setSelection({ affinity: 'before', anchor: 1, head: 3 })
    setScrollPosition({ top: 12, left: 4 })
    await flushEffects()

    expect(mounted.controller.editor()).toBe(instance)
    expect(editorElement(mounted.host)?.style.getPropertyValue('--editor-background')).toBe(
      '#222222',
    )
    expect(setHiddenSpy).toHaveBeenCalledWith('show')
    expect(mounted.controller.snapshot()?.selections[0]).toMatchObject({
      affinity: 'before',
      anchorOffset: 1,
      headOffset: 3,
    })
    expect(instance?.getScrollPosition()).toEqual({ top: 12, left: 4 })

    mounted.dispose()
  })

  it('exports a command facade that safely handles missing editor instances', () => {
    let controller!: SolidEditorController
    createRoot((dispose) => {
      controller = createEditor()
      dispose()
    })

    expect(controller.commands.dispatchCommand('selectAll')).toBe(false)
    expect(controller.commands.openFind()).toBe(false)
    expect(() => controller.commands.focus()).not.toThrow()
  })
})

function mountInRoot(
  create: Parameters<typeof createEditor>[0] | (() => SolidEditorController),
): MountedEditor {
  let controller!: SolidEditorController
  let disposeRoot!: () => void
  const host = document.createElement('div')

  createRoot((dispose) => {
    disposeRoot = dispose
    controller = typeof create === 'function' ? create() : createEditor(create)
    controller.ref(host)
  })

  return {
    controller,
    host,
    dispose: disposeRoot,
  }
}

function editorElement(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.editor')
}

// Only a real collection can tell a cache that pins a document from one that lets it go.
const collectGarbage: () => void = (() => {
  setFlagsFromString('--expose-gc')
  return runInNewContext('gc') as () => void
})()

// `deref` keeps its target alive until the current job ends, so collect first and look after.
async function expectCollected(reference: WeakRef<object>): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushEffects()
    collectGarbage()
    if (!reference.deref()) return
  }
  expect(reference.deref()).toBeUndefined()
}

function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function collectDiagnostics(): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  ;(globalThis as DiagnosticGlobal).__EDITOR_PERFORMANCE_DIAGNOSTICS__ = (diagnostic) => {
    diagnostics.push(diagnostic)
  }
  return diagnostics
}

/** Whole-text reads of any kind: materialization, a full-range readRange, or a chunk walk. */
function fullTextReads(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.name === 'textSnapshot.read' && diagnostic.detail?.fullTextReads === 1,
  )
}

function viewText(controller: SolidEditorController): string | undefined {
  const source = controller.snapshot()?.textSnapshot
  return source?.readRange(0, source.length)
}
