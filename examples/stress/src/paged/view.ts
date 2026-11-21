import { PAGED_PROOF_OPTIONS } from '@singapore-editor/paged'
import type {
  PagedDocument,
  PagedDocumentView,
  PagedEndpoint,
  PagedFragment,
  PagedUnavailable,
  PagedWindow,
} from '@singapore-editor/paged'

const ROW_HEIGHT = 20
const VISIBLE_ROWS = 24
const WINDOW_ROWS = VISIBLE_ROWS + 3

export type PagedViewportOptions = {
  readonly indexedLines?: boolean
  readonly renderFragments?: (window: PagedWindow, textElements: readonly HTMLSpanElement[]) => void
}

export class PagedViewport {
  readonly #view: PagedDocumentView
  readonly #status = document.createElement('p')
  readonly #rows = document.createElement('div')
  readonly #jump = document.createElement('input')
  readonly #byte = document.createElement('input')
  readonly #jumpControls = document.createElement('span')
  readonly #byteControls = document.createElement('span')
  readonly #previous: HTMLButtonElement
  readonly #next: HTMLButtonElement
  readonly #end: HTMLButtonElement
  #generation = 0
  #pendingScroll = false
  #lastScrollTop = 0
  #window: PagedWindow | null = null

  constructor(
    private readonly host: HTMLElement,
    private readonly source: PagedDocument,
    private readonly options: PagedViewportOptions = {},
  ) {
    this.#view = source.createView()
    this.#jump.type = 'number'
    this.#jump.min = '1'
    this.#jump.value = '1'
    this.#jump.setAttribute('aria-label', 'Global line number')
    this.#byte.type = 'number'
    this.#byte.min = '0'
    this.#byte.value = '0'
    this.#byte.setAttribute('aria-label', 'Byte offset')
    this.#status.setAttribute('role', 'status')
    this.#rows.setAttribute('role', 'region')
    this.#rows.setAttribute('aria-label', 'Read-only file range')
    this.#rows.tabIndex = 0
    this.#rows.style.cssText = `height:${VISIBLE_ROWS * ROW_HEIGHT}px;overflow:auto;overflow-anchor:none;font:14px/${ROW_HEIGHT}px monospace;white-space:pre`
    this.#previous = button('Previous page', () => this.previous())
    this.#next = button('Next page', () => this.next())
    this.#end = button('End', () => this.load(() => this.#view.end(WINDOW_ROWS)))
    this.#jumpControls.hidden = !options.indexedLines
    this.#jumpControls.append(
      this.#jump,
      button('Go to line', () => this.showLine(Number(this.#jump.value) - 1)),
    )
    this.#byteControls.append(
      this.#byte,
      button('Go to byte', () => this.showByte(Number(this.#byte.value))),
    )
    const controls = document.createElement('div')
    controls.append(
      button('Home', () => this.first()),
      this.#previous,
      this.#next,
      this.#end,
      this.#jumpControls,
      this.#byteControls,
    )
    this.#rows.addEventListener('scroll', () => void this.rebase())
    this.#rows.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaY >= 0 || this.#rows.scrollTop > 0 || !this.#window?.previous) return
        event.preventDefault()
        void this.previous(3)
      },
      { passive: false },
    )
    this.#rows.addEventListener('keydown', (event) => this.pageKey(event))
    this.#rows.addEventListener('copy', (event) => this.copy(event))
    host.append(controls, this.#status, this.#rows)
    this.updateControls()
  }

  first() {
    return this.load(() => this.#view.first(WINDOW_ROWS))
  }

  showLine(line: number) {
    return this.load(() => this.#view.seekLine(line, WINDOW_ROWS))
  }

  showByte(offset: number) {
    return this.load(() => this.#view.seekByte(offset, WINDOW_ROWS))
  }

  refreshMetadata() {
    this.updateControls()
    if (this.#window) this.describe(this.#window)
  }

  dispose() {
    this.#generation++
    this.#view.dispose()
    this.#window = null
    this.host.removeAttribute('aria-busy')
    this.host.replaceChildren()
  }

  private pageKey(event: KeyboardEvent) {
    switch (event.key) {
      case 'PageDown':
        void this.next()
        break
      case 'PageUp':
        void this.previous()
        break
      case 'Home':
        void this.first()
        break
      case 'End':
        if (this.#end.disabled) return
        this.#end.click()
        break
      default:
        return
    }
    event.preventDefault()
  }

  private next() {
    const cursor = this.#window?.next
    return cursor ? this.load(() => this.#view.next(cursor, WINDOW_ROWS)) : Promise.resolve()
  }

  private previous(rows = WINDOW_ROWS) {
    const current = this.#window
    const cursor = current?.previous
    if (!cursor) return Promise.resolve()
    return this.load(async () => {
      const previous = await this.#view.previous(cursor, rows)
      if (rows === WINDOW_ROWS || !previous.fragments.length) return previous
      const combined = previous.fragments.concat(current.fragments)
      const fragments = fitWindow(combined)
      const next = combined.length > fragments.length ? fragments.at(-1)!.end : current.next
      return { ...previous, atEnd: !next, next, fragments }
    })
  }

  private async rebase() {
    const current = this.#window
    const cursor = current?.next
    const top = this.#rows.scrollTop
    if (top === this.#lastScrollTop) return
    this.#lastScrollTop = top
    const drop = Math.floor(top / ROW_HEIGHT)
    if (!cursor || !drop || this.#pendingScroll || this.host.getAttribute('aria-busy') === 'true')
      return
    this.#pendingScroll = true
    try {
      await this.load(
        async () => {
          const more = await this.#view.next(cursor, Math.min(drop, WINDOW_ROWS))
          const remove = Math.min(drop, more.fragments.length)
          return {
            ...more,
            atStart: false,
            previous: current.fragments[remove]?.start ?? more.previous,
            fragments: current.fragments.slice(remove).concat(more.fragments),
          }
        },
        (window) => {
          const removed = current.fragments.findIndex(
            (fragment) => fragment === window.fragments[0],
          )
          return this.#rows.scrollTop - Math.max(0, removed) * ROW_HEIGHT
        },
      )
    } finally {
      this.#pendingScroll = false
    }
  }

  private async load(
    operation: () => Promise<PagedWindow | PagedUnavailable>,
    scrollTop: (window: PagedWindow) => number = () => 0,
  ) {
    const generation = ++this.#generation
    this.#status.textContent = 'Loading file range…'
    this.host.setAttribute('aria-busy', 'true')
    try {
      const window = await operation()
      if (generation !== this.#generation) return
      if (window.kind === 'unavailable') {
        this.#status.textContent = availability(window)
        return
      }
      this.render(window, scrollTop(window))
    } catch (error) {
      if (generation !== this.#generation) return
      this.#status.textContent =
        error instanceof Error ? error.message : 'The range could not load.'
      if (this.source.stats.state === 'stale') {
        this.#window = null
        this.#rows.replaceChildren()
      }
    } finally {
      if (generation === this.#generation) this.host.setAttribute('aria-busy', 'false')
    }
  }

  private render(window: PagedWindow, scrollTop: number) {
    this.#window = window
    const rows = window.fragments.map(rowElement)
    this.#rows.replaceChildren(...rows.map(({ row }) => row))
    this.#rows.scrollTop = scrollTop
    this.#lastScrollTop = this.#rows.scrollTop
    this.options.renderFragments?.(
      window,
      rows.map(({ text }) => text),
    )
    this.refreshMetadata()
  }

  private updateControls() {
    const byteLength = this.source.stats.totals.byteLength
    this.#previous.disabled = !this.#window?.previous
    this.#next.disabled = !this.#window?.next
    this.#end.disabled = byteLength === undefined
    this.#byteControls.hidden = byteLength === undefined
    this.#byte.max = byteLength === undefined ? '' : String(byteLength)
  }

  private describe(window: PagedWindow) {
    const first = window.fragments[0]
    const last = window.fragments.at(-1)
    const place =
      first && last && first.line !== undefined && last.line !== undefined
        ? `Lines ${first.line + 1}–${last.line + 1}`
        : `Byte ${first?.start.byteOffset ?? window.next?.byteOffset ?? 0}`
    const size = this.source.stats.totals.byteLength
    const state = window.atEnd
      ? 'End of file'
      : window.stop === 'budget'
        ? 'Read limit reached. Continue to load more.'
        : first?.continuesBefore || last?.continuesAfter
          ? 'Continued line'
          : size === undefined
            ? 'Size unknown'
            : `${size.toLocaleString()} bytes`
    this.#status.textContent = `${place} · ${state}`
  }

  private copy(event: ClipboardEvent) {
    if (this.source.stats.state !== 'open') return
    const selection = document.getSelection()
    const fragments = this.#window?.fragments
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      selection.isCollapsed ||
      !fragments ||
      !event.clipboardData
    )
      return
    const anchor = selectionEndpoint(
      this.#rows,
      fragments,
      selection.anchorNode,
      selection.anchorOffset,
    )
    const focus = selectionEndpoint(
      this.#rows,
      fragments,
      selection.focusNode,
      selection.focusOffset,
    )
    if (!anchor || !focus) return
    const [left, right] = anchor.index <= focus.index ? [anchor, focus] : [focus, anchor]
    event.clipboardData.setData('text/plain', selectionText(fragments, left, right))
    event.preventDefault()
  }
}

function fitWindow(fragments: PagedFragment[]) {
  let units = 0
  let count = 0
  for (const fragment of fragments) {
    units += fragment.text.length + fragment.lineBreak.length
    if (units > PAGED_PROOF_OPTIONS.maxWindowUnits || count === WINDOW_ROWS) break
    count++
  }
  return count === fragments.length ? fragments : fragments.slice(0, count)
}

function availability(window: PagedUnavailable) {
  if (window.reason === 'no-mapping') return 'That position is outside the mapped part of the file.'
  if (window.reason === 'unknown-length') return 'The end of the file is unknown.'
  return 'That position is outside the file.'
}

function button(label: string, action: () => Promise<void>) {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = label
  control.addEventListener('click', () => void action())
  return control
}

function rowElement(fragment: PagedFragment, index: number) {
  const row = document.createElement('div')
  row.dataset.fragment = String(index)
  row.dataset.byte = String(fragment.start.byteOffset)
  row.style.minHeight = `${ROW_HEIGHT}px`
  if (fragment.line !== undefined) row.dataset.line = String(fragment.line + 1)
  const number = document.createElement('span')
  number.textContent = fragment.continuesBefore
    ? '↪'
    : fragment.line === undefined
      ? '·'
      : String(fragment.line + 1)
  number.setAttribute('aria-hidden', 'true')
  number.style.cssText = 'display:inline-block;min-width:100px;color:#666;user-select:none'
  const text = document.createElement('span')
  text.dataset.text = ''
  text.textContent =
    fragment.lineBreak && fragment.text.endsWith('\r') ? fragment.text.slice(0, -1) : fragment.text
  row.append(number, text)
  return { row, text }
}

type VisibleEndpoint = PagedEndpoint & { index: number }

function selectionEndpoint(
  rows: HTMLElement,
  fragments: readonly PagedFragment[],
  node: Node,
  offset: number,
): VisibleEndpoint | undefined {
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest<HTMLElement>('[data-fragment]')
  if (!row || row.parentElement !== rows) return undefined
  const index = Number(row.dataset.fragment)
  const fragment = fragments[index]
  const content = row.querySelector('[data-text]')
  if (!fragment || !content) return undefined
  if (!content.contains(node)) {
    const afterText = node === row && offset >= row.childNodes.length
    return { fragment, index, column: afterText ? fragment.text.length : 0 }
  }
  const range = document.createRange()
  range.selectNodeContents(content)
  range.setEnd(node, offset)
  return { fragment, index, column: range.toString().length }
}

function selectionText(
  fragments: readonly PagedFragment[],
  left: VisibleEndpoint,
  right: VisibleEndpoint,
) {
  if (left.index === right.index)
    return left.fragment.text.slice(
      Math.min(left.column, right.column),
      Math.max(left.column, right.column),
    )
  const first = left.fragment.text.slice(left.column) + left.fragment.lineBreak
  const middle = fragments
    .slice(left.index + 1, right.index)
    .map((fragment) => fragment.text + fragment.lineBreak)
  return first + middle.join('') + right.fragment.text.slice(0, right.column)
}
