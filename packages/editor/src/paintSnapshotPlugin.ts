import { decodeSnapshot } from './editor/documentPaint'
import { encodePaintSnapshot } from './editor/paintSnapshot'
import {
  EDITOR_PAINT_SNAPSHOT_FEATURE,
  EDITOR_PAINT_SNAPSHOT_FEATURE_ID,
  type EditorPaintSnapshotSupport,
} from './editor/paintSnapshotSupport'
import type { EditorPlugin } from './plugins'
import { captureDocumentPaint } from './virtualization/documentPaintCapture'
import { mountDocumentPaint } from './virtualization/documentPaintRows'
import { captureGutterPaint, paintProvisionalRows } from './virtualization/provisionalPaintRows'

/** What the plugin registers; tests that drive a bare view pass it to `restorePaint`. */
export const paintSnapshotSupport: EditorPaintSnapshotSupport = {
  decode: decodeSnapshot,
  encodeViewport: encodePaintSnapshot,
  captureDocument: captureDocumentPaint,
  mountDocument: mountDocumentPaint,
  paintViewportRows: paintProvisionalRows,
  captureGutters: captureGutterPaint,
}

/**
 * Lets the editor save and restore painted views: `editor.captureSnapshot()` returns a paint that
 * a later editor shows through `setSnapshot()` or the `snapshot` option until its document is
 * live. Without this plugin, capture returns nothing and an offered snapshot is ignored.
 */
export function createPaintSnapshotPlugin(): EditorPlugin {
  return {
    name: EDITOR_PAINT_SNAPSHOT_FEATURE_ID,
    activate: (context) =>
      context.registerCapabilityContribution({
        createContribution: (editor) =>
          editor.registerFeature(EDITOR_PAINT_SNAPSHOT_FEATURE, paintSnapshotSupport),
      }),
  }
}
