import { createEditorCapabilityToken } from '../plugins'
import type { EditorPaintSnapshotSupport } from '../virtualization/virtualizedTextViewInternals'

// The contract lives with the view's types; this module only names the token, and the view never
// imports it, so it stays outside the view's import cycle.
export type { EditorPaintSnapshotSupport }

export const EDITOR_PAINT_SNAPSHOT_FEATURE_ID = 'editor.paintSnapshot'

export const EDITOR_PAINT_SNAPSHOT_FEATURE =
  createEditorCapabilityToken<EditorPaintSnapshotSupport>(EDITOR_PAINT_SNAPSHOT_FEATURE_ID)
