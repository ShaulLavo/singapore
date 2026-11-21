import '@singapore-editor/core/style.css'
import { PagedDocument, type RangeSource } from '@singapore-editor/paged'
import { TYPESCRIPT_TREE_SITTER_LANGUAGE } from '@singapore-editor/tree-sitter-languages'
import { PagedSyntax } from './syntax'
import { PagedViewport } from './view'

const header = ['/* Paged 🦊', ' * e\u0301 中 */', 'export const page = "00000000";']
const replacementBlock = 320_000
const encoder = new TextEncoder()
const tile = codeTile('export const label = `Group ${page}`;')
const replacementTile = codeTile('export function read() { return 42 }')
const headerText = header.join('\r\n')
const marker = encoder.encode(headerText.slice(0, headerText.indexOf('00000000'))).length
const blocks = Math.ceil((64 * 1024 * 1024) / tile.length)
const length = blocks * tile.length

type CodeOptions = {
  readonly prewarmed?: boolean
  readonly language?: 'typescript' | 'unsupported'
  readonly giantLine?: boolean
}
type SourceRead = { readonly start: number; readonly end: number }
type CodeView = {
  readonly source: PagedDocument
  readonly viewport: PagedViewport
  readonly syntax: PagedSyntax
  readonly reads: readonly SourceRead[]
}

let current: CodeView | null = null
let revision = 0

async function open(options: CodeOptions = {}) {
  dispose()
  const host = document.querySelector<HTMLElement>('#view')
  if (!host) throw new Error('Missing paged code viewport')
  const reads: SourceRead[] = []
  const source = new PagedDocument(codeSource(options, reads, String(++revision)))
  const language = options.language === 'unsupported' ? null : TYPESCRIPT_TREE_SITTER_LANGUAGE
  const syntax = new PagedSyntax(host, language)
  const viewport = new PagedViewport(host, source, {
    onWindowCleared: () => void syntax.dispose(),
    renderFragments: (window, elements, startedAt) => syntax.render(window, elements, startedAt),
  })
  current = { source, syntax, viewport, reads }
  const warmed = syntax.prewarm()
  if (options.prewarmed) await warmed
  await viewport.first()
  return inspect()
}

function codeSource(
  options: CodeOptions,
  reads: SourceRead[],
  openedRevision: string,
): RangeSource {
  return {
    id: 'paged-typescript',
    revision: openedRevision,
    async readBytes(start, end, signal) {
      signal.throwIfAborted()
      if (reads.length < 256) reads.push({ start, end })
      const to = Math.min(end, length)
      const bytes = new Uint8Array(Math.max(0, to - start))
      if (options.giantLine) bytes.fill(120)
      else fillCode(bytes, start)
      return { revision: String(revision), bytes, eof: to >= length }
    },
  }
}

function fillCode(bytes: Uint8Array, start: number): void {
  let cursor = 0
  while (cursor < bytes.length) {
    const offset = start + cursor
    const within = offset % tile.length
    const count = Math.min(tile.length - within, bytes.length - cursor)
    const block = Math.floor(offset / tile.length)
    const source = block === replacementBlock ? replacementTile : tile
    bytes.set(source.subarray(within, within + count), cursor)
    const id = String(block).padStart(8, '0')
    const to = Math.min(within + count, marker + id.length)
    for (let at = Math.max(marker, within); at < to; at++) {
      bytes[cursor + at - within] = id.charCodeAt(at - marker)
    }
    cursor += count
  }
}

function codeTile(line: string): Uint8Array {
  return encoder.encode(header.concat([line.padEnd(40), '']).join('\r\n'))
}

function inspect() {
  if (!current) return null
  return {
    source: current.source.stats,
    reads: current.reads,
    syntax: current.syntax.inspect(),
  }
}

function dispose(): void {
  if (!current) return
  void current.syntax.dispose()
  current.viewport.dispose()
  current.source.dispose()
  current = null
}

const proof = {
  open,
  inspect,
  dispose,
  tileBytes: tile.length,
  fixtureBytes: length,
  replacementBlock,
  revise: () => revision++,
  showByte: (offset: number) => current?.viewport.showByte(offset),
}

declare global {
  var __pagedCode: typeof proof
}

globalThis.__pagedCode = proof
document.querySelector('#close')?.addEventListener('click', dispose)
if (!new URL(location.href).searchParams.has('proof')) void open()
