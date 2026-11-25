import {
  createTreeDocument,
  createSourceEndpoint,
  disposeTreeDocuments,
} from './factories/document'
import { readAll } from '../../editor/test/factories/snapshotText'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  createDocumentSession,
  createPieceTableSnapshot,
  createDocumentTextSnapshot,
} from '@singapore-editor/core/document'
import {
  styleForTreeSitterCapture,
  toEditorTokenStore,
  treeSitterCapturesToEditorTokens,
  type EditorToken,
  type EditorTokenInput,
} from '@singapore-editor/core/syntax'
import { EditorPluginHost } from '@singapore-editor/core/testing'
import {
  createTreeSitterLanguagePlugin,
  createTreeSitterSyntaxPlugin,
  createTreeSitterSyntaxProvider,
  flushDefaultTreeSitterProvider,
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageContribution,
  TreeSitterLanguageRegistry,
  type TreeSitterLanguageContribution,
} from '../src'
import { createTreeSitterEditPayload } from '../src/session'
import type { DocumentWorkerReadReference } from '@singapore-editor/core/internal/document-worker'
const messageSource: DocumentWorkerReadReference = {
  identity: {
    documentId: 'message-doc',
    documentGeneration: 1,
    endpointGeneration: 1,
    registrationId: 1,
  },
  point: { segment: 'message-segment', revision: 0, textVersion: 0 },
  readId: 'message-read',
}
import type {
  TreeSitterEditRequest,
  TreeSitterParseAckResult,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterRangeResult,
} from '../src/treeSitter/types'
import {
  treeSitterBackendForOwner,
  type TreeSitterBackend,
  type TreeSitterBackendParsePayload,
  type TreeSitterEditPayload,
  type TreeSitterRangePayload,
  type TreeSitterWorkerOwner,
} from '../src/treeSitter/workerClient'

afterEach(disposeTreeDocuments)

describe('Tree-sitter syntax capture conversion', () => {
  it('maps known capture names to editor token styles', () => {
    expect(styleForTreeSitterCapture('keyword.declaration')).toEqual({
      color: 'var(--editor-syntax-keyword-declaration)',
    })
    expect(styleForTreeSitterCapture('string')).toEqual({
      color: 'var(--editor-syntax-string)',
    })
    expect(styleForTreeSitterCapture('constructor')).toEqual({
      color: 'var(--editor-syntax-type-definition)',
    })
    expect(styleForTreeSitterCapture('text.title')).toEqual({
      color: 'var(--editor-syntax-keyword-declaration)',
      fontWeight: 700,
    })
    expect(styleForTreeSitterCapture('text.uri')).toEqual({
      color: 'var(--editor-syntax-string)',
      textDecoration: 'underline',
    })
    expect(styleForTreeSitterCapture('unknown.scope')).toBeNull()
  })

  it('resolves registered aliases and descriptors', async () => {
    const registry = createTestLanguageRegistry()
    const descriptor = await registry.resolveTreeSitterLanguage('ts')

    expect(descriptor).toMatchObject({
      id: 'typescript',
      wasmUrl: '/typescript.wasm',
      extensions: ['.ts', '.cts', '.mts', '.tsx'],
      aliases: ['typescript', 'ts', 'tsx'],
      highlightQuerySource: '(identifier) @variable',
    })
    expect(resolveTreeSitterLanguageAlias('js', registry)).toBe('javascript')
    expect(resolveTreeSitterLanguageAlias('css', registry)).toBeNull()
    expect(resolveTreeSitterLanguageAlias('sql', registry)).toBeNull()
  })

  it('supports async language asset loaders', async () => {
    const descriptor = await resolveTreeSitterLanguageContribution({
      id: 'rust',
      extensions: ['rs'],
      aliases: ['rust'],
      load: async () => ({
        wasmUrl: '/rust.wasm',
        highlightQuerySource: '(identifier) @variable',
      }),
    })

    expect(descriptor).toMatchObject({
      id: 'rust',
      extensions: ['.rs'],
      aliases: ['rust'],
      wasmUrl: '/rust.wasm',
    })
  })

  it('rejects duplicate language ids unless replacement is explicit', async () => {
    const registry = new TreeSitterLanguageRegistry()
    const original = registry.registerLanguage(testLanguage('typescript', ['.ts']))

    expect(() => registry.registerLanguage(testLanguage('typescript', ['.tsx']))).toThrow(
      /already registered/,
    )

    const replacement = registry.registerLanguage(testLanguage('typescript', ['.mts']), {
      replace: true,
    })
    await expect(registry.resolveTreeSitterLanguage('typescript')).resolves.toMatchObject({
      extensions: ['.mts'],
    })

    replacement.dispose()
    await expect(registry.resolveTreeSitterLanguage('typescript')).resolves.toMatchObject({
      extensions: ['.ts'],
    })

    original.dispose()
    await expect(registry.resolveTreeSitterLanguage('typescript')).resolves.toBeNull()
  })

  it('registers language contributions through typed editor plugin providers', () => {
    const host = new EditorPluginHost([
      createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], { name: 'sql-language' }),
    ])
    expect(host.getSyntaxProvider()).not.toBeNull()
    host.dispose()
    expect(host.getSyntaxProvider()).toBeNull()
  })

  it('registers a host-owned syntax provider without constructing another provider', () => {
    const provider = createTreeSitterSyntaxProvider()
    provider.registerLanguage(testLanguage('sql', ['.sql']))
    const host = new EditorPluginHost([
      createTreeSitterSyntaxPlugin(provider, { name: 'shared-tree-sitter' }),
    ])

    expect(createSqlSyntaxSession(host)).not.toBeNull()

    host.dispose()
  })

  it('shares language plugin registrations across editor plugin hosts', async () => {
    const plugin = createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], {
      name: 'sql-language',
    })
    const firstHost = new EditorPluginHost([plugin])
    const secondHost = new EditorPluginHost([plugin])

    expect(createSqlSyntaxSession(firstHost)).not.toBeNull()
    expect(createSqlSyntaxSession(secondHost)).not.toBeNull()

    firstHost.dispose()

    expect(createSqlSyntaxSession(secondHost)).not.toBeNull()

    secondHost.dispose()

    const emptyHost = new EditorPluginHost([])
    expect(createSqlSyntaxSession(emptyHost)).toBeNull()
    emptyHost.dispose()

    const nextHost = new EditorPluginHost([plugin])
    expect(createSqlSyntaxSession(nextHost)).not.toBeNull()
    nextHost.dispose()
    await flushDefaultTreeSitterProvider()
  })

  it('disposes the default Tree-sitter worker and clears globalThis after the last editor releases it', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    try {
      const plugin = createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], {
        name: 'sql-language',
      })
      const firstHost = new EditorPluginHost([plugin])
      const secondHost = new EditorPluginHost([plugin])

      const initialRegistration = state[key] as
        | { readonly owner: { inspect(): { readonly lifecycle: string } } }
        | undefined
      expect(initialRegistration).toBeDefined()

      // Disposing only one host keeps the shared default provider live.
      firstHost.dispose()
      vi.advanceTimersByTime(10_000)
      expect(state[key]).toBe(initialRegistration)
      expect(initialRegistration?.owner.inspect().lifecycle).not.toBe('disposed')

      // Disposing the last host starts the idle grace window; mounting again before expiry
      // cancels disposal and keeps the warm registration alive.
      secondHost.dispose()
      vi.advanceTimersByTime(2_000)
      expect(state[key]).toBe(initialRegistration)

      const reattachedHost = new EditorPluginHost([plugin])
      vi.advanceTimersByTime(10_000)
      expect(state[key]).toBe(initialRegistration)
      expect(initialRegistration?.owner.inspect().lifecycle).not.toBe('disposed')

      // Flushing while an active editor holds the provider is a no-op.
      await flushDefaultTreeSitterProvider()
      expect(state[key]).toBe(initialRegistration)

      // Once the last host releases and the grace period elapses, the worker owner is disposed
      // and the globalThis slot is cleared.
      reattachedHost.dispose()
      vi.advanceTimersByTime(5_000)
      expect(state[key]).toBeUndefined()
      expect(initialRegistration?.owner.inspect().lifecycle).toBe('disposed')

      // Mounting a subsequent editor creates a fresh provider cleanly.
      const freshHost = new EditorPluginHost([plugin])
      const freshRegistration = state[key] as
        | { readonly owner: { inspect(): { readonly lifecycle: string } } }
        | undefined
      expect(freshRegistration).toBeDefined()
      expect(freshRegistration).not.toBe(initialRegistration)
      expect(createSqlSyntaxSession(freshHost)).not.toBeNull()

      freshHost.dispose()
      // Immediate flush helper disposes an idle default provider without waiting for the timer.
      await flushDefaultTreeSitterProvider()
      expect(state[key]).toBeUndefined()
      expect(freshRegistration?.owner.inspect().lifecycle).toBe('disposed')
    } finally {
      await flushDefaultTreeSitterProvider()
      vi.useRealTimers()
    }
  })

  it('terminates an active default Web Worker when the idle grace window expires', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    const terminated: number[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(message: { id?: number; payload?: { type?: string } }): void {
        if (message.id !== undefined) {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { id: message.id, ok: true, result: { type: message.payload?.type ?? 'init' } },
            } as MessageEvent)
          })
        }
      }
      terminate(): void {
        terminated.push(1)
      }
    }
    vi.stubGlobal('Worker', FakeWorker)

    try {
      const plugin = createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], {
        name: 'sql-worker-lifecycle',
      })
      const host = new EditorPluginHost([plugin])
      const registration = state[key] as {
        readonly owner: TreeSitterWorkerOwner
        readonly provider: {
          resolveTreeSitterLanguage(
            id: string,
          ): Promise<Awaited<ReturnType<TreeSitterLanguageRegistry['resolveTreeSitterLanguage']>>>
        }
      }
      const descriptor = await registration.provider.resolveTreeSitterLanguage('sql')
      expect(descriptor).not.toBeNull()
      await treeSitterBackendForOwner(registration.owner).registerLanguages([descriptor!])
      expect(registration.owner.inspect().workerGeneration).toBe(1)

      host.dispose()
      expect(terminated).toHaveLength(0)

      vi.advanceTimersByTime(5_000)
      expect(terminated).toHaveLength(1)
      expect(state[key]).toBeUndefined()
      expect(registration.owner.inspect().lifecycle).toBe('disposed')
    } finally {
      await flushDefaultTreeSitterProvider()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('does not collide lazy language loaders that have identical toString() output', async () => {
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    const makeLoader = (wasmUrl: string) => async () => ({
      wasmUrl,
      highlightQuerySource: '(identifier) @variable',
    })
    const loaderA = makeLoader('/grammar-a.wasm')
    const loaderB = makeLoader('/grammar-b.wasm')
    expect(loaderA.toString()).toBe(loaderB.toString())

    const hostA = new EditorPluginHost([
      createTreeSitterLanguagePlugin([{ id: 'custom-lang', load: loaderA }], {
        name: 'custom-lang-a',
      }),
    ])
    const hostB = new EditorPluginHost([
      createTreeSitterLanguagePlugin([{ id: 'custom-lang', load: loaderB }], {
        name: 'custom-lang-b',
      }),
    ])

    try {
      const registration = state[key] as {
        readonly provider: {
          resolveTreeSitterLanguage(id: string): Promise<{ readonly wasmUrl: string } | null>
        }
      }
      // Second distinct closure must register its own loader rather than colliding with loaderA.
      await expect(
        registration.provider.resolveTreeSitterLanguage('custom-lang'),
      ).resolves.toMatchObject({
        wasmUrl: '/grammar-b.wasm',
      })

      // Disposing hostB restores hostA's registration cleanly.
      hostB.dispose()
      await expect(
        registration.provider.resolveTreeSitterLanguage('custom-lang'),
      ).resolves.toMatchObject({
        wasmUrl: '/grammar-a.wasm',
      })
    } finally {
      hostB.dispose()
      hostA.dispose()
      await flushDefaultTreeSitterProvider()
    }
  })

  it('deduplicates lazy language loaders by function reference or explicit cacheKey', async () => {
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    const loadByKey = vi.fn(async () => ({
      wasmUrl: '/shared-key.wasm',
      highlightQuerySource: '(identifier) @variable',
    }))
    const hostA = new EditorPluginHost([
      createTreeSitterLanguagePlugin(
        [{ id: 'cached-lang', cacheKey: 'cached-lang:v1', load: () => loadByKey() }],
        { name: 'cached-a' },
      ),
    ])
    const hostB = new EditorPluginHost([
      createTreeSitterLanguagePlugin(
        [{ id: 'cached-lang', cacheKey: 'cached-lang:v1', load: () => loadByKey() }],
        { name: 'cached-b' },
      ),
    ])

    try {
      const registration = state[key] as {
        readonly provider: {
          resolveTreeSitterLanguage(id: string): Promise<{ readonly wasmUrl: string } | null>
        }
        readonly languageReferences: Map<string, { readonly references: number }>
      }
      expect(registration.languageReferences.size).toBe(1)
      expect([...registration.languageReferences.values()][0]?.references).toBe(2)
      await expect(
        registration.provider.resolveTreeSitterLanguage('cached-lang'),
      ).resolves.toMatchObject({ wasmUrl: '/shared-key.wasm' })
      expect(loadByKey).toHaveBeenCalledTimes(1)
    } finally {
      hostA.dispose()
      hostB.dispose()
      await flushDefaultTreeSitterProvider()
    }
  })

  it('tracks loader identity on the shared global registration so distinct module copies do not collide', async () => {
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    const makeLoader = (wasmUrl: string) => async () => ({
      wasmUrl,
      highlightQuerySource: '(identifier) @variable',
    })
    const hostA = new EditorPluginHost([
      createTreeSitterLanguagePlugin([{ id: 'dual-copy', load: makeLoader('/copy-a.wasm') }], {
        name: 'dual-copy-a',
      }),
    ])
    const hostB = new EditorPluginHost([
      createTreeSitterLanguagePlugin([{ id: 'dual-copy', load: makeLoader('/copy-b.wasm') }], {
        name: 'dual-copy-b',
      }),
    ])

    try {
      const registration = state[key] as {
        readonly loaderIdentityIds: WeakMap<object, number>
        readonly nextLoaderIdentityId: number
        readonly provider: {
          resolveTreeSitterLanguage(id: string): Promise<{ readonly wasmUrl: string } | null>
        }
      }
      expect(registration.loaderIdentityIds).toBeInstanceOf(WeakMap)
      expect(registration.nextLoaderIdentityId).toBe(2)
      await expect(
        registration.provider.resolveTreeSitterLanguage('dual-copy'),
      ).resolves.toMatchObject({ wasmUrl: '/copy-b.wasm' })
    } finally {
      hostB.dispose()
      hostA.dispose()
      await flushDefaultTreeSitterProvider()
    }
  })

  it('preserves idle disposal when a remount during the grace window throws during activation', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    try {
      const plugin = createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], {
        name: 'sql-remount-fail',
      })
      const firstHost = new EditorPluginHost([plugin])
      const registration = state[key] as {
        readonly owner: TreeSitterWorkerOwner
      }
      firstHost.dispose()

      // Remount during the idle grace window with a failing context.
      vi.advanceTimersByTime(1_000)
      const failingContext = {
        registerSyntaxProvider: () => {
          throw new Error('syntax registration failed')
        },
        registerSelectionRangeProvider: () => ({ dispose: () => undefined }),
      } as unknown as Parameters<NonNullable<typeof plugin.activate>>[0]
      expect(() => plugin.activate(failingContext)).toThrow('syntax registration failed')

      // Idle disposal must still fire and clean up the global registration & worker owner.
      vi.advanceTimersByTime(5_000)
      expect(state[key]).toBeUndefined()
      expect(registration.owner.inspect().lifecycle).toBe('disposed')
    } finally {
      await flushDefaultTreeSitterProvider()
      vi.useRealTimers()
    }
  })

  it('does not dispose an activating default provider if flushDefaultTreeSitterProvider runs inside registerSyntaxProvider', async () => {
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    await flushDefaultTreeSitterProvider()

    const plugin = createTreeSitterLanguagePlugin([testLanguage('sql', ['.sql'])], {
      name: 'sql-reentrant-flush',
    })
    let flushPromise: Promise<void> | null = null
    const context = {
      registerSyntaxProvider: () => {
        flushPromise = flushDefaultTreeSitterProvider()
        return { dispose: () => undefined }
      },
      registerSelectionRangeProvider: () => ({ dispose: () => undefined }),
    } as unknown as Parameters<NonNullable<typeof plugin.activate>>[0]

    const disposables = plugin.activate(context)
    try {
      await flushPromise
      const registration = state[key] as
        | { readonly owner: TreeSitterWorkerOwner; readonly activeContexts: number }
        | undefined
      expect(registration).toBeDefined()
      expect(registration?.activeContexts).toBe(1)
      expect(registration?.owner.inspect().lifecycle).not.toBe('disposed')
    } finally {
      if (Array.isArray(disposables)) {
        for (const disposable of disposables.toReversed()) disposable.dispose()
      }
      await flushDefaultTreeSitterProvider()
    }
  })

  it('converts non-empty captures to editor tokens', () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: 'keyword.declaration' },
      { startIndex: 6, endIndex: 6, captureName: 'string' },
      { startIndex: 7, endIndex: 10, captureName: 'not.mapped' },
    ])

    expect(tokens).toEqual([
      {
        start: 0,
        end: 5,
        style: { color: 'var(--editor-syntax-keyword-declaration)' },
      },
    ])
  })

  it('builds single-edit payloads for incremental reparsing', () => {
    const previousSnapshot = createPieceTableSnapshot('const a = 1;\n')
    const edits = [{ from: 6, to: 7, text: 'answer' }]
    const payload = createTreeSitterEditPayload({
      documentId: 'file.ts',
      runtimeSessionId: 'runtime-file.ts',
      languageId: 'typescript',
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      previousRead: createDocumentTextSnapshot(previousSnapshot),
      source: messageSource,
      edits,
    })

    expect(payload).toMatchObject({
      documentId: 'file.ts',
      snapshotVersion: 2,
      languageId: 'typescript',
      inputEdits: [
        {
          startIndex: 6,
          oldEndIndex: 7,
          newEndIndex: 12,
          startPosition: { row: 0, column: 6 },
          oldEndPosition: { row: 0, column: 7 },
          newEndPosition: { row: 0, column: 12 },
        },
      ],
    })
  })

  it('keeps worker parse and edit requests source-based', () => {
    const source = messageSource
    const parseRequest: TreeSitterParseRequest = {
      type: 'parse',
      documentId: 'file.ts',
      runtimeSessionId: 'runtime-file.ts',
      snapshotVersion: 1,
      languageId: 'typescript',
      includeHighlights: true,
      source,
      generation: 1,
    }
    const editRequest: TreeSitterEditRequest = {
      type: 'edit',
      documentId: 'file.ts',
      runtimeSessionId: 'runtime-file.ts',
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'typescript',
      includeHighlights: true,
      source,
      edits: [],
      inputEdits: [],
      generation: 2,
    }

    expect('source' in parseRequest).toBe(true)
    expect('snapshot' in parseRequest).toBe(false)
    expect('text' in parseRequest).toBe(false)
    expect('source' in editRequest).toBe(true)
    expect('snapshot' in editRequest).toBe(false)
    expect('text' in editRequest).toBe(false)
    expectTypeOf<'snapshot'>().not.toMatchTypeOf<keyof TreeSitterParseRequest>()
    expectTypeOf<'text'>().not.toMatchTypeOf<keyof TreeSitterParseRequest>()
    expectTypeOf<'snapshot'>().not.toMatchTypeOf<keyof TreeSitterEditRequest>()
    expectTypeOf<'text'>().not.toMatchTypeOf<keyof TreeSitterEditRequest>()
  })

  it('builds incremental payloads for multi-edits', () => {
    const previousSnapshot = createPieceTableSnapshot('ab\ncd')
    const edits = [
      { from: 0, to: 1, text: 'x' },
      { from: 3, to: 5, text: 'yz' },
    ]
    const payload = createTreeSitterEditPayload({
      documentId: 'file.ts',
      runtimeSessionId: 'runtime-file.ts',
      languageId: 'typescript',
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      previousRead: createDocumentTextSnapshot(previousSnapshot),
      source: messageSource,
      edits,
    })

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 3,
        oldEndIndex: 5,
        newEndIndex: 5,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 1, column: 2 },
        newEndPosition: { row: 1, column: 2 },
      },
      {
        startIndex: 0,
        oldEndIndex: 1,
        newEndIndex: 1,
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 1 },
        newEndPosition: { row: 0, column: 1 },
      },
    ])
  })

  it('composes skipped typing through the canonical owner before incremental parsing', async () => {
    const backend = createCapturingTreeSitterBackend()
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: 'const a = 1;',
    })
    try {
      await session.run()
      session.view.applyEdits([{ from: 12, to: 12, text: '!' }])
      session.view.applyEdits([{ from: 13, to: 13, text: '?' }])
      await session.run()
      expect(backend.latestEdit?.edits).toEqual([{ from: 12, to: 12, text: '!?' }])
      expect(session.buffer.materializeFullText()).toBe('const a = 1;!?')
    } finally {
      session.dispose()
    }
  })

  it.each([
    { foldQuerySource: '(object) @fold', expected: 'supported' },
    { foldQuerySource: '', expected: 'unsupported' },
  ] as const)(
    'resolves folding support from language assets: $expected',
    async ({ foldQuerySource, expected }) => {
      const registration = createDeferred<void>()
      const snapshot = createPieceTableSnapshot('const config = {}')
      const session = createTreeDocument({
        documentId: 'config.js',
        languageId: 'javascript',
        text: readAll(createDocumentTextSnapshot(snapshot)),
        backend: createCapturingTreeSitterBackend(),
        languageResolver: {
          resolveTreeSitterLanguage: async () => {
            await registration.promise
            return {
              id: 'javascript',
              aliases: [],
              extensions: ['.js'],
              wasmUrl: '/javascript.wasm',
              foldQuerySource,
            }
          },
        },
      })
      const result = session.run()
      expect(session.runtime.foldingSupport).toBe('pending')
      registration.resolve()
      await result
      expect(session.runtime.foldingSupport).toBe(expected)
      session.dispose()
    },
  )

  it('uses compact worker tokens without requiring returned captures', async () => {
    const parsePayloads: TreeSitterBackendParsePayload[] = []
    const tokens = [{ start: 0, end: 5, style: { color: '#123456' } }]
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parsePayloads.push(payload)
        return { ...createParseResult(payload), captures: [], tokens }
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      includeCaptures: false,
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })

    const result = await session.run()

    expect(parsePayloads[0]?.includeCaptures).toBe(false)
    expect(result.captures).toEqual([])
    expect(tokenObjects(result.tokens)).toEqual(tokens)
  })

  it('tags full syntax results with snapshot and language configuration', async () => {
    const text = 'const a = 1;'
    const snapshot = createPieceTableSnapshot(text)
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => createParseResult(payload),
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(snapshot)),
    })

    const result = await session.run()

    expect(result.degraded).toBeNull()
    expect(result.projection).toEqual({
      source: undefined,
      analysis: { kind: 'full', coveredRange: { startIndex: 0, endIndex: text.length } },
      language: {
        includeCaptures: true,
        includeHighlights: true,
        languageId: 'typescript',
        mode: 'full',
      },
      requestedRanges: [],
      snapshot: {
        documentId: 'file.ts',
        length: text.length,
        version: 1,
      },
    })
  })

  it('returns typed degraded syntax when a language cannot be resolved', async () => {
    let parseCount = 0
    const text = 'select 1;'
    const snapshot = createPieceTableSnapshot(text)
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parseCount += 1
        return createParseResult(payload)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const session = createTreeDocument({
      backend,
      documentId: 'query.sql',
      languageId: 'sql',
      languageResolver: {
        resolveTreeSitterLanguage: async () => null,
      },
      text: readAll(createDocumentTextSnapshot(snapshot)),
    })

    const result = await session.run()

    expect(parseCount).toBe(0)
    expect(result.degraded).toMatchObject({
      kind: 'language-unavailable',
    })
    expect(result.projection.snapshot).toEqual({
      documentId: 'query.sql',
      length: text.length,
      version: 0,
    })
    expect(result.projection.language).toMatchObject({
      languageId: 'sql',
      mode: 'full',
    })
  })

  it('preserves capture-returning behavior by default', async () => {
    const parsePayloads: TreeSitterBackendParsePayload[] = []
    const captures = [{ startIndex: 0, endIndex: 5, captureName: 'keyword.declaration' }]
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parsePayloads.push(payload)
        return { ...createParseResult(payload), captures }
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })

    const result = await session.run()

    expect(parsePayloads[0]?.includeCaptures).toBe(true)
    expect(result.captures).toEqual(captures)
    expect(tokenObjects(result.tokens)).toEqual(treeSitterCapturesToEditorTokens(captures))
  })

  it('keeps the completed tree queryable after a range query exhausts its budget', async () => {
    const tokens = [{ start: 0, end: 5, style: { color: '#123456' } }]
    let calls = 0
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => ({
        ...createParseAck(payload.snapshotVersion),
        analysis: { kind: 'full', coveredRange: { startIndex: 0, endIndex: 12 } },
      }),
      queryRange: async (payload) => {
        const result = createRangeResult(payload, tokens)
        if (++calls !== 2) return result
        return {
          ...result,
          tokens: [],
          analysis: {
            kind: 'cancelled',
            reason: 'budget',
            elapsedMs: 20_001,
            budgetMs: 20_000,
            coveredRange: { startIndex: 0, endIndex: 0 },
            timings: [{ name: 'treeSitter.highlights', durationMs: 20_001 }],
          },
        }
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const doc = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: 'const x = 1;',
    })
    await doc.run()
    const successful = await doc.runtime.queryRange({ startIndex: 0, endIndex: 12 })
    const cancelled = await doc.runtime.queryRange({ startIndex: 0, endIndex: 12 })
    expect(cancelled.projection.analysis).toMatchObject({
      kind: 'cancelled',
      reason: 'budget',
      elapsedMs: 20_001,
      timings: [{ name: 'treeSitter.highlights', durationMs: 20_001 }],
    })
    expect(doc.runtime.getResult()).toBe(successful)
    expect(doc.runtime.canQueryRange()).toBe(true)
    const retried = await doc.runtime.queryRange({ startIndex: 0, endIndex: 5 })
    expect(calls).toBe(3)
    expect(tokenObjects(retried.tokens)).toEqual(tokens)
    expect(doc.runtime.canQueryRange()).toBe(true)
  })

  it('uses parse acknowledgements and explicit range queries in range syntax mode', async () => {
    const parsePayloads: TreeSitterBackendParsePayload[] = []
    const rangePayloads: TreeSitterRangePayload[] = []
    const tokens = [{ start: 0, end: 5, style: { color: '#123456' } }]
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parsePayloads.push(payload)
        return createParseAck(payload.snapshotVersion)
      },
      queryRange: async (payload) => {
        rangePayloads.push(payload)
        return createRangeResult(payload, tokens)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })

    const refreshed = await session.run()
    const ranged = await session.runtime.queryRange({ startIndex: 0, endIndex: 6 })

    expect(parsePayloads[0]?.resultMode).toBe('parseOnly')
    expect(tokenObjects(refreshed.tokens)).toEqual([])
    expect(refreshed.projection).toMatchObject({
      language: { languageId: 'typescript', mode: 'range' },
      requestedRanges: [],
      snapshot: { documentId: 'file.ts', length: text.length, version: 1 },
    })
    expect(rangePayloads[0]?.range).toEqual({ startIndex: 0, endIndex: 6 })
    expect(ranged.projection.requestedRanges).toEqual([{ startIndex: 0, endIndex: 6 }])
    expect(ranged.projection.snapshot).toEqual({
      documentId: 'file.ts',
      length: text.length,
      version: 1,
    })
    expect(tokenObjects(ranged.tokens)).toEqual(tokens)
  })

  it('maps worker degraded states onto syntax results', async () => {
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => ({
        ...createParseAck(payload.snapshotVersion),
        degraded: [
          {
            kind: 'optional-phase-failed' as const,
            phase: 'collect highlights',
            message: 'query failed',
          },
        ],
      }),
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })

    const result = await session.run()

    expect(result.degraded).toEqual({
      kind: 'optional-phase-failed',
      phase: 'collect highlights',
      message: 'query failed',
    })
  })

  it('re-runs a complete degraded parse on unchanged text instead of reusing the degraded result', async () => {
    let parseCount = 0
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parseCount += 1
        if (parseCount === 1) {
          return {
            ...createParseAck(payload.snapshotVersion),
            degraded: [
              {
                kind: 'optional-phase-failed' as const,
                phase: 'collect highlights',
                message: 'transient failure',
              },
            ],
          }
        }
        return createParseAck(payload.snapshotVersion)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const session = createTreeDocument({
      backend,
      documentId: 'retry-degraded.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: 'const a = 1;',
    })

    const first = await session.run()
    expect(first.degraded?.kind).toBe('optional-phase-failed')
    expect(parseCount).toBe(1)

    const retried = await session.run()
    expect(parseCount).toBe(2)
    expect(retried.degraded).toBeNull()
  })

  it('keeps large editor-path syntax results range-only', async () => {
    const parsePayloads: TreeSitterBackendParsePayload[] = []
    const rangePayloads: TreeSitterRangePayload[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => {
        parsePayloads.push(payload)
        return createParseAck(payload.snapshotVersion)
      },
      queryRange: async (payload) => {
        rangePayloads.push(payload)
        return createRangeResult(payload, [])
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = Array.from(
      { length: 20_000 },
      (_value, index) => `export const value${index} = ${index};`,
    ).join('\n')
    const snapshot = createPieceTableSnapshot(text)
    const session = createTreeDocument({
      backend,
      documentId: 'large.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(snapshot)),
    })

    await session.run()
    await session.runtime.queryRange({ startIndex: 1_000, endIndex: 2_000 })

    expect(parsePayloads[0]?.resultMode).toBe('bootstrap')
    expect(rangePayloads).toMatchObject([
      {
        range: { startIndex: 1_000, endIndex: 2_000 },
      },
    ])
  })

  it('does not dispatch range queries until the parsed snapshot is current', async () => {
    const parseResult = createDeferred<TreeSitterParseAckResult>()
    const rangePayloads: TreeSitterRangePayload[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async () => parseResult.promise,
      queryRange: async (payload) => {
        rangePayloads.push(payload)
        return createRangeResult(payload, [{ start: 0, end: 5, style: { color: '#123456' } }])
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const snapshot = createPieceTableSnapshot(text)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(snapshot)),
    })

    const refresh = session.run()
    const pendingRange = await session.runtime.queryRange({ startIndex: 0, endIndex: 6 })

    expect(session.runtime.canQueryRange()).toBe(false)
    expect(tokenObjects(pendingRange.tokens)).toEqual([])
    expect(rangePayloads).toHaveLength(0)

    parseResult.resolve(createParseAck(1))
    await refresh
    const readyRange = await session.runtime.queryRange({ startIndex: 0, endIndex: 6 })

    expect(session.runtime.canQueryRange()).toBe(true)
    expect(rangePayloads).toHaveLength(1)
    expect(tokenObjects(readyRange.tokens)).toEqual([
      { start: 0, end: 5, style: { color: '#123456' } },
    ])
  })

  it('suppresses stale range query results', async () => {
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => createParseAck(payload.snapshotVersion),
      queryRange: async (payload) =>
        createRangeResult({ ...payload, snapshotVersion: payload.snapshotVersion - 1 }, [
          { start: 0, end: 5, style: { color: '#123456' } },
        ]),
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })

    await session.run()
    const result = await session.runtime.queryRange({ startIndex: 0, endIndex: 6 })

    expect(tokenObjects(result.tokens)).toEqual([])
  })

  it('keeps the newest range answer when an older one arrives after it', async () => {
    const replies: {
      readonly payload: TreeSitterRangePayload
      readonly result: Deferred<TreeSitterRangeResult>
    }[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: async (payload) => createParseAck(payload.snapshotVersion),
      queryRange: (payload) => {
        const result = createDeferred<TreeSitterRangeResult>()
        replies.push({ payload, result })
        return result.promise
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const text = 'const a = 1;'
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      syntaxMode: 'range',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text))),
    })
    const olderToken = { start: 0, end: 5, style: { color: '#111111' } }
    const newerToken = { start: 6, end: 7, style: { color: '#222222' } }

    await session.run()
    const older = session.runtime.queryRange({ startIndex: 0, endIndex: 6 })
    const newer = session.runtime.queryRange({ startIndex: 6, endIndex: 12 })
    await Promise.resolve()
    replies[1]!.result.resolve(createRangeResult(replies[1]!.payload, [newerToken]))
    await newer
    replies[0]!.result.resolve(createRangeResult(replies[0]!.payload, [olderToken]))

    // Each caller gets the range it asked for; the session keeps the one asked for last.
    expect(tokenObjects((await older).tokens)).toEqual([olderToken])
    expect(tokenObjects(session.runtime.getResult().tokens)).toEqual([newerToken])
  })

  it('suppresses stale parse results after a newer refresh starts', async () => {
    const parses: {
      readonly payload: TreeSitterBackendParsePayload
      readonly result: Deferred<TreeSitterParseResult>
    }[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => undefined,
      parse: (payload) => {
        const result = createDeferred<TreeSitterParseResult>()
        parses.push({ payload, result })
        return result.promise
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot('const a = 1;'))),
    })

    const firstRefresh = session.run()
    await Promise.resolve()
    const secondRefresh = session.run()
    await vi.waitFor(() => expect(parses).toHaveLength(2))

    const second = parses[1]!
    second.result.resolve({
      ...createParseResult(second.payload),
      tokens: [{ start: 6, end: 7, style: { color: '#00ff00' } }],
    })
    await secondRefresh

    const first = parses[0]!
    first.result.resolve({
      ...createParseResult(first.payload),
      tokens: [{ start: 6, end: 7, style: { color: '#ff0000' } }],
    })
    await firstRefresh

    expect(tokenObjects(session.runtime.getResult().tokens)).toEqual([
      { start: 6, end: 7, style: { color: '#00ff00' } },
    ])
  })

  it('reuses document change edits when they apply to the cached syntax snapshot', async () => {
    const backend = createCapturingTreeSitterBackend()
    const text = 'const a = 1;'
    const document = createDocumentSession(text)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })
    await session.run()

    const change = document.applyEdits([
      { from: text.length, text: '\nconst b = 2;', to: text.length },
    ])

    await session.edit(change.edits)

    expect(backend.latestEdit?.edits).toEqual([
      { from: text.length, text: '\nconst b = 2;', to: text.length },
    ])
  })

  it('resets admitted source after the canonical history bound is exceeded', async () => {
    const backend = createCapturingTreeSitterBackend()
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: 'abc',
    })
    try {
      await session.run()
      for (let index = 0; index < 129; index++) {
        const end = session.buffer.getTextSnapshot().length
        session.view.applyEdits([{ from: end, to: end, text: '!' }])
      }
      await session.run()
      expect(backend.latestEdit).toBeNull()
      expect(session.runtime.getSnapshotVersion()).toBe(2)
      expect(session.buffer.materializeFullText()).toBe('abc' + '!'.repeat(129))
    } finally {
      session.dispose()
    }
  })

  it('targets incremental edits at the parsed snapshot version', async () => {
    const { backend, edits } = createDeferredTreeSitterBackend()
    const initialText = 'const a = 1;'
    const document = createDocumentSession(initialText)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })

    await session.run()

    const firstChange = document.applyEdits([
      { from: initialText.length, text: '!', to: initialText.length },
    ])
    const firstPromise = session.edit(firstChange.edits)
    const secondChange = document.applyEdits([
      { from: firstChange.textSnapshot.length, text: '?', to: firstChange.textSnapshot.length },
    ])
    const secondPromise = session.edit(secondChange.edits)
    await vi.waitFor(() => expect(edits).toHaveLength(2))

    expect(edits.map(({ payload }) => payload.previousSnapshotVersion)).toEqual([1, 1])
    expect(edits.map(({ payload }) => payload.snapshotVersion)).toEqual([2, 3])
    expect(edits[1]?.payload.edits).toEqual([
      { from: initialText.length, text: '!?', to: initialText.length },
    ])

    const firstEdit = edits[0]!
    firstEdit.result.resolve(createParseResult(firstEdit.payload))
    await firstPromise
    const secondEdit = edits[1]!
    secondEdit.result.resolve(createParseResult(secondEdit.payload))
    await secondPromise

    const currentText = document.materializeFullText()
    const thirdChange = document.applyEdits([
      { from: currentText.length, text: ';', to: currentText.length },
    ])
    const thirdPromise = session.edit(thirdChange.edits)
    await vi.waitFor(() => expect(edits).toHaveLength(3))

    expect(edits[2]?.payload.previousSnapshotVersion).toBe(3)

    const thirdEdit = edits[2]!
    thirdEdit.result.resolve(createParseResult(thirdEdit.payload))
    await thirdPromise
  })

  it('refreshes instead of editing before the first parse succeeds', async () => {
    const parseVersions: number[] = []
    let editCount = 0
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: () => undefined,
      edit: async () => {
        editCount += 1
        throw new Error('unexpected edit before parse')
      },
      parse: async (payload) => {
        parseVersions.push(payload.snapshotVersion)
        return createParseResult(payload)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const initialText = 'const a = 1;'
    const document = createDocumentSession(initialText)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })

    const change = document.applyEdits([
      { from: initialText.length, text: '\nconst b = 2;', to: initialText.length },
    ])
    await session.edit(change.edits)

    expect(editCount).toBe(0)
    expect(parseVersions).toEqual([1])
    expect(session.runtime.getSnapshotVersion()).toBe(1)
  })

  it('falls back to a full refresh when incremental parsing fails', async () => {
    const parseVersions: number[] = []
    const disposedDocuments: string[] = []
    const disposedRuntimeSessionIds = new Set<string>()
    const parseRuntimeSessionIds: string[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: (runtimeSessionId) => {
        disposedDocuments.push(runtimeSessionId)
        disposedRuntimeSessionIds.add(runtimeSessionId)
      },
      edit: async () => {
        throw new Error('incremental parse failed')
      },
      parse: async (payload) => {
        parseRuntimeSessionIds.push(payload.runtimeSessionId)
        parseVersions.push(payload.snapshotVersion)
        if (disposedRuntimeSessionIds.has(payload.runtimeSessionId)) return undefined
        return createParseResult(payload)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const initialText = 'const a = 1;'
    const document = createDocumentSession(initialText)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })

    await session.run()
    const change = document.applyEdits([
      { from: initialText.length, text: '\nconst b = 2;', to: initialText.length },
    ])
    const result = await session.edit(change.edits)

    expect(parseVersions).toEqual([1, 3])
    expect(parseRuntimeSessionIds).toHaveLength(2)
    expect(parseRuntimeSessionIds[1]).not.toBe(parseRuntimeSessionIds[0])
    expect(disposedDocuments).toEqual([parseRuntimeSessionIds[0]])
    expect(parseRuntimeSessionIds).not.toContain('file.ts')
    expect(session.runtime.getSnapshotVersion()).toBe(3)
    expect(result.projection.snapshot.version).toBe(3)
    expect(session.runtime.getResult()).toBe(result)
  })

  it('ignores parse results that complete after syntax session disposal', async () => {
    const disposedDocuments: string[] = []
    const parse = createDeferred<TreeSitterParseResult>()
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId)
      },
      edit: async () => undefined,
      parse: () => parse.promise,
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const document = createDocumentSession('const a = 1;')
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })
    const initialResult = session.runtime.getResult()
    const refresh = session.run()

    session.dispose()
    parse.resolve(
      createParseResult({
        documentId: 'file.ts',
        languageId: 'typescript',
        snapshotVersion: 1,
      }),
    )
    await expect(refresh).resolves.toBe(initialResult)

    expect(disposedDocuments).toHaveLength(1)
    expect(disposedDocuments[0]).not.toBe('file.ts')
    expect(session.runtime.getResult()).toBe(initialResult)
  })

  it('falls back to a full refresh when current incremental parsing is cancelled', async () => {
    const parseVersions: number[] = []
    const disposedDocuments: string[] = []
    const parseRuntimeSessionIds: string[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId)
      },
      edit: async () => undefined,
      parse: async (payload) => {
        parseRuntimeSessionIds.push(payload.runtimeSessionId)
        parseVersions.push(payload.snapshotVersion)
        return createParseResult(payload)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const initialText = 'const a = 1;'
    const document = createDocumentSession(initialText)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })

    await session.run()
    const change = document.applyEdits([
      { from: initialText.length, text: '\nconst b = 2;', to: initialText.length },
    ])
    const result = await session.edit(change.edits)

    expect(parseVersions).toEqual([1, 3])
    expect(parseRuntimeSessionIds).toHaveLength(2)
    expect(parseRuntimeSessionIds[1]).not.toBe(parseRuntimeSessionIds[0])
    expect(disposedDocuments).toEqual([parseRuntimeSessionIds[0]])
    expect(parseRuntimeSessionIds).not.toContain('file.ts')
    expect(session.runtime.getSnapshotVersion()).toBe(3)
    expect(session.runtime.getResult()).toBe(result)
  })

  it('does not run stale incremental fallbacks after a newer edit starts', async () => {
    const parseVersions: number[] = []
    const disposedDocuments: string[] = []
    const edits: { payload: TreeSitterEditPayload; result: Deferred<TreeSitterParseResult> }[] = []
    const backend = {
      generation: 1,
      sourceEndpoint: createSourceEndpoint(),
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId)
      },
      edit: (payload: TreeSitterEditPayload) => {
        const result = createDeferred<TreeSitterParseResult>()
        edits.push({ payload, result })
        return result.promise
      },
      parse: async (payload) => {
        parseVersions.push(payload.snapshotVersion)
        return createParseResult(payload)
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend
    const initialText = 'const a = 1;'
    const document = createDocumentSession(initialText)
    const session = createTreeDocument({
      backend,
      documentId: 'file.ts',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(document.getSnapshot())),
    })

    await session.run()
    const firstChange = document.applyEdits([
      { from: initialText.length, text: '!', to: initialText.length },
    ])
    const firstPromise = session.edit(firstChange.edits)
    const secondChange = document.applyEdits([
      { from: firstChange.textSnapshot.length, text: '?', to: firstChange.textSnapshot.length },
    ])
    const secondPromise = session.edit(secondChange.edits)
    await vi.waitFor(() => expect(edits).toHaveLength(2))

    edits[0]?.result.reject(new Error('stale incremental parse failed'))
    await firstPromise
    const secondEdit = edits[1]!
    secondEdit.result.resolve(createParseResult(secondEdit.payload))
    await secondPromise

    expect(parseVersions).toEqual([1])
    expect(disposedDocuments).toEqual([])
    expect(session.runtime.getSnapshotVersion()).toBe(3)
  })
})

function tokenObjects(tokens: EditorTokenInput): readonly EditorToken[] {
  return toEditorTokenStore(tokens).toTokens()
}

function createCapturingTreeSitterBackend() {
  const backend = {
    generation: 1,
    sourceEndpoint: createSourceEndpoint(),
    latestEdit: null as TreeSitterEditPayload | null,
    disposeDocument: () => undefined,
    edit: async (payload: TreeSitterEditPayload) => {
      backend.latestEdit = payload
      return {
        brackets: [],
        captures: [],
        documentId: payload.documentId,
        errors: [],
        folds: [],
        injections: [],
        languageId: payload.languageId,
        snapshotVersion: payload.snapshotVersion,
        timings: [],
      }
    },
    parse: async (payload) => createParseResult(payload),
    registerLanguages: async () => undefined,
    select: async () => undefined,
  } satisfies TreeSitterBackend & { latestEdit: TreeSitterEditPayload | null }

  return backend
}

type Deferred<T> = {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createDeferredTreeSitterBackend() {
  const edits: { payload: TreeSitterEditPayload; result: Deferred<TreeSitterParseResult> }[] = []
  const backend = {
    generation: 1,
    sourceEndpoint: createSourceEndpoint(),
    disposeDocument: () => undefined,
    edit: (payload: TreeSitterEditPayload) => {
      const result = createDeferred<TreeSitterParseResult>()
      edits.push({ payload, result })
      return result.promise
    },
    parse: async (payload) => createParseResult(payload),
    registerLanguages: async () => undefined,
    select: async () => undefined,
  } satisfies TreeSitterBackend

  return { backend, edits }
}

function createParseResult(payload: {
  readonly documentId: string
  readonly languageId: string
  readonly snapshotVersion: number
}): TreeSitterParseResult {
  return {
    brackets: [],
    captures: [],
    documentId: payload.documentId,
    errors: [],
    folds: [],
    injections: [],
    languageId: payload.languageId,
    snapshotVersion: payload.snapshotVersion,
    timings: [],
  }
}

function createParseAck(
  snapshotVersion: number,
): Extract<TreeSitterParseAckResult, { readonly status: 'parsed' }> {
  return {
    changedRanges: [],
    documentId: 'file.ts',
    languageId: 'typescript',
    snapshotVersion,
    status: 'parsed',
    timings: [],
  }
}

function createRangeResult(
  payload: Pick<TreeSitterRangePayload, 'documentId' | 'languageId' | 'range' | 'snapshotVersion'>,
  tokens: TreeSitterRangeResult['tokens'],
): TreeSitterRangeResult {
  return {
    brackets: [],
    captures: [],
    documentId: payload.documentId,
    errors: [],
    folds: [],
    injections: [],
    languageId: payload.languageId,
    range: payload.range,
    snapshotVersion: payload.snapshotVersion,
    timings: [],
    tokens,
  }
}

function createTestLanguageRegistry(): TreeSitterLanguageRegistry {
  const registry = new TreeSitterLanguageRegistry()
  registry.registerLanguage(
    testLanguage('javascript', ['.js', '.cjs', '.jsx', '.mjs'], ['javascript', 'js', 'jsx']),
  )
  registry.registerLanguage(
    testLanguage('typescript', ['.ts', '.cts', '.mts', '.tsx'], ['typescript', 'ts', 'tsx']),
  )
  return registry
}

function createSqlSyntaxSession(host: EditorPluginHost) {
  return host.getSyntaxProvider()
}

function testLanguage(
  id: string,
  extensions: readonly string[],
  aliases: readonly string[] = [id],
): TreeSitterLanguageContribution {
  return {
    id,
    extensions,
    aliases,
    wasmUrl: `/${id}.wasm`,
    highlightQuerySource: '(identifier) @variable',
  }
}
