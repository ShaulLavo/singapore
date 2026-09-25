import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  LspClient,
  LspWorkspace,
  type LspManagedTransport,
  type LspNotificationHandler,
  type LspWebSocketTransportOptions,
  type LspWorkerLike,
} from '@singapore-editor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type { LanguageServerStatus } from './types'

const DIAGNOSTIC_REFRESH_METHOD = 'workspace/diagnostic/refresh'
/** A connection that stayed up this long ended a crash streak; its next loss starts a new one. */
const STABLE_CONNECTION_MS = 60_000

export type LspReconnectOptions = {
  /** One delay per attempt; when they run out the connection gives up and reports unavailable. */
  readonly delaysMs: readonly number[]
}

export type LspConnectionTransportFactory = () => LspManagedTransport | Promise<LspManagedTransport>

export type LspConnectionOptions = {
  readonly rootUri: lsp.DocumentUri | null
  readonly initializationOptions: unknown
  readonly timeoutMs: number
  /**
   * Merged over `defaultClientCapabilities()` by the client itself, so a host declares only what it
   * adds. This is how a host turns on a feature the defaults deliberately leave off —
   * `textDocument.semanticTokens` among them, which no server sends without being asked.
   */
  readonly capabilities?: lsp.ClientCapabilities
  /**
   * Load-bearing rather than cosmetic: at least one real server branches on the client name and
   * withholds a request from clients it does not recognise. The value is the host's to pick.
   */
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  /**
   * Merged around the connection's own handlers rather than replacing them. See createClient.
   */
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>
  /** Reconnects a transport that closed or failed on its own. Absent, the first loss is final. */
  readonly reconnect?: LspReconnectOptions
  createTransport(): LspManagedTransport | Promise<LspManagedTransport>
}

export type LspConnectionCallbacks = {
  /** Also called again after a reconnect: the client re-initialized and re-opened its documents. */
  onConnected(): void
  onDiagnosticRefresh?(): void
  /** The transport is gone and another is on its way; what the server said so far is stale. */
  onReconnecting?(error: unknown): void
  onUnavailable(): void
  onPublishDiagnostics(params: unknown): void
  onStatusChange?: (status: LanguageServerStatus) => void
  onError?: (error: unknown) => void
}

/** A connection a view borrows. `release` ends its interest; closing is the provider's call. */
export type LspConnectionLease = {
  readonly connection: LspConnection
  release(): void
}

/**
 * Supplies connections that outlive one view, so a file switch does not pay a handshake and an
 * `initialize` round trip. `options` is the connection the plugin would have built: build from it on
 * a new key, ignore it on a known one.
 *
 * **`callbacks.onConnected` must never fire synchronously from `acquire`** — the caller is
 * mid-construction. Replay it on a microtask.
 */
export type LspConnectionProvider = {
  acquire(options: LspConnectionOptions, callbacks: LspConnectionCallbacks): LspConnectionLease
}

export class LspConnection {
  public readonly workspace = new LspWorkspace()
  public readonly client: LspClient

  private transport: LspManagedTransport | null = null
  private removeTransportCloseListener: (() => void) | null = null
  private disposed = false
  private status: LanguageServerStatus = 'idle'
  private reconnectAttempts = 0
  private readyAt: number | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  public constructor(
    private readonly options: LspConnectionOptions,
    private readonly callbacks: LspConnectionCallbacks,
  ) {
    this.client = this.createClient()
  }

  public connect(): void {
    this.setStatus('loading')
    this.connectTransport()
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus('idle')
  }

  private createClient(): LspClient {
    const hostHandlers = this.options.notificationHandlers
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: this.options.initializationOptions,
      capabilities: this.options.capabilities,
      clientInfo: this.options.clientInfo,
      // Host handlers are merged *around* the connection's own rather than replacing them: the
      // whole diagnostics feature hangs off publishDiagnostics, so a host that happens to want that
      // notification too must not be able to take it away. Its handler runs after ours.
      notificationHandlers: {
        ...hostHandlers,
        [DIAGNOSTIC_REFRESH_METHOD]: (client, params, message) => {
          this.callbacks.onDiagnosticRefresh?.()
          hostHandlers?.[DIAGNOSTIC_REFRESH_METHOD]?.(client, params, message)
          return true
        },
        'textDocument/publishDiagnostics': (client, params, message) => {
          this.callbacks.onPublishDiagnostics(params)
          hostHandlers?.['textDocument/publishDiagnostics']?.(client, params, message)
          return true
        },
      },
      serverRequestHandlers: {
        [DIAGNOSTIC_REFRESH_METHOD]: () => {
          this.callbacks.onDiagnosticRefresh?.()
          return null
        },
      },
    })
  }

  private connectTransport(): void {
    try {
      const transport = this.options.createTransport()
      if (isTransportPromise(transport)) {
        void transport
          .then((value) => this.connectManagedTransport(value))
          .catch((error) => {
            this.handleConnectError(error)
          })
        return
      }

      this.connectManagedTransport(transport)
    } catch (error) {
      this.handleConnectError(error)
    }
  }

  private connectManagedTransport(transport: LspManagedTransport): void {
    if (this.disposed) {
      transport.close()
      return
    }

    this.transport = transport
    this.removeTransportCloseListener = transport.onDidClose((error) =>
      this.handleTransportClose(error),
    )
    void this.client
      .connect(transport)
      .then(() => this.handleConnected())
      .catch((error: unknown) => this.handleConnectError(error))
  }

  private handleConnected(): void {
    if (this.disposed) return

    this.readyAt = now()
    this.setStatus('ready')
    this.callbacks.onConnected()
  }

  private handleConnectError(error: unknown): void {
    if (this.disposed) return

    this.detachTransport()
    this.giveUpOrReconnect(error)
  }

  private handleTransportClose(error?: unknown): void {
    if (this.disposed) return

    this.detachTransport()
    this.giveUpOrReconnect(error ?? new Error('LSP transport closed'))
  }

  private detachTransport(): void {
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
  }

  private giveUpOrReconnect(error: unknown): void {
    if (this.scheduleReconnect(error)) return

    this.setStatus('error')
    this.callbacks.onUnavailable()
    this.handleError(error)
  }

  private scheduleReconnect(error: unknown): boolean {
    if (this.readyAt !== null && now() - this.readyAt >= STABLE_CONNECTION_MS) {
      this.reconnectAttempts = 0
    }
    this.readyAt = null
    const delay = this.options.reconnect?.delaysMs[this.reconnectAttempts]
    if (delay === undefined) return false

    this.reconnectAttempts += 1
    this.setStatus('loading')
    this.callbacks.onReconnecting?.(error)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.disposed) this.connectTransport()
    }, delay)
    return true
  }

  private setStatus(status: LanguageServerStatus): void {
    if (this.status === status) return

    this.status = status
    this.callbacks.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}

export function createWebSocketLspTransportFactory(
  route: string | URL,
  options?: LspWebSocketTransportOptions,
): LspConnectionTransportFactory {
  return () =>
    createWebSocketLspTransport(route, {
      protocols: options?.protocols,
      WebSocketCtor: options?.WebSocketCtor,
    })
}

export function createWorkerLspTransportFactory(
  workerFactory: () => LspWorkerLike,
): LspConnectionTransportFactory {
  return () =>
    createWorkerLspTransport(workerFactory(), {
      messageFormat: 'json',
      terminateOnClose: true,
    })
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function isTransportPromise(
  value: LspManagedTransport | Promise<LspManagedTransport>,
): value is Promise<LspManagedTransport> {
  return typeof (value as Promise<LspManagedTransport>).then === 'function'
}
