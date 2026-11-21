import { createEditorTextBuffer, createEditorBufferSession } from '@singapore-editor/core/document'
import {
  blobRangeSource,
  PAGED_POSITION_POLICY,
  PAGED_PROOF_OPTIONS,
  PagedDocument,
  type PagedIndex,
  type RangeSource,
} from '@singapore-editor/paged'
import { PagedViewport } from './view'

const TILE = 'row🙂 e\u0301 中 payload\r\n'
const tile = new TextEncoder().encode(TILE)
const host = document.querySelector<HTMLElement>('#view')!
const file = document.querySelector<HTMLInputElement>('#file')!
let documentSource: PagedDocument | undefined
let viewport: PagedViewport | undefined
let retained: ReturnType<typeof createEditorTextBuffer> | undefined
let reportLength = false
let holdReads = false
let closed: PagedDocument['stats'] | undefined
let cancelled = 0
let minimumReadStart = 0

type PagedMode = 'demand' | 'indexed' | 'traverse'

function virtualSource(size: number, mode: PagedMode): RangeSource {
  return {
    id: 'generated-utf8',
    revision: 'one',
    async readBytes(start, end, signal) {
      if (start < minimumReadStart) throw new Error('Read before the supplied index checkpoint')
      if (mode === 'demand' && end > 2 * PAGED_PROOF_OPTIONS.pageBytes + 4096)
        throw new Error('Read outside the permitted demand region')
      if (holdReads) {
        await holdUntilCancelled(signal)
      }
      const first = start === 0 && mode === 'demand'
      const through = Math.min(size, first ? 27 * tile.length : end, end)
      const bytes = virtualBytes(start, Math.max(start, through))
      return {
        revision: 'one',
        bytes,
        eof: mode !== 'demand' && through >= size,
        ...(reportLength ? { byteLength: size } : {}),
      }
    },
  }
}

function holdUntilCancelled(signal: AbortSignal) {
  return new Promise<void>((_resolve, reject) => {
    const abort = () => {
      cancelled++
      reject(signal.reason)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function virtualBytes(start: number, end: number) {
  const bytes = new Uint8Array(end - start)
  for (let at = 0; at < bytes.length; at++) bytes[at] = tile[(start + at) % tile.length]!
  return bytes
}

async function mount(source: RangeSource, index?: PagedIndex) {
  const doc = new PagedDocument(source, { index })
  documentSource = doc
  viewport = new PagedViewport(host, doc, { indexedLines: Boolean(index) })
  const start = performance.now()
  await viewport.first()
  return performance.now() - start
}

async function open(size: number, mode: PagedMode) {
  dispose()
  closed = undefined
  cancelled = 0
  minimumReadStart = 0
  holdReads = false
  reportLength = false
  const bytes = Math.floor(size / tile.length) * tile.length
  const source = virtualSource(bytes, mode)
  const farLine = Math.floor((bytes / tile.length) * 0.9)
  const farByte = farLine * tile.length
  const index: PagedIndex | undefined =
    mode === 'indexed'
      ? {
          sourceId: source.id,
          revision: source.revision,
          positionPolicy: PAGED_POSITION_POLICY,
          coverage: [{ kind: 'line', start: farLine, end: farLine + 1 }],
          checkpoints: [{ byteOffset: farByte, line: farLine, utf16Offset: farLine * TILE.length }],
        }
      : undefined
  const firstContentMs = await mount(source, index)
  return {
    bytes,
    firstContentMs,
    tile: TILE,
    tileBytes: tile.length,
    farLine,
    farByte,
    stats: documentSource!.stats,
  }
}

async function compare(mode: 'resident' | 'streamed', size: number) {
  dispose()
  const bytes = Math.floor(size / tile.length) * tile.length
  const start = performance.now()
  if (mode === 'resident') {
    retained = createEditorTextBuffer(new TextDecoder().decode(virtualBytes(0, bytes)))
    return { bytes, units: retained.getSnapshot().length, buildMs: performance.now() - start }
  }
  retained = createEditorTextBuffer('')
  const session = createEditorBufferSession(retained)
  const decoder = new TextDecoder()
  let pendingCR = ''
  for (let offset = 0; offset < bytes; offset += PAGED_PROOF_OPTIONS.pageBytes) {
    const part = virtualBytes(offset, Math.min(bytes, offset + PAGED_PROOF_OPTIONS.pageBytes))
    const text = pendingCR + decoder.decode(part, { stream: true })
    pendingCR = text.endsWith('\r') ? '\r' : ''
    const complete = pendingCR ? text.slice(0, -1) : text
    session.applyEdits(
      [{ from: retained.getSnapshot().length, to: retained.getSnapshot().length, text: complete }],
      { history: 'skip' },
    )
  }
  const tail = pendingCR + decoder.decode()
  if (tail)
    session.applyEdits(
      [{ from: retained.getSnapshot().length, to: retained.getSnapshot().length, text: tail }],
      { history: 'skip' },
    )
  return { bytes, units: retained.getSnapshot().length, buildMs: performance.now() - start }
}

function dispose() {
  const doc = documentSource
  viewport?.dispose()
  doc?.dispose()
  if (doc) captureClosed(doc)
  viewport = undefined
  documentSource = undefined
  retained = undefined
  file.value = ''
}

function captureClosed(doc: PagedDocument) {
  const snapshot = doc.stats
  closed = snapshot
  if (!snapshot.inFlight) return
  requestAnimationFrame(() => {
    if (closed === snapshot) closed = doc.stats
  })
}

async function traverse() {
  const doc = documentSource!
  const view = doc.createView()
  const start = performance.now()
  let pieces = 0
  let through = 0
  try {
    let window = await view.first(PAGED_PROOF_OPTIONS.maxWindowRows)
    while (true) {
      for (const piece of window.fragments) {
        if (
          piece.start.byteOffset !== through ||
          (piece.lineBreak && piece.text + piece.lineBreak !== TILE)
        )
          throw new Error('Traversal differs from the virtual source')
        through = piece.end.byteOffset
        pieces++
      }
      if (!window.next) break
      window = await view.next(window.next, PAGED_PROOF_OPTIONS.maxWindowRows)
    }
    return { ms: performance.now() - start, pieces, through, stats: doc.stats }
  } finally {
    view.dispose()
  }
}

document.querySelector('#close')?.addEventListener('click', dispose)
file.addEventListener('change', () => {
  const blob = file.files?.[0]
  if (!blob) return
  dispose()
  void mount(blobRangeSource(blob, { id: blob.name, revision: String(blob.lastModified) }))
})

const proof = {
  open,
  compare,
  dispose,
  traverse,
  stats: () => documentSource?.stats,
  closed: () => ({ stats: closed, cancelled }),
  revealLength: () => {
    reportLength = true
  },
  holdReads: () => {
    holdReads = true
  },
  requireReadStart: (start: number) => {
    minimumReadStart = start
  },
}

declare global {
  var __paged: typeof proof
}
globalThis.__paged = proof
