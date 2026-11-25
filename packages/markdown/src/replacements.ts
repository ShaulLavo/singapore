import './style.css'
import { TextBlockReader, type TextReadSnapshot } from '@singapore-editor/core/document'
import type { InlineReplacementSpec } from '@singapore-editor/core/rendering'
import { Kind } from 'tree-sitter-md'
import { indexMarkdownDefinitions, markdownLinkDestination } from './linkDestination'
import { renderMarkdownLinks, type MarkdownLink, type MarkdownLinkOptions } from './linkRender'

type Span = { readonly start: number; readonly end: number }
type Container = Span & { readonly order: number }
type PendingMarkerOwner = Span & {
  readonly from: number
  readonly to: number
}

const BACKTICK_CODE = 0x60
const SPACE_CODE = 0x20
const TILDE_CODE = 0x7e

/** Inline replacements returned in a new array owned by the caller. */
export function markdownInlineReplacements(
  text: TextReadSnapshot,
  records: Uint32Array,
  options: MarkdownLinkOptions = {},
): InlineReplacementSpec[] {
  const reader = new TextBlockReader(text)
  const specs: InlineReplacementSpec[] = []
  const links: (Span & { readonly kind: number })[] = []
  const renderedLinks: MarkdownLink[] = []
  const containers = collectContainers(records)
  const pendingOwners = new Map<number, PendingMarkerOwner[]>()
  let cachedDefinitions: ReadonlyMap<string, string | null> | null = null
  const linkLookupOptions = {
    reader,
    definitions: () => {
      cachedDefinitions ??= indexMarkdownDefinitions(text, records, reader)
      return cachedDefinitions
    },
  }

  for (let index = 0; index < records.length; index += 4) {
    const start = records[index]!,
      end = records[index + 1]!
    const kind = records[index + 2]!,
      extra = records[index + 3]!
    if (end <= start) continue
    if (kind === Kind.Link || kind === Kind.Image) links.push({ start, end, kind })
    if (kind === Kind.LinkText) {
      while (links.length && (links.at(-1)!.start > start || links.at(-1)!.end < end)) links.pop()
      const link = links.pop()
      const href =
        link?.kind === Kind.Link
          ? markdownLinkDestination(text, link, { start, end }, records, linkLookupOptions)
          : null
      if (link?.kind === Kind.Image || href !== null)
        appendLink(specs, reader, link, { start, end })
      if (link && href !== null) renderedLinks.push({ span: link, label: { start, end }, href })
    }
    const before = specs.length
    appendMarker(specs, reader, { start, end }, kind, extra)
    if (specs.length > before) {
      const parent = markerParentKind(kind)
      if (parent !== undefined && containers.byKind.has(parent)) {
        let bucket = pendingOwners.get(parent)
        if (!bucket) {
          bucket = []
          pendingOwners.set(parent, bucket)
        }
        bucket.push({ from: before, to: specs.length, start, end })
      }
    }
  }

  for (const [parentKind, markers] of pendingOwners) {
    const parentContainers = containers.byKind.get(parentKind)
    if (parentContainers && parentContainers.length > 0) {
      assignMarkerOwners(specs, markers, parentContainers)
    }
  }

  renderMarkdownLinks(specs, text, renderedLinks, options)
  return preserveTableWidths(specs, text, containers.tables)
}

function preserveTableWidths(
  specs: InlineReplacementSpec[],
  source: TextReadSnapshot,
  tables: readonly Container[],
): InlineReplacementSpec[] {
  if (tables.length === 0 || specs.length === 0) return specs

  const sortedTables = sortSpansByStart(tables)
  const specOrder = sortedSpecIndices(specs)
  let tableIndex = 0
  const activeTables: Container[] = []

  for (let orderPos = 0; orderPos < specOrder.length; orderPos++) {
    const specIndex = specOrder[orderPos]!
    const spec = specs[specIndex]!
    while (tableIndex < sortedTables.length && sortedTables[tableIndex]!.start <= spec.startIndex) {
      const table = sortedTables[tableIndex++]!
      if (table.end >= spec.startIndex) activeTables.push(table)
    }
    if (activeTables.length === 0) continue

    let write = 0
    let insideTable = false
    for (let i = 0; i < activeTables.length; i++) {
      const table = activeTables[i]!
      if (table.end < spec.startIndex) continue
      activeTables[write++] = table
      if (table.end >= spec.endIndex) insideTable = true
    }
    activeTables.length = write
    if (!insideTable) continue

    const width = Math.max(0, Math.min(source.length, spec.endIndex) - Math.max(0, spec.startIndex))
    const padding = ' '.repeat(Math.max(0, width - spec.text.length))
    if (!padding) continue
    const render = spec.render
    specs[specIndex] = {
      ...spec,
      text: spec.text + padding,
      className: 'editor-markdown-text',
      render: paddedRender(render, spec.text.length),
    }
  }

  return specs
}

function paddedRender(
  render: InlineReplacementSpec['render'],
  textLength: number,
): InlineReplacementSpec['render'] {
  return (container, displayText, displayStart) => {
    const labelLength = Math.max(0, Math.min(displayText.length, textLength - displayStart))
    const text = displayText.slice(0, labelLength)
    const padding = displayText.slice(labelLength)
    const disposable = labelLength > 0 ? render?.(container, text, displayStart) : undefined
    if (!render) container.append(text)
    const spacer = container.ownerDocument.createElement('span')
    spacer.className = 'editor-markdown-padding'
    spacer.textContent = padding
    spacer.ariaHidden = 'true'
    container.append(spacer)
    return disposable
  }
}

function appendMarker(
  specs: InlineReplacementSpec[],
  reader: TextBlockReader,
  span: Span,
  kind: number,
  extra: number,
): void {
  const group = `${kind}:${span.start}:${span.end}`
  if (
    kind === Kind.Emphasis ||
    kind === Kind.Strong ||
    kind === Kind.Strikethrough ||
    kind === Kind.CodeSpan
  ) {
    const count = delimiterLength(reader, span, kind)
    specs.push(replacement(span.start, span.start + count, '', 'marker', group))
    specs.push(replacement(span.end - count, span.end, '', 'marker', group))
    return
  }
  if (kind === Kind.HeadingMark) {
    const end = span.end + leadingSpaces(reader, span.end)
    specs.push(replacement(span.start, end, '', `heading-marker-${extra}`, group))
    return
  }
  if (kind === Kind.FenceMark || kind === Kind.CodeInfo) {
    specs.push(replacement(span.start, span.end, '', 'fence-marker', group))
    return
  }
  if (kind === Kind.Task) {
    specs.push(replacement(span.start, span.end, extra ? '☑' : '☐', 'task-marker', group))
    return
  }
  if (kind !== Kind.ListMark && kind !== Kind.QuoteMark) return
  const source = reader.slice(span.start, span.end)
  if (kind === Kind.ListMark && /^[-*+]/.test(source)) {
    specs.push(replacement(span.start, span.end, `•${source.slice(1)}`, 'list-marker', group))
  }
  if (kind === Kind.QuoteMark) {
    specs.push(replacement(span.start, span.end, `│${source.slice(1)}`, 'quote-marker', group))
  }
}

function delimiterLength(reader: TextBlockReader, span: Span, kind: number): number {
  if (kind === Kind.Strong) return 2
  if (kind === Kind.Emphasis) return 1
  if (kind === Kind.Strikethrough) {
    return reader.charCodeAt(span.start) === TILDE_CODE &&
      reader.charCodeAt(span.start + 1) === TILDE_CODE
      ? 2
      : 1
  }
  let count = 0
  while (span.start + count < span.end && reader.charCodeAt(span.start + count) === BACKTICK_CODE) {
    count++
  }
  return count
}

function appendLink(
  specs: InlineReplacementSpec[],
  reader: TextBlockReader,
  link: Span | undefined,
  label: Span,
): void {
  if (!link) return
  const group = `link:${link.start}:${link.end}`
  appendHiddenLines(specs, reader, link.start, label.start, 'link-marker', group, link)
  appendHiddenLines(specs, reader, label.end, link.end, 'link-target', group, link)
}

function appendHiddenLines(
  specs: InlineReplacementSpec[],
  reader: TextBlockReader,
  start: number,
  end: number,
  kind: string,
  group: string,
  owner: Span,
): void {
  const source = reader.slice(start, end)
  let offset = start
  for (const line of source.split(/(\r?\n)/)) {
    if (line && !line.includes('\n'))
      specs.push({
        ...replacement(offset, offset + line.length, '', kind, group),
        revealRange: owner,
      })
    offset += line.length
  }
}

function replacement(
  startIndex: number,
  endIndex: number,
  text: string,
  kind: string,
  groupId: string,
): InlineReplacementSpec {
  return { id: `${kind}:${startIndex}:${endIndex}`, startIndex, endIndex, text, kind, groupId }
}

function leadingSpaces(reader: TextBlockReader, offset: number): number {
  let count = 0
  while (offset + count < reader.length && reader.charCodeAt(offset + count) === SPACE_CODE) {
    count++
  }
  return count
}

type CollectedContainers = {
  readonly byKind: ReadonlyMap<number, readonly Container[]>
  readonly tables: readonly Container[]
}

function collectContainers(records: Uint32Array): CollectedContainers {
  const byKind = new Map<number, Container[]>()
  const tables: Container[] = []
  let order = 0
  for (let i = 0; i < records.length; i += 4) {
    const kind = records[i + 2]!
    if (kind === Kind.Table) {
      tables.push({ start: records[i]!, end: records[i + 1]!, order: order++ })
      continue
    }
    if (
      kind === Kind.Heading ||
      kind === Kind.CodeBlock ||
      kind === Kind.BlockQuote ||
      kind === Kind.ListItem
    ) {
      let bucket = byKind.get(kind)
      if (!bucket) {
        bucket = []
        byKind.set(kind, bucket)
      }
      bucket.push({ start: records[i]!, end: records[i + 1]!, order: order++ })
    }
  }
  return { byKind, tables }
}

function assignMarkerOwners(
  specs: InlineReplacementSpec[],
  markers: readonly PendingMarkerOwner[],
  containers: readonly Container[],
): void {
  const sortedContainers = sortContainersByStart(containers)
  const sortedMarkers = sortSpansByStart(markers)
  let containerIndex = 0
  const active: Container[] = []
  let activeNested = true

  for (const marker of sortedMarkers) {
    while (
      containerIndex < sortedContainers.length &&
      sortedContainers[containerIndex]!.start <= marker.start
    ) {
      const next = sortedContainers[containerIndex++]!
      if (next.end < marker.start) continue
      while (activeNested && active.length > 0 && active[active.length - 1]!.end < marker.start) {
        active.pop()
      }
      if (active.length > 0) {
        const top = active[active.length - 1]!
        if (next.end > top.end || next.order < top.order) activeNested = false
      }
      active.push(next)
    }

    if (activeNested) {
      while (active.length > 0 && active[active.length - 1]!.end < marker.start) {
        active.pop()
      }
      let owner: Container | undefined
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i]!.end >= marker.end) {
          owner = active[i]
          break
        }
      }
      if (owner) applyRevealRange(specs, marker.from, marker.to, owner)
      continue
    }

    let write = 0
    let owner: Container | undefined
    for (let i = 0; i < active.length; i++) {
      const candidate = active[i]!
      if (candidate.end < marker.start) continue
      active[write++] = candidate
      if (candidate.end >= marker.end && (!owner || candidate.order > owner.order)) {
        owner = candidate
      }
    }
    active.length = write
    if (owner) applyRevealRange(specs, marker.from, marker.to, owner)
  }
}

function sortContainersByStart(containers: readonly Container[]): readonly Container[] {
  for (let i = 1; i < containers.length; i++) {
    const prev = containers[i - 1]!
    const curr = containers[i]!
    if (prev.start > curr.start || (prev.start === curr.start && prev.order > curr.order)) {
      return containers.toSorted(
        (left, right) => left.start - right.start || left.order - right.order,
      )
    }
  }
  return containers
}

function sortSpansByStart<T extends Span>(spans: readonly T[]): readonly T[] {
  for (let i = 1; i < spans.length; i++) {
    if (spans[i - 1]!.start > spans[i]!.start) {
      return spans.toSorted((left, right) => left.start - right.start)
    }
  }
  return spans
}

function sortedSpecIndices(specs: readonly InlineReplacementSpec[]): Uint32Array {
  const order = new Uint32Array(specs.length)
  let sorted = true
  for (let i = 0; i < specs.length; i++) {
    order[i] = i
    if (i > 0 && specs[i - 1]!.startIndex > specs[i]!.startIndex) sorted = false
  }
  if (sorted) return order
  return order.sort((left, right) => specs[left]!.startIndex - specs[right]!.startIndex)
}

function markerParentKind(kind: number): number | undefined {
  if (kind === Kind.HeadingMark) return Kind.Heading
  if (kind === Kind.FenceMark || kind === Kind.CodeInfo) return Kind.CodeBlock
  if (kind === Kind.QuoteMark) return Kind.BlockQuote
  if (kind === Kind.ListMark || kind === Kind.Task) return Kind.ListItem
  return undefined
}

function applyRevealRange(
  specs: InlineReplacementSpec[],
  from: number,
  to: number,
  owner: Span,
): void {
  const revealRange: Span = { start: owner.start, end: owner.end }
  for (let i = from; i < to; i++) {
    specs[i] = { ...specs[i]!, revealRange }
  }
}
