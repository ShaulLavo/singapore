import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor'
import { createEditorStructuralOperation } from '../src/editor/syntaxOperations'
import { createEmptySyntaxResult, type EditorSyntaxRuntime } from '../src/syntax/session'
import {
  EditorSecondaryWorkScheduler,
  type EditorSecondaryWorkOptions,
} from '../src/editor/secondaryWorkScheduler'
import { resetEditorInstanceCount } from '../src/public/testing'

/**
 * Rapid input defers synchronous text-derived feature/decoration work behind a bounded debounce,
 * while syntax refreshes dispatch immediately via single-flight coalescing without waiting on the
 * typing debounce. These assert the wiring, not the scheduler primitive — see
 * secondaryWorkScheduler.test.ts for the primitive.
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

  it('bounds how long a typing burst can defer feature work without debouncing syntax', () => {
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

    // Syntax refreshes bypass the typing debounce via single-flight coalescing; text-derived
    // feature contributions stay debounced under a ceiling so a sustained run still flushes.
    expect([...deferred.keys()]).not.toContain('editor.syntaxRefresh')
    expect([...deferred.keys()]).toContain('editor.featureContributions')
    const features = deferred.get('editor.featureContributions')!
    expect(features.delayMs).toBeGreaterThan(0)
    expect(features.maxDelayMs).toBeGreaterThan(features.delayMs!)
  })

  it('keeps feature debounce current across a selection change and invalidates it on another edit', () => {
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'x',
        inputType: 'insertText',
      }),
    )
    const features = scheduled.find((work) => work.key === 'editor.featureContributions')!
    expect(features.isCurrent?.(features.version!)).toBe(true)
    editor.setSelection(0, 2)
    expect(features.isCurrent?.(features.version!)).toBe(true)
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'y',
        inputType: 'insertText',
      }),
    )
    expect(features.isCurrent?.(features.version!)).toBe(false)
  })
})

/**
 * Edits dispatch syntax immediately via 0 ms single-flight coalescing both before and after the
 * first highlight lands, while preserving the separate feature/decoration debounce.
 */
describe('single-flight syntax refresh during typing', () => {
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

  it('requests syntax for typed text immediately without scheduling editor.syntaxRefresh', async () => {
    const analysed: number[] = []
    open((read, signal) => {
      analysed.push(read.text.length)
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    await vi.waitFor(() => expect(analysed).toEqual([3]))

    type('x')

    expect(scheduled.map((work) => work.key)).not.toContain('editor.syntaxRefresh')
    expect(scheduled.map((work) => work.key)).toContain('editor.featureContributions')
    await vi.waitFor(() => expect(analysed).toEqual([3, 4]))
    expect(editor.getState().initialHighlightStatus).toBe('loading')
  })

  it('coalesces same-turn and in-flight key bursts into bounded single-flight parses', async () => {
    const analysed: number[] = []
    const resolvers: Array<() => void> = []
    open((read) => {
      analysed.push(read.text.length)
      return new Promise((resolve) => {
        resolvers.push(() => resolve(createEmptySyntaxResult()))
      })
    })
    await vi.waitFor(() => expect(analysed).toEqual([3]))
    resolvers.shift()!()
    await vi.waitFor(() => expect(editor.getState().initialHighlightStatus).not.toBe('loading'))

    // Same-turn burst coalesces into a single flight reading all 3 typed characters.
    type('x')
    type('y')
    type('z')
    expect(scheduled.map((work) => work.key)).not.toContain('editor.syntaxRefresh')
    await vi.waitFor(() => expect(analysed).toEqual([3, 6]))

    // Typing multiple keys while that flight is in progress coalesces into at most one trailing flight.
    type('1')
    type('2')
    type('3')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(analysed).toEqual([3, 6])

    resolvers.shift()!()
    await vi.waitFor(() => expect(analysed).toEqual([3, 6, 9]))
    resolvers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(analysed).toEqual([3, 6, 9])
  })

  it('continues dispatching syntax without typing debounce once the first highlight has landed', async () => {
    const analysed: number[] = []
    open(async (read) => {
      analysed.push(read.text.length)
      return createEmptySyntaxResult()
    })
    await vi.waitFor(() => expect(editor.getState().initialHighlightStatus).not.toBe('loading'))

    type('x')

    expect(scheduled.map((work) => work.key)).not.toContain('editor.syntaxRefresh')
    await vi.waitFor(() => expect(analysed).toEqual([3, 4]))
  })
})

describe('feature debounce preservation during 0 ms syntax publication', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    vi.useRealTimers()
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

  it('does not invoke feature/decoration contributions on syntax publish while feature debounce is armed, and recovers after paste or setText', async () => {
    let featureUpdates = 0
    const pendingResolvers: Array<() => void> = []
    const result = createEmptySyntaxResult()
    const session: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze: () =>
        new Promise((resolve) => {
          pendingResolvers.push(() => resolve(result))
        }),
      getResult: () => result,
      getTokens: () => [],
      getSnapshotVersion: () => 0,
      dispose: () => undefined,
    }
    editor = new Editor(container, {
      plugins: [
        {
          activate: (context) => [
            context.registerSyntaxProvider({
              operation: createEditorStructuralOperation(() => session),
            }),
            context.registerDecorationContribution({
              createContribution: () => ({
                handleEditorChange: () => {
                  featureUpdates += 1
                },
                dispose: () => undefined,
              }),
            }),
          ],
        },
      ],
    })

    editor.setText('abc', { languageId: 'fixture' })
    await vi.waitFor(() => expect(pendingResolvers.length).toBeGreaterThan(0))
    pendingResolvers.shift()!()
    await vi.waitFor(() => expect(editor.getState().initialHighlightStatus).not.toBe('loading'))

    // Typing arms the 150 ms feature debounce while syntax resolves immediately.
    featureUpdates = 0
    type('x')
    await vi.waitFor(() => expect(pendingResolvers.length).toBeGreaterThan(0))
    pendingResolvers.shift()!()
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))
    // Syntax published, but feature contribution stays suppressed while the 150 ms debounce is armed.
    expect(featureUpdates).toBe(0)

    // Switching documents before the typing timer fires must cancel/invalidate the stale timer so
    // syntax-driven feature notifications are not suppressed on the next document.
    editor.setText('def', { languageId: 'fixture' })
    featureUpdates = 0
    await vi.waitFor(() => expect(pendingResolvers.length).toBeGreaterThan(0))
    while (pendingResolvers.length > 0) pendingResolvers.shift()!()
    await vi.waitFor(() => expect(featureUpdates).toBeGreaterThan(0))
  })

  it('bypasses the keystroke paint gate when document is hidden and drains on visibilitychange', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    const resolvers: Array<() => void> = []
    const result = createEmptySyntaxResult()
    const session: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze: () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve(result))
        }),
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
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
    resolvers.shift()!()
    await vi.waitFor(() => expect(editor.getState().initialHighlightStatus).not.toBe('loading'))

    // While visible with an un-fired rAF, an edit reply waits on the paint gate until
    // visibilityState transitions to hidden (or rAF fires).
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    rafCallbacks.length = 0
    type('x')
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
    resolvers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(editor.getState().syntaxStatus).toBe('loading')

    // Tab becomes hidden while rAF is paused: visibilitychange drains pending edit apply.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))

    // Subsequent edit while already hidden bypasses the paint gate completely.
    rafCallbacks.length = 0
    type('y')
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
    resolvers.shift()!()
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))
    expect(rafCallbacks).toHaveLength(0)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    vi.restoreAllMocks()
  })
})
