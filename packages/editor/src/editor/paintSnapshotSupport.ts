import { createEditorCapabilityToken } from '../plugins'
import type { VirtualizedTextViewInternal } from '../virtualization/virtualizedTextViewInternals'
import type { MountedPaintSnapshot } from '../virtualization/documentPaintRows'
import type {
  DocumentPaintCapture,
  DocumentPaintRow,
  PaintSnapshot,
  SavedDocumentPaint,
} from './documentPaint'
import type { encodePaintSnapshot, SavedPaint, SavedPaintRow } from './paintSnapshot'

/**
 * Saving and restoring painted views: the codecs and the DOM capture and mount code behind
 * `captureSnapshot()` and `setSnapshot()`. The editor keeps only the provisional-paint lifecycle;
 * `createPaintSnapshotPlugin()` supplies this, so an app that never caches paint never loads it.
 */
export type EditorPaintSnapshotSupport = {
  decode(serialized: string): PaintSnapshot | null
  readonly encodeViewport: typeof encodePaintSnapshot
  captureDocument(
    view: VirtualizedTextViewInternal,
    appearance: string,
    headings: ReadonlyMap<number, NonNullable<DocumentPaintRow['heading']>>,
  ): DocumentPaintCapture
  mountDocument(
    host: HTMLElement,
    paint: SavedDocumentPaint,
    options: { readonly width?: number },
  ): MountedPaintSnapshot | null
  paintViewportRows(view: VirtualizedTextViewInternal, paint: SavedPaint): (() => void) | null
  captureGutters(view: VirtualizedTextViewInternal): readonly SavedPaintRow['gutterCells'][] | null
}

export const EDITOR_PAINT_SNAPSHOT_FEATURE_ID = 'editor.paintSnapshot'

export const EDITOR_PAINT_SNAPSHOT_FEATURE =
  createEditorCapabilityToken<EditorPaintSnapshotSupport>(EDITOR_PAINT_SNAPSHOT_FEATURE_ID)
