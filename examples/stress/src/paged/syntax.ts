import { applyEditorTheme } from '@singapore-editor/core/rendering'
import type { EditorTokenStore } from '@singapore-editor/core/syntax'
import type { PagedFragment, PagedWindow } from '@singapore-editor/paged'
import {
  createTreeSitterSliceHighlighter,
  type TreeSitterHighlightedSlice,
  type TreeSitterHighlightSlice,
  type TreeSitterLanguageContribution,
  type TreeSitterSliceHighlightResult,
} from '@singapore-editor/tree-sitter'

const MAX_SLICE_UNITS = 8 * 1024
let nextHighlightId = 0

type FragmentSpan = { readonly from: number; readonly to: number; readonly color: string }
type PaintedFragments = {
  readonly sourceId: string
  readonly revision: string
  readonly spans: ReadonlyMap<string, readonly FragmentSpan[]>
}
type SliceFragment = {
  readonly node: Text
  readonly start: number
  readonly key: string
}
type PreparedSlice = {
  readonly slice: TreeSitterHighlightSlice
  readonly fragments: readonly SliceFragment[]
}

export type PagedSyntaxStatus =
  | { readonly kind: 'idle' | 'pending' }
  | Extract<TreeSitterSliceHighlightResult, { kind: 'plain' }>
  | {
      readonly kind: 'highlighted'
      readonly quality: TreeSitterHighlightedSlice['quality']
      readonly cached: boolean
      readonly tokens: number
      readonly requestToColorMs: number
      readonly timings: TreeSitterHighlightedSlice['timings'] | null
    }

export class PagedSyntax {
  readonly #highlighter
  readonly #prefix = `paged-syntax-${nextHighlightId++}`
  readonly #stylesheet = document.createElement('style')
  readonly #names = new Map<string, string>()
  #generation = 0
  #painted: PaintedFragments | null = null
  #status: PagedSyntaxStatus = { kind: 'idle' }

  constructor(host: HTMLElement, language: TreeSitterLanguageContribution | null) {
    applyEditorTheme(host, null)
    this.#highlighter = createTreeSitterSliceHighlighter({
      language,
      limits: { maxTextUnits: MAX_SLICE_UNITS },
    })
  }

  prewarm() {
    return this.#highlighter.prewarm()
  }

  private clear() {
    this.#generation++
    this.#highlighter.cancel()
    this.#painted = null
    this.paint([], new Map())
    this.#status = { kind: 'idle' }
  }

  dispose() {
    this.clear()
    this.#stylesheet.remove()
    this.#names.clear()
    return this.#highlighter.dispose()
  }

  inspect() {
    const retainedRenderSpans = Array.from(
      this.#painted?.spans.values() ?? [],
      (spans) => spans.length,
    ).reduce((count, spans) => count + spans, 0)
    return { ...this.#highlighter.inspect(), retainedRenderSpans, status: this.#status }
  }

  render(
    window: PagedWindow,
    elements: readonly HTMLSpanElement[],
    requestStartedAt: number,
  ): void {
    const generation = ++this.#generation
    const prepared = prepareSlice(window, elements)
    if (!prepared || !globalThis.CSS?.highlights || typeof Highlight !== 'function') {
      this.clear()
      this.#status = { kind: 'plain', reason: prepared ? 'unavailable' : 'over-budget' }
      return
    }
    const { slice, fragments } = prepared
    const cached = this.#highlighter.lookup(slice)
    const answer = this.#highlighter.highlight(slice)
    if (cached) {
      this.accept(prepared, cached, requestStartedAt, true)
      return
    }

    const previous = this.#painted
    const sameRevision =
      previous?.sourceId === slice.sourceId && previous.revision === slice.revision
    this.paint(fragments, sameRevision ? previous.spans : new Map())
    this.#status = { kind: 'pending' }
    void answer.then((result) => {
      if (this.#generation === generation) this.accept(prepared, result, requestStartedAt, false)
    })
  }

  private accept(
    { slice, fragments }: PreparedSlice,
    result: TreeSitterSliceHighlightResult,
    requestStartedAt: number,
    cached: boolean,
  ) {
    if (result.kind === 'plain') {
      this.#painted = null
      this.paint([], new Map())
      this.#status = result
      return
    }
    const spans = new Map(
      fragments.map(({ key, node, start }) => [
        key,
        projectTokens(result.tokens, start, node.length),
      ]),
    )
    this.#painted = { sourceId: slice.sourceId, revision: slice.revision, spans }
    this.paint(fragments, spans)
    this.#status = {
      kind: 'highlighted',
      quality: result.quality,
      cached,
      tokens: result.tokens.length,
      requestToColorMs: performance.now() - requestStartedAt,
      timings: cached ? null : result.timings,
    }
  }

  private paint(fragments: readonly SliceFragment[], spans: PaintedFragments['spans']): void {
    const registry = globalThis.CSS?.highlights
    if (!registry) return
    const groups = new Map<string, Highlight>()
    for (const { key, node } of fragments) {
      addRanges(groups, node, spans.get(key) ?? [])
    }
    for (const [color, name] of this.#names) {
      if (!groups.has(color)) registry.delete(name)
    }
    for (const [color, group] of groups) {
      registry.set(this.nameForColor(color), group)
    }
  }

  private nameForColor(color: string): string {
    const existing = this.#names.get(color)
    if (existing) return existing
    if (!this.#stylesheet.isConnected) document.head.append(this.#stylesheet)
    const name = `${this.#prefix}-${this.#names.size}`
    this.#stylesheet.sheet?.insertRule(`[data-text]::highlight(${name}) { color: ${color}; }`)
    this.#names.set(color, name)
    return name
  }
}

function prepareSlice(
  window: PagedWindow,
  elements: readonly HTMLSpanElement[],
): PreparedSlice | null {
  const fragments: SliceFragment[] = []
  const parts: string[] = []
  let length = 0
  for (const [index, fragment] of window.fragments.entries()) {
    const start = length
    length += fragment.text.length + fragment.lineBreak.length
    if (length > MAX_SLICE_UNITS) return null
    parts.push(fragment.text, fragment.lineBreak)
    const node = elements[index]?.firstChild
    if (node instanceof Text) fragments.push({ node, start, key: fragmentKey(fragment) })
  }
  const first = window.fragments[0]
  const last = window.fragments.at(-1)
  const location = `${first?.start.byteOffset ?? 0}:${last?.end.byteOffset ?? 0}:${last?.lineBreak === '\n' ? 1 : 0}`
  return {
    fragments,
    slice: {
      text: parts.join(''),
      sourceId: window.sourceId,
      revision: window.revision,
      location,
      startsAtSourceStart: window.atStart,
      endsAtSourceEnd: window.atEnd,
    },
  }
}

function fragmentKey(fragment: PagedFragment): string {
  return `${fragment.start.byteOffset}:${fragment.end.byteOffset}:${fragment.lineBreak === '\n' ? 1 : 0}`
}

function projectTokens(
  tokens: EditorTokenStore,
  start: number,
  length: number,
): readonly FragmentSpan[] {
  const spans: FragmentSpan[] = []
  const end = start + length
  for (let index = tokens.firstEndingAfter(start); index < tokens.length; index++) {
    const from = tokens.startAt(index)
    if (from >= end) break
    const color = tokens.styleAt(index).color
    if (color)
      spans.push({
        from: Math.max(0, from - start),
        to: Math.min(length, tokens.endAt(index) - start),
        color,
      })
  }
  return spans
}

function addRanges(
  groups: Map<string, Highlight>,
  node: Text,
  spans: readonly FragmentSpan[],
): void {
  for (const { from, to, color } of spans) {
    const group = groups.get(color) ?? new Highlight()
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    group.add(range)
    groups.set(color, group)
  }
}
