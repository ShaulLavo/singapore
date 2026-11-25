import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEditorBufferSession, createEditorTextBuffer } from '../src/documentSession'
import { Editor } from '../src/editor'
import { createEditorStructuralOperation } from '../src/editor/syntaxOperations'
import { EditorWorkScheduler, type EditorWorkEvent } from '../src/editor/workScheduler'
import { createEmptySyntaxResult, type EditorSyntaxRuntime } from '../src/syntax/session'
import { resetEditorInstanceCount } from '../src/public/testing'

describe('shared EditorWorkScheduler per Editor', () => {
  const containers: HTMLElement[] = []
  const editors: Editor[] = []

  const mountEditor = (options?: ConstructorParameters<typeof Editor>[1]): Editor => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)
    const editor = new Editor(container, options)
    editors.push(editor)
    return editor
  }

  afterEach(() => {
    for (const editor of editors.splice(0)) editor.dispose()
    for (const container of containers.splice(0)) container.remove()
    resetEditorInstanceCount()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('routes syntax, secondary work, document analysis, and input tasks through one shared scheduler', async () => {
    const events: EditorWorkEvent[] = []
    const workScheduler = new EditorWorkScheduler({
      onEvent: (event) => events.push(event),
    })

    const result = createEmptySyntaxResult()
    const runtime: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze: async () => result,
      getResult: () => result,
      getTokens: () => [],
      getSnapshotVersion: () => 0,
      dispose: () => undefined,
    }
    let runtimeSessionId = ''

    const editor = mountEditor({
      workScheduler,
      folding: true,
      plugins: [
        {
          activate: (context) =>
            context.registerSyntaxProvider({
              operation: createEditorStructuralOperation((ctx) => {
                runtimeSessionId = ctx.runtimeSessionId
                return runtime
              }),
            }),
        },
      ],
    })

    editor.setText('function demo() {\n  const x = 1\n}\n', { languageId: 'fixture' })
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))

    // Trigger rapid typing (secondary feature work) and touch hold scheduling.
    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'a',
        inputType: 'insertText',
      }),
    )

    const scheduledKeys = new Set(
      events.filter((event) => event.type === 'scheduled').map((event) => event.key),
    )

    // Syntax request slot, document analysis runtime entry, and secondary feature work all share
    // the single injected EditorWorkScheduler instance.
    expect([...scheduledKeys].some((key) => key.includes('editor.syntax.document'))).toBe(true)
    expect([...scheduledKeys].some((key) => key.includes('editor.featureContributions'))).toBe(true)
    expect([...scheduledKeys].some((key) => key.includes('editor.fallbackFolds'))).toBe(true)
    expect(runtimeSessionId).not.toBe('')
    expect(scheduledKeys.has(runtimeSessionId)).toBe(true)

    workScheduler.dispose()
  })

  it('uses one EditorWorkScheduler instance across subsystems on the default simple API path', async () => {
    const schedulers = new Set<EditorWorkScheduler>()
    const originalSchedule = EditorWorkScheduler.prototype.schedule
    vi.spyOn(EditorWorkScheduler.prototype, 'schedule').mockImplementation(function (
      this: EditorWorkScheduler,
      options,
    ) {
      schedulers.add(this)
      return originalSchedule.call(this, options)
    })

    const result = createEmptySyntaxResult()
    const runtime: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze: async () => result,
      getResult: () => result,
      getTokens: () => [],
      getSnapshotVersion: () => 0,
      dispose: () => undefined,
    }

    const editor = mountEditor({
      folding: true,
      plugins: [
        {
          activate: (context) =>
            context.registerSyntaxProvider({
              operation: createEditorStructuralOperation(() => runtime),
            }),
        },
      ],
    })

    editor.setText('function simple() {\n  return 1\n}\n', { languageId: 'fixture' })
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))

    editor.getInputElement().dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'x',
        inputType: 'insertText',
      }),
    )

    expect(schedulers.size).toBe(1)
  })

  it('arbitrates cross-subsystem deferred work by priority on the shared scheduler', () => {
    vi.useFakeTimers()
    const order: string[] = []
    const workScheduler = new EditorWorkScheduler()

    // Enqueue lower-priority tasks before higher-priority tasks in the same turn.
    workScheduler.schedule({
      key: 'text-storage:1',
      taskClass: 'idle-cache',
      defer: true,
      run: () => order.push('idle-storage'),
    })
    workScheduler.schedule({
      key: 'secondary.1:editor.fallbackFolds',
      taskClass: 'background-derived',
      defer: true,
      run: () => order.push('background-folds'),
    })
    workScheduler.schedule({
      key: 'syntax.1:editor.syntax.visibleRange',
      taskClass: 'viewport-derived',
      defer: true,
      run: () => order.push('viewport-syntax'),
    })
    workScheduler.schedule({
      key: 'editor.virtualizer.trailingScroll:1',
      taskClass: 'visible-render',
      defer: true,
      run: () => order.push('visible-render'),
    })

    vi.runAllTimers()

    expect(order).toEqual(['visible-render', 'viewport-syntax', 'background-folds', 'idle-storage'])
    workScheduler.dispose()
  })

  it('cancels a disposed editor tasks without colliding with or breaking a sibling editor on the same host scheduler', async () => {
    vi.useFakeTimers()
    const workScheduler = new EditorWorkScheduler()
    const updatesA: string[] = []
    const updatesB: string[] = []

    const editorA = mountEditor({
      workScheduler,
      defaultText: 'alpha',
      plugins: [
        {
          activate: (context) =>
            context.registerDecorationContribution({
              createContribution: () => ({
                handleEditorChange: (change) => {
                  if (change) updatesA.push(change.kind)
                },
                dispose: () => undefined,
              }),
            }),
        },
      ],
    })
    const editorB = mountEditor({
      workScheduler,
      defaultText: 'beta',
      plugins: [
        {
          activate: (context) =>
            context.registerDecorationContribution({
              createContribution: () => ({
                handleEditorChange: (change) => {
                  if (change) updatesB.push(change.kind)
                },
                dispose: () => undefined,
              }),
            }),
        },
      ],
    })

    updatesA.length = 0
    updatesB.length = 0

    // Both editors schedule debounced secondary feature work on the shared host scheduler.
    const typeIn = (editor: Editor, data: string) =>
      editor.getInputElement().dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data,
          inputType: 'insertText',
        }),
      )
    typeIn(editorA, '1')
    typeIn(editorB, '2')

    // Dispose editorA before the debounce fires.
    editorA.dispose()

    await vi.advanceTimersByTimeAsync(250)

    // editorA's pending work was cancelled, while editorB's work ran cleanly without collision.
    expect(updatesA).toEqual([])
    expect(updatesB).toEqual(['edit'])

    // Shared host scheduler remains usable after editorA disposal.
    const followUp = vi.fn()
    workScheduler.schedule({
      key: 'host.followUp',
      taskClass: 'background-derived',
      defer: true,
      run: followUp,
    })
    vi.runAllTimers()
    expect(followUp).toHaveBeenCalledTimes(1)

    workScheduler.dispose()
  })

  it('keeps shared DocumentAnalysis running for a sibling view after the first view disposes its own scheduler', async () => {
    const buffer = createEditorTextBuffer('const a = 1\n')
    const analyzedLengths: number[] = []
    const result = createEmptySyntaxResult()
    const runtime: EditorSyntaxRuntime = {
      foldingSupport: 'unsupported',
      analyze: async (read) => {
        analyzedLengths.push(read.text.length)
        return result
      },
      getResult: () => result,
      getTokens: () => [],
      getSnapshotVersion: () => 0,
      dispose: () => undefined,
    }
    const syntaxPlugin = {
      activate: (context: {
        registerSyntaxProvider: (provider: {
          operation: ReturnType<typeof createEditorStructuralOperation>
        }) => { dispose(): void }
      }) =>
        context.registerSyntaxProvider({
          operation: createEditorStructuralOperation(() => runtime),
        }),
    }

    // Two editors with independent default schedulers sharing one underlying EditorTextBuffer.
    const editorA = mountEditor({ plugins: [syntaxPlugin] })
    const editorB = mountEditor({ plugins: [syntaxPlugin] })

    editorA.attachSession(createEditorBufferSession(buffer), {
      documentId: 'shared-doc',
      languageId: 'fixture',
    })
    editorB.attachSession(createEditorBufferSession(buffer), {
      documentId: 'shared-doc',
      languageId: 'fixture',
    })

    await vi.waitFor(() => expect(editorA.getState().syntaxStatus).toBe('ready'))
    await vi.waitFor(() => expect(editorB.getState().syntaxStatus).toBe('ready'))
    const initialCalls = analyzedLengths.length

    // Trigger an edit and immediately dispose editorA before deferred analysis completes,
    // verifying shared DocumentAnalysis migrates cleanly onto editorB's scheduler.
    editorB.edit([{ from: 0, to: 0, text: '// header\n' }])
    editorA.dispose()

    await vi.waitFor(() => expect(analyzedLengths.length).toBeGreaterThan(initialCalls))
    await vi.waitFor(() => expect(editorB.getState().syntaxStatus).toBe('ready'))

    // Subsequent edits in editorB continue analyzing without errors.
    const afterFirstEdit = analyzedLengths.length
    editorB.edit([{ from: 0, to: 0, text: '// line2\n' }])
    await vi.waitFor(() => expect(analyzedLengths.length).toBeGreaterThan(afterFirstEdit))
    expect(editorB.getState().syntaxStatus).toBe('ready')
  })
})
