import { LspFrameDecoder, encodeLspFrame } from './framing'
import { LspTransportClosedError, type LspManagedTransport } from './transports'
import type { LspTransportHandler } from './types'

const MEBIBYTE = 1024 * 1024
const DEFAULT_MAX_MESSAGE_BYTES = 64 * MEBIBYTE
const DEFAULT_MAX_PENDING_STDIN_BYTES = 32 * MEBIBYTE

export type LspStdioOptions = {
  /**
   * Stops the server process. Called at most once, and only while the process may still be
   * running: on `close()`, when the server breaks the protocol or closes its stdin, and when a
   * limit is exceeded.
   */
  stop(): void
  /** Largest message accepted from the server. Defaults to 64 MiB. */
  readonly maxMessageBytes?: number
  /** Most bytes allowed to wait for the server to read its stdin. Defaults to 32 MiB. */
  readonly maxPendingStdinBytes?: number
}

/** The page's end of a language server process that speaks LSP on its standard streams. */
export type LspStdio = {
  readonly transport: LspManagedTransport
  /** Framed messages for the server's stdin. */
  readonly stdin: ReadableStream<Uint8Array>
  /** Takes bytes the server wrote to stdout, in order. Never throws. */
  stdout(bytes: Uint8Array): void
  /**
   * The process ended and nothing of it is left running. Unless `close()` came first, this is what
   * reports the loss, with the protocol failure that led to it or else `reason`.
   */
  exited(reason?: unknown): void
}

/**
 * LSP over a server process's standard streams, for a host that holds the process: hand its stdout
 * to `stdout`, pipe `stdin` into it, and call `exited` when it is gone. A server that failed or
 * exited is reported lost only then, so its replacement does not start while it is still stopping.
 */
export const createStdioLspTransport = (options: LspStdioOptions): LspStdio => {
  const transport = new StdioLspTransport(options)
  return {
    transport,
    stdin: transport.stdin,
    stdout: (bytes) => transport.receive(bytes),
    exited: (reason) => transport.exited(reason),
  }
}

/**
 * `stopping` is a process told to stop that has not ended yet: its output is ignored and messages
 * for it are dropped, and `failure` is why. `closed` is final.
 */
type StdioState = 'open' | 'stopping' | 'closed'

class StdioLspTransport implements LspManagedTransport {
  public readonly stdin: ReadableStream<Uint8Array>

  private readonly handlers = new Set<LspTransportHandler>()
  private readonly closeHandlers = new Set<(error?: unknown) => void>()
  private readonly decoder: LspFrameDecoder
  private stdinController!: ReadableStreamDefaultController<Uint8Array>
  private state: StdioState = 'open'
  private failure: unknown = undefined
  private sentCount = 0
  private receivedCount = 0

  public constructor(private readonly options: LspStdioOptions) {
    this.decoder = new LspFrameDecoder(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
    this.stdin = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.stdinController = controller
        },
        // Usually the first sign of an exit, whose own reason then says more than this would.
        cancel: () => this.stopServer(),
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: options.maxPendingStdinBytes ?? DEFAULT_MAX_PENDING_STDIN_BYTES,
      }),
    )
  }

  public send(message: string): void {
    if (this.state === 'closed') throw this.closedError('stdio transport closed')
    if (this.state === 'stopping') return

    const frame = encodeLspFrame(message)
    // Room left is negative once the server has stopped reading and the queue passed its limit.
    if (frame.length > (this.stdinController.desiredSize ?? 0)) {
      this.stopServer(this.closedError('server stopped reading its stdin'))
      return
    }
    this.stdinController.enqueue(frame)
    this.sentCount += 1
  }

  public isClosed(): boolean {
    return this.state !== 'open'
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler)
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler)
  }

  public onDidClose(handler: (error?: unknown) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  public close(): void {
    if (this.state === 'closed') return

    const running = this.state === 'open'
    this.finish()
    if (running) this.options.stop()
  }

  public receive(bytes: Uint8Array): void {
    if (this.state !== 'open') return

    try {
      this.decoder.push(bytes, this.deliver)
    } catch (error) {
      this.stopServer(error)
    }
  }

  public exited(reason?: unknown): void {
    if (this.state === 'closed') return

    const error = this.failure ?? reason ?? this.closedError('server exited')
    const handlers = Array.from(this.closeHandlers)
    this.finish()
    for (const handler of handlers) handler(error)
  }

  /** A subscriber throws on a message it cannot parse, which is the server breaking the protocol. */
  private readonly deliver = (message: string): void => {
    if (this.state !== 'open') return

    this.receivedCount += 1
    for (const handler of this.handlers) handler(message)
  }

  /** The one way a running server is told to go; `failure` outranks whatever its exit reports. */
  private stopServer(failure?: unknown): void {
    if (this.state !== 'open') return

    this.state = 'stopping'
    this.failure = failure
    this.endStdin()
    this.options.stop()
  }

  private finish(): void {
    const wasOpen = this.state === 'open'
    this.state = 'closed'
    this.handlers.clear()
    this.closeHandlers.clear()
    if (wasOpen) this.endStdin()
  }

  /** Ends the stream after what is queued; a stream the server already cancelled needs nothing. */
  private endStdin(): void {
    try {
      this.stdinController.close()
    } catch {
      // Cancelled by the reader, which is the same end.
    }
  }

  private closedError(reason: string): LspTransportClosedError {
    return new LspTransportClosedError({
      code: null,
      reason,
      wasClean: null,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
    })
  }
}
