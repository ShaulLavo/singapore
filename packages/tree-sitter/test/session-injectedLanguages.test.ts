import {
  createTreeDocument,
  createSourceEndpoint,
  disposeTreeDocuments,
} from './factories/document'
import { readAll } from '../../editor/test/factories/snapshotText'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorTextBuffer } from '@singapore-editor/core/document'
import { createEditorDocumentAnalysis } from '@singapore-editor/core/editor'
import { defineStructuralOperation } from '@singapore-editor/core/internal/document-worker'
import type { EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { RecordingWorker } from './factories/worker'

import {
  commitPreparedDocumentTransaction,
  createPieceTableSnapshot,
  createDocumentTextSnapshot,
  prepareDocumentTransaction,
} from '@singapore-editor/core/document'
import { createTreeSitterSyntaxProvider, createTreeSitterWorkerOwner } from '../src/index.ts'
import { TreeSitterSyntaxSession } from '../src/session.ts'
import type { TreeSitterLanguageDescriptor } from '../src/treeSitter/registry.ts'
import type { TreeSitterBackend } from '../src/treeSitter/workerClient.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  disposeTreeDocuments()
  for (const dispose of cleanup.splice(0)) await dispose()
})

const DESCRIPTORS: Record<string, TreeSitterLanguageDescriptor> = {
  container: descriptor(
    'container',
    '((inline) @injection.content (#set! injection.language "embedded"))',
  ),
  embedded: descriptor(
    'embedded',
    '((html_tag) @injection.content (#set! injection.language "html"))',
  ),
  html: descriptor('html'),
}

describe('injected language registration', () => {
  it('keeps declared injection assets unloaded until the worker requests them', async () => {
    const registered: string[][] = []
    const session = createSession('container', registered)

    await session.run()

    expect(registered).toEqual([['container']])
  })

  it('registers only the document language when nothing is injected', async () => {
    const registered: string[][] = []
    const session = createSession('html', registered)

    await session.run()

    expect(registered).toEqual([['html']])
  })
})

function createSession(languageId: string, registered: string[][]) {
  return createTreeDocument({
    documentId: 'doc',
    languageId,
    languageResolver: {
      resolveTreeSitterLanguage: async (id) => DESCRIPTORS[id] ?? null,
    },
    backend: recordingBackend(registered),
    text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(''))),
  })
}

function recordingBackend(registered: string[][]): TreeSitterBackend {
  return {
    generation: 1,
    sourceEndpoint: createSourceEndpoint(),
    registerLanguages: async (languages) => {
      registered.push(languages.map((language) => language.id))
    },
    parse: async () => undefined,
    edit: async () => undefined,
    select: async () => undefined,
    disposeDocument: () => undefined,
  }
}

function descriptor(id: string, injectionQuerySource?: string): TreeSitterLanguageDescriptor {
  return {
    id,
    aliases: [id],
    injectionDependencies: { container: ['embedded'], embedded: ['html'] }[id] ?? [],
    extensions: [],
    wasmUrl: `${id}.wasm`,
    ...(injectionQuerySource ? { injectionQuerySource } : {}),
  }
}

it('does not register or parse a delayed injection after disposal', async () => {
  let release!: (descriptor: TreeSitterLanguageDescriptor) => void
  let requested!: () => void
  const requestedPromise = new Promise<void>((resolve) => {
    requested = resolve
  })
  const delayed = new Promise<TreeSitterLanguageDescriptor>((resolve) => {
    release = resolve
  })
  const registered: string[][] = []
  let parses = 0
  const backend: TreeSitterBackend = {
    ...recordingBackend(registered),
    parse: async (payload) => {
      parses += 1
      return {
        documentId: payload.documentId,
        languageId: payload.languageId,
        snapshotVersion: payload.snapshotVersion,
        status: 'parsed',
        changedRanges: [],
        missingLanguages: ['astro', 'astro'],
        timings: [],
      }
    },
  }
  const snapshot = createPieceTableSnapshot('```astro\n<Card />\n```')
  const session = createTreeDocument({
    documentId: 'delayed',
    languageId: 'container',
    text: readAll(createDocumentTextSnapshot(snapshot)),
    backend,
    syntaxMode: 'range',
    languageResolver: {
      resolveTreeSitterLanguage: async (id) => {
        if (id !== 'astro') return descriptor(id)
        requested()
        return delayed
      },
    },
  })
  const refresh = session.run()
  await requestedPromise
  session.dispose()
  const parsedBeforeDisposal = parses
  release(descriptor('astro'))
  await refresh
  await flushPromises()
  expect(parses).toBe(parsedBeforeDisposal)
  expect(registered).toEqual([['container']])
})

it('shares a delayed language load with the newer document version', async () => {
  let release!: (descriptor: TreeSitterLanguageDescriptor) => void
  let requested!: () => void
  const requestedPromise = new Promise<void>((resolve) => {
    requested = resolve
  })
  const delayed = new Promise<TreeSitterLanguageDescriptor>((resolve) => {
    release = resolve
  })
  const registered: string[][] = []
  let loads = 0
  const backend: TreeSitterBackend = {
    ...recordingBackend(registered),
    parse: async (payload) => ({
      documentId: payload.documentId,
      languageId: payload.languageId,
      snapshotVersion: payload.snapshotVersion,
      status: 'parsed',
      changedRanges: [],
      missingLanguages: registered.some((ids) => ids.includes('astro')) ? [] : ['astro'],
      timings: [],
    }),
  }
  const snapshot = createPieceTableSnapshot('```astro\n<Card />\n```')
  const session = createTreeDocument({
    documentId: 'delayed',
    languageId: 'container',
    text: readAll(createDocumentTextSnapshot(snapshot)),
    backend,
    syntaxMode: 'range',
    languageResolver: {
      resolveTreeSitterLanguage: async (id) => {
        if (id !== 'astro') return descriptor(id)
        loads += 1
        requested()
        return delayed
      },
    },
  })
  const published: EditorSyntaxResult[] = []
  session.runtime.subscribeResults((_read, result) => published.push(result))
  const first = session.run()
  await requestedPromise
  const second = session.edit([{ from: 0, to: 0, text: 'x' }])
  release(descriptor('astro'))
  const [, answered] = await Promise.all([first, second])
  await vi.waitFor(() => expect(registered).toEqual([['container'], ['astro']]))
  await flushPromises()
  // The grammar arrives either before the newer version is parsed, whose answer then has it, or
  // after, and is then published as that version's next result. Either way the complete result
  // of the newest text was handed to someone.
  const latest = session.runtime.getResult()
  expect(loads).toBe(1)
  expect(latest.projection.analysis?.kind).toBe('full')
  expect(latest.projection.snapshot.length).toBe(session.buffer.getTextSnapshot().length)
  expect(published.concat([answered])).toContain(latest)
  session.dispose()
})

describe('the first answer and injected grammars', () => {
  // The document's injections need these until they are registered.
  type Injecting = { needs: readonly string[] }

  type Identified = { documentId: string; languageId: string; snapshotVersion: number }
  const answer = (payload: Identified) => ({
    documentId: payload.documentId,
    languageId: payload.languageId,
    snapshotVersion: payload.snapshotVersion,
  })
  const parsed = (payload: Identified, missingLanguages: readonly string[]) => ({
    ...answer(payload),
    status: 'parsed' as const,
    changedRanges: [],
    missingLanguages,
    timings: [],
  })
  const rangeAnswer = (
    payload: Identified & { range: { startIndex: number; endIndex: number } },
  ) => ({
    ...answer(payload),
    range: payload.range,
    captures: [],
    folds: [],
    brackets: [],
    errors: [],
    injections: [],
    timings: [],
  })

  /**
   * `edits`, when given, makes the backend apply edits to the tree it has, as the worker does,
   * and records them. Without it an edit is refused and the session parses from the start.
   */
  const injectingBackend = (
    registered: string[][],
    parses: number[],
    document: Injecting = { needs: ['astro'] },
    edits?: number[],
  ): TreeSitterBackend => {
    const missing = () => document.needs.filter((id) => !registered.some((ids) => ids.includes(id)))
    return {
      ...recordingBackend(registered),
      parse: async (payload) => {
        parses.push(payload.snapshotVersion)
        return parsed(payload, missing())
      },
      edit: async (payload) => {
        if (!edits) return undefined
        edits.push(payload.snapshotVersion)
        // The worker looks for injections where the edit changed the text, and keeps reporting
        // the grammars the rest of the document was already waiting for.
        return parsed(payload, missing())
      },
      queryRange: async (payload) => rangeAnswer(payload),
    }
  }

  /**
   * A file long enough to be answered from its first part. A range past that part has no
   * answer until the whole tree is parsed.
   */
  const largeFileBackend = (registered: string[][], log: string[]): TreeSitterBackend => {
    const missing = () => (registered.some((ids) => ids.includes('astro')) ? [] : ['astro'])
    let wholeTree = false
    return {
      ...recordingBackend(registered),
      parse: async (payload) => {
        log.push(`${payload.resultMode} parse of version ${payload.snapshotVersion}`)
        wholeTree = payload.resultMode !== 'bootstrap'
        if (wholeTree) return parsed(payload, missing())
        return {
          ...parsed(payload, []),
          analysis: { kind: 'partial', coveredRange: { startIndex: 0, endIndex: 0 } },
        }
      },
      edit: async (payload) => {
        log.push(`edit to version ${payload.snapshotVersion}`)
        return parsed(payload, missing())
      },
      queryRange: async (payload) => (wholeTree ? rangeAnswer(payload) : undefined),
    }
  }

  /** The promise's value, or `waiting` when it has not settled after a few turns of the loop. */
  const soon = <T>(promise: Promise<T>): Promise<T | 'waiting'> =>
    Promise.race([promise, turns(20).then(() => 'waiting' as const)])

  const turns = async (count: number): Promise<void> => {
    for (let turn = 0; turn < count; turn += 1) await flushPromises()
  }

  const delayedAstro = () => {
    let release!: () => void
    const delayed = new Promise<TreeSitterLanguageDescriptor>((resolve) => {
      release = () => resolve(descriptor('astro'))
    })
    return {
      release,
      resolver: {
        resolveTreeSitterLanguage: async (id: string) =>
          id === 'astro' ? delayed : descriptor(id),
      },
    }
  }

  const analysisOf = (result: EditorSyntaxResult) => result.projection.analysis?.kind

  it('answers from the document grammar while an injected grammar is still loading', async () => {
    const registered: string[][] = []
    const parses: number[] = []
    const astro = delayedAstro()
    const session = createTreeDocument({
      documentId: 'injected',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend: injectingBackend(registered, parses),
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))

    // The injected grammar has not arrived, and the document's first answer does not wait for
    // it. It says so: `partial`, as a large document's first screen does.
    const first = await session.run()
    expect(parses).toEqual([1])
    expect(registered).toEqual([['container']])
    expect(published).toEqual([])
    expect(analysisOf(first)).toBe('partial')
    const range = { startIndex: 0, endIndex: 8 }
    expect(analysisOf(await session.runtime.queryRange(range))).toBe('partial')

    astro.release()
    await vi.waitFor(() => expect(published).toHaveLength(1))

    // The same text is parsed again with the grammar registered, and published as the complete
    // result.
    expect(registered).toEqual([['container'], ['astro']])
    expect(new Set(parses)).toEqual(new Set([1]))
    expect(analysisOf(published[0]!)).toBe('full')
    expect(session.runtime.getResult()).toBe(published[0])
    expect(analysisOf(await session.runtime.queryRange(range))).toBe('full')
    session.dispose()
  })

  it('completes the first answer after a revision that leaves the text unchanged', async () => {
    const registered: string[][] = []
    const astro = delayedAstro()
    const session = createTreeDocument({
      documentId: 'same-text',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend: injectingBackend(registered, []),
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    const publishedAt: number[] = []
    session.runtime.subscribeResults((read) => publishedAt.push(read.revision.point.revision))
    expect(analysisOf(await session.run())).toBe('partial')

    // A transaction whose net text is the same: a new revision, the same parse.
    const committed = commitPreparedDocumentTransaction(
      { buffer: session.buffer, sourceView: null },
      prepareDocumentTransaction(session.buffer, [{ from: 0, to: 1, text: '`' }], 1, null),
      { history: { kind: 'external-barrier', groupId: 'same-text' } },
    )
    expect(committed.status).toBe('logical-only')
    expect(analysisOf(await session.run())).toBe('partial')

    astro.release()
    await vi.waitFor(() => expect(publishedAt.length).toBeGreaterThan(0))

    // The grammar still arrives, and its result is published against the revision that is
    // current now, which is the one a listener is waiting on.
    expect(registered).toEqual([['container'], ['astro']])
    expect(publishedAt.at(-1)).toBe(session.buffer.getRevision())
    expect(analysisOf(session.runtime.getResult())).toBe('full')
    session.dispose()
  })

  it('settles an edit that removes the injection without the grammar it was waiting for', async () => {
    const registered: string[][] = []
    const document: Injecting = { needs: ['astro'] }
    const astro = delayedAstro()
    const session = createTreeDocument({
      documentId: 'removed',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend: injectingBackend(registered, [], document),
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    expect(analysisOf(await session.run())).toBe('partial')

    // The fence goes; the grammar it needed is still loading and never arrives.
    document.needs = []
    const edited = await session.edit([{ from: 0, to: 3, text: '' }])

    expect(analysisOf(edited)).toBe('full')
    expect(analysisOf(session.runtime.getResult())).toBe('full')
    expect(registered).toEqual([['container']])
    session.dispose()
  })

  it('registers the grammars that load when another fails, and keeps reporting the failure', async () => {
    const registered: string[][] = []
    const parses: number[] = []
    const session = createTreeDocument({
      documentId: 'one-fails',
      languageId: 'container',
      text: '```astro\n<Card />\n```\n```broken\n```',
      backend: injectingBackend(registered, parses, { needs: ['astro', 'broken'] }),
      syntaxMode: 'range',
      languageResolver: {
        resolveTreeSitterLanguage: async (id) => {
          if (id === 'broken') throw new Error('asset offline')
          return descriptor(id)
        },
      },
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))
    expect(analysisOf(await session.run())).toBe('partial')
    await vi.waitFor(() => expect(published).toHaveLength(1))

    // The grammar that resolved is registered and the document is complete with it.
    expect(registered).toEqual([['container'], ['astro']])
    expect(analysisOf(published[0]!)).toBe('full')
    const failure = {
      kind: 'optional-phase-failed',
      phase: 'load injected languages',
      message: expect.stringContaining('asset offline'),
    }
    expect(published[0]!.degraded).toEqual(failure)

    // The failure stays on what is asked of this revision, and on the next one, which is not
    // held back or parsed twice for a grammar already known not to load.
    const ranged = await session.runtime.queryRange({ startIndex: 0, endIndex: 8 })
    expect(ranged.degraded).toEqual(failure)
    const parsedBeforeEdit = parses.length
    const edited = await session.edit([{ from: 0, to: 0, text: ' ' }])
    await flushPromises()
    expect(analysisOf(edited)).toBe('full')
    expect(edited.degraded).toEqual(failure)
    expect(parses).toHaveLength(parsedBeforeEdit + 1)
    expect(published).toHaveLength(1)
    session.dispose()
  })

  it('tells a retained range caller when the complete result replaces the first answer', async () => {
    const registered: string[][] = []
    const astro = delayedAstro()
    const backend = injectingBackend(registered, [])
    const buffer = createEditorTextBuffer('```astro\n<Card />\n```')
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'retained' })
    const lease = analysis.borrowStructural({
      languageId: 'container',
      syntaxMode: 'range',
      provider: {
        operation: defineStructuralOperation(
          (context) =>
            new TreeSitterSyntaxSession({
              ...context,
              languageId: 'container',
              languageResolver: astro.resolver,
              backend,
            }),
        ),
      },
    })!
    cleanup.push(() => {
      lease.dispose()
      analysis.dispose()
    })
    let produced = 0
    lease.onDidProduceSyntax(() => {
      produced += 1
    })
    const range = { startIndex: 0, endIndex: 8 }

    // The range API's own answers carry the signal: `partial` until the grammars are in.
    expect(analysisOf(await lease.refresh(buffer.getTextSnapshot()))).toBe('partial')
    expect(analysisOf(await lease.queryRange(range))).toBe('partial')
    expect(produced).toBe(0)

    astro.release()
    await vi.waitFor(() => expect(produced).toBe(1))

    expect(analysisOf(await lease.queryRange(range))).toBe('full')
  })

  it('gives a pending range its colors only, and its folds with the complete result', async () => {
    const registered: string[][] = []
    const astro = delayedAstro()
    const fold = { startIndex: 0, endIndex: 21, startLine: 0, endLine: 2, type: 'fence' }
    const backend: TreeSitterBackend = {
      ...injectingBackend(registered, []),
      queryRange: async (payload) => ({ ...rangeAnswer(payload), folds: [fold] }),
    }
    const session = createTreeDocument({
      documentId: 'colors-only',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend,
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))
    await session.run()
    const range = { startIndex: 0, endIndex: 21 }

    // A partial answer is provisional: nothing structural is shown and then changed.
    const pending = await session.runtime.queryRange(range)
    expect(analysisOf(pending)).toBe('partial')
    expect(pending.folds).toEqual([])

    astro.release()
    await vi.waitFor(() => expect(published).toHaveLength(1))

    const complete = await session.runtime.queryRange(range)
    expect(analysisOf(complete)).toBe('full')
    expect(complete.folds).toEqual([fold])
    session.dispose()
  })

  it('applies an edit to the tree it has while an injected grammar is still loading', async () => {
    const registered: string[][] = []
    const parses: number[] = []
    const edits: number[] = []
    const astro = delayedAstro()
    const session = createTreeDocument({
      documentId: 'typed-while-loading',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend: injectingBackend(registered, parses, { needs: ['astro'] }, edits),
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    expect(analysisOf(await session.run())).toBe('partial')

    // The grammar is still downloading. The key is applied to the tree the worker already has:
    // it is not a reason to parse the file from the start.
    const edited = await session.edit([{ from: 0, to: 0, text: ' ' }])
    expect(edits).toEqual([2])
    expect(parses).not.toContain(3)
    expect(analysisOf(edited)).toBe('partial')

    astro.release()
    await vi.waitFor(() => expect(analysisOf(session.runtime.getResult())).toBe('full'))

    // The edited version gets its injected layers from a parse of that same version.
    expect(registered).toEqual([['container'], ['astro']])
    expect(session.runtime.getSnapshotVersion()).toBe(2)
    session.dispose()
  })

  it('keeps a large file partial until its injected grammars are in, across an edit', async () => {
    const registered: string[][] = []
    const log: string[] = []
    const astro = delayedAstro()
    const text = '```astro\n<Card />\n```\n' + 'x'.repeat(70_000)
    const session = createTreeDocument({
      documentId: 'large',
      languageId: 'container',
      text,
      backend: largeFileBackend(registered, log),
      syntaxMode: 'range',
      languageResolver: astro.resolver,
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))
    expect(analysisOf(await session.run())).toBe('partial')

    // A range past the first part waits for the whole tree and for nothing else: it is answered
    // from that tree while the grammar is still loading, and says the answer is not final.
    const far = { startIndex: text.length - 10, endIndex: text.length }
    const answered = await soon(session.runtime.queryRange(far))
    expect(answered).not.toBe('waiting')
    expect(analysisOf(answered as EditorSyntaxResult)).toBe('partial')
    // Nothing is published for the whole tree alone: what is on screen is replaced once, by
    // the complete result.
    expect(published).toEqual([])

    // Typing on another line edits that tree; the document is still waiting for the grammar.
    const edited = await session.edit([{ from: text.length, to: text.length, text: 'y' }])
    expect(analysisOf(edited)).toBe('partial')
    expect(log.slice(0, 3)).toEqual([
      'bootstrap parse of version 1',
      'parseOnly parse of version 1',
      'edit to version 2',
    ])

    astro.release()
    await vi.waitFor(() => expect(published).toHaveLength(1))

    // The grammar arrives for the edited version, which is completed without a parse from the
    // start.
    expect(registered).toEqual([['container'], ['astro']])
    expect(analysisOf(published[0]!)).toBe('full')
    expect(published[0]!.projection.snapshot.version).toBe(2)
    expect(analysisOf(await session.runtime.queryRange(far))).toBe('full')
    expect(log.filter((entry) => entry.startsWith('bootstrap'))).toHaveLength(1)
    session.dispose()
  })

  it('reports injected layers the worker gave up on, and stops calling the result partial', async () => {
    const registered: string[][] = []
    const cancelled = { cancel: true }
    const backend: TreeSitterBackend = {
      ...recordingBackend(registered),
      parse: async (payload) => {
        const loaded = registered.some((ids) => ids.includes('astro'))
        if (!loaded) return parsed(payload, ['astro'])
        if (!cancelled.cancel) return parsed(payload, [])
        // The grammar's own download outlasted the parse that was to use it.
        return {
          ...parsed(payload, []),
          status: 'cancelled',
          analysis: {
            kind: 'cancelled',
            coveredRange: { startIndex: 0, endIndex: 0 },
            reason: 'budget',
            elapsedMs: 20_000,
            budgetMs: 20_000,
            timings: [],
          },
        }
      },
      edit: async (payload) => parsed(payload, ['astro']),
      queryRange: async (payload) => rangeAnswer(payload),
    }
    const session = createTreeDocument({
      documentId: 'gave-up',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend,
      syntaxMode: 'range',
      languageResolver: { resolveTreeSitterLanguage: async (id) => descriptor(id) },
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))
    expect(analysisOf(await session.run())).toBe('partial')
    await vi.waitFor(() => expect(published).toHaveLength(1))

    // The document's own tree is whole, so the result is final for this version and says what
    // it lacks. A range answer says the same instead of promising more.
    const failure = { kind: 'optional-phase-failed', phase: 'load injected languages' }
    expect(analysisOf(published[0]!)).toBe('full')
    expect(published[0]!.degraded).toMatchObject(failure)
    const ranged = await session.runtime.queryRange({ startIndex: 0, endIndex: 8 })
    expect(analysisOf(ranged)).toBe('full')
    expect(ranged.degraded).toMatchObject(failure)

    // The next edit starts over: the worker still reports the layers as lacking, and this time
    // the grammar is in.
    cancelled.cancel = false
    expect(analysisOf(await session.edit([{ from: 0, to: 0, text: ' ' }]))).toBe('partial')
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(analysisOf(published[1]!)).toBe('full')
    expect(published[1]!.degraded).toBeNull()
    session.dispose()
  })

  it('keeps the first part of a large file whose whole parse the worker gave up on', async () => {
    const registered: string[][] = []
    const parses: string[] = []
    const backend: TreeSitterBackend = {
      ...recordingBackend(registered),
      parse: async (payload) => {
        parses.push(String(payload.resultMode))
        if (payload.resultMode === 'bootstrap')
          return {
            ...parsed(payload, []),
            analysis: { kind: 'partial', coveredRange: { startIndex: 0, endIndex: 0 } },
          }
        return {
          ...parsed(payload, []),
          status: 'cancelled',
          analysis: {
            kind: 'cancelled',
            coveredRange: { startIndex: 0, endIndex: 0 },
            reason: 'budget',
            elapsedMs: 20_000,
            budgetMs: 20_000,
            timings: [],
          },
        }
      },
      queryRange: async () => undefined,
    }
    const session = createTreeDocument({
      documentId: 'no-whole-tree',
      languageId: 'container',
      text: 'x'.repeat(70_000),
      backend,
      syntaxMode: 'range',
      languageResolver: { resolveTreeSitterLanguage: async (id) => descriptor(id) },
    })
    const published: EditorSyntaxResult[] = []
    session.runtime.subscribeResults((_read, result) => published.push(result))
    expect(analysisOf(await session.run())).toBe('partial')
    await session.runtime.queryRange({ startIndex: 69_000, endIndex: 70_000 })
    await vi.waitFor(() => expect(published).toHaveLength(1))

    // There is no whole tree to call complete: the result stays partial and records why. It is
    // final for this version, so asking again does not start the parse again.
    const analysis = published[0]!.projection.analysis
    expect(analysis).toMatchObject({ kind: 'partial', background: { reason: 'budget' } })
    await session.runtime.queryRange({ startIndex: 69_000, endIndex: 70_000 })
    await turns(3)
    expect(parses).toEqual(['bootstrap', 'parseOnly'])
    session.dispose()
  })

  it('waits for injected grammars when the caller is given one complete answer', async () => {
    const registered: string[][] = []
    const parses: number[] = []
    const astro = delayedAstro()
    const session = createTreeDocument({
      documentId: 'complete',
      languageId: 'container',
      text: '```astro\n<Card />\n```',
      backend: injectingBackend(registered, parses),
      syntaxMode: 'full',
      languageResolver: astro.resolver,
    })
    let answered = false
    const run = session.run().then(() => {
      answered = true
    })
    await vi.waitFor(() => expect(parses).toEqual([1]))
    await flushPromises()
    expect(answered).toBe(false)

    astro.release()
    await run

    expect(registered).toEqual([['container'], ['astro']])
    expect(parses).toEqual([1, 1])
    session.dispose()
  })
})

describe('provider warm-up', () => {
  it('warms the host languages with their injection closures after a first parse', async () => {
    const warm = warmingProvider(() => ['container', 'html', 'unknown'])

    expect(warm.warmed).toEqual([])
    await warm.openDocument('html')
    await flushPromises()

    expect(warm.warmed).toEqual([['container', 'embedded', 'html']])
  })

  it('reads the host set again for each new document and skips an unchanged one', async () => {
    let languages = ['html']
    const warm = warmingProvider(() => languages)

    await warm.openDocument('html')
    await warm.openDocument('html')
    languages = ['container']
    await warm.openDocument('html')
    await flushPromises()

    expect(warm.warmed).toEqual([['html'], ['container', 'embedded']])
  })

  it('warms replaced registrations even when the host language list is unchanged', async () => {
    const warmedUrls: string[][] = []
    const warm = warmingProvider(
      () => ['html'],
      async (languages) => {
        warmedUrls.push(languages.map((language) => language.wasmUrl))
      },
    )
    await warm.openDocument('html')
    await flushPromises()
    const replacement = warm.provider.registerLanguage(
      { ...descriptor('html'), wasmUrl: '/replacement.wasm' },
      { replace: true },
    )
    await warm.openDocument('html')
    await flushPromises()
    replacement.dispose()
    await warm.openDocument('html')
    await flushPromises()

    expect(warmedUrls).toEqual([
      [descriptor('html').wasmUrl],
      ['/replacement.wasm'],
      [descriptor('html').wasmUrl],
    ])
  })

  it('skips a grammar that fails to load and survives a worker that cannot start', async () => {
    const warm = warmingProvider(() => ['broken', 'html'])
    warm.provider.registerLanguage({
      id: 'broken',
      load: () => Promise.reject(new Error('offline')),
    })

    await warm.openDocument('html')
    await flushPromises()
    expect(warm.warmed).toEqual([['html']])

    const failing = warmingProvider(
      () => ['html'],
      () => Promise.reject(new Error('down')),
    )
    await failing.openDocument('html')
    await flushPromises()
  })
})

function warmingProvider(
  languages: () => readonly string[],
  warmLanguages?: TreeSitterBackend['warmLanguages'],
) {
  const warmed: string[][] = []
  const owner = createTreeSitterWorkerOwner({
    workerFactory: () =>
      new RecordingWorker(
        warmLanguages ??
          (async (descriptors) => {
            warmed.push(descriptors.map((language) => language.id))
          }),
      ),
  })
  cleanup.push(() => owner.dispose())
  const provider = createTreeSitterSyntaxProvider({ workerOwner: owner, warmLanguages: languages })
  for (const language of Object.values(DESCRIPTORS)) provider.registerLanguage(language)
  const openDocument = async (languageId: string) => {
    const buffer = createEditorTextBuffer('<p>hi</p>')
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: `doc-${languageId}` })
    const lease = analysis.borrowStructural({ provider, languageId })!
    try {
      await lease.refresh(buffer.getTextSnapshot())
    } finally {
      lease.dispose()
      analysis.dispose()
    }
  }
  return { openDocument, provider, warmed }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
