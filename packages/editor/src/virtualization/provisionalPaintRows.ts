import type { SavedPaint, SavedPaintRow } from '../editor/paintSnapshot'
import type { EditorGutterContribution } from '../plugins'
import { invalidateRowPresentations } from '../rowPresentation'
import { releaseNativeRowGeometry } from './virtualizedTextViewGeometry'
import { markRowRetired } from './virtualizedTextViewHelpers'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import {
  createRow,
  forgetCursorLineGutterBand,
  getMountedRows,
  setCursorLineGutterBand,
} from './virtualizedTextViewRows'
import type { MountedVirtualizedTextRow } from './virtualizedTextViewTypes'

// Saved viewport paint (format 5): drawn into pooled rows until the live document takes over.
// Only the paint snapshot plugin loads this module.

type PaintedProvisionalRow = {
  readonly row: SavedPaintRow
  readonly slot: MountedVirtualizedTextRow
}

const SELECTION_PAINT_LAYER_ID = 'editor.selection'

/** The row pool owns these nodes; provisional slots never enter the document row map. */
export function paintProvisionalRows(
  view: VirtualizedTextViewInternal,
  paint: SavedPaint,
): (() => void) | null {
  const paintedRows: PaintedProvisionalRow[] = []
  for (const row of view.rowElements.values()) {
    invalidateRowPresentations(row.element)
    releaseNativeRowGeometry(row)
    markRowRetired(row)
    row.element.remove()
    row.gutterElement.remove()
    view.rowPool.push(row)
  }
  view.rowElements.clear()
  for (const row of paint.rows) {
    const slot = view.rowPool.pop() ?? createRow(view)
    if (slot) paintedRows.push({ row, slot })
    if (slot && paintProvisionalRow(view, slot, row, paint)) continue
    for (const { slot: created } of paintedRows) releaseProvisionalSlot(view, created)
    return null
  }
  const rectangles = paint.layers.flatMap((layer) =>
    layer.rectangles.map((rectangle) =>
      mountSavedPaintLayerRectangle(view, paint, paintedRows, layer.id, rectangle),
    ),
  )
  return () => {
    for (const rectangle of rectangles) rectangle.remove()
    for (const { slot } of paintedRows) releaseProvisionalSlot(view, slot)
  }
}

function mountSavedPaintLayerRectangle(
  view: VirtualizedTextViewInternal,
  paint: SavedPaint,
  paintedRows: readonly PaintedProvisionalRow[],
  layerId: string,
  rectangle: SavedPaint['layers'][number]['rectangles'][number],
): HTMLDivElement {
  const element = view.scrollElement.ownerDocument.createElement('div')
  element.dataset.editorSavedPaintLayer = layerId
  const matchedRow =
    layerId === SELECTION_PAINT_LAYER_ID
      ? findProvisionalRowForRectangle(paintedRows, rectangle)
      : null
  if (matchedRow) {
    Object.assign(element.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '-1',
      left: `${rectangle.left - paint.gutterWidth}px`,
      top: `${rectangle.top - matchedRow.row.top}px`,
      width: `${rectangle.width}px`,
      height: `${rectangle.height}px`,
      backgroundColor: rectangle.backgroundColor,
    })
    matchedRow.slot.element.insertBefore(element, matchedRow.slot.element.firstChild)
    return element
  }
  Object.assign(element.style, {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: layerId === SELECTION_PAINT_LAYER_ID ? '0' : '1',
    left: `${rectangle.left}px`,
    top: `${rectangle.top}px`,
    width: `${rectangle.width}px`,
    height: `${rectangle.height}px`,
    backgroundColor: rectangle.backgroundColor,
  })
  view.spacer.appendChild(element)
  return element
}

function findProvisionalRowForRectangle(
  paintedRows: readonly PaintedProvisionalRow[],
  rectangle: SavedPaint['layers'][number]['rectangles'][number],
): PaintedProvisionalRow | null {
  const centerY = rectangle.top + rectangle.height / 2
  const byCenter = paintedRows.find(
    ({ row }) => centerY >= row.top && centerY < row.top + row.height,
  )
  if (byCenter) return byCenter
  const bottom = rectangle.top + rectangle.height
  return (
    paintedRows.find(({ row }) => rectangle.top < row.top + row.height && bottom > row.top) ?? null
  )
}

function paintProvisionalRow(
  view: VirtualizedTextViewInternal,
  slot: MountedVirtualizedTextRow,
  row: SavedPaintRow,
  paint: SavedPaint,
): boolean {
  slot.element.className = 'editor-virtualized-row'
  slot.gutterElement.className = 'editor-virtualized-gutter-row'
  forgetCursorLineGutterBand(slot.gutterElement)
  delete slot.element.dataset.editorVirtualWindowStart
  delete slot.element.dataset.editorVirtualWindowEnd
  slot.element.classList.toggle('editor-virtualized-cursor-line-row', row.cursor)
  slot.element.removeAttribute('data-editor-virtual-row')
  slot.element.dataset.editorProvisionalRow = ''
  Object.assign(slot.element.style, {
    top: `${row.top}px`,
    backgroundColor: row.backgroundColor,
    color: row.color,
    transform: '',
    height: `${row.height}px`,
    lineHeight: `${row.height}px`,
    left: `${paint.gutterWidth}px`,
    minWidth: `${Math.max(0, paint.scrollWidth - paint.gutterWidth)}px`,
  })
  slot.element.replaceChildren()
  if (row.left > 0) {
    slot.leftSpacerElement.style.width = `${row.left}px`
    slot.element.appendChild(slot.leftSpacerElement)
  }
  for (const segment of row.segments) {
    const span = view.scrollElement.ownerDocument.createElement('span')
    span.textContent = segment.text
    if (segment.kind === 'control') span.className = 'editor-virtualized-control-character'
    if (segment.kind === 'refusal') span.className = 'editor-virtualized-bidi-ceiling'
    if (segment.width > 0) span.style.width = `${segment.width}px`
    Object.assign(span.style, {
      color: segment.color,
      backgroundColor: segment.backgroundColor,
      textDecoration: segment.textDecoration,
    })
    slot.element.appendChild(span)
  }
  if (row.fold === 'collapsed') {
    slot.foldPlaceholderElement.hidden = false
    slot.element.appendChild(slot.foldPlaceholderElement)
  }
  if (!paintProvisionalGutter(view, slot, row, paint)) return false
  view.spacer.appendChild(slot.element)
  return true
}

function paintProvisionalGutter(
  view: VirtualizedTextViewInternal,
  slot: MountedVirtualizedTextRow,
  row: SavedPaintRow,
  paint: SavedPaint,
): boolean {
  slot.gutterElement.removeAttribute('data-editor-virtual-gutter-row')
  Object.assign(slot.gutterElement.style, {
    top: `${row.top}px`,
    transform: '',
    height: `${row.height}px`,
  })
  for (const lane of paint.gutterLayout.lanes) {
    const cell = slot.gutterCells.get(lane.id)
    if (!cell) return false
    cell.style.width = `${lane.width}px`
    cell.classList.toggle(
      'editor-virtualized-cursor-line-gutter',
      row.activeLanes.includes(lane.id),
    )
    const renderer = view.gutterContributions.find(
      (contribution) => contribution.id === lane.id,
    )?.snapshotRenderer
    const savedCell = row.gutterCells.find((saved) => saved.id === lane.id)
    if (!renderer || !savedCell || !restoreSavedGutter(renderer, cell, savedCell.paint))
      return false
  }
  setCursorLineGutterBand(
    slot.gutterElement,
    paint.gutterLayout.leadingInset > 0 &&
      view.cursorLineHighlight.gutterBackground === true &&
      row.activeLanes.length > 0,
  )
  slot.gutterElement.style.backgroundColor = row.gutterBackgroundColor
  view.gutterElement.appendChild(slot.gutterElement)
  return true
}

function restoreSavedGutter(
  renderer: NonNullable<EditorGutterContribution['snapshotRenderer']>,
  cell: HTMLElement,
  paint: string,
): boolean {
  try {
    return renderer.restore(cell, paint)
  } catch {
    return false
  }
}

function releaseProvisionalSlot(
  view: VirtualizedTextViewInternal,
  slot: MountedVirtualizedTextRow,
): void {
  slot.element.remove()
  slot.gutterElement.remove()
  slot.element.removeAttribute('data-editor-provisional-row')
  slot.element.removeAttribute('style')
  slot.gutterElement.removeAttribute('style')
  slot.element.className = 'editor-virtualized-row'
  slot.gutterElement.className = 'editor-virtualized-gutter-row'
  forgetCursorLineGutterBand(slot.gutterElement)
  delete slot.element.dataset.editorVirtualWindowStart
  delete slot.element.dataset.editorVirtualWindowEnd
  slot.textNode.data = ''
  slot.element.replaceChildren(slot.textNode)
  slot.foldPlaceholderElement.hidden = true
  Object.assign(slot, {
    index: -1,
    textRevision: -1,
    text: '',
    inlineMapping: null,
    chunks: [],
    chunkKey: '',
    geometryCache: null,
    top: Number.NaN,
    height: Number.NaN,
    leftSpacerWidth: 0,
    textRenderMode: 'simple',
    cursorLineContentActive: false,
    gutterNumberCursorLine: false,
    gutterCursorLineBackgroundLaneIds: [],
    selectionLayerKey: '',
    hiddenCharactersKey: '',
    foldMarkerKey: '',
    foldCollapsed: false,
    rowDecorationClassName: '',
    rowDecorationGutterClassName: '',
    rowDecorationKey: '',
    rowDecorationSnapshotStyle: false,
    inlineKindsClassName: '',
    hasTokenSpans: false,
    baseDomRevision: slot.baseDomRevision + 1,
  })
  view.rowPool.push(slot)
}

export function captureGutterPaint(
  view: VirtualizedTextViewInternal,
): readonly SavedPaintRow['gutterCells'][] | null {
  const captured: SavedPaintRow['gutterCells'][] = []
  for (const row of getMountedRows(view)) {
    const cells = captureRowGutterPaint(view, row)
    if (cells === null) return null
    captured.push(cells)
  }
  return captured
}

function captureRowGutterPaint(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): SavedPaintRow['gutterCells'] | null {
  const cells: { id: string; paint: string }[] = []
  for (const contribution of view.gutterContributions) {
    const cell = row.gutterCells.get(contribution.id)
    const paint = cell && contribution.snapshotRenderer?.capture(cell)
    if (paint === undefined || paint === null) return null
    cells.push({ id: contribution.id, paint })
  }
  return cells
}
