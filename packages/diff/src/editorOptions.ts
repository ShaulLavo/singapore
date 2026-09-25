import type { EditorOptions } from '@singapore-editor/core/editor'
import {
  editorKeymapLayersForCommandPacks,
  type EditorCommandPack,
  type EditorKeymapOptions,
} from '@singapore-editor/core/keymap'
import type { EditorCursorLineHighlightOptions } from '@singapore-editor/core/rendering'

// Every nested field is present, so a host extends `keymap.layers` or one highlight part in place.
export type DiffEditorOptions = Required<
  Pick<EditorOptions, 'detectIndentation' | 'documentMode' | 'editability'>
> & {
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>
  readonly keymap: Required<Pick<EditorKeymapOptions, 'defaultBindings' | 'layers'>>
}

// Read-only already refuses every editing key. Folding would hide projected rows and misalign a split.
const DIFF_COMMAND_PACKS = [
  'navigation',
  'selection',
  'find',
] as const satisfies readonly EditorCommandPack[]

/**
 * The options an editor holding a `mode: 'document'` diff needs; an overlay diff keeps its host's
 * editable options. Spread them and add the host's own, such as plugins, typography and theme.
 */
export function createDiffEditorOptions(): DiffEditorOptions {
  return {
    cursorLineHighlight: { gutterBackground: false, gutterNumber: false, rowBackground: false },
    // The buffer interleaves both sides, so a guess would change the width per file and per toggle.
    detectIndentation: false,
    documentMode: 'static',
    editability: 'readonly',
    keymap: {
      defaultBindings: false,
      layers: editorKeymapLayersForCommandPacks(DIFF_COMMAND_PACKS),
    },
  }
}
