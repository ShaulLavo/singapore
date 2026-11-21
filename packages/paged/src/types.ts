export type RangeRead = {
  readonly revision: string
  readonly bytes: Uint8Array
  readonly eof: boolean
  readonly byteLength?: number
}

export type RangeSource = {
  readonly id: string
  readonly revision: string
  readonly byteLength?: number
  readBytes(start: number, end: number, signal: AbortSignal): Promise<RangeRead>
  validate?(signal: AbortSignal): Promise<{ readonly revision: string }>
}

export type PagedTotals = {
  readonly byteLength?: number
  readonly lineCount?: number
  readonly utf16Length?: number
}

export type PagedCheckpoint = {
  readonly byteOffset: number
  readonly line: number
  readonly utf16Offset?: number
}

export type PagedCoordinate =
  | { readonly kind: 'line'; readonly value: number }
  | { readonly kind: 'utf16'; readonly value: number }

export type PagedIndexCoverage = {
  readonly kind: PagedCoordinate['kind']
  readonly start: number
  readonly end: number
}

export const PAGED_POSITION_POLICY = 'utf8-raw-bom-lf' as const

export type PagedIndex = {
  readonly sourceId: string
  readonly revision: string
  readonly positionPolicy: typeof PAGED_POSITION_POLICY
  readonly coverage: readonly PagedIndexCoverage[]
  readonly totals?: PagedTotals
} & (
  | { readonly checkpoints: readonly PagedCheckpoint[] }
  | {
      locate(coordinate: PagedCoordinate, signal: AbortSignal): Promise<PagedCheckpoint | null>
    }
)

export type PagedOptions = {
  readonly pageBytes: number
  readonly cacheBytes: number
  readonly checkpointLimit: number
  readonly checkpointStride: number
  readonly maxInFlight: number
  readonly maxViews: number
  readonly maxWindowUnits: number
  readonly maxWindowRows: number
  readonly maxReadBytes: number
  readonly maxReadRequests: number
}

export const PAGED_PROOF_OPTIONS: PagedOptions = {
  pageBytes: 65_536,
  cacheBytes: 8 * 1024 * 1024,
  checkpointLimit: 4096,
  checkpointStride: 262_144,
  maxInFlight: 2,
  maxViews: 2,
  maxWindowUnits: 512 * 1024,
  maxWindowRows: 128,
  maxReadBytes: 1024 * 1024,
  maxReadRequests: 32,
}

export type PagedOpenOptions = Partial<PagedOptions> & {
  readonly totals?: PagedTotals
  readonly index?: PagedIndex
}

declare const cursorBrand: unique symbol
export type PagedCursor = {
  readonly byteOffset: number
  readonly [cursorBrand]: true
}

export type PagedFragment = {
  readonly text: string
  readonly start: PagedCursor
  readonly end: PagedCursor
  readonly lineBreak: '' | '\n'
  readonly continuesBefore: boolean
  readonly continuesAfter: boolean
  readonly line?: number
  readonly utf16Offset?: number
}

export type PagedWindow = {
  readonly kind: 'window'
  readonly sourceId: string
  readonly revision: string
  readonly fragments: readonly PagedFragment[]
  readonly previous: PagedCursor | null
  readonly next: PagedCursor | null
  readonly atStart: boolean
  readonly atEnd: boolean
  readonly stop: 'rows' | 'text' | 'budget' | 'eof' | 'boundary'
}

export type PagedUnavailable = {
  readonly kind: 'unavailable'
  readonly reason: 'no-mapping' | 'unknown-length' | 'outside-source'
}

export type PagedEndpoint = {
  readonly fragment: PagedFragment
  readonly column: number
}

export type PagedCopyResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'limit'; readonly reason: 'text' | 'budget' }
  | PagedUnavailable

export class PagedSourceInvalidatedError extends Error {
  constructor(cause?: unknown) {
    super('The file changed during the paged read', { cause })
    this.name = 'PagedSourceInvalidatedError'
  }
}

export class PagedSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PagedSourceError'
  }
}
