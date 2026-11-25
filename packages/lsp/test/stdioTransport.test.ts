import { describe, expect, it, vi } from 'vitest'

import {
  LspClient,
  LspFramingError,
  LspRequestCancelledError,
  LspTransportClosedError,
  encodeLspFrame,
} from '../src/index.ts'
import { ServerProcess, initializingServer } from './stdioServer.ts'

const encoder = new TextEncoder()

async function settled(condition: () => boolean): Promise<void> {
  await vi.waitUntil(condition, { interval: 1, timeout: 5000 })
}

function closesOf(server: ServerProcess): unknown[] {
  const closes: unknown[] = []
  server.transport.onDidClose((error) => closes.push(error))
  return closes
}

function messagesOf(server: ServerProcess): string[] {
  const messages: string[] = []
  server.transport.subscribe((message) => messages.push(message))
  return messages
}

describe('stdio LSP transport', () => {
  it('frames each sent message with its UTF-8 byte length', async () => {
    const server = new ServerProcess()

    server.transport.send('{"method":"é😀"}')
    await settled(() => server.stdinText.length === 1)

    expect(server.stdinText).toEqual(['Content-Length: 19\r\n\r\n{"method":"é😀"}'])
    server.transport.close()
  })

  it('delivers messages that arrive split and batched, as they arrive', () => {
    const server = new ServerProcess()
    const received = messagesOf(server)
    const first = encodeLspFrame('{"id":1,"result":"日本"}')
    const second = encodeLspFrame('{"id":2}')
    const tail = new Uint8Array(2 + second.length)
    tail.set(first.slice(first.length - 2))
    tail.set(second, 2)

    server.write(first.slice(0, 9))
    server.write(first.slice(9, first.length - 2))
    expect(received).toEqual([])
    server.write(tail)

    expect(received).toEqual(['{"id":1,"result":"日本"}', '{"id":2}'])
    server.transport.close()
  })

  it('reports an exit with the reason given, after the frames written before it', () => {
    const server = new ServerProcess()
    const closes = closesOf(server)
    const received = messagesOf(server)
    const exited = new Error('language server exited with code 134')

    server.send({ id: 1 })
    server.exit(exited)

    expect(received).toEqual(['{"id":1}'])
    expect(closes).toEqual([exited])
    expect(server.stops).toBe(0)
    expect(server.transport.isClosed?.()).toBe(true)
    expect(() => server.transport.send('{"id":2}')).toThrow(LspTransportClosedError)
  })

  it('reports an exit that gave no reason as a closed transport', () => {
    const server = new ServerProcess()
    const closes = closesOf(server)
    server.transport.send('{"id":1}')

    server.exit()
    server.exit()

    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ reason: 'server exited', sentCount: 1, receivedCount: 0 })
  })

  it.each([
    ['a malformed header', encoder.encode('Content-Length: nope\r\n\r\n')],
    [
      'a body that is not UTF-8',
      new Uint8Array([...encoder.encode('Content-Length: 2\r\n\r\n'), 0xff, 0xfe]),
    ],
    ['a body larger than the limit', encoder.encode('Content-Length: 4097\r\n\r\n')],
  ])('stops the server once on %s and reports it when the server is gone', (_, bytes) => {
    const server = new ServerProcess({ maxMessageBytes: 4096 })
    const closes = closesOf(server)
    const received = messagesOf(server)

    server.send({ id: 1 })
    server.write(bytes)
    server.send({ id: 2 })
    server.transport.send('{"dropped":true}')

    expect(received).toEqual(['{"id":1}'])
    expect(server.stops).toBe(1)
    expect(closes).toEqual([])
    expect(server.transport.isClosed?.()).toBe(true)

    server.exit(new Error('killed'))

    expect(closes).toHaveLength(1)
    expect(closes[0]).toBeInstanceOf(LspFramingError)
    expect(server.stops).toBe(1)
  })

  it('treats a message its subscriber cannot parse as a protocol failure', () => {
    const server = new ServerProcess()
    const closes = closesOf(server)
    server.transport.subscribe((message) => void JSON.parse(message))

    server.write(encodeLspFrame('{"id":1'))
    server.exit()

    expect(server.stops).toBe(1)
    expect(closes[0]).toBeInstanceOf(SyntaxError)
  })

  it('stops a server that no longer reads its stdin once the pending bytes pass the limit', () => {
    const server = new ServerProcess({ maxPendingStdinBytes: 256, readsStdin: false })
    const closes = closesOf(server)
    const message = JSON.stringify({ method: 'textDocument/didChange', text: 'x'.repeat(100) })

    server.transport.send(message)
    expect(server.stops).toBe(0)
    server.transport.send(message)
    server.transport.send(message)
    server.exit(new Error('killed'))

    expect(server.stops).toBe(1)
    expect(closes[0]).toMatchObject({ reason: 'server stopped reading its stdin', sentCount: 1 })
  })

  it('stops a server that closed its stdin and reports the exit that follows', async () => {
    const server = new ServerProcess({ readsStdin: false })
    const closes = closesOf(server)
    const exited = new Error('language server exited with code 1')
    server.transport.send('{"id":1}')

    await server.closeStdin()
    server.transport.send('{"dropped":true}')
    expect(server.stops).toBe(1)
    expect(closes).toEqual([])
    server.exit(exited)

    expect(closes).toEqual([exited])
  })

  it('ends stdin and stops the server on close, then ignores what the server still does', async () => {
    const server = new ServerProcess()
    const closes = closesOf(server)
    const received = messagesOf(server)
    server.transport.send('{"method":"exit"}')

    server.transport.close()
    server.transport.close()
    server.send({ id: 1 })
    server.exit(new Error('killed'))
    await settled(() => server.stdinEnded)

    expect(server.methods()).toEqual(['exit'])
    expect(server.stops).toBe(1)
    expect(closes).toEqual([])
    expect(received).toEqual([])
  })

  it('does not stop a server twice when it is closed while already stopping', () => {
    const server = new ServerProcess()
    const closes = closesOf(server)

    server.write(encoder.encode('not a frame\r\n\r\n'))
    server.transport.close()
    server.exit(new Error('killed'))

    expect(server.stops).toBe(1)
    expect(closes).toEqual([])
  })
})

describe('LSP client over a stdio transport', () => {
  it('initializes, then answers a request', async () => {
    const server = initializingServer()
    const client = new LspClient({ rootUri: 'file:///project' })
    await client.connect(server.transport)
    const initialize = server.onMessage
    server.onMessage = (message) => {
      initialize(message)
      if (message.method === 'textDocument/hover') server.reply(message, { contents: 'π: number' })
    }

    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: 'file:///project/a.ts' },
      position: { line: 0, character: 0 },
    })

    expect(hover).toEqual({ contents: 'π: number' })
    expect(server.methods().slice(0, 3)).toEqual([
      'initialize',
      'initialized',
      'textDocument/hover',
    ])
    client.disconnect()
  })

  it('sends $/cancelRequest for a cancelled request and rejects it locally', async () => {
    const server = initializingServer()
    const client = new LspClient({ rootUri: 'file:///project' })
    await client.connect(server.transport)

    const handle = client.requestHandle('textDocument/completion', {})
    const outcome = handle.response.catch((error: unknown) => error)
    await settled(() => server.methods().includes('textDocument/completion'))
    handle.cancel()
    await settled(() => server.methods().includes('$/cancelRequest'))

    expect(await outcome).toBeInstanceOf(LspRequestCancelledError)
    expect(server.received.at(-1)).toMatchObject({
      method: '$/cancelRequest',
      params: { id: handle.id },
    })
    client.disconnect()
  })

  it('rejects a request that was pending when the server died', async () => {
    const server = initializingServer()
    const client = new LspClient({ rootUri: 'file:///project' })
    server.transport.onDidClose(() => client.disconnect())
    await client.connect(server.transport)

    const pending = client.request('textDocument/definition', {}).catch((error: unknown) => error)
    await settled(() => server.methods().includes('textDocument/definition'))
    server.exit()

    expect(await pending).toBeInstanceOf(Error)
    expect(client.connected).toBe(false)
  })
})
