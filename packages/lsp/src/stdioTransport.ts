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
   * limit is exceeded. A throw is kept and reported as the reason for the loss, unless something
   * earlier already was. So is a rejection, but only one that has settled by the time `exited`
   * reports the loss; a later one is observed and dropped.
   */
  stop(): void | Promise<void>
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
   * The process ended and nothing of it is left running. Always call it, also after `close()`:
   * it settles `transport.gone`, which a connection waits for before starting a replacement.
   * Unless `close()` came first it also reports the loss, with the failure that led to it or
   * else `reason`.
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
 * `stopping` is a process told to stop that has not ended yet: messages for it are dropped, and
 * what it still writes is delivered unless its output is what failed. `closed` is final.
 */
type StdioState = 'open' | 'stopping' | 'closed'

class StdioLspTransport implements LspManagedTransport {
  public readonly stdin: ReadableStream<Uint8Array>
  public readonly gone: Promise<void>

  /** Each handler with the order it registered in, so a message reaches only those before it. */
  private readonly handlers = new Map<LspTransportHandler, number>()
  private nextRegistration = 0
  private readonly closeHandlers = new Set<(error?: unknown) => void>()
  /** Null once the output is no longer read: it broke the protocol, or the transport closed. */
  private decoder: LspFrameDecoder | null
  private stdinController!: ReadableStreamDefaultController<Uint8Array>
  private state: StdioState = 'open'
  /** Why the server was told to stop, or what went wrong telling it. Outranks its exit reason. */
  private failure: unknown = undefined
  private resolveGone!: () => void
  private sentCount = 0
  private receivedCount = 0

  public constructor(private readonly options: LspStdioOptions) {
    this.decoder = new LspFrameDecoder(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
    this.gone = new Promise((resolve) => {
      this.resolveGone = resolve
    })
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
    if (this.handlers.has(handler)) return
    this.handlers.set(handler, ++this.nextRegistration)
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
    if (running) this.requestStop()
  }

  public receive(bytes: Uint8Array): void {
    if (!this.decoder) return

    try {
      this.decoder.push(bytes, this.deliver)
    } catch (error) {
      this.decoder = null
      this.stopServer(error)
    }
  }

  public exited(reason?: unknown): void {
    this.resolveGone()
    if (this.state === 'closed') return

    const error =
      this.failure ?? this.truncation(reason) ?? reason ?? this.closedError('server exited')
    const handlers = Array.from(this.closeHandlers)
    this.finish()
    for (const handler of handlers) handler(error)
  }

  /** A subscriber throws on a message it cannot parse, which is the server breaking the protocol. */
  private readonly deliver = (message: string): void => {
    if (!this.decoder) return

    // A handler that subscribes or resubscribes while this message is out waits for the next one.
    const cutoff = this.nextRegistration
    this.receivedCount += 1
    for (const [handler, registration] of this.handlers) {
      if (registration <= cutoff) handler(message)
    }
  }

  /** The one way a running server is told to go. */
  private stopServer(failure?: unknown): void {
    this.failure ??= failure
    if (this.state !== 'open') return

    this.state = 'stopping'
    this.endStdin()
    this.requestStop()
  }

  private requestStop(): void {
    try {
      Promise.resolve(this.options.stop()).catch(this.stopFailed)
    } catch (error) {
      this.stopFailed(error)
    }
  }

  private readonly stopFailed = (error: unknown): void => {
    this.failure ??= error
  }

  /**
   * Output still being read that ends partway through a message broke the protocol. That holds
   * after a stdin hangup too, which is how an exiting process usually first shows.
   */
  private truncation(reason: unknown): unknown {
    try {
      this.decoder?.finish(reason)
      return undefined
    } catch (error) {
      return error
    }
  }

  private finish(): void {
    const wasOpen = this.state === 'open'
    this.state = 'closed'
    this.decoder = null
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
