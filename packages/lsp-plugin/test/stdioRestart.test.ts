import {
  LspFrameDecoder,
  LspServerExitedError,
  arrayLspLineStarts,
  createStdioLspTransport,
  encodeLspFrame,
  type LspManagedTransport,
} from '@singapore-editor/lsp'
import { describe, expect, it, vi } from 'vitest'

import { LspConnection } from '../src/lspConnection'

type Message = { readonly id?: number; readonly method?: string; readonly params?: unknown }

/** One run of a stdio language server process, as its host drives the transport. */
class ServerProcess {
  public readonly transport: LspManagedTransport
  public readonly received: Message[] = []
  public stdinEnded = false
  public stops = 0
  private readonly stdio = createStdioLspTransport({
    stop: () => {
      this.stops += 1
    },
  })

  /** A server that does not answer never finishes `initialize`. */
  public constructor(private readonly answers = true) {
    this.transport = this.stdio.transport
    void this.serve(this.stdio.stdin.getReader())
  }

  public exit(reason: unknown): void {
    this.stdio.exited(reason)
  }

  public opened(): readonly unknown[] {
    return this.received
      .filter((message) => message.method === 'textDocument/didOpen')
      .map((message) => message.params)
  }

  private async serve(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new LspFrameDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      decoder.push(value, (text) => this.accept(JSON.parse(text) as Message))
    }
    this.stdinEnded = true
  }

  private accept(message: Message): void {
    this.received.push(message)
    if (message.method !== 'initialize' || !this.answers) return

    const result = { capabilities: { textDocumentSync: { openClose: true, change: 2 } } }
    this.stdio.stdout(encodeLspFrame(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })))
  }
}

function harness(delaysMs: readonly number[], silentRuns = 0) {
  const processes: ServerProcess[] = []
  const losses: unknown[] = []
  const statuses: string[] = []
  let unavailable = 0
  const connection = new LspConnection(
    {
      rootUri: 'file:///project',
      initializationOptions: undefined,
      timeoutMs: 5000,
      reconnect: { delaysMs },
      createTransport: () => {
        const process = new ServerProcess(processes.length >= silentRuns)
        processes.push(process)
        return process.transport
      },
    },
    {
      onConnected: () => undefined,
      onPublishDiagnostics: () => undefined,
      onReconnecting: (error) => losses.push(error),
      onStatusChange: (status) => statuses.push(status),
      onUnavailable: () => {
        unavailable += 1
      },
    },
  )
  return { connection, processes, losses, statuses, unavailable: () => unavailable }
}

const TEXT = 'const answer: number = 42\n'

/** Connects and opens one document on the first process, the state a restart has to rebuild. */
async function connectedHarness(delaysMs: readonly number[]) {
  const h = harness(delaysMs)
  h.connection.connect()
  await until(() => h.statuses.at(-1) === 'ready')
  h.connection.workspace.openDocumentSnapshot({
    uri: 'file:///project/src/answer.ts',
    languageId: 'typescript',
    lineStarts: arrayLspLineStarts([0, TEXT.length]),
    sourceRevision: 0,
    sourceSegment: {},
    textSnapshot: {
      length: TEXT.length,
      readRange: (start, end) => TEXT.slice(start, end),
      forEachTextChunk: (visit) => visit(TEXT, 0, TEXT.length),
    },
  })
  await until(() => h.processes[0]!.opened().length === 1)
  return h
}

async function until(condition: () => boolean): Promise<void> {
  await vi.waitUntil(condition, { interval: 1, timeout: 5000 })
}

describe('a language server process behind a stdio transport', () => {
  it('is started again after it exits, with open documents sent to the new process', async () => {
    const h = await connectedHarness([0])
    const exited = new LspServerExitedError({ outcome: 'exited', exitCode: 134 })

    h.processes[0]!.exit(exited)
    await until(() => h.processes[1]?.opened().length === 1)

    expect(h.losses).toEqual([exited])
    expect(h.processes[0]!.stops).toBe(0)
    expect(h.processes[1]!.opened()).toEqual([
      {
        textDocument: {
          uri: 'file:///project/src/answer.ts',
          languageId: 'typescript',
          version: 0,
          text: TEXT,
        },
      },
    ])
    expect(h.statuses).toEqual(['loading', 'ready', 'loading', 'ready'])
    h.connection.dispose()
  })

  it('reports the server unavailable once its restarts run out', async () => {
    const h = await connectedHarness([0])

    h.processes[0]!.exit(new Error('first exit'))
    await until(() => h.processes[1]?.opened().length === 1)
    h.processes[1]!.exit(new Error('second exit'))
    await until(() => h.unavailable() === 1)

    expect(h.processes).toHaveLength(2)
    expect(h.statuses.at(-1)).toBe('error')
    h.connection.dispose()
  })

  it('waits for a server that never initialized to be gone before starting its replacement', async () => {
    vi.useFakeTimers()
    try {
      const h = harness([0], 1)
      h.connection.connect()

      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.processes[0]!.stops).toBe(1)
      expect(h.processes).toHaveLength(1)

      h.processes[0]!.exit(new Error('killed'))
      await until(() => h.statuses.at(-1) === 'ready')

      expect(h.processes).toHaveLength(2)
      expect(h.processes[1]!.stops).toBe(0)
      h.connection.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts one replacement, however often connect is called while the old server is going', async () => {
    vi.useFakeTimers()
    try {
      const h = harness([0], 1)
      h.connection.connect()
      await vi.advanceTimersByTimeAsync(6000)

      h.connection.connect()
      h.connection.connect()
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.processes).toHaveLength(1)

      h.processes[0]!.exit(new Error('killed'))
      await until(() => h.statuses.at(-1) === 'ready')
      await vi.advanceTimersByTimeAsync(1000)

      expect(h.processes).toHaveLength(2)
      h.connection.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second server when connect is called on a live connection', async () => {
    const h = await connectedHarness([0])

    h.connection.connect()
    await Promise.resolve()

    expect(h.processes).toHaveLength(1)
    expect(h.statuses.at(-1)).toBe('ready')
    h.connection.dispose()
  })

  it('ends stdin and stops the process once when the connection is disposed', async () => {
    const h = await connectedHarness([0])

    h.connection.dispose()
    await until(() => h.processes[0]!.stdinEnded)
    h.processes[0]!.exit(new Error('killed'))

    expect(h.processes).toHaveLength(1)
    expect(h.processes[0]!.stops).toBe(1)
    expect(h.losses).toEqual([])
  })
})
