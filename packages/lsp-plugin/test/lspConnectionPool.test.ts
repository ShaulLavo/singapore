import {
  LspServerExitedError,
  createStdioLspTransport,
  type LspManagedTransport,
  type LspStdio,
  type LspTransportHandler,
  type LspWebSocketLike,
  type LspWorkerLike,
} from '@singapore-editor/lsp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LanguageServerStatus,
  LspConnectionCallbacks,
  LspConnectionLease,
  LspConnectionOptions,
  LspConnectionPoolEvent,
} from '../src/index.ts'
import {
  LspConnection,
  LspConnectionPool,
  createWebSocketLspTransportFactory,
  createWorkerLspTransportFactory,
} from '../src/index.ts'

/** The socket the pool is supposed to stop rebuilding. */
class FakeTransport implements LspManagedTransport {
  public static readonly created: FakeTransport[] = []
  public readonly sent: string[] = []
  public closed = false
  private readonly handlers = new Set<LspTransportHandler>()
  private readonly closeHandlers = new Set<() => void>()

  public constructor() {
    FakeTransport.created.push(this)
  }

  public send(message: string): void {
    this.sent.push(message)
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler)
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler)
  }

  public onDidClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  public close(): void {
    this.closed = true
    this.handlers.clear()
  }

  public receive(message: unknown): void {
    for (const handler of this.handlers) handler(JSON.stringify(message))
  }

  public fail(): void {
    for (const handler of this.closeHandlers) handler()
    this.closeHandlers.clear()
  }

  public methods(): readonly unknown[] {
    return this.sent.map((message) => (JSON.parse(message) as { method?: unknown }).method)
  }
}

/** A transport whose server keeps running after `close()` until the host confirms it is gone. */
class StoppingTransport extends FakeTransport {
  public readonly gone: Promise<void>
  public confirmGone!: () => void
  public failGone!: (error: unknown) => void

  public constructor() {
    super()
    this.gone = new Promise((resolve, reject) => {
      this.confirmGone = resolve
      this.failGone = reject
    })
  }
}

/** A socket whose handshake never finishes, and which reports nothing when it is closed. */
class ConnectingSocket implements LspWebSocketLike {
  public static readonly created: ConnectingSocket[] = []
  public readyState = 0

  public constructor() {
    ConnectingSocket.created.push(this)
  }

  public send(): void {}

  public close(): void {
    this.readyState = 3
  }

  public addEventListener(): void {}

  public removeEventListener(): void {}
}

/** A server process behind a stdio transport, recorded in `servers` when started. */
function stdioOptions(
  servers: LspStdio[],
  stop: () => void = () => undefined,
): LspConnectionOptions {
  return connectionOptions({
    timeoutMs: 600_000,
    createTransport: () => {
      const server = createStdioLspTransport({ stop })
      servers.push(server)
      return server.transport
    },
  })
}

function worker(terminate: () => void): LspWorkerLike {
  return {
    addEventListener: () => undefined,
    postMessage: () => undefined,
    removeEventListener: () => undefined,
    terminate,
  }
}

function stoppingOptions(overrides: Partial<LspConnectionOptions> = {}): LspConnectionOptions {
  return connectionOptions({ createTransport: () => new StoppingTransport(), ...overrides })
}

function connectionOptions(overrides: Partial<LspConnectionOptions> = {}): LspConnectionOptions {
  return {
    capabilities: {},
    createTransport: () => new FakeTransport(),
    initializationOptions: undefined,
    notificationHandlers: { 'custom/refresh': () => true },
    rootUri: 'file:///w',
    timeoutMs: 5_000,
    ...overrides,
  }
}

function callbacks() {
  return {
    onConnected: vi.fn<() => void>(),
    onDiagnosticRefresh: vi.fn<() => void>(),
    onPublishDiagnostics: vi.fn<(params: unknown) => void>(),
    onStatusChange: vi.fn<(status: LanguageServerStatus) => void>(),
    onUnavailable: vi.fn<() => void>(),
    onError: vi.fn<(error: unknown) => void>(),
  } satisfies LspConnectionCallbacks
}

/** Answers the handshake the pool starts the moment a key is first acquired. */
function completeHandshake(transport: FakeTransport): void {
  const request = JSON.parse(transport.sent[0] ?? '{}') as { id?: unknown }
  transport.receive({
    id: request.id,
    jsonrpc: '2.0',
    result: { capabilities: { textDocumentSync: { change: 2, openClose: true } } },
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const KEY = 'w\u0000typescript'

let pool: LspConnectionPool
let events: LspConnectionPoolEvent[]

beforeEach(() => {
  events = []
  pool = new LspConnectionPool({ onEvent: (event) => events.push(event) })
})

afterEach(() => {
  pool.dispose()
  FakeTransport.created.length = 0
  vi.useRealTimers()
})

describe('LspConnectionPool', () => {
  it('opens one connection for repeated acquires of the same root and server', () => {
    const provider = pool.provider(KEY)

    const first = provider.acquire(connectionOptions(), callbacks())
    const second = provider.acquire(connectionOptions(), callbacks())

    // The measured defect was thirteen of these in twenty-two seconds.
    expect(FakeTransport.created).toHaveLength(1)
    expect(first.connection).toBe(second.connection)
  })

  it('reuses a key only when immutable initialize options and capabilities are deep-equal', () => {
    const provider = pool.provider(KEY)
    const first = provider.acquire(
      connectionOptions({
        capabilities: { workspace: { diagnostics: { refreshSupport: true } } },
        initializationOptions: { preferences: { quote: 'single', semicolons: false } },
      }),
      callbacks(),
    )
    const second = provider.acquire(
      connectionOptions({
        capabilities: { workspace: { diagnostics: { refreshSupport: true } } },
        initializationOptions: { preferences: { semicolons: false, quote: 'single' } },
        timeoutMs: 30_000,
      }),
      callbacks(),
    )

    expect(first.connection).toBe(second.connection)
    expect(FakeTransport.created).toHaveLength(1)
  })

  it('rejects a later borrower whose pooled initialization contract differs', () => {
    const provider = pool.provider(KEY)
    provider.acquire(
      connectionOptions({ capabilities: { workspace: { diagnostics: { refreshSupport: true } } } }),
      callbacks(),
    )

    expect(() =>
      provider.acquire(
        connectionOptions({
          capabilities: { workspace: { diagnostics: { refreshSupport: false } } },
        }),
        callbacks(),
      ),
    ).toThrow('different initialization contract')
    expect(FakeTransport.created).toHaveLength(1)
  })

  it('opens a separate connection per server on one root', () => {
    pool.provider(KEY).acquire(connectionOptions(), callbacks())
    pool.provider('w\u0000python').acquire(connectionOptions(), callbacks())

    expect(FakeTransport.created).toHaveLength(2)
  })

  it('keeps the connection alive across the gap between two views', () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const lease = provider.acquire(connectionOptions(), callbacks())

    // A file switch disposes the old contribution before building the next, so
    // the lease count touches zero in between. Closing on that would be the bug.
    lease.release()
    vi.advanceTimersByTime(1_000)
    provider.acquire(connectionOptions(), callbacks())
    vi.advanceTimersByTime(120_000)

    expect(FakeTransport.created).toHaveLength(1)
    expect(FakeTransport.created[0]?.closed).toBe(false)
  })

  it('retires a dead ready connection so a later borrower gets a live one', async () => {
    const provider = pool.provider(KEY)
    const firstCallbacks = callbacks()
    provider.acquire(connectionOptions(), firstCallbacks)
    const first = FakeTransport.created[0]
    if (!first) throw new Error('missing transport')
    completeHandshake(first)
    await flush()

    first.fail()
    const replacement = provider.acquire(connectionOptions(), callbacks())

    expect(firstCallbacks.onUnavailable).toHaveBeenCalledTimes(1)
    expect(FakeTransport.created).toHaveLength(2)
    expect(replacement.connection).not.toBeUndefined()
    expect(events.some((event) => event.kind === 'retired')).toBe(true)
  })

  it('closes a connection nothing has borrowed once the grace period passes', () => {
    vi.useFakeTimers()
    const lease = pool.provider(KEY).acquire(connectionOptions(), callbacks())

    lease.release()
    vi.advanceTimersByTime(60_000)

    expect(FakeTransport.created[0]?.closed).toBe(true)
  })

  it('waits for the server of an evicted connection to be gone before starting one for the same key', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    provider.acquire(stoppingOptions(), callbacks()).release()
    vi.advanceTimersByTime(60_000)
    const evicted = FakeTransport.created[0] as StoppingTransport
    expect(evicted.closed).toBe(true)

    const lease = provider.acquire(stoppingOptions(), callbacks())
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeTransport.created).toHaveLength(1)

    evicted.confirmGone()
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeTransport.created).toHaveLength(2)
    lease.release()
  })

  it('waits for a server that failed to initialize to be gone before starting one for the same key', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const gaveUp = callbacks()
    provider.acquire(stoppingOptions(), gaveUp)
    await vi.advanceTimersByTimeAsync(5_000)
    const silent = FakeTransport.created[0] as StoppingTransport
    expect(gaveUp.onUnavailable).toHaveBeenCalledTimes(1)
    expect(silent.closed).toBe(true)

    provider.acquire(stoppingOptions(), callbacks())
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeTransport.created).toHaveLength(1)

    silent.confirmGone()
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeTransport.created).toHaveLength(2)
  })

  it('waits for a server whose factory had not returned when its connection closed', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    let starts = 0
    let attach!: (transport: LspManagedTransport) => void
    const options = connectionOptions({
      createTransport: () => {
        starts += 1
        if (starts > 1) return new StoppingTransport()
        return new Promise<LspManagedTransport>((resolve) => {
          attach = resolve
        })
      },
    })
    provider.acquire(options, callbacks()).release()
    vi.advanceTimersByTime(60_000)

    provider.acquire(options, callbacks())
    await vi.advanceTimersByTimeAsync(1000)
    expect(starts).toBe(1)

    const late = new StoppingTransport()
    attach(late)
    await vi.advanceTimersByTimeAsync(1000)
    expect(late.closed).toBe(true)
    expect(starts).toBe(1)

    late.confirmGone()
    await vi.advanceTimersByTimeAsync(0)

    expect(starts).toBe(2)
  })

  it('holds back a replacement that the old server asks for while it is being stopped', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const servers: LspStdio[] = []
    let replacement: LspConnectionLease | null = null
    const options: LspConnectionOptions = connectionOptions({
      timeoutMs: 600_000,
      createTransport: () => {
        const server = createStdioLspTransport({
          stop: () => {
            replacement ??= provider.acquire(options, callbacks())
          },
        })
        servers.push(server)
        return server.transport
      },
    })
    provider.acquire(options, callbacks()).release()
    vi.advanceTimersByTime(60_000)
    expect(replacement).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1000)
    expect(servers).toHaveLength(1)

    servers[0]!.exited()
    await vi.advanceTimersByTimeAsync(0)

    expect(servers).toHaveLength(2)
  })

  it('holds back a key that another key asks for while the pool is being disposed', async () => {
    vi.useFakeTimers()
    const first: LspStdio[] = []
    const second: LspStdio[] = []
    const secondOptions = stdioOptions(second)
    let asked = false
    const askForSecond = (): void => {
      if (asked) return
      asked = true
      pool.provider('second').acquire(secondOptions, callbacks())
    }
    pool.provider('first').acquire(stdioOptions(first, askForSecond), callbacks())
    pool.provider('second').acquire(secondOptions, callbacks())

    pool.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(asked).toBe(true)
    expect(second).toHaveLength(1)

    second[0]!.exited()
    await vi.advanceTimersByTimeAsync(0)

    expect(second).toHaveLength(2)
  })

  it('holds back a replacement that a factory asks for before it returns', async () => {
    vi.useFakeTimers()
    const servers: LspStdio[] = []
    let asked = false
    const options: LspConnectionOptions = connectionOptions({
      timeoutMs: 600_000,
      createTransport: async () => {
        const server = createStdioLspTransport({ stop: () => undefined })
        servers.push(server)
        if (!asked) {
          asked = true
          pool.dispose()
          pool.provider(KEY).acquire(options, callbacks())
        }
        return server.transport
      },
    })
    pool.provider(KEY).acquire(options, callbacks())
    await vi.advanceTimersByTimeAsync(1000)
    expect(asked).toBe(true)
    expect(servers).toHaveLength(1)

    servers[0]!.exited()
    await vi.advanceTimersByTimeAsync(0)

    expect(servers).toHaveLength(2)
  })

  it('cancels an unfinished WebSocket handshake and replaces it without waiting for it', async () => {
    ConnectingSocket.created.length = 0
    const provider = pool.provider(KEY)
    const options = connectionOptions({
      createTransport: createWebSocketLspTransportFactory('ws://lsp.test', {
        WebSocketCtor: ConnectingSocket,
      }),
    })
    provider.acquire(options, callbacks())
    pool.dispose()
    provider.acquire(options, callbacks())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ConnectingSocket.created).toHaveLength(2)
    expect(ConnectingSocket.created[0]!.readyState).toBe(3)
  })

  it('closes every connection of a disposed pool when one worker fails to stop', () => {
    const terminated: string[] = []
    const failing = callbacks()
    const stopFailure = new Error('worker would not stop')
    const failingWorker = worker(() => {
      throw stopFailure
    })
    pool.provider('first').acquire(
      connectionOptions({
        createTransport: createWorkerLspTransportFactory(() => failingWorker),
      }),
      failing,
    )
    pool.provider('second').acquire(
      connectionOptions({
        createTransport: createWorkerLspTransportFactory(() =>
          worker(() => terminated.push('second')),
        ),
      }),
      callbacks(),
    )

    pool.dispose()

    expect(terminated).toEqual(['second'])
    expect(failing.onError).toHaveBeenCalledWith(stopFailure)
  })

  it('finishes disposing the pool when an error reporter throws', async () => {
    const terminated: string[] = []
    const reporterFailure = new Error('reporter failed')
    const failingWorker = worker(() => {
      throw new Error('worker would not stop')
    })
    pool.provider('first').acquire(
      connectionOptions({ createTransport: createWorkerLspTransportFactory(() => failingWorker) }),
      {
        ...callbacks(),
        onError: () => {
          throw reporterFailure
        },
      },
    )
    const secondOptions = connectionOptions({
      createTransport: createWorkerLspTransportFactory(() =>
        worker(() => terminated.push('second')),
      ),
    })
    pool.provider('second').acquire(secondOptions, callbacks())

    expect(() => pool.dispose()).toThrow(reporterFailure)
    expect(terminated).toEqual(['second'])

    let restarted = 0
    pool.provider('second').acquire(
      connectionOptions({
        createTransport: () => {
          restarted += 1
          return new FakeTransport()
        },
      }),
      callbacks(),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(restarted).toBe(1)
  })

  it('gives a borrower that retries on a failed connection a new one', async () => {
    let starts = 0
    let retry: LspConnectionLease | null = null
    const provider = pool.provider(KEY)
    const options = connectionOptions({
      createTransport: () => {
        starts += 1
        return new FakeTransport()
      },
    })
    const failed = provider.acquire(options, {
      ...callbacks(),
      onStatusChange: (status) => {
        if (status === 'error') retry ??= provider.acquire(options, callbacks())
      },
    })

    FakeTransport.created[0]!.fail()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(retry).not.toBeNull()
    expect(retry!.connection).not.toBe(failed.connection)
    expect(starts).toBe(2)
  })

  it('keeps waiting for an old server after a connection that was waiting for it closes', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    provider.acquire(stoppingOptions(), callbacks()).release()
    vi.advanceTimersByTime(60_000)
    provider.acquire(stoppingOptions(), callbacks()).release()
    vi.advanceTimersByTime(60_000)

    provider.acquire(stoppingOptions(), callbacks())
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeTransport.created).toHaveLength(1)

    ;(FakeTransport.created[0] as StoppingTransport).confirmGone()
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeTransport.created).toHaveLength(2)
  })

  it('starts a key at once when no server of it is still going', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    provider.acquire(stoppingOptions(), callbacks()).release()
    vi.advanceTimersByTime(60_000)
    ;(FakeTransport.created[0] as StoppingTransport).confirmGone()
    await vi.advanceTimersByTimeAsync(0)

    provider.acquire(stoppingOptions(), callbacks())

    expect(FakeTransport.created).toHaveLength(2)
  })

  it('does not leave a rejection unhandled when the server of a closed transport fails to go', async () => {
    vi.useFakeTimers()
    const connection = new LspConnection(
      stoppingOptions({ reconnect: { delaysMs: [100] } }),
      callbacks(),
    )
    connection.connect()
    const first = FakeTransport.created[0] as StoppingTransport
    completeHandshake(first)
    await vi.advanceTimersByTimeAsync(0)

    first.fail()
    first.failGone(new Error('teardown failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeTransport.created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)

    expect(FakeTransport.created).toHaveLength(2)
    connection.dispose()
  })

  it('tells a view that joined a live connection it is already connected', async () => {
    const provider = pool.provider(KEY)
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    const late = callbacks()
    provider.acquire(connectionOptions(), late)
    // Never synchronously: the borrower is mid-construction and the semantic
    // token layer this callback feeds does not exist yet.
    expect(late.onConnected).not.toHaveBeenCalled()
    await flush()

    expect(late.onConnected).toHaveBeenCalledTimes(1)
    expect(late.onStatusChange).toHaveBeenCalledWith('ready')
  })

  it('delivers diagnostics to every borrower', async () => {
    const provider = pool.provider(KEY)
    const first = callbacks()
    const second = callbacks()
    provider.acquire(connectionOptions(), first)
    provider.acquire(connectionOptions(), second)
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    transport.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { diagnostics: [], uri: 'file:///w/a.ts' },
    })

    expect(first.onPublishDiagnostics).toHaveBeenCalledTimes(1)
    expect(second.onPublishDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('delivers diagnostic refresh requests to every borrower and acknowledges the server', async () => {
    const provider = pool.provider(KEY)
    const first = callbacks()
    const second = callbacks()
    provider.acquire(connectionOptions(), first)
    provider.acquire(connectionOptions(), second)
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    transport.receive({
      jsonrpc: '2.0',
      id: 'refresh',
      method: 'workspace/diagnostic/refresh',
      params: null,
    })
    await flush()

    expect(first.onDiagnosticRefresh).toHaveBeenCalledTimes(1)
    expect(second.onDiagnosticRefresh).toHaveBeenCalledTimes(1)
    expect(JSON.parse(transport.sent.at(-1) ?? '{}')).toMatchObject({ id: 'refresh', result: null })
  })

  it('delivers pooled diagnostic refresh notifications to every borrower', async () => {
    const provider = pool.provider(KEY)
    const first = callbacks()
    const second = callbacks()
    provider.acquire(connectionOptions(), first)
    provider.acquire(connectionOptions(), second)
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()
    const sentBefore = transport.sent.length

    transport.receive({
      jsonrpc: '2.0',
      method: 'workspace/diagnostic/refresh',
    })

    expect(first.onDiagnosticRefresh).toHaveBeenCalledTimes(1)
    expect(second.onDiagnosticRefresh).toHaveBeenCalledTimes(1)
    expect(transport.sent).toHaveLength(sentBefore)
  })

  it('stops delivering to a borrower that released', async () => {
    const provider = pool.provider(KEY)
    const gone = callbacks()
    const lease: LspConnectionLease = provider.acquire(connectionOptions(), gone)
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()
    lease.release()

    transport.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { diagnostics: [], uri: 'file:///w/a.ts' },
    })

    expect(gone.onPublishDiagnostics).not.toHaveBeenCalled()
  })

  it('routes a notification to the handler of every borrower, not just the first', async () => {
    const provider = pool.provider(KEY)
    const firstHandler = vi.fn(() => true)
    const secondHandler = vi.fn(() => true)
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/refresh': firstHandler } }),
      callbacks(),
    )
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/refresh': secondHandler } }),
      callbacks(),
    )
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    transport.receive({ jsonrpc: '2.0', method: 'custom/refresh', params: {} })

    // The controller a refresh is for belongs to whichever surface is showing the
    // file, which is never reliably the one that happened to connect first.
    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler).toHaveBeenCalledTimes(1)
  })

  it('reports the lifecycle a host needs to log', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const first = provider.acquire(connectionOptions(), callbacks())
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await vi.advanceTimersByTimeAsync(0)
    first.release()
    vi.advanceTimersByTime(60_000)

    expect(events.map((event) => event.kind)).toEqual(['created', 'reused', 'ready', 'released'])
    // `closed` is absent on purpose: one borrower is still holding it.
    expect(events.at(-1)?.leaseCount).toBe(1)
    expect(events.find((event) => event.kind === 'ready')?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a close only once nothing holds the connection', () => {
    vi.useFakeTimers()
    const lease = pool.provider(KEY).acquire(connectionOptions(), callbacks())

    lease.release()
    vi.advanceTimersByTime(60_000)

    const closed = events.find((event) => event.kind === 'closed')
    expect(closed?.key).toBe(KEY)
    expect(closed?.reachedReady).toBe(false)
  })

  it('names a notification a later borrower declared that this connection cannot dispatch', () => {
    const provider = pool.provider(KEY)
    provider.acquire(connectionOptions({ notificationHandlers: {} }), callbacks())
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/late': () => true } }),
      callbacks(),
    )

    // Silently dropping it is how a refresh notification stops arriving and
    // nothing anywhere says so.
    expect(events.find((event) => event.kind === 'handler_ignored')?.methods).toEqual([
      'custom/late',
    ])
  })

  it('answers a server request through the first borrower that handles it', async () => {
    const provider = pool.provider(KEY)
    const first = provider.acquire(
      connectionOptions({ serverRequestHandlers: { 'custom/files': () => ({ from: 'first' }) } }),
      callbacks(),
    )
    provider.acquire(
      connectionOptions({ serverRequestHandlers: { 'custom/files': () => ({ from: 'second' }) } }),
      callbacks(),
    )
    const transport = FakeTransport.created[0] as FakeTransport
    completeHandshake(transport)
    await flush()

    transport.receive({ jsonrpc: '2.0', id: 'server-1', method: 'custom/files' })
    await flush()
    first.release()
    transport.receive({ jsonrpc: '2.0', id: 'server-2', method: 'custom/files' })
    await flush()

    expect(responses(transport)).toEqual([
      { jsonrpc: '2.0', id: 'server-1', result: { from: 'first' } },
      { jsonrpc: '2.0', id: 'server-2', result: { from: 'second' } },
    ])
  })

  it('reports the close after a server says why it exited as that exit', async () => {
    const lease = callbacks()
    pool.provider(KEY).acquire(connectionOptions(), lease)
    const transport = FakeTransport.created[0] as FakeTransport
    completeHandshake(transport)
    await flush()

    transport.receive({
      jsonrpc: '2.0',
      method: '$/serverExited',
      params: { outcome: 'exited', exitCode: 1, error: { message: 'The server stopped.' } },
    })
    transport.fail()

    const error = lease.onError.mock.calls.at(-1)?.[0]
    expect(error).toBeInstanceOf(LspServerExitedError)
    expect(error).toMatchObject({ message: 'The server stopped.', params: { exitCode: 1 } })
    expect(lease.onStatusChange).toHaveBeenCalledWith('error')
  })

  // Driven without the pool, which retires a failed connection before a second report could land.
  it('reports a transport that closes before initialize is answered once', async () => {
    const lease = callbacks()
    const connection = new LspConnection(connectionOptions(), lease)
    connection.connect()
    const transport = FakeTransport.created[0] as FakeTransport

    transport.receive({ jsonrpc: '2.0', method: '$/serverExited', params: { outcome: 'crashed' } })
    transport.fail()
    await flush()
    await flush()

    expect(lease.onError).toHaveBeenCalledTimes(1)
    expect(lease.onError.mock.calls[0]?.[0]).toBeInstanceOf(LspServerExitedError)
    connection.dispose()
  })

  it('does not blame a later close on an exit the server kept talking after', async () => {
    const lease = callbacks()
    pool.provider(KEY).acquire(connectionOptions(), lease)
    const transport = FakeTransport.created[0] as FakeTransport
    completeHandshake(transport)
    await flush()

    transport.receive({ jsonrpc: '2.0', method: '$/serverExited', params: { outcome: 'exited' } })
    transport.receive({ jsonrpc: '2.0', method: 'custom/refresh', params: {} })
    transport.fail()

    expect(lease.onError).toHaveBeenCalledTimes(1)
    expect(lease.onError.mock.calls[0]?.[0]).not.toBeInstanceOf(LspServerExitedError)
  })
})

function responses(transport: FakeTransport): readonly unknown[] {
  return transport.sent
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => typeof message.id === 'string' && !('method' in message))
}
