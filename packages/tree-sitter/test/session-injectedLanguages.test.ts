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

  const injectingBackend = (
    registered: string[][],
    parses: number[],
    document: Injecting = { needs: ['astro'] },
  ): TreeSitterBackend => {
    const missing = () => document.needs.filter((id) => !registered.some((ids) => ids.includes(id)))
    const answer = (payload: {
      documentId: string
      languageId: string
      snapshotVersion: number
    }) => ({
      documentId: payload.documentId,
      languageId: payload.languageId,
      snapshotVersion: payload.snapshotVersion,
    })
    return {
      ...recordingBackend(registered),
      parse: async (payload) => {
        parses.push(payload.snapshotVersion)
        return {
          ...answer(payload),
          status: 'parsed',
          changedRanges: [],
          missingLanguages: missing(),
          timings: [],
        }
      },
      queryRange: async (payload) => ({
        ...answer(payload),
        range: payload.range,
        captures: [],
        folds: [],
        brackets: [],
        errors: [],
        injections: [],
        timings: [],
      }),
    }
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
