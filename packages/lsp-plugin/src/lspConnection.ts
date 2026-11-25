import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  LSP_SERVER_EXITED,
  LspClient,
  LspServerExitedError,
  LspWorkspace,
  type LspServerExitedParams,
  type LspManagedTransport,
  type LspNotificationHandler,
  type LspServerRequestHandler,
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
  /** Answers the server's requests; the connection's own `workspace/diagnostic/refresh` stays its. */
  readonly serverRequestHandlers?: Readonly<Record<string, LspServerRequestHandler<LspClient>>>
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
  /** Settles when the server behind the attached transport is gone; null when it has none. */
  private transportGone: Promise<void> | null = null
  /** The same for the last closed transport, kept until it settles: the next start waits for it. */
  private retiring: Promise<void> | null = null
  /** A start is under way: waiting on `retiring`, or in the factory, until a transport attaches. */
  private starting = false
  /** Why the server said it is going, reported as the reason for the close that follows. */
  private exit: LspServerExitedParams | null = null

  public constructor(
    private readonly options: LspConnectionOptions,
    private readonly callbacks: LspConnectionCallbacks,
  ) {
    this.client = this.createClient()
  }

  /** Starts the connection. A no-op while it is connected or already on its way to being. */
  public connect(): void {
    if (this.transport || this.starting) return

    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.setStatus('loading')
    this.connectTransport()
  }

  /**
   * Pending while the server behind this connection's last closed transport is still going, null
   * otherwise. It never rejects. Whoever starts another server for the same work waits for it.
   */
  public get retirement(): Promise<void> | null {
    return this.retiring
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.client.disconnect()
    this.closeTransport()
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
        [LSP_SERVER_EXITED]: (client, params, message) => {
          this.exit = serverExitedParams(params)
          hostHandlers?.[LSP_SERVER_EXITED]?.(client, params, message)
          return true
        },
        'textDocument/publishDiagnostics': (client, params, message) => {
          this.callbacks.onPublishDiagnostics(params)
          hostHandlers?.['textDocument/publishDiagnostics']?.(client, params, message)
          return true
        },
      },
      serverRequestHandlers: {
        ...this.options.serverRequestHandlers,
        [DIAGNOSTIC_REFRESH_METHOD]: () => {
          this.callbacks.onDiagnosticRefresh?.()
          return null
        },
      },
    })
  }

  /** The one gate every start goes through: one at a time, and never beside a server still going. */
  private connectTransport(): void {
    if (this.transport || this.starting) return

    this.starting = true
    const retiring = this.retiring
    if (retiring) {
      void retiring.then(this.startTransport)
      return
    }
    this.startTransport()
  }

  private readonly startTransport = (): void => {
    if (this.disposed) return

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
    this.starting = false
    // Observed from the first moment, so a server that fails to go never rejects unheard.
    const gone = settled(transport.gone)
    if (this.disposed) {
      transport.close()
      return
    }

    this.transport = transport
    this.transportGone = gone
    this.exit = null
    this.removeTransportCloseListener = transport.onDidClose((error) =>
      this.handleTransportClose(error),
    )
    transport.subscribe(this.forgetExitOnLaterMessage)
    // Only while this transport is still the connection's: a close that already detached it made
    // the report, and the initialize it rejected on the way out must not make a second one.
    void this.client
      .connect(transport)
      .then(() => {
        if (this.transport === transport) this.handleConnected()
      })
      .catch((error: unknown) => {
        if (this.transport === transport) this.handleConnectError(error)
      })
  }

  /** A server that says anything after announcing its exit did not exit; a later close is its own. */
  private readonly forgetExitOnLaterMessage = (message: string): void => {
    if (this.exit && !message.includes(LSP_SERVER_EXITED)) this.exit = null
  }

  private handleConnected(): void {
    if (this.disposed) return

    this.readyAt = now()
    this.setStatus('ready')
    this.callbacks.onConnected()
  }

  private handleConnectError(error: unknown): void {
    this.starting = false
    if (this.disposed) return

    this.detachTransport()
    this.giveUpOrReconnect(error)
  }

  private handleTransportClose(error?: unknown): void {
    if (this.disposed) return

    const exit = this.exit
    this.exit = null
    this.detachTransport()
    if (exit) {
      this.giveUpOrReconnect(new LspServerExitedError(exit))
      return
    }
    this.giveUpOrReconnect(error ?? new Error('LSP transport closed'))
  }

  private detachTransport(): void {
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.transport?.unsubscribe(this.forgetExitOnLaterMessage)
    this.client.disconnect()
    this.closeTransport()
  }

  /** Closes the transport and keeps its server's going as what the next start waits for. */
  private closeTransport(): void {
    this.transport?.close()
    this.transport = null
    const gone = this.transportGone
    this.transportGone = null
    if (!gone) return

    this.retiring = gone
    void gone.then(() => {
      if (this.retiring === gone) this.retiring = null
    })
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
    // @justification A reconnect backoff, not rendering work: the handle is kept, cleared on dispose,
    // and a disposed connection ignores it.
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

/** `gone` as a signal only: a server that failed to go is still not one to wait on any longer. */
function settled(gone: Promise<void> | undefined): Promise<void> | null {
  return gone ? gone.then(ignore, ignore) : null
}

const ignore = (): void => undefined

function isTransportPromise(
  value: LspManagedTransport | Promise<LspManagedTransport>,
): value is Promise<LspManagedTransport> {
  return typeof (value as Promise<LspManagedTransport>).then === 'function'
}

function serverExitedParams(params: unknown): LspServerExitedParams | null {
  if (typeof params !== 'object' || params === null) return null
  const outcome = (params as { outcome?: unknown }).outcome
  return typeof outcome === 'string' ? (params as LspServerExitedParams) : null
}
