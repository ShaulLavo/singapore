export { decodeSnapshot as decodePaintSnapshot } from './editor/documentPaint'
export type {
  PaintSnapshot,
  SavedDocumentPaint,
  DocumentPaintCapture,
} from './editor/documentPaint'
export type { MountedPaintSnapshot } from './virtualization/documentPaintRows'
import type { PaintSnapshot } from './editor/documentPaint'
import { mountDocumentPaint } from './virtualization/documentPaintRows'
import { installSelectionCopy } from './editor/selectionCopy'
import {
  activateDocumentPaintHighlights,
  prepareDocumentPaintHighlights,
  revealDocumentPaintHighlights,
} from './virtualization/documentPaintHighlights'
export type { ActivatedPaintSnapshotHighlights } from './virtualization/documentPaintHighlights'

export function mountPaintSnapshot(
  element: HTMLElement,
  paint: PaintSnapshot,
  options: { readonly width?: number } = {},
) {
  return paint.format === 6 ? mountDocumentPaint(element, paint, options) : null
}

/** Gate streamed snapshot visibility before inserting markup; release when parsing ends. */
export function preparePaintSnapshotHighlights(document: Document): void {
  prepareDocumentPaintHighlights(document)
}

/** Attach syntax paint to emitted snapshot HTML before its first visible frame. */
export function activatePaintSnapshotHighlights(element: HTMLElement, paint: PaintSnapshot) {
  try {
    return paint.format === 6 ? activateDocumentPaintHighlights(element, paint) : null
  } finally {
    revealDocumentPaintHighlights(element)
  }
}

/**
 * Makes copying a page selection that runs through emitted snapshot roots or editors keep their
 * line breaks. Snapshot and editor rows are absolutely positioned, so the browser's own copy joins
 * their lines. Editors install this themselves; call it for pages that show snapshots alone. The
 * returned function removes this installation.
 */
export function installPaintSnapshotCopy(document: Document): () => void {
  return installSelectionCopy(document)
}
