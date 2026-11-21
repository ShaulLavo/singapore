import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import {
  blobRangeSource,
  httpRangeSource,
  openHttpRangeSource,
  PagedDocument,
  PagedSourceInvalidatedError,
} from '../src/index'

const url = 'https://files.example/utf8'
const signal = new AbortController().signal
const etag = '"first"'

function httpFixture(...responses: Response[]) {
  const requests: Headers[] = []
  const fetcher: typeof fetch = async (_url, options) => {
    requests.push(new Headers(options?.headers))
    const response = responses.shift()
    if (!response) throw new Error('Unexpected HTTP request')
    return response
  }
  return { requests, fetcher }
}

function partial(range: string, text: string, additional?: HeadersInit) {
  const headers = new Headers(additional)
  headers.set('Content-Range', range)
  if (!headers.has('ETag')) headers.set('ETag', etag)
  return new Response(text, { status: 206, headers })
}

function reader(...responses: Response[]) {
  const { fetcher } = httpFixture(...responses)
  return httpRangeSource(url, { id: 'fixture', etag, fetch: fetcher })
}

test('Blob reads bounded slices and distinguishes empty EOF and cancellation', async () => {
  const source = blobRangeSource(new Blob(['abc🙂']), { id: 'local', revision: 'one' })
  expect(source.byteLength).toBe(7)
  expect(await source.readBytes(1, 4, signal)).toEqual({
    bytes: new Uint8Array([0x62, 0x63, 0xf0]),
    revision: 'one',
    byteLength: 7,
    eof: false,
  })
  expect(await source.readBytes(7, 8, signal)).toMatchObject({ eof: true, bytes: new Uint8Array() })
  await expect(source.readBytes(0, 1, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError',
  })
})

test('unknown totals, short ranges and full-sized final pages preserve HTTP semantics', async () => {
  const { requests, fetcher } = httpFixture(
    partial('bytes 0-1/*', 'ab', { 'Content-Length': '2' }),
    partial('bytes 2-5/6', 'cdef', { 'Content-Length': '4' }),
  )
  const source = httpRangeSource(url, { id: 'fixed', etag, fetch: fetcher })
  expect(await source.readBytes(0, 4, signal)).toMatchObject({
    revision: etag,
    eof: false,
    byteLength: undefined,
  })
  expect(await source.readBytes(2, 6, signal)).toMatchObject({
    revision: etag,
    eof: true,
    byteLength: 6,
  })
  expect(
    requests.map((entry) => [
      entry.get('Range'),
      entry.get('If-Match'),
      entry.get('Accept-Encoding'),
    ]),
  ).toEqual([
    ['bytes=0-3', etag, null],
    ['bytes=2-5', etag, null],
  ])
})

test('one opening read pins the revision and its bytes satisfy the first window', async () => {
  const { requests, fetcher } = httpFixture(
    partial('bytes 0-3/*', 'one\n'),
    partial('bytes 4-7/8', 'two\n'),
  )
  const source = await openHttpRangeSource(url, { id: 'remote', firstBytes: 4, fetch: fetcher })
  const doc = new PagedDocument(source, { pageBytes: 4 })
  const view = doc.createView()
  const first = await view.first(1)
  expect(first.fragments[0]?.text).toBe('one')
  expect(doc.stats.totals.byteLength).toBeUndefined()
  expect(requests).toHaveLength(1)
  expect((await view.next(first.next!, 1)).fragments[0]?.text).toBe('two')
  expect(doc.stats.totals.byteLength).toBe(8)
  expect(requests.map((request) => request.get('If-Match'))).toEqual([null, etag])
})

test('accepts a versioned immutable URL without an ETag', async () => {
  const { requests, fetcher } = httpFixture(
    new Response('ab', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-1/2' },
    }),
  )
  const source = httpRangeSource(url, {
    id: 'fixed',
    revision: 'v3',
    immutable: true,
    fetch: fetcher,
  })
  expect(await source.readBytes(0, 2, signal)).toMatchObject({ revision: 'v3', eof: true })
  expect(requests[0]?.has('If-Match')).toBe(false)
})

test('416 validates identity and requires an exact size consistent with the probe', async () => {
  const response = (range?: string, identity = etag) =>
    new Response(null, {
      status: 416,
      headers: { ETag: identity, ...(range ? { 'Content-Range': range } : {}) },
    })
  expect(await reader(response('bytes */6')).readBytes(8, 12, signal)).toMatchObject({
    eof: true,
    byteLength: 6,
  })
  await expect(reader(response('bytes */6')).readBytes(1, 4, signal)).rejects.toThrow('unsatisfied')
  await expect(reader(response()).readBytes(8, 12, signal)).rejects.toThrow('unsatisfied')
  await expect(
    reader(response('bytes */6', '"other"')).readBytes(8, 12, signal),
  ).rejects.toBeInstanceOf(PagedSourceInvalidatedError)
})

test('412 and a changed ETag invalidate the source', async () => {
  const response = new Response(null, { status: 412 })
  await expect(reader(response).readBytes(0, 3, signal)).rejects.toBeInstanceOf(
    PagedSourceInvalidatedError,
  )
  await expect(
    reader(partial('bytes 0-1/2', 'aa', { ETag: '"other"' })).readBytes(0, 3, signal),
  ).rejects.toBeInstanceOf(PagedSourceInvalidatedError)
})

test('an ignored Range cancels its body and an explicitly empty 200 verifies the body', async () => {
  let cancelled = 0
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([97]))
      },
      cancel() {
        cancelled++
      },
    })
  await expect(
    reader(new Response(body(), { headers: { ETag: etag } })).readBytes(0, 3, signal),
  ).rejects.toThrow('ignored')
  expect(cancelled).toBe(1)
  const headers = { ETag: etag, 'Content-Length': '0' }
  expect(await reader(new Response(null, { headers })).readBytes(0, 3, signal)).toMatchObject({
    eof: true,
    byteLength: 0,
    bytes: new Uint8Array(),
  })
  await expect(reader(new Response(body(), { headers })).readBytes(0, 3, signal)).rejects.toThrow(
    'exceeds',
  )
  expect(cancelled).toBe(2)
})

test('rejects wrong bounds, encoded, multipart, weak, missing, short and overlong responses', async () => {
  const cases = [
    [partial('bytes 1-2/3', 'ab'), 'bounds'],
    [partial('bytes 0-3/4', 'abcd'), 'bounds'],
    [partial('bytes 0-1/1', 'ab'), 'bounds'],
    [partial('bytes 0-1/*', 'ab', { 'Content-Encoding': 'gzip' }), 'identity representation'],
    [
      partial('bytes 0-1/*', 'ab', { 'Content-Type': 'multipart/byteranges; boundary=x' }),
      'single byte range',
    ],
    [partial('bytes 0-1/2', 'ab', { 'Content-Length': '3' }), 'contradicts'],
    [partial('bytes 0-1/2', 'a'), 'ended before'],
    [partial('bytes 0-1/2', 'abc'), 'exceeds'],
    [
      new Response('ab', { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } }),
      'strong ETag',
    ],
  ] as const
  for (const [response, error] of cases)
    await expect(reader(response).readBytes(0, 3, signal)).rejects.toThrow(error)
  expect(() => httpRangeSource(url, { id: 'weak', etag: 'W/"weak"' })).toThrow('strong ETag')
})

test('an aborted HTTP read cancels a pending body', async () => {
  const abort = new AbortController()
  let open!: () => void
  const pulled = new Promise<void>((resolve) => {
    open = resolve
  })
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        open()
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const result = reader(
    new Response(body, {
      status: 206,
      headers: { ETag: etag, 'Content-Range': 'bytes 0-1/2' },
    }),
  ).readBytes(0, 3, abort.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await pulled
  abort.abort()
  await rejected
  expect(cancelled).toBe(true)
})

test('a redirect cannot switch a bootstrapped source to a stranger with the same strong ETag', async () => {
  let requests = 0
  let redirected = 0
  const server = createServer((request, response) => {
    if (request.url === '/other') {
      redirected++
      response.writeHead(206, { ETag: etag, 'Content-Range': 'bytes 4-7/8' }).end('bad\n')
      return
    }
    requests++
    if (requests === 1) {
      response.writeHead(206, { ETag: etag, 'Content-Range': 'bytes 0-3/*' }).end('one\n')
      return
    }
    response.writeHead(302, { Location: '/other' }).end()
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No HTTP fixture address')
    const source = await openHttpRangeSource(`http://127.0.0.1:${address.port}/latest`, {
      id: 'local',
      firstBytes: 4,
    })
    expect((await source.readBytes(0, 4, signal)).bytes.length).toBe(4)
    await expect(source.readBytes(4, 8, signal)).rejects.toThrow()
    expect(requests).toBe(2)
    expect(redirected).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each(['pinned', 'opening'])('snapshots a mutable URL before the %s read', async (mode) => {
  const address = new URL(url)
  const seen: string[] = []
  const replies = [partial('bytes 0-3/*', 'one\n'), partial('bytes 4-7/8', 'two\n')]
  const fetcher: typeof fetch = async (input) => {
    seen.push(String(input))
    await Promise.resolve()
    return replies.shift()!
  }

  const opened =
    mode === 'opening'
      ? openHttpRangeSource(address, { id: 'local', firstBytes: 4, fetch: fetcher })
      : Promise.resolve(httpRangeSource(address, { id: 'local', etag, fetch: fetcher }))
  address.pathname = '/other'
  const source = await opened
  await source.readBytes(0, 4, signal)
  await source.readBytes(4, 8, signal)
  expect(seen).toEqual([url, url])
})
