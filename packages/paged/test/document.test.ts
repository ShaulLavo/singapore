import { expect, test } from 'vitest'
import {
  PAGED_POSITION_POLICY,
  PagedDocument,
  PagedSourceInvalidatedError,
  type PagedIndex,
  type PagedWindow,
  type RangeRead,
  type RangeSource,
} from '../src/index'

const encode = (text: string) => new TextEncoder().encode(text)
const small = { cacheBytes: 32, pageBytes: 8, checkpointStride: 4, maxReadBytes: 32 }
const raw = (window: PagedWindow) =>
  window.fragments.map((part) => part.text + part.lineBreak).join('')

function fixture(bytes: Uint8Array, chunk = Infinity, known = false) {
  const calls: [number, number][] = []
  const source: RangeSource = {
    id: 'fixture',
    revision: 'one',
    ...(known ? { byteLength: bytes.length } : {}),
    async readBytes(start, end) {
      calls.push([start, end])
      const delivered = bytes.slice(start, Math.min(start + chunk, end))
      return { revision: 'one', bytes: delivered, eof: start + delivered.length >= bytes.length }
    },
  }
  return { source, calls }
}

function indexed(
  source: RangeSource,
  settings: Partial<Omit<PagedIndex, 'positionPolicy'>> &
    (
      | { checkpoints: Extract<PagedIndex, { checkpoints: unknown }>['checkpoints'] }
      | { locate: Extract<PagedIndex, { locate: unknown }>['locate'] }
    ),
): PagedIndex {
  const common = {
    sourceId: settings.sourceId ?? source.id,
    revision: settings.revision ?? source.revision,
    positionPolicy: PAGED_POSITION_POLICY,
    coverage: settings.coverage ?? [{ kind: 'line', start: 0, end: 10 }],
    totals: settings.totals,
  }
  return 'locate' in settings
    ? { ...common, locate: settings.locate }
    : { ...common, checkpoints: settings.checkpoints }
}

test.each([false, true])(
  'first window only reads the visible region (known length %s)',
  async (known) => {
    const requests: [number, number][] = []
    const source: RangeSource = {
      id: 'virtual',
      revision: 'one',
      ...(known ? { byteLength: 10 ** 10 } : {}),
      async readBytes(start, end) {
        requests.push([start, end])
        if (end > 16) throw new Error('Read beyond the allowed region')
        return {
          revision: 'one',
          bytes: encode('abc\ndef\nghi\njkl\n').slice(start, end),
          eof: false,
        }
      },
    }
    const doc = new PagedDocument(source, small)
    const view = doc.createView()
    await doc.initialize()
    expect(requests).toEqual([])
    expect(doc.stats.state).toBe('open')
    expect(raw(await view.first(2))).toBe('abc\ndef\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toEqual([[0, 8]])
    expect(doc.stats.totals.lineCount).toBeUndefined()
    expect(doc.stats.totals.byteLength).toBe(known ? 10 ** 10 : undefined)
    expect(await view.seekLine(700, 1)).toEqual({ kind: 'unavailable', reason: 'no-mapping' })
    expect(await view.copyRange(700, 703)).toEqual({ kind: 'unavailable', reason: 'no-mapping' })
    expect(requests).toHaveLength(1)
  },
)

test('next and previous reuse nearby reads, then replay evicted content', async () => {
  const { source, calls } = fixture(encode('abc\ndef\nghi\njkl\nmno\npqr\nstu\nvwx\nyza\n'))
  const doc = new PagedDocument(source, { ...small, cacheBytes: 8 })
  const view = doc.createView()
  const first = await view.first(1)
  const second = await view.next(first.next!, 1)
  const before = await view.previous(second.previous!, 1)
  expect(raw(before)).toBe('abc\n')
  expect(calls).toEqual([[0, 8]])
  let window = second
  for (let at = 0; at < 5; at++) window = await view.next(window.next!, 1)
  const count = calls.length
  expect(raw(await view.next(before.next!, 1))).toBe('def\n')
  expect(calls.length).toBeGreaterThan(count)
  expect(doc.stats.peakCachedBytes).toBeLessThanOrEqual(8)
})

test('copy uses stable local columns and preserves CRLF and giant-line boundaries', async () => {
  const { source, calls } = fixture(encode('a🙂bcdef\r\nhello\nlast'))
  const doc = new PagedDocument(source, { ...small, maxWindowUnits: 6 })
  const view = doc.createView()
  const first = await view.first(1)
  const second = await view.next(first.next!, 1)
  expect(raw(first)).toBe('a🙂bcd')
  expect(raw(second)).toBe('ef\r\n')
  expect(first.fragments[0]?.continuesAfter).toBe(true)
  expect(second.fragments[0]?.continuesBefore).toBe(true)
  const done = await view.next(second.next!, 1)
  const left = { fragment: second.fragments[0]!, column: 1 }
  const right = { fragment: done.fragments[0]!, column: 2 }
  const count = calls.length
  expect(await view.copy(right, left)).toEqual({ kind: 'text', text: 'f\r\nhe' })
  expect(await view.copy({ fragment: first.fragments[0]!, column: 0 }, right)).toEqual({
    kind: 'limit',
    reason: 'text',
  })
  expect(calls).toHaveLength(count)
})

test.each([1, 2, 3, 4, 5, 6, 7, 8])(
  'resumes every UTF-8 split with %s delivered bytes at a time',
  async (chunk) => {
    const bytes = Uint8Array.from(
      Array.from(encode('\ufeffa🙂e\u0301\r\n'), (byte) => byte).concat(
        [0xe0, 0x80, 0xbf, 0xe1, 0x80, 0x2e, 0xf0, 0x9e, 0xa0, 0xf1, 0x80, 0xa0, 0x20],
        Array.from(encode('🙂\n')),
        [0xf0, 0x91],
      ),
    )
    const { source } = fixture(bytes, chunk)
    const doc = new PagedDocument(source, {
      ...small,
      maxReadBytes: 8,
      maxReadRequests: 1,
      maxWindowUnits: 3,
    })
    const view = doc.createView()
    let window = await view.first(1)
    let visible = raw(window)
    let through = 0
    for (let i = 0; window.next && i < 100; i++) {
      expect(window.next.byteOffset).toBeGreaterThanOrEqual(through)
      through = window.next.byteOffset
      window = await view.next(window.next, 1)
      for (const piece of window.fragments) expect(piece.text).not.toMatch(/[\uD800-\uDBFF]$/u)
      visible += raw(window)
    }
    const oracle = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    expect(window.atEnd).toBe(true)
    expect(visible).toBe(oracle)
    expect(doc.stats.totals).toEqual({
      byteLength: bytes.length,
      lineCount: oracle.split('\n').length,
      utf16Length: oracle.length,
    })
  },
)

test.each(['', 'abc\ndef\n', 'abcd1234', 'missing newline'])(
  'retains EOF and logical rows for %j',
  async (text) => {
    const { source } = fixture(encode(text))
    const doc = new PagedDocument(source, small)
    const view = doc.createView()
    const parts: string[] = []
    let window = await view.first(1)
    for (let i = 0; i < 20; i++) {
      parts.push(...window.fragments.map((part) => part.text))
      if (!window.next) break
      window = await view.next(window.next, 1)
    }
    expect(parts).toEqual(text.split('\n'))
    expect(doc.stats.totals.byteLength).toBe(encode(text).length)
    expect(window.atEnd).toBe(true)
  },
)

test('empty distant reads establish an upper bound, then demand learns the exact end', async () => {
  const { source, calls } = fixture(encode('abc'))
  const doc = new PagedDocument(source, small)
  const view = doc.createView()
  expect(await view.end(1)).toEqual({ kind: 'unavailable', reason: 'unknown-length' })
  expect(await view.seekByte(1000, 1)).toEqual({ kind: 'unavailable', reason: 'outside-source' })
  expect(doc.stats.totals.byteLength).toBeUndefined()
  expect(calls).toEqual([[997, 1005]])
  expect(raw(await view.first(1))).toBe('abc')
  expect(doc.stats.totals.byteLength).toBe(3)
  expect(await view.end(1)).toMatchObject({ atEnd: true, fragments: [{ text: 'abc' }] })
})

test('a no-progress read fails only the operation and a later demand can retry', async () => {
  let broken = true
  const source: RangeSource = {
    id: 'retry',
    revision: 'one',
    async readBytes() {
      return { revision: 'one', bytes: broken ? new Uint8Array() : encode('yes'), eof: !broken }
    },
  }
  const doc = new PagedDocument(source, small)
  const view = doc.createView()
  await expect(view.first(1)).rejects.toThrow('no progress')
  expect(doc.stats.state).toBe('open')
  broken = false
  expect(raw(await view.first(1))).toBe('yes')
})

test('rejects a split UTF-16 signature without a separate probe', async () => {
  const { source, calls } = fixture(new Uint8Array([0xff, 0xfe, 0x61, 0]), 1)
  const doc = new PagedDocument(source, small)
  await expect(doc.createView().first(1)).rejects.toThrow('UTF-16')
  expect(calls).toHaveLength(2)
})

test('opens near a trusted distant checkpoint, with independent totals and coordinate coverage', async () => {
  const calls: [number, number][] = []
  const far = 10 ** 9
  const source: RangeSource = {
    id: 'far',
    revision: 'one',
    async readBytes(start, end) {
      calls.push([start, end])
      if (start < far) throw new Error('Read before the trusted checkpoint')
      return {
        revision: 'one',
        bytes: encode('hi🙂\nnext\n').slice(start - far, end - far),
        eof: false,
      }
    },
  }
  const index = indexed(source, {
    checkpoints: [{ byteOffset: far, line: 42, utf16Offset: 100 }],
    coverage: [
      { kind: 'line', start: 42, end: 44 },
      { kind: 'utf16', start: 100, end: 107 },
    ],
    totals: { lineCount: 200 },
  })
  const doc = new PagedDocument(source, { ...small, index })
  const view = doc.createView()
  expect(calls).toEqual([])
  expect(await view.seekLine(42, 1)).toMatchObject({
    kind: 'window',
    fragments: [{ line: 42, utf16Offset: 100, text: 'hi🙂' }],
  })
  expect(calls).toEqual([[far, far + 8]])
  expect(await view.copyRange(101, 105)).toEqual({ kind: 'text', text: 'i🙂\n' })
  expect(calls).toHaveLength(1)
  expect(await view.seekLine(44, 1)).toEqual({ kind: 'unavailable', reason: 'no-mapping' })
  expect(doc.stats.totals).toEqual({ lineCount: 200 })
})

test('sparse locator gaps resume without rereading a giant prefix', async () => {
  const text = 'x'.repeat(160) + '\nactual\n'
  const { source, calls } = fixture(encode(text))
  let lookups = 0
  const index = indexed(source, {
    coverage: [{ kind: 'line', start: 1, end: 2 }],
    async locate() {
      lookups++
      return { byteOffset: 0, line: 0, utf16Offset: 0 }
    },
  })
  const view = new PagedDocument(source, { ...small, index, maxReadRequests: 2 }).createView()
  const started = await view.seekLine(1, 1)
  if (started.kind !== 'window') throw new Error('Line mapping was unavailable')
  let window = started
  expect(window.stop).toBe('budget')
  while (!window.fragments.length) {
    const prior = window.next!
    expect(prior.byteOffset).toBeGreaterThan(0)
    window = await view.next(prior, 1)
    if (window.next) expect(window.next.byteOffset).toBeGreaterThan(prior.byteOffset)
  }
  expect(raw(window)).toBe('actual\n')
  expect(lookups).toBe(1)
  expect(calls.map(([start]) => start)).toEqual(Array.from({ length: 21 }, (_, index) => index * 8))
})

test('trusted metadata contradictions fail during bounded demand', async () => {
  const { source, calls } = fixture(encode('a\nb\n'))
  expect(
    () =>
      new PagedDocument(source, { index: indexed(source, { revision: 'other', checkpoints: [] }) }),
  ).toThrow('identity')
  const doc = new PagedDocument(source, { ...small, totals: { lineCount: 2 } })
  await expect(doc.createView().first(4)).rejects.toThrow('contradicts')
  expect(calls).toEqual([[0, 8]])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

test('shared requests survive one cancellation and do not publish after disposal', async () => {
  const calls: AbortSignal[] = []
  let pending = deferred<RangeRead>()
  const source: RangeSource = {
    id: 'held',
    revision: 'one',
    readBytes(_start, _end, signal) {
      calls.push(signal)
      return pending.promise
    },
  }
  const doc = new PagedDocument(source, small)
  const first = doc.createView()
  const second = doc.createView()
  const rejected = expect(first.first(1)).rejects.toMatchObject({ name: 'AbortError' })
  const useful = second.first(1)
  await Promise.resolve()
  first.cancel()
  await rejected
  expect(calls).toHaveLength(1)
  expect(calls[0]?.aborted).toBe(false)
  pending.resolve({ revision: 'one', bytes: encode('one\n'), eof: false })
  expect(raw(await useful)).toBe('one\n')
  pending = deferred()
  const late = expect(second.seekByte(100, 1)).rejects.toThrow('disposed')
  await Promise.resolve()
  doc.dispose()
  await late
  expect(calls[1]?.aborted).toBe(true)
  pending.resolve({ revision: 'two', bytes: encode('late'), eof: false })
  await Promise.resolve()
  expect(doc.stats).toMatchObject({ state: 'disposed', cachedBytes: 0, checkpoints: 0 })
})

test('cache hits do not probe the source, and explicit validation invalidates cursors and selection', async () => {
  let revision = 'one'
  const { source, calls } = fixture(encode('one\ntwo'))
  const doc = new PagedDocument({ ...source, validate: async () => ({ revision }) }, small)
  const view = doc.createView()
  const first = await view.first(1)
  revision = 'two'
  expect(raw(await view.first(1))).toBe('one\n')
  expect(calls).toHaveLength(1)
  await expect(doc.validate()).rejects.toBeInstanceOf(PagedSourceInvalidatedError)
  await expect(view.next(first.next!, 1)).rejects.toBeInstanceOf(PagedSourceInvalidatedError)
  expect(doc.stats).toMatchObject({ state: 'stale', cachedBytes: 0, indexCheckpoints: 0 })
})
