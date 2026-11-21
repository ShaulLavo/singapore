import { natural } from './source'
import {
  PAGED_PROOF_OPTIONS,
  PagedSourceError,
  PagedSourceInvalidatedError,
  type RangeRead,
  type RangeSource,
} from './types'

type Identity = { readonly id: string; readonly revision: string }

export function blobRangeSource(blob: Blob, identity: Identity): RangeSource {
  return {
    ...identity,
    byteLength: blob.size,
    async readBytes(start, end, signal) {
      checkRange(start, end, signal)
      const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer())
      signal.throwIfAborted()
      return {
        revision: identity.revision,
        bytes,
        eof: start + bytes.length >= blob.size,
        byteLength: blob.size,
      }
    },
  }
}

type HttpOptions = { readonly id: string; readonly fetch?: typeof fetch }

export type HttpRangeOptions = HttpOptions &
  ({ readonly etag: string } | { readonly revision: string; readonly immutable: true })

export type HttpOpenOptions = HttpOptions & {
  readonly firstBytes?: number
  readonly signal?: AbortSignal
}

export function httpRangeSource(url: string | URL, options: HttpRangeOptions): RangeSource {
  const address = String(url)
  const pinned = 'etag' in options
  const revision = pinned ? strongEtag(options.etag) : options.revision
  return {
    id: options.id,
    revision,
    readBytes: (start, end, signal) =>
      httpRead(address, { fetch: options.fetch, revision, pin: pinned }, start, end, signal),
  }
}

export async function openHttpRangeSource(
  url: string | URL,
  options: HttpOpenOptions,
): Promise<RangeSource> {
  const address = String(url)
  const firstBytes = options.firstBytes ?? PAGED_PROOF_OPTIONS.pageBytes
  const signal = options.signal ?? new AbortController().signal
  let opening: RangeRead | null = await httpRead(
    address,
    { fetch: options.fetch, pin: true },
    0,
    firstBytes,
    signal,
  )
  const source = httpRangeSource(address, { ...options, etag: opening.revision })
  return {
    ...source,
    byteLength: opening.byteLength,
    async readBytes(start, end, signal) {
      checkRange(start, end, signal)
      if (opening?.eof && opening.bytes.length === 0) {
        const empty = opening
        opening = null
        return empty
      }
      if (!opening || start >= opening.bytes.length) return source.readBytes(start, end, signal)
      const bytes = opening.bytes.slice(start, end)
      const result = {
        ...opening,
        bytes,
        eof: opening.eof && start + bytes.length === opening.bytes.length,
      }
      if (start + bytes.length === opening.bytes.length) opening = null
      return result
    },
  }
}

type HttpReadOptions = {
  readonly fetch?: typeof fetch
  readonly revision?: string
  readonly pin: boolean
}

async function httpRead(
  url: string,
  options: HttpReadOptions,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<RangeRead> {
  checkRange(start, end, signal)
  const headers = new Headers({ Range: `bytes=${start}-${end - 1}` })
  if (options.pin && options.revision) headers.set('If-Match', options.revision)
  const request = options.fetch ?? globalThis.fetch
  const response = await request(url, { headers, signal, redirect: 'error' })
  try {
    signal.throwIfAborted()
    if (response.status === 412) throw new PagedSourceInvalidatedError()
    if (![200, 206, 416].includes(response.status))
      throw new PagedSourceError(`HTTP range failed with status ${response.status}`)
    const revision = readRevision(response, options)
    const encoding = response.headers.get('Content-Encoding')
    if (encoding && encoding.toLowerCase() !== 'identity')
      throw new PagedSourceError('HTTP range requires an identity representation')
    if (response.status === 206) return await partial(response, revision, start, end, signal)
    if (response.status === 416) return unsatisfied(response, revision, start)
    if (response.headers.get('Content-Length') !== '0')
      throw new PagedSourceError('The server ignored the HTTP Range request')
    const bytes = await boundedBody(response, 0, signal)
    return { bytes, revision, eof: true, byteLength: 0 }
  } catch (error) {
    discard(response)
    throw error
  }
}

function readRevision(response: Response, options: HttpReadOptions) {
  if (!options.pin) return options.revision!
  const header = response.headers.get('ETag')
  if (header && options.revision && header !== options.revision)
    throw new PagedSourceInvalidatedError()
  return strongEtag(header)
}

function strongEtag(value: string | null) {
  if (value && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const opaque = value.slice(1, -1)
    if (Array.from(opaque).every(isEtagCharacter)) return value
  }
  throw new PagedSourceError('HTTP paging requires a strong ETag')
}

function isEtagCharacter(character: string) {
  const code = character.charCodeAt(0)
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff)
}

function checkRange(start: number, end: number, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!natural(start) || !natural(end) || end <= start)
    throw new PagedSourceError('Invalid byte range')
}

async function partial(
  response: Response,
  revision: string,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('Content-Range') ?? '')
  const contentType = response.headers.get('Content-Type')?.toLowerCase()
  if (!range || contentType?.startsWith('multipart/byteranges'))
    throw new PagedSourceError('Invalid Content-Range for a single byte range')
  const from = Number(range[1])
  const last = Number(range[2])
  const byteLength = range[3] === '*' ? undefined : Number(range[3])
  if (
    from !== start ||
    !natural(last) ||
    last < start ||
    last >= end ||
    (byteLength !== undefined && (!natural(byteLength) || last >= byteLength))
  )
    throw new PagedSourceError('Content-Range does not match the requested bounds')
  const size = last - start + 1
  const length = response.headers.get('Content-Length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size))
    throw new PagedSourceError('Content-Length contradicts Content-Range')
  const bytes = await boundedBody(response, size, signal)
  return { bytes, revision, eof: last + 1 === byteLength, byteLength }
}

function unsatisfied(response: Response, revision: string, start: number) {
  const range = /^bytes \*\/(\d+)$/i.exec(response.headers.get('Content-Range') ?? '')
  const byteLength = Number(range?.[1])
  if (!natural(byteLength) || start < byteLength)
    throw new PagedSourceError('Invalid unsatisfied Content-Range')
  discard(response)
  return { bytes: new Uint8Array(), revision, eof: true, byteLength }
}

async function boundedBody(response: Response, size: number, signal: AbortSignal) {
  const bytes = new Uint8Array(size)
  const body = response.body?.getReader()
  if (!body) {
    if (size) throw new PagedSourceError('HTTP range body is missing')
    return bytes
  }
  let length = 0
  let complete = false
  const cancel = () => {
    void body.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await body.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (!chunk.value.length) throw new PagedSourceError('HTTP range body made no progress')
      if (chunk.value.length > size - length)
        throw new PagedSourceError('HTTP range body exceeds its declared byte count')
      bytes.set(chunk.value, length)
      length += chunk.value.length
    }
    complete = true
    if (length !== size)
      throw new PagedSourceError('HTTP range body ended before its declared byte count')
    return bytes
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    body.releaseLock()
  }
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => {})
}
