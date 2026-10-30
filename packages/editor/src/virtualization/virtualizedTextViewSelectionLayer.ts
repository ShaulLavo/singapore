import { setStyleValue } from './virtualizedTextViewHelpers'
import {
  beginRowRectMeasurements,
  endRowRectMeasurements,
  rangeSegments,
} from './virtualizedTextViewGeometry'
import type {
  VirtualizedStoredSelection,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'
import type { MountedVirtualizedTextRow } from './virtualizedTextViewTypes'

type SelectionSegment = {
  readonly left: number
  readonly width: number
}

const SELECTION_RECT_MERGE_EPSILON = 0.9

/**
 * Every row is measured before any layer is written. A layer write dirties layout, so measuring and
 * writing row by row forces one full layout per mounted row, which is every row in content mode.
 * The layers are absolutely positioned and cannot move the text measured under them.
 */
export function renderSelectionLayer(view: VirtualizedTextViewInternal): void {
  const measured = measureSelectionLayers(view)
  for (const [row, segments] of measured) writeSelectionLayerForRow(row, segments)
}

function measureSelectionLayers(
  view: VirtualizedTextViewInternal,
): readonly (readonly [MountedVirtualizedTextRow, readonly SelectionSegment[]])[] {
  beginRowRectMeasurements()
  try {
    return Array.from(
      view.rowElements.values(),
      (row) => [row, selectionSegmentsForRow(view, row)] as const,
    )
  } finally {
    endRowRectMeasurements()
  }
}

export function clearSelectionLayer(view: VirtualizedTextViewInternal): void {
  for (const row of view.rowElements.values()) {
    if (!row.selectionLayerElement.parentElement) continue
    clearSelectionLayerForRow(row)
  }
}

function writeSelectionLayerForRow(
  row: MountedVirtualizedTextRow,
  segments: readonly SelectionSegment[],
): void {
  if (segments.length === 0) {
    clearSelectionLayerForRow(row)
    return
  }

  const key = selectionSegmentKey(segments)
  if (row.selectionLayerKey === key) {
    attachSelectionLayer(row)
    return
  }

  setSelectionLayerKey(row, key)
  row.selectionLayerElement.replaceChildren(
    ...segments.map((segment) => createSelectionElement(row, segment)),
  )
  attachSelectionLayer(row)
}

function selectionSegmentsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): readonly SelectionSegment[] {
  if (row.kind !== 'text') return []

  const segments: SelectionSegment[] = []
  for (const selection of view.selections)
    appendSelectionSegmentForRange(segments, view, row, selection)

  return mergeSelectionSegments(segments)
}

function appendSelectionSegmentForRange(
  segments: SelectionSegment[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  selection: VirtualizedStoredSelection,
): void {
  const emptyRowSegment = emptyRowSelectionSegment(view, row, selection)
  if (emptyRowSegment) {
    segments.push(emptyRowSegment)
    return
  }

  segments.push(...rangeSegments(view, row, selection.start, selection.end))
}

function emptyRowSelectionSegment(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  selection: VirtualizedStoredSelection,
): SelectionSegment | null {
  const offset = emptyRowSelectionOffset(view, row)
  if (offset === null) return null
  if (!selectionIncludesOffset(selection, offset)) return null

  return {
    left: 0,
    width: Math.max(1, view.metrics.characterWidth),
  }
}

function emptyRowSelectionOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number | null {
  if (row.text.length !== 0) return null
  if (row.startOffset < view.model.textLength) return row.startOffset
  if (row.startOffset === 0) return null
  if (view.model.textSnapshot.readRange(row.startOffset - 1, row.startOffset) !== '\n') return null
  return row.startOffset - 1
}

function selectionIncludesOffset(selection: VirtualizedStoredSelection, offset: number): boolean {
  return selection.start <= offset && offset < selection.end
}

function mergeSelectionSegments(segments: SelectionSegment[]): readonly SelectionSegment[] {
  const sorted = segments.sort((left, right) => left.left - right.left || left.width - right.width)
  const merged: SelectionSegment[] = []
  for (const segment of sorted) mergeSelectionSegment(merged, segment)
  return merged
}

function mergeSelectionSegment(segments: SelectionSegment[], segment: SelectionSegment): void {
  const previous = segments.at(-1)
  if (!previous || segment.left > previous.left + previous.width + SELECTION_RECT_MERGE_EPSILON) {
    segments.push(segment)
    return
  }

  const left = Math.min(previous.left, segment.left)
  segments[segments.length - 1] = {
    left,
    width: Math.max(previous.left + previous.width, segment.left + segment.width) - left,
  }
}

function selectionSegmentKey(segments: readonly SelectionSegment[]): string {
  return segments.map(selectionSegmentKeyPart).join('|')
}

function selectionSegmentKeyPart(segment: SelectionSegment): string {
  return `${segment.left}:${segment.width}`
}

function createSelectionElement(
  row: MountedVirtualizedTextRow,
  segment: SelectionSegment,
): HTMLSpanElement {
  const element = row.element.ownerDocument.createElement('span')
  element.className = 'editor-virtualized-selection-range'
  element.dataset.editorSelectionRect = selectionSegmentKeyPart(segment)
  setStyleValue(element, 'left', `${segment.left}px`)
  setStyleValue(element, 'width', `${segment.width}px`)
  return element
}

function clearSelectionLayerForRow(row: MountedVirtualizedTextRow): void {
  setSelectionLayerKey(row, '')
  row.selectionLayerElement.replaceChildren()
  row.selectionLayerElement.remove()
}

function attachSelectionLayer(row: MountedVirtualizedTextRow): void {
  const layer = row.selectionLayerElement
  if (layer.parentElement === row.element) return

  row.element.insertBefore(layer, row.element.firstChild)
}

function setSelectionLayerKey(row: MountedVirtualizedTextRow, key: string): void {
  const mutable = row as { selectionLayerKey: string }
  mutable.selectionLayerKey = key
}
