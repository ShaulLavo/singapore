import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor'
import { createEditorStructuralOperation } from '../src/editor/operationDefinitions'
import { createEmptySyntaxResult, type EditorSyntaxRuntime } from '../src/syntax/session'
import {
  EditorSecondaryWorkScheduler,
  type EditorSecondaryWorkOptions,
} from '../src/editor/secondaryWorkScheduler'
import { resetEditorInstanceCount } from '../src/public/testing'

/**
 * Rapid input defers syntax and feature work behind a debounce. A sustained
 * typing run never leaves that gap, so the deferral has to carry a ceiling or
 * the editor stops re-tokenizing entirely until the user pauses. These assert
 * the wiring, not the scheduler primitive — see secondaryWorkScheduler.test.ts
 * for the primitive.
 */
describe('rapid input secondary work', () => {
  let container: HTMLElement
  let editor: Editor
  let scheduled: EditorSecondaryWorkOptions[]

  beforeEach(() => {
    scheduled = []
    vi.spyOn(EditorSecondaryWorkScheduler.prototype, 'schedule').mockImplementation((options) => {
      scheduled.push(options)
    })
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, { defaultText: 'abc' })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    vi.restoreAllMocks()
  })

  it('bounds how long a typing burst can defer syntax and feature work', () => {
    const root = document.querySelector('.editor-virtualized') as HTMLElement
    root.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'x',
        inputType: 'insertText',
      }),
    )

    const deferred = new Map(scheduled.map((options) => [options.key, options]))

    // Whatever a keystroke defers, it defers under a ceiling: a sustained run
    // never leaves the debounce gap, so an uncapped key would never run at all.
    expect([...deferred.keys()]).toEqual(
      expect.arrayContaining(['editor.syntaxRefresh', 'editor.featureContributions']),
    )
    expect(deferred.size).toBeGreaterThanOrEqual(2)
    for (const options of deferred.values()) {
      expect(options.delayMs).toBeGreaterThan(0)
      expect(options.maxDelayMs).toBeGreaterThan(options.delayMs!)
    }
  })
  it('keeps a pending parse current when the user selects text after typing', () => {
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'x',
        inputType: 'insertText',
      }),
    )
    const syntax = scheduled.find((work) => work.key === 'editor.syntaxRefresh')!
    expect(syntax.isCurrent?.(syntax.version!)).toBe(true)
    editor.setSelection(0, 2)
    expect(syntax.isCurrent?.(syntax.version!)).toBe(true)
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'y',
        inputType: 'insertText',
      }),
    )
    expect(syntax.isCurrent?.(syntax.version!)).toBe(false)
  })
})

/**
 * The debounce protects colors that are already on screen. A key typed while the document's
 * first highlight is still loading has none to protect, so its syntax request goes out at once.
 */
describe('typing before the first highlight', () => {
  let container: HTMLElement
  let editor: Editor
  let scheduled: EditorSecondaryWorkOptions[]

  beforeEach(() => {
    scheduled = []
    vi.spyOn(EditorSecondaryWorkScheduler.prototype, 'schedule').mockImplementation((options) => {
      scheduled.push(options)
    })
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    vi.restoreAllMocks()
  })

  const type = (data: string) =>
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data,
        inputType: 'insertText',
      }),
    )

  const open = (analyze: EditorSyntaxRuntime['analyze']) => {
    const result = createEmptySyntaxResult()
    const session: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze,
      getResult: () => result,
      getTokens: () => [],
      getSnapshotVersion: () => 0,
      dispose: () => undefined,
    }
    editor = new Editor(container, {
      plugins: [
        {
          activate: (context) =>
            context.registerSyntaxProvider({
              operation: createEditorStructuralOperation(() => session),
            }),
        },
      ],
    })
    editor.setText('abc', { languageId: 'fixture' })
  }

  it('requests syntax for the typed text without the typing debounce', async () => {
    const analysed: number[] = []
    // Answers only by being superseded: the first highlight stays pending, as it does while a
    // grammar downloads.
    open((read, signal) => {
      analysed.push(read.text.length)
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    await vi.waitFor(() => expect(analysed).toEqual([3]))

    type('x')

    // The scheduler is stubbed, so deferred work never runs: only an immediate request gets here.
    expect(scheduled.map((work) => work.key)).not.toContain('editor.syntaxRefresh')
    expect(scheduled.map((work) => work.key)).toContain('editor.featureContributions')
    await vi.waitFor(() => expect(analysed).toEqual([3, 4]))
    expect(editor.getState().initialHighlightStatus).toBe('loading')
  })

  it('skips the debounce for the first key only, so a burst does not ask once per key', async () => {
    const analysed: number[] = []
    open((read, signal) => {
      analysed.push(read.text.length)
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    await vi.waitFor(() => expect(analysed).toEqual([3]))

    type('x')
    type('y')
    type('z')

    // The first key asks at once. The two after it go to the debounce, which coalesces them into
    // one request; the scheduler is stubbed here, so that one never runs and nothing more is
    // analysed.
    expect(scheduled.filter((work) => work.key === 'editor.syntaxRefresh')).toHaveLength(2)
    await vi.waitFor(() => expect(analysed).toEqual([3, 4]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(analysed).toEqual([3, 4])
  })

  it('debounces again once the first highlight has landed', async () => {
    open(async () => createEmptySyntaxResult())
    await vi.waitFor(() => expect(editor.getState().initialHighlightStatus).not.toBe('loading'))

    type('x')

    expect(scheduled.map((work) => work.key)).toContain('editor.syntaxRefresh')
  })
})
