/**
 * Copying a page selection that runs through editors and document snapshots.
 *
 * Editor rows and snapshot rows are absolutely positioned, so the browser's own serialization runs
 * their lines together and, for an editor, sees only the rows it happens to have in the DOM. A copy
 * whose selection reaches one of these regions is rebuilt here: page text around them comes from
 * the browser, and each region contributes its own text with real line breaks.
 */

/** Reads a live editor's part of a page selection; boundaries outside the editor clamp to its ends. */
export type SelectionCopySource = (range: Range) => string | null

const SOURCE_ATTRIBUTE = 'data-editor-selection-copy'
const PAINT_SELECTOR = '[data-editor-document-paint]'
// Registered symbols, so separately bundled copies of this module share sources and one listener.
const SOURCE = Symbol.for('@singapore-editor/core/selection-copy-source')
const INSTALL = Symbol.for('@singapore-editor/core/selection-copy-install')
type Install = { count: number; readonly listener: (event: ClipboardEvent) => void }
type WithSource = { [SOURCE]?: SelectionCopySource }
type WithInstall = { [INSTALL]?: Install }

/** Lets copies that run through `element` read its text from `source` instead of its rows. */
export function registerSelectionCopySource(
  element: HTMLElement,
  source: SelectionCopySource,
): () => void {
  const holder = element as WithSource
  holder[SOURCE] = source
  element.setAttribute(SOURCE_ATTRIBUTE, '')
  const release = installSelectionCopy(element.ownerDocument)
  return () => {
    release()
    if (holder[SOURCE] !== source) return
    delete holder[SOURCE]
    element.removeAttribute(SOURCE_ATTRIBUTE)
  }
}

/**
 * Installs the document's copy handler. Calls share one listener, across bundles too; each returned
 * release undoes one call.
 */
export function installSelectionCopy(document: Document): () => void {
  const holder = document as WithInstall
  const install: Install = holder[INSTALL] ?? {
    count: 0,
    listener: (event) => handleCopy(document, event),
  }
  if (install.count === 0) {
    holder[INSTALL] = install
    document.addEventListener('copy', install.listener)
  }
  install.count++
  let released = false
  return () => {
    if (released) return
    released = true
    install.count--
    if (install.count > 0) return
    delete holder[INSTALL]
    document.removeEventListener('copy', install.listener)
  }
}

/** Whether the page selection runs into `element` from outside, so the document's handler copies it. */
export function selectionLeavesElement(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  // A page selection elsewhere says nothing about a copy aimed at the editor.
  if (!range.intersectsNode(element)) return false
  return !element.contains(range.startContainer) || !element.contains(range.endContainer)
}

function handleCopy(document: Document, event: ClipboardEvent): void {
  if (event.defaultPrevented || !event.clipboardData) return
  const copied = composeSelectionCopy(document)
  if (!copied) return
  event.clipboardData.setData('text/plain', copied.text)
  event.clipboardData.setData('text/html', copied.html)
  event.preventDefault()
}

type Region = { readonly element: Element; readonly text: string }
type Part = { readonly page: boolean; readonly text: string; readonly html: string }

export function composeSelectionCopy(
  document: Document,
): { readonly text: string; readonly html: string } | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const regions = regionsInRange(range)
  if (!regions || regions.length === 0) return null
  // A selection inside one editor is that editor's to copy, including its multiple carets.
  const [first] = regions
  if (
    regions.length === 1 &&
    first!.element.hasAttribute(SOURCE_ATTRIBUTE) &&
    first!.element.contains(range.startContainer) &&
    first!.element.contains(range.endContainer)
  )
    return null

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  const parts: Part[] = []
  try {
    let from = range.cloneRange()
    for (const region of regions) {
      if (!region.element.contains(range.startContainer)) {
        from.setEndBefore(region.element)
        parts.push(pagePart(selection, from))
      }
      parts.push({ page: false, text: region.text, html: `<pre>${escapeHtml(region.text)}</pre>` })
      from = document.createRange()
      from.setStartAfter(region.element)
      from.setEnd(range.endContainer, range.endOffset)
    }
    if (!regions[regions.length - 1]!.element.contains(range.endContainer))
      parts.push(pagePart(selection, from))
  } finally {
    if (anchorNode && focusNode)
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  }
  return { text: joinText(parts), html: parts.map((part) => part.html).join('') }
}

function regionsInRange(range: Range): readonly Region[] | null {
  const root = range.commonAncestorContainer
  const scope = root.nodeType === 1 ? (root as Element) : root.parentElement
  if (!scope) return null
  const enclosing = scope.closest(`[${SOURCE_ATTRIBUTE}], ${PAINT_SELECTOR}`)
  const candidates = enclosing
    ? [enclosing]
    : Array.from(scope.querySelectorAll(`[${SOURCE_ATTRIBUTE}], ${PAINT_SELECTOR}`))
  const regions: Region[] = []
  for (const element of candidates) {
    if (!range.intersectsNode(element) || !isShown(element)) continue
    // Snapshot paint inside a mounting editor belongs to that editor.
    if (element.parentElement?.closest(`[${SOURCE_ATTRIBUTE}], ${PAINT_SELECTOR}`)) continue
    const text = element.hasAttribute(SOURCE_ATTRIBUTE)
      ? ((element as WithSource)[SOURCE]?.(range) ?? null)
      : paintText(element, range)
    // An editor that cannot read its part leaves the whole copy to the browser.
    if (text === null) return null
    regions.push({ element, text })
  }
  return regions
}

/** Hidden alternatives, such as a snapshot for another width or an editor still preparing. */
function isShown(element: Element): boolean {
  if (typeof element.checkVisibility === 'function')
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  return element.getClientRects().length > 0
}

/** A snapshot's selected text: its rows' text, with a line break wherever a source line ends. */
function paintText(root: Element, range: Range): string {
  let text = ''
  let previousLine: string | undefined
  for (const row of Array.from(
    root.querySelectorAll<HTMLElement>('[data-editor-document-paint-row]'),
  )) {
    if (!range.intersectsNode(row)) continue
    const line = row.dataset.editorDocumentPaintSourceRow
    if (previousLine !== undefined && line !== previousLine) text += '\n'
    previousLine = line
    const content = row.textContent ?? ''
    const start = row.contains(range.startContainer)
      ? offsetInRow(row, range.startContainer, range.startOffset)
      : 0
    const end = row.contains(range.endContainer)
      ? offsetInRow(row, range.endContainer, range.endOffset)
      : content.length
    text += content.slice(start, end)
  }
  return text
}

function offsetInRow(row: Element, node: Node, offset: number): number {
  const prefix = row.ownerDocument.createRange()
  prefix.setStart(row, 0)
  prefix.setEnd(node, offset)
  return prefix.toString().length
}

/** A stretch of page, as the browser itself would copy it: plain text with its block breaks. */
function pagePart(selection: Selection, range: Range): Part {
  if (range.collapsed) return { page: true, text: '', html: '' }
  selection.removeAllRanges()
  selection.addRange(range)
  const holder = range.startContainer.ownerDocument!.createElement('div')
  holder.append(range.cloneContents())
  return { page: true, text: selection.toString(), html: holder.innerHTML }
}

/** Each part keeps the line breaks it brought; a line break joins parts that meet mid-line. */
function joinText(parts: readonly Part[]): string {
  let text = ''
  for (const part of parts) {
    if (!part.text) continue
    text =
      text && !text.endsWith('\n') && !part.text.startsWith('\n')
        ? `${text}\n${part.text}`
        : text + part.text
  }
  return text
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
