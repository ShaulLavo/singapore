import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EditorPlugin, EditorPluginContext } from '@singapore-editor/core/extensions'
import {
  createTreeSitterLanguagePlugin,
  createTreeSitterSyntaxPlugin,
  createTreeSitterSyntaxProvider,
  createTreeSitterWorkerOwner,
} from '../src/index.ts'
import type { TreeSitterLanguageDescriptor } from '../src/treeSitter/registry.ts'
import type { TreeSitterWorkerRequest } from '../src/treeSitter/types.ts'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient.ts'

// A worker that acknowledges every request, so registration traffic is observable.
class EchoWorker {
  static readonly requests: TreeSitterWorkerRequest[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage(request: TreeSitterWorkerRequest): void {
    EchoWorker.requests.push(request)
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true } } as MessageEvent))
  }

  terminate(): void {}
}

// A worker whose parser runtime never finishes loading; everything else is acknowledged.
class SlowRuntimeWorker {
  static readonly requests: TreeSitterWorkerRequest[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage(request: TreeSitterWorkerRequest): void {
    SlowRuntimeWorker.requests.push(request)
    if (request.payload.type === 'init') return
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true } } as MessageEvent))
  }

  terminate(): void {}
}

const DEFAULT_PROVIDER = Symbol.for('@singapore-editor/tree-sitter/default-provider')

const descriptor = (wasmUrl: string): TreeSitterLanguageDescriptor => ({
  id: 'fixture',
  extensions: ['.fx'],
  aliases: [],
  wasmUrl,
  highlightQuerySource: '(identifier) @variable',
})

const registrations = () =>
  EchoWorker.requests.filter((request) => request.payload.type === 'registerLanguages')

describe('tree-sitter worker client language registration', () => {
  afterEach(() => {
    EchoWorker.requests.length = 0
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('registers a descriptor once and never serialises its wasm', async () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()
    const wasmUrl = `data:application/wasm;base64,${'A'.repeat(64 * 1024)}`
    const language = descriptor(wasmUrl)
    const stringify = vi.spyOn(JSON, 'stringify')

    await client.registerLanguages([language])
    await client.registerLanguages([language])
    await client.registerLanguages([language, language])

    expect(registrations()).toHaveLength(1)
    const serialisedWasm = stringify.mock.results.filter(
      (result) => typeof result.value === 'string' && result.value.includes(wasmUrl),
    )
    expect(serialisedWasm).toHaveLength(0)
  })

  it('re-registers an equal id whose grammar or queries changed', async () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()

    await client.registerLanguages([descriptor('data:one')])
    await client.registerLanguages([descriptor('data:one')])
    await client.registerLanguages([descriptor('data:two')])
    await client.registerLanguages([{ ...descriptor('data:two'), highlightQuerySource: '' }])

    expect(registrations()).toHaveLength(3)
  })
})

describe('tree-sitter worker start', () => {
  afterEach(() => {
    EchoWorker.requests.length = 0
    SlowRuntimeWorker.requests.length = 0
    vi.unstubAllGlobals()
    delete (globalThis as Record<PropertyKey, unknown>)[DEFAULT_PROVIDER]
  })

  const requestTypes = (worker: { requests: TreeSitterWorkerRequest[] }) =>
    worker.requests.map((request) => request.payload.type)

  const activate = (plugin: EditorPlugin) =>
    plugin.activate({
      registerSyntaxProvider: () => ({ dispose: () => undefined }),
      registerSelectionRangeProvider: () => ({ dispose: () => undefined }),
    } as unknown as EditorPluginContext)

  it('starts the worker and its parser runtime without a document', () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()

    client.start()
    client.start()

    expect(requestTypes(EchoWorker)).toEqual(['init'])
    expect(client.inspect().lifecycle).toBe('initializing')
  })

  it('starts when a language plugin is activated, before any document is set', () => {
    vi.stubGlobal('Worker', EchoWorker)

    activate(createTreeSitterLanguagePlugin([descriptor('data:one')]))

    expect(requestTypes(EchoWorker)).toEqual(['init'])
  })

  it('starts the worker of a provider the host configured', () => {
    let workers = 0
    const owner = createTreeSitterWorkerOwner({
      workerFactory: () => {
        workers += 1
        return new EchoWorker() as unknown as Worker
      },
    })

    activate(createTreeSitterSyntaxPlugin(createTreeSitterSyntaxProvider({ workerOwner: owner })))

    expect(workers).toBe(1)
    expect(requestTypes(EchoWorker)).toEqual(['init'])
  })

  it('registers a language while the parser runtime is still loading', async () => {
    vi.stubGlobal('Worker', SlowRuntimeWorker)
    const client = new TreeSitterWorkerClient()
    client.start()

    // The runtime load never answers here; the registration is posted behind it regardless, so
    // the worker can download the grammar alongside the runtime.
    await client.registerLanguages([descriptor('data:one')])

    expect(requestTypes(SlowRuntimeWorker)).toEqual(['init', 'registerLanguages'])
    expect(client.inspect().lifecycle).toBe('initializing')
  })
})

describe('tree-sitter worker client warm-up', () => {
  afterEach(() => {
    EchoWorker.requests.length = 0
    vi.unstubAllGlobals()
  })

  const warms = () =>
    EchoWorker.requests.flatMap((request) =>
      request.payload.type === 'warmLanguages' ? [request.payload.languageIds] : [],
    )

  it('starts the worker with nothing to compile', async () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()

    await client.warmLanguages([])

    expect(EchoWorker.requests.map((request) => request.payload.type)).toEqual(['init'])
  })

  it('registers before compiling and compiles each language once', async () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()
    const fixture = descriptor('data:one')
    const other = { ...descriptor('data:other'), id: 'other' }

    await client.warmLanguages([fixture])
    await client.warmLanguages([fixture, other])
    await client.warmLanguages([other])

    expect(EchoWorker.requests.map((request) => request.payload.type)).toEqual([
      'init',
      'registerLanguages',
      'warmLanguages',
      'registerLanguages',
      'warmLanguages',
    ])
    expect(warms()).toEqual([['fixture'], ['other']])
  })

  it('compiles a language again after its registration changes', async () => {
    vi.stubGlobal('Worker', EchoWorker)
    const client = new TreeSitterWorkerClient()

    await client.warmLanguages([descriptor('data:one')])
    await client.registerLanguages([descriptor('data:two')])
    await client.warmLanguages([descriptor('data:two')])

    expect(warms()).toEqual([['fixture'], ['fixture']])
  })
})
