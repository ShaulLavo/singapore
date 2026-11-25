const HEADER_LIMIT_BYTES = 8192
const SEPARATOR_LENGTH = 4
const CARRIAGE_RETURN = 13
const LINE_FEED = 10
const INITIAL_CAPACITY = 4096
const PREVIEW_BYTES = 80

const encoder = new TextEncoder()

/** The bytes on the stream were not an LSP base-protocol frame, such as a server's stray log line. */
export class LspFramingError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'LspFramingError'
  }
}

/** One LSP base-protocol frame: a `Content-Length` header counting UTF-8 bytes, then the body. */
export const encodeLspFrame = (message: string): Uint8Array => {
  const body = encoder.encode(message)
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

/**
 * Turns a byte stream cut at arbitrary points back into messages. A body is decoded only once all
 * of it has arrived, so a chunk boundary inside a multibyte character never reaches the decoder.
 * Anything that is not a frame throws `LspFramingError`; the decoder is not usable afterwards.
 */
export class LspFrameDecoder {
  private buffer = new Uint8Array(INITIAL_CAPACITY)
  private start = 0
  private end = 0
  /** Bytes of the pending header already searched for its terminator. */
  private scanned = 0
  private bodyLength: number | null = null
  private readonly headerText = new TextDecoder()
  private readonly bodyText = new TextDecoder('utf-8', { fatal: true })

  /** `maxBodyBytes` bounds what one header can make the decoder hold. */
  public constructor(private readonly maxBodyBytes = Number.MAX_SAFE_INTEGER) {}

  public push(chunk: Uint8Array, emit: (message: string) => void): void {
    this.append(chunk)
    for (;;) {
      const message = this.next()
      if (message === null) return
      emit(message)
    }
  }

  private next(): string | null {
    this.bodyLength ??= this.readHeader()
    if (this.bodyLength === null) return null
    if (this.end - this.start < this.bodyLength) return null

    const body = this.buffer.subarray(this.start, this.start + this.bodyLength)
    this.start += this.bodyLength
    this.bodyLength = null
    return this.decodeBody(body)
  }

  private decodeBody(body: Uint8Array): string {
    try {
      return this.bodyText.decode(body)
    } catch {
      throw new LspFramingError('LSP message body is not valid UTF-8')
    }
  }

  private readHeader(): number | null {
    const terminator = this.findTerminator()
    const headerBytes = (terminator === -1 ? this.end : terminator) - this.start
    if (headerBytes > HEADER_LIMIT_BYTES) throw this.malformed('is too long')
    if (terminator === -1) {
      this.scanned = headerBytes
      return null
    }

    const length = contentLength(
      this.headerText.decode(this.buffer.subarray(this.start, terminator)),
    )
    if (length === null) throw this.malformed('needs exactly one decimal Content-Length')
    if (length > this.maxBodyBytes) {
      throw new LspFramingError(
        `LSP message of ${length} bytes exceeds the ${this.maxBodyBytes} byte limit`,
      )
    }

    this.start = terminator + SEPARATOR_LENGTH
    this.scanned = 0
    return length
  }

  private findTerminator(): number {
    const from = this.start + Math.max(0, this.scanned - (SEPARATOR_LENGTH - 1))
    const last = this.end - SEPARATOR_LENGTH
    for (let index = from; index <= last; index += 1) {
      if (this.isTerminatorAt(index)) return index
    }
    return -1
  }

  private isTerminatorAt(index: number): boolean {
    return (
      this.buffer[index] === CARRIAGE_RETURN &&
      this.buffer[index + 1] === LINE_FEED &&
      this.buffer[index + 2] === CARRIAGE_RETURN &&
      this.buffer[index + 3] === LINE_FEED
    )
  }

  private append(chunk: Uint8Array): void {
    const pending = this.end - this.start
    if (this.end + chunk.length > this.buffer.length) this.makeRoom(pending, chunk.length)
    this.buffer.set(chunk, this.end)
    this.end += chunk.length
  }

  /** Moves pending bytes to the front, growing only when they and the chunk still do not fit. */
  private makeRoom(pending: number, incoming: number): void {
    const needed = pending + incoming
    const target =
      needed > this.buffer.length
        ? new Uint8Array(Math.max(needed, this.buffer.length * 2))
        : this.buffer
    target.set(this.buffer.subarray(this.start, this.end))
    this.buffer = target
    this.start = 0
    this.end = pending
  }

  private malformed(problem: string): LspFramingError {
    const preview = this.buffer.subarray(this.start, Math.min(this.end, this.start + PREVIEW_BYTES))
    const sent = JSON.stringify(this.headerText.decode(preview))
    return new LspFramingError(`LSP message header ${problem}; the stream sent ${sent}`)
  }
}

/** The one `Content-Length` of a header block, or null when it has none, several or a bad one. */
function contentLength(header: string): number | null {
  let length: number | null = null
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) return null
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue

    const value = line.slice(colon + 1).trim()
    if (length !== null || !/^\d+$/.test(value)) return null
    length = Number(value)
  }
  return Number.isSafeInteger(length) ? length : null
}
