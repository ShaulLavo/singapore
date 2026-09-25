import type { EditorOptions } from '@singapore-editor/core/editor'
import {
  editorKeymapLayersForCommandPacks,
  type EditorCommandPack,
} from '@singapore-editor/core/keymap'

export type DiffEditorOptions = Required<
  Pick<
    EditorOptions,
    'cursorLineHighlight' | 'detectIndentation' | 'documentMode' | 'editability' | 'keymap'
  >
>

// Read-only already refuses every editing key. Folding would hide projected rows and misalign a split.
const DIFF_COMMAND_PACKS = [
  'navigation',
  'selection',
  'find',
] as const satisfies readonly EditorCommandPack[]

/**
 * The options an editor showing a diff needs. Spread them and add the host's own, such as plugins,
 * typography and theme.
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
