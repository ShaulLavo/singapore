import {
  LspFrameDecoder,
  createStdioLspTransport,
  encodeLspFrame,
  type LspManagedTransport,
  type LspStdioOptions,
} from '../src/index.ts'

export type JsonRpcMessage = {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
}

type ServerProcessOptions = Omit<LspStdioOptions, 'stop'> & {
  /** False leaves stdin unread, the way a hung server does. */
  readonly readsStdin?: boolean
}

/** A language server process as its host sees it: it reads stdin, writes stdout, and exits. */
export class ServerProcess {
  public readonly transport: LspManagedTransport
  public readonly received: JsonRpcMessage[] = []
  public readonly stdinText: string[] = []
  public stops = 0
  public stdinEnded = false
  public onMessage: (message: JsonRpcMessage) => void = () => undefined

  private readonly stdio
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new LspFrameDecoder()

  public constructor(options: ServerProcessOptions = {}) {
    this.stdio = createStdioLspTransport({
      ...options,
      stop: () => {
        this.stops += 1
      },
    })
    this.transport = this.stdio.transport
    this.reader = this.stdio.stdin.getReader()
    if (options.readsStdin !== false) void this.readStdin()
  }

  public write(bytes: Uint8Array): void {
    this.stdio.stdout(bytes)
  }

  public send(message: unknown): void {
    this.write(encodeLspFrame(JSON.stringify(message)))
  }

  public reply(request: JsonRpcMessage, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: request.id, result })
  }

  public exit(reason?: unknown): void {
    this.stdio.exited(reason)
  }

  public closeStdin(): Promise<void> {
    return this.reader.cancel()
  }

  public methods(): readonly (string | undefined)[] {
    return this.received.map((message) => message.method)
  }

  private async readStdin(): Promise<void> {
    const text = new TextDecoder()
    for (;;) {
      const { done, value } = await this.reader.read()
      if (done) break
      this.stdinText.push(text.decode(value))
      this.decoder.push(value, (message) => this.accept(JSON.parse(message) as JsonRpcMessage))
    }
    this.stdinEnded = true
  }

  private accept(message: JsonRpcMessage): void {
    this.received.push(message)
    this.onMessage(message)
  }
}

/** Answers `initialize`, the way every server must before it sees anything else. */
export function initializingServer(): ServerProcess {
  const server = new ServerProcess()
  server.onMessage = (message) => {
    if (message.method === 'initialize') server.reply(message, { capabilities: {} })
  }
  return server
}
