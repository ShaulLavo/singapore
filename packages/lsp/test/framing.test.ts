import { describe, expect, it } from 'vitest'

import { LspFrameDecoder, LspFramingError, encodeLspFrame } from '../src/index.ts'

const encoder = new TextEncoder()

function decodeChunks(chunks: readonly Uint8Array[]): string[] {
  const decoder = new LspFrameDecoder()
  const messages: string[] = []
  for (const chunk of chunks) decoder.push(chunk, (message) => messages.push(message))
  return messages
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

function cutAt(bytes: Uint8Array, sizes: () => number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length;) {
    const size = Math.max(1, sizes())
    chunks.push(bytes.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

/** Deterministic, so a failing cut can be replayed. */
function seededSizes(seed: number, maximum: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state % maximum) + 1
  }
}

describe('LSP frame encoding', () => {
  it('counts the body in UTF-8 bytes, not characters', () => {
    const frame = new TextDecoder().decode(encodeLspFrame('{"text":"é😀"}'))

    expect(frame).toBe('Content-Length: 17\r\n\r\n{"text":"é😀"}')
  })
})

describe('LSP frame decoding', () => {
  it('reassembles a frame delivered one byte at a time', () => {
    const frame = encodeLspFrame('{"jsonrpc":"2.0","id":1,"result":null}')

    expect(decodeChunks(cutAt(frame, () => 1))).toEqual(['{"jsonrpc":"2.0","id":1,"result":null}'])
  })

  it('emits every message held in one chunk, in order', () => {
    const chunk = concatBytes([
      encodeLspFrame('{"id":1}'),
      encodeLspFrame('{"id":2}'),
      encodeLspFrame('{"id":3}'),
    ])

    expect(decodeChunks([chunk])).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  it('keeps a multibyte character whole when a chunk boundary falls inside it', () => {
    const message = '{"hover":"日本語 é 😀"}'
    const frame = encodeLspFrame(message)
    const insideEmoji = frame.length - 4

    expect(decodeChunks([frame.slice(0, insideEmoji), frame.slice(insideEmoji)])).toEqual([message])
  })

  it('reads the length case-insensitively and ignores other headers', () => {
    const frame = encoder.encode(
      'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}',
    )

    expect(decodeChunks([frame])).toEqual(['{}'])
  })

  it('carries the tail of one chunk into the next message', () => {
    const first = encodeLspFrame('{"id":1}')
    const second = encodeLspFrame('{"id":2}')
    const joined = concatBytes([first, second])
    const insideSecondHeader = first.length + 7

    expect(
      decodeChunks([joined.slice(0, insideSecondHeader), joined.slice(insideSecondHeader)]),
    ).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('handles a body far larger than a chunk, then keeps decoding', () => {
    const large = JSON.stringify({
      items: Array.from({ length: 20_000 }, (_, index) => `é${index}`),
    })
    const stream = concatBytes([
      encodeLspFrame(large),
      encodeLspFrame('{"id":2}'),
      encodeLspFrame(large),
    ])

    expect(decodeChunks(cutAt(stream, () => 1000))).toEqual([large, '{"id":2}', large])
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('survives arbitrary cut points (seed %i)', (seed) => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({ id: index, text: 'π😀'.repeat(index % 7), pad: 'x'.repeat(index * 13) }),
    )
    const stream = concatBytes(messages.map(encodeLspFrame))

    expect(decodeChunks(cutAt(stream, seededSizes(seed, 97)))).toEqual(messages)
  })

  it('delivers the messages before a malformed frame, then rejects it', () => {
    const decoder = new LspFrameDecoder()
    const messages: string[] = []
    const chunk = concatBytes([
      encodeLspFrame('{"id":1}'),
      encoder.encode('Content-Length: many\r\n\r\n{}'),
    ])

    expect(() => decoder.push(chunk, (message) => messages.push(message))).toThrow(LspFramingError)
    expect(messages).toEqual(['{"id":1}'])
  })

  it('rejects a header block with two Content-Length lines', () => {
    const frame = encoder.encode('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}')

    expect(() => decodeChunks([frame])).toThrow('needs exactly one decimal Content-Length')
  })

  it('rejects an oversized header block even when its end arrived with it', () => {
    const frame = encoder.encode(`X-Padding: ${'.'.repeat(9000)}\r\nContent-Length: 2\r\n\r\n{}`)

    expect(() => decodeChunks([frame])).toThrow('is too long')
  })

  it('rejects a body over the limit before buffering it', () => {
    const decoder = new LspFrameDecoder(16)
    const header = encoder.encode('Content-Length: 17\r\n\r\n')

    expect(() => decoder.push(header, () => undefined)).toThrow('exceeds the 16 byte limit')
  })

  it('rejects a body that is not UTF-8', () => {
    const frame = concatBytes([
      encoder.encode('Content-Length: 2\r\n\r\n'),
      new Uint8Array([0xc3, 0x28]),
    ])

    expect(() => decodeChunks([frame])).toThrow('not valid UTF-8')
  })

  it('rejects a header block with no Content-Length', () => {
    const frame = encoder.encode('Content-Type: application/json\r\n\r\n{}')

    expect(() => decodeChunks([frame])).toThrow('needs exactly one decimal Content-Length')
  })

  it('rejects output that is not a frame and quotes it', () => {
    const noise = encoder.encode(`Debugger listening on ws://127.0.0.1:9229\n${'.'.repeat(9000)}`)

    expect(() => decodeChunks([noise])).toThrow('Debugger listening')
  })
})
