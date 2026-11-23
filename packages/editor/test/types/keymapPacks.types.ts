// Compiled against the built declarations; nothing here runs. The built-in packs are written as
// compact rows, and these lines hold their published types to the literal shape the rows expand
// to: exact commands, contexts and keys, never the wider `Binding` fields.
import {
  baseEditorKeymap,
  defaultEditorPacks,
  readonlyDiffPack,
  vscodeEditingPack,
  vscodeSelectionPack,
  type EditorKeymapPack,
} from '@singapore-editor/core/keymap'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export function bindingFieldsAreStrings(): readonly string[] {
  // A strict consumer reads these as plain strings; `Binding` would make them nullable.
  const command: string = baseEditorKeymap.linux[0].command
  const context: string = baseEditorKeymap.linux[0].context
  const source: string = baseEditorKeymap.linux[0].source
  return [command, context, source]
}

export type KeymapPackChecks = [
  Assert<
    Equal<
      (typeof baseEditorKeymap.linux)[0],
      {
        readonly keys: readonly [{ readonly key: 'End'; readonly ctrl: true }]
        readonly command: 'cursorDocumentEnd'
        readonly context: 'Editor && !EditorWidget'
        readonly source: 'default'
      }
    >
  >,
  // A row limited to one platform is absent from the others.
  Assert<
    Equal<
      (typeof baseEditorKeymap.mac)[0]['keys'],
      readonly [{ readonly key: 'ArrowDown'; readonly meta: true }]
    >
  >,
  // Text strokes pass through, and `preventDefault` appears only on the rows that set it.
  Assert<
    Equal<
      Extract<(typeof baseEditorKeymap.windows)[number], { readonly command: 'copy' }>,
      {
        readonly keys: readonly ['Mod+C']
        readonly command: 'copy'
        readonly context: 'Editor && !EditorWidget'
        readonly source: 'default'
        readonly preventDefault: false
      }
    >
  >,
  // Chords keep one stroke per step.
  Assert<
    Equal<
      (typeof vscodeSelectionPack.linux)[4]['keys'],
      readonly [
        { readonly key: 'K'; readonly mod: true },
        { readonly key: 'ArrowRight'; readonly alt: true },
      ]
    >
  >,
  Assert<Equal<(typeof vscodeEditingPack.mac)[2]['preventDefault'], true>>,
  Assert<
    Equal<(typeof readonlyDiffPack.linux)[0]['context'], 'Editor && !EditorWidget && mode == diff'>
  >,
  Assert<Equal<(typeof baseEditorKeymap.linux)['length'], 55>>,
  Assert<Equal<(typeof baseEditorKeymap.mac)['length'], 58>>,
]

// Every literal pack still fits where a pack is expected.
export const packs: readonly EditorKeymapPack[] = defaultEditorPacks.concat([
  baseEditorKeymap,
  readonlyDiffPack,
])
