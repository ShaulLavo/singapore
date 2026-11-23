import type {
  Binding,
  KeyChord,
  KeymapEntry,
  KeymapPlatform,
  RawHotkey,
  RawModifiers,
} from '@shaulavo/hotkeys'
import type { EditorAnyCommandId } from '../editor/commandCatalog'

export type EditorKeymapPack = Readonly<Record<KeymapPlatform, readonly Binding[]>>
export type EditorKeymapOptions = {
  readonly packs?: readonly EditorKeymapPack[]
  readonly bindings?: readonly KeymapEntry[]
}

/**
 * One binding of a built-in pack: keys, command, and what sets it apart from the pack's other
 * rows.
 *
 * A string key spec is one stroke per space, each stroke its modifier fields joined to the key by
 * `+`: `'mod+K alt+ArrowLeft'` is `[{ key: 'K', mod: true }, { key: 'ArrowLeft', alt: true }]`.
 * An array passes through as the hotkeys library's own text strokes, such as `['Shift+Enter']`.
 * The rows are written this way because the expanded objects, repeated for three platforms, made
 * this table the largest module in the editor bundle.
 */
type KeymapRow = readonly [
  keys: string | KeyChord,
  command: EditorAnyCommandId,
  options?: {
    /** The context, when it is not the pack's. */
    readonly when?: string
    /** The platforms that have this row; every platform when absent. */
    readonly on?: 'mac' | 'linux' | 'linux windows' | 'windows mac'
    readonly preventDefault?: boolean
  },
]

const EDITOR = 'Editor && !EditorWidget'

function when(condition: string): string {
  return `${EDITOR} && ${condition}`
}

function stroke(spec: string): RawHotkey {
  const parts = spec.split('+')
  const hotkey: { key: string } & RawModifiers = { key: parts.pop()! }
  for (const modifier of parts) hotkey[modifier as keyof RawModifiers] = true
  return hotkey
}

function chord(spec: string): KeyChord {
  const [first, ...rest] = spec.split(' ').map(stroke)
  return [first!, ...rest]
}

function binding(
  [keys, command, options]: KeymapRow,
  context: string,
  source: Binding['source'],
): Binding {
  const row: Binding = {
    keys: typeof keys === 'string' ? chord(keys) : keys,
    command,
    context: options?.when ?? context,
    source,
  }
  return options?.preventDefault === undefined
    ? row
    : { ...row, preventDefault: options.preventDefault }
}

function pack(
  context: string,
  source: Binding['source'],
  rows: readonly KeymapRow[],
): EditorKeymapPack {
  const platformRows = (platform: KeymapPlatform) =>
    rows
      .filter(([, , options]) => options?.on?.includes(platform) ?? true)
      .map((row) => binding(row, context, source))
  return {
    linux: platformRows('linux'),
    mac: platformRows('mac'),
    windows: platformRows('windows'),
  }
}

export const baseEditorKeymap: EditorKeymapPack = pack(EDITOR, 'default', [
  ['ctrl+End', 'cursorDocumentEnd', { on: 'linux windows' }],
  ['ctrl+Home', 'cursorDocumentStart', { on: 'linux windows' }],
  ['meta+ArrowDown', 'cursorDocumentEnd', { on: 'mac' }],
  ['meta+ArrowUp', 'cursorDocumentStart', { on: 'mac' }],
  ['PageDown', 'cursorPageDown'],
  ['PageUp', 'cursorPageUp'],
  ['ArrowDown', 'cursorDown'],
  ['ArrowUp', 'cursorUp'],
  ['meta+ArrowRight', 'cursorLineEnd', { on: 'mac' }],
  ['meta+ArrowLeft', 'cursorLineStart', { on: 'mac' }],
  ['End', 'cursorLineEnd'],
  ['Home', 'cursorLineStart'],
  ['ctrl+ArrowRight', 'cursorWordRight', { on: 'linux windows' }],
  ['ctrl+ArrowLeft', 'cursorWordLeft', { on: 'linux windows' }],
  ['alt+ArrowRight', 'cursorWordRight', { on: 'mac' }],
  ['alt+ArrowLeft', 'cursorWordLeft', { on: 'mac' }],
  ['ArrowRight', 'cursorRight'],
  ['ArrowLeft', 'cursorLeft'],
  ['ctrl+shift+End', 'selectDocumentEnd', { on: 'linux windows' }],
  ['ctrl+shift+Home', 'selectDocumentStart', { on: 'linux windows' }],
  ['meta+shift+ArrowDown', 'selectDocumentEnd', { on: 'mac' }],
  ['meta+shift+ArrowUp', 'selectDocumentStart', { on: 'mac' }],
  ['shift+PageDown', 'selectPageDown'],
  ['shift+PageUp', 'selectPageUp'],
  ['shift+ArrowDown', 'selectDown'],
  ['shift+ArrowUp', 'selectUp'],
  ['meta+shift+ArrowRight', 'selectLineEnd', { on: 'mac' }],
  ['meta+shift+ArrowLeft', 'selectLineStart', { on: 'mac' }],
  ['shift+End', 'selectLineEnd'],
  ['shift+Home', 'selectLineStart'],
  ['ctrl+shift+ArrowRight', 'selectWordRight', { on: 'linux windows' }],
  ['ctrl+shift+ArrowLeft', 'selectWordLeft', { on: 'linux windows' }],
  ['alt+shift+ArrowRight', 'selectWordRight', { on: 'mac' }],
  ['alt+shift+ArrowLeft', 'selectWordLeft', { on: 'mac' }],
  ['shift+ArrowRight', 'selectRight'],
  ['shift+ArrowLeft', 'selectLeft'],
  ['mod+A', 'selectAll'],
  ['ctrl+Y', 'redo', { on: 'linux windows' }],
  ['mod+shift+Z', 'redo'],
  ['mod+Z', 'undo'],
  ['shift+Tab', 'outdentSelection', { when: when('!tabFocusMode') }],
  ['Tab', 'indentSelection', { when: when('!tabFocusMode') }],
  ['Delete', 'deleteForward'],
  ['Backspace', 'deleteBackward'],
  ['ctrl+Delete', 'deleteWordRight', { on: 'linux windows' }],
  ['ctrl+Backspace', 'deleteWordLeft', { on: 'linux windows' }],
  ['alt+Delete', 'deleteWordRight', { on: 'mac' }],
  ['alt+Backspace', 'deleteWordLeft', { on: 'mac' }],
  [['Enter'], 'insertNewlineAndIndent', { when: when('mode != single_line') }],
  [['Shift+Enter'], 'insertNewlineAndIndent', { when: when('mode != single_line') }],
  [['Mod+C'], 'copy', { preventDefault: false }],
  [['Mod+X'], 'cut', { preventDefault: false }],
  [['Mod+V'], 'paste', { preventDefault: false }],
  [['Escape'], 'closeFind', { when: 'Editor > FindWidget' }],
  [['Mod+F'], 'closeFind', { when: 'Editor > FindWidget' }],
  [['Enter'], 'findNext', { when: 'Editor > (FindWidget && !ReplaceInput)' }],
  [['Shift+Enter'], 'findPrevious', { when: 'Editor > FindWidget' }],
  [['Enter'], 'replaceOne', { when: 'Editor > ReplaceInput' }],
  [['Enter'], 'lsp.rename.accept', { when: 'Editor > RenameWidget' }],
  [['Escape'], 'lsp.rename.cancel', { when: 'Editor > RenameWidget' }],
  [['Escape'], 'tooltip.hide', { when: 'Editor > Tooltip' }],
  [['Escape'], 'tooltip.hide', { when: 'Editor > HoverVisible' }],
  [['Enter'], 'markdown.openLink', { when: 'Editor > MarkdownLink' }],
  [['ArrowUp'], 'tooltip.scrollUp', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
  [['ArrowDown'], 'tooltip.scrollDown', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
  [['PageUp'], 'tooltip.pageUp', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
  [['PageDown'], 'tooltip.pageDown', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
  [['Home'], 'tooltip.scrollStart', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
  [['End'], 'tooltip.scrollEnd', { when: 'Editor > (TooltipBody && !TooltipControl)' }],
])

export const vscodeNavigationPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['alt+ctrl+ArrowRight', 'cursorWordPartRight'],
  ['alt+ctrl+ArrowLeft', 'cursorWordPartLeft'],
  ['alt+Z', 'editor.action.toggleWordWrap'],
  ['mod+shift+\\', 'editor.action.jumpToBracket'],
])

export const vscodeSelectionPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['mod+alt+shift+PageDown', 'cursorColumnSelectPageDown'],
  ['mod+alt+shift+PageUp', 'cursorColumnSelectPageUp'],
  ['mod+ArrowDown', 'cursorColumnSelectDown', { on: 'linux' }],
  ['mod+ArrowUp', 'cursorColumnSelectUp', { on: 'linux' }],
  ['mod+alt+shift+ArrowDown', 'cursorColumnSelectDown', { on: 'windows mac' }],
  ['mod+alt+shift+ArrowUp', 'cursorColumnSelectUp', { on: 'windows mac' }],
  ['mod+K alt+ArrowRight', 'cursorColumnSelectRight', { on: 'linux windows' }],
  ['mod+K alt+ArrowLeft', 'cursorColumnSelectLeft', { on: 'linux windows' }],
  ['mod+alt+shift+ArrowRight', 'cursorColumnSelectRight', { on: 'mac' }],
  ['mod+alt+shift+ArrowLeft', 'cursorColumnSelectLeft', { on: 'mac' }],
  ['alt+ctrl+shift+ArrowRight', 'cursorWordPartRightSelect'],
  ['alt+ctrl+shift+ArrowLeft', 'cursorWordPartLeftSelect'],
  ['alt+shift+ArrowLeft', 'editor.action.smartSelect.shrink', { on: 'linux windows' }],
  ['alt+shift+ArrowRight', 'editor.action.smartSelect.expand', { on: 'linux windows' }],
  ['mod+ctrl+shift+ArrowLeft', 'editor.action.smartSelect.shrink', { on: 'mac' }],
  ['mod+ctrl+shift+ArrowRight', 'editor.action.smartSelect.expand', { on: 'mac' }],
])

export const vscodeEditingPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['mod+shift+U', 'cursorRedo'],
  ['mod+U', 'cursorUndo'],
  ['alt+ArrowRight', 'jumpForward', { on: 'linux windows', preventDefault: true }],
  ['alt+ArrowLeft', 'jumpBack', { on: 'linux windows', preventDefault: true }],
  ['ctrl+shift+-', 'jumpForward', { on: 'mac', preventDefault: true }],
  ['ctrl+-', 'jumpBack', { on: 'mac', preventDefault: true }],
  ['mod+alt+Enter', 'replaceAll'],
  ['mod+H', 'findReplace', { on: 'linux windows' }],
  ['ctrl+M', 'editor.action.toggleTabFocusMode', { on: 'linux windows' }],
  ['mod+alt+F', 'findReplace', { on: 'mac' }],
  ['ctrl+shift+M', 'editor.action.toggleTabFocusMode', { on: 'mac' }],
])

export const vscodeAdvancedEditingPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['mod+alt+shift+I', 'editor.action.reindentlines'],
  ['alt+shift+I', 'editor.action.reindentselectedlines'],
  ['mod+[', 'editor.action.outdentLines'],
  ['mod+]', 'editor.action.indentLines'],
  ['mod+shift+A', 'editor.action.blockComment', { on: 'linux' }],
  ['alt+shift+A', 'editor.action.blockComment', { on: 'windows mac' }],
  ['mod+/', 'editor.action.commentLine'],
  ['mod+Enter', 'editor.action.insertLineAfter'],
  ['mod+shift+Enter', 'editor.action.insertLineBefore'],
  ['alt+ArrowDown', 'editor.action.moveLinesDownAction'],
  ['alt+ArrowUp', 'editor.action.moveLinesUpAction'],
  ['mod+alt+shift+ArrowDown', 'editor.action.copyLinesDownAction', { on: 'linux' }],
  ['mod+alt+shift+ArrowUp', 'editor.action.copyLinesUpAction', { on: 'linux' }],
  ['alt+shift+ArrowDown', 'editor.action.copyLinesDownAction', { on: 'windows mac' }],
  ['alt+shift+ArrowUp', 'editor.action.copyLinesUpAction', { on: 'windows mac' }],
  ['mod+shift+K', 'editor.action.deleteLines'],
  ['alt+ctrl+Delete', 'deleteWordPartRight'],
  ['alt+ctrl+Backspace', 'deleteWordPartLeft'],
  ['mod+K mod+X', 'editor.action.trimTrailingWhitespace'],
  ['mod+K mod+C', 'editor.action.commentLine'],
])

export const vscodeMultiCursorPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['Escape', 'clearSecondarySelections', { when: when('!findVisible') }],
  ['mod+F2', 'editor.action.changeAll'],
  ['mod+shift+L', 'editor.action.selectHighlights'],
  ['mod+shift+ArrowDown', 'editor.action.insertCursorBelow', { on: 'linux' }],
  ['mod+shift+ArrowUp', 'editor.action.insertCursorAbove', { on: 'linux' }],
  ['alt+shift+ArrowDown', 'editor.action.insertCursorBelow', { on: 'linux' }],
  ['alt+shift+ArrowUp', 'editor.action.insertCursorAbove', { on: 'linux' }],
  ['mod+alt+ArrowDown', 'editor.action.insertCursorBelow', { on: 'windows mac' }],
  ['mod+alt+ArrowUp', 'editor.action.insertCursorAbove', { on: 'windows mac' }],
  ['alt+Enter', 'selectAllMatches'],
  ['mod+D', 'addNextOccurrence'],
])

export const vscodeFindPack: EditorKeymapPack = pack(when('findVisible'), 'pack', [
  ['alt+P', 'togglePreserveCase'],
  ['alt+L', 'toggleFindInSelection'],
  ['alt+R', 'toggleFindRegex'],
  ['alt+W', 'toggleFindWholeWord'],
  ['alt+C', 'toggleFindCaseSensitive'],
  ['shift+F3', 'findPrevious', { when: EDITOR, on: 'linux windows' }],
  ['F3', 'findNext', { when: EDITOR, on: 'linux windows' }],
  ['mod+shift+G', 'findPrevious', { when: EDITOR, on: 'mac' }],
  ['mod+G', 'findNext', { when: EDITOR, on: 'mac' }],
  ['mod+F', 'find', { when: EDITOR }],
  ['Escape', 'closeFind'],
])

export const vscodeFoldingPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['mod+K mod+,', 'editor.createFoldingRangeFromSelection', { when: when('hasSelection') }],
  ['mod+K mod+7', 'editor.foldLevel7'],
  ['mod+K mod+6', 'editor.foldLevel6'],
  ['mod+K mod+5', 'editor.foldLevel5'],
  ['mod+K mod+4', 'editor.foldLevel4'],
  ['mod+K mod+3', 'editor.foldLevel3'],
  ['mod+K mod+2', 'editor.foldLevel2'],
  ['mod+K mod+1', 'editor.foldLevel1'],
  ['mod+K mod+J', 'editor.unfoldAll'],
  ['mod+K mod+0', 'editor.foldAll'],
  ['mod+K mod+.', 'editor.removeManualFoldingRanges'],
  ['mod+K mod+]', 'editor.unfoldRecursively'],
  ['mod+K mod+[', 'editor.foldRecursively'],
  ['mod+shift+]', 'editor.unfold', { on: 'linux windows' }],
  ['mod+shift+[', 'editor.fold', { on: 'linux windows' }],
  ['mod+alt+]', 'editor.unfold', { on: 'mac' }],
  ['mod+alt+[', 'editor.fold', { on: 'mac' }],
])

export const vscodeLspNavigationPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['F12', 'editor.action.goToDefinition'],
  ['shift+F8', 'editor.action.marker.prev'],
  ['F8', 'editor.action.marker.next'],
  ['mod+K F12', 'editor.action.revealDefinitionAside'],
  ['mod+F12', 'editor.action.goToImplementation'],
  ['alt+F12', 'editor.action.peekDefinition'],
  ['shift+F12', 'editor.action.goToReferences'],
  ['mod+K mod+I', 'editor.action.showHover'],
])

export const vscodeLspEditingPack: EditorKeymapPack = pack(EDITOR, 'pack', [
  ['F2', 'editor.action.rename'],
  ['alt+shift+.', 'editor.action.autoFix', { on: 'linux windows' }],
  ['mod+alt+.', 'editor.action.autoFix', { on: 'mac' }],
  ['alt+shift+F', 'editor.action.formatDocument'],
])

export const vscodeInlineSuggestPack: EditorKeymapPack = pack(
  when('!tabFocusMode && inlineSuggestionVisible'),
  'pack',
  [
    [
      'mod+alt+ArrowRight',
      'editor.action.inlineSuggest.acceptNextWord',
      { when: when('inlineSuggestionVisible'), on: 'mac' },
    ],
    ['Tab', 'editor.action.inlineSuggest.commit'],
  ],
)

export const suggestPack: EditorKeymapPack = pack(when('suggestWidgetVisible'), 'pack', [
  [
    'ArrowUp',
    'showPrevParameterHint',
    { when: when('parameterHintsVisible && parameterHintsMultipleSignatures') },
  ],
  [
    'ArrowDown',
    'showNextParameterHint',
    { when: when('parameterHintsVisible && parameterHintsMultipleSignatures') },
  ],
  ['Escape', 'closeParameterHints', { when: when('parameterHintsVisible') }],
  ['Escape', 'hideSuggestWidget'],
  ['shift+Tab', 'acceptSelectedSuggestion'],
  ['shift+Enter', 'acceptSelectedSuggestion'],
  ['Tab', 'acceptSelectedSuggestion'],
  ['Enter', 'acceptSelectedSuggestion'],
  ['PageUp', 'selectPrevPageSuggestion'],
  ['PageDown', 'selectNextPageSuggestion'],
  ['ArrowUp', 'selectPrevSuggestion'],
  ['ArrowDown', 'selectNextSuggestion'],
  ['ctrl+Space', 'editor.action.triggerSuggest', { when: EDITOR }],
])

export const markdownPack: EditorKeymapPack = pack(when('markdown'), 'pack', [
  ['ctrl+shift+K', 'markdown.link', { on: 'linux windows' }],
  ['ctrl+I', 'markdown.italic', { on: 'linux windows' }],
  ['ctrl+B', 'markdown.bold', { on: 'linux windows' }],
  ['meta+shift+K', 'markdown.link', { on: 'mac' }],
  ['meta+I', 'markdown.italic', { on: 'mac' }],
  ['meta+B', 'markdown.bold', { on: 'mac' }],
  [
    ['Tab'],
    'markdown.indentListItem',
    {
      when: when(
        'markdown && writable && !tabFocusMode && !inlineSuggestionVisible && !suggestWidgetVisible',
      ),
    },
  ],
  [
    ['Shift+Tab'],
    'markdown.outdentListItem',
    {
      when: when(
        'markdown && writable && !tabFocusMode && !inlineSuggestionVisible && !suggestWidgetVisible',
      ),
    },
  ],
])

export const readonlyDiffPack: EditorKeymapPack = pack(when('mode == diff'), 'pack', [
  ['ctrl+End', 'cursorDocumentEnd', { on: 'linux windows' }],
  ['ctrl+Home', 'cursorDocumentStart', { on: 'linux windows' }],
  ['meta+ArrowDown', 'cursorDocumentEnd', { on: 'mac' }],
  ['meta+ArrowUp', 'cursorDocumentStart', { on: 'mac' }],
  ['PageDown', 'cursorPageDown'],
  ['PageUp', 'cursorPageUp'],
  ['ArrowDown', 'cursorDown'],
  ['ArrowUp', 'cursorUp'],
  ['meta+ArrowRight', 'cursorLineEnd', { on: 'mac' }],
  ['meta+ArrowLeft', 'cursorLineStart', { on: 'mac' }],
  ['End', 'cursorLineEnd'],
  ['Home', 'cursorLineStart'],
  ['alt+ctrl+ArrowRight', 'cursorWordPartRight'],
  ['alt+ctrl+ArrowLeft', 'cursorWordPartLeft'],
  ['ctrl+ArrowRight', 'cursorWordRight', { on: 'linux windows' }],
  ['ctrl+ArrowLeft', 'cursorWordLeft', { on: 'linux windows' }],
  ['alt+ArrowRight', 'cursorWordRight', { on: 'mac' }],
  ['alt+ArrowLeft', 'cursorWordLeft', { on: 'mac' }],
  ['ArrowRight', 'cursorRight'],
  ['ArrowLeft', 'cursorLeft'],
  ['mod+alt+shift+PageDown', 'cursorColumnSelectPageDown'],
  ['mod+alt+shift+PageUp', 'cursorColumnSelectPageUp'],
  ['mod+ArrowDown', 'cursorColumnSelectDown', { on: 'linux' }],
  ['mod+ArrowUp', 'cursorColumnSelectUp', { on: 'linux' }],
  ['mod+alt+shift+ArrowDown', 'cursorColumnSelectDown', { on: 'windows mac' }],
  ['mod+alt+shift+ArrowUp', 'cursorColumnSelectUp', { on: 'windows mac' }],
  ['mod+K alt+ArrowRight', 'cursorColumnSelectRight', { on: 'linux windows' }],
  ['mod+K alt+ArrowLeft', 'cursorColumnSelectLeft', { on: 'linux windows' }],
  ['ctrl+shift+End', 'selectDocumentEnd', { on: 'linux windows' }],
  ['ctrl+shift+Home', 'selectDocumentStart', { on: 'linux windows' }],
  ['mod+alt+shift+ArrowRight', 'cursorColumnSelectRight', { on: 'mac' }],
  ['mod+alt+shift+ArrowLeft', 'cursorColumnSelectLeft', { on: 'mac' }],
  ['meta+shift+ArrowDown', 'selectDocumentEnd', { on: 'mac' }],
  ['meta+shift+ArrowUp', 'selectDocumentStart', { on: 'mac' }],
  ['shift+PageDown', 'selectPageDown'],
  ['shift+PageUp', 'selectPageUp'],
  ['shift+ArrowDown', 'selectDown'],
  ['shift+ArrowUp', 'selectUp'],
  ['meta+shift+ArrowRight', 'selectLineEnd', { on: 'mac' }],
  ['meta+shift+ArrowLeft', 'selectLineStart', { on: 'mac' }],
  ['shift+End', 'selectLineEnd'],
  ['shift+Home', 'selectLineStart'],
  ['alt+ctrl+shift+ArrowRight', 'cursorWordPartRightSelect'],
  ['alt+ctrl+shift+ArrowLeft', 'cursorWordPartLeftSelect'],
  ['ctrl+shift+ArrowRight', 'selectWordRight', { on: 'linux windows' }],
  ['ctrl+shift+ArrowLeft', 'selectWordLeft', { on: 'linux windows' }],
  ['alt+shift+ArrowRight', 'selectWordRight', { on: 'mac' }],
  ['alt+shift+ArrowLeft', 'selectWordLeft', { on: 'mac' }],
  ['shift+ArrowRight', 'selectRight'],
  ['shift+ArrowLeft', 'selectLeft'],
  ['alt+shift+ArrowLeft', 'editor.action.smartSelect.shrink', { on: 'linux windows' }],
  ['alt+shift+ArrowRight', 'editor.action.smartSelect.expand', { on: 'linux windows' }],
  ['mod+ctrl+shift+ArrowLeft', 'editor.action.smartSelect.shrink', { on: 'mac' }],
  ['mod+ctrl+shift+ArrowRight', 'editor.action.smartSelect.expand', { on: 'mac' }],
  ['mod+A', 'selectAll'],
  ['alt+P', 'togglePreserveCase', { when: when('findVisible && mode == diff') }],
  ['alt+L', 'toggleFindInSelection', { when: when('findVisible && mode == diff') }],
  ['alt+R', 'toggleFindRegex', { when: when('findVisible && mode == diff') }],
  ['alt+W', 'toggleFindWholeWord', { when: when('findVisible && mode == diff') }],
  ['alt+C', 'toggleFindCaseSensitive', { when: when('findVisible && mode == diff') }],
  ['shift+F3', 'findPrevious', { on: 'linux windows' }],
  ['F3', 'findNext', { on: 'linux windows' }],
  ['mod+shift+G', 'findPrevious', { on: 'mac' }],
  ['mod+G', 'findNext', { on: 'mac' }],
  ['mod+F', 'find'],
  ['Escape', 'clearSecondarySelections', { when: when('!findVisible && mode == diff') }],
  ['Escape', 'closeFind', { when: when('findVisible && mode == diff') }],
])

export const defaultEditorPacks: readonly EditorKeymapPack[] = [
  vscodeNavigationPack,
  vscodeSelectionPack,
  vscodeEditingPack,
  vscodeAdvancedEditingPack,
  vscodeMultiCursorPack,
  vscodeFindPack,
  vscodeFoldingPack,
  vscodeLspNavigationPack,
  vscodeLspEditingPack,
  vscodeInlineSuggestPack,
  suggestPack,
] as const satisfies readonly EditorKeymapPack[]

export function editorKeymapBindings(
  options: EditorKeymapOptions = {},
  platform: KeymapPlatform,
): readonly KeymapEntry[] {
  const base: readonly KeymapEntry[] = baseEditorKeymap[platform]
  return base.concat(
    (options.packs ?? defaultEditorPacks).flatMap((pack) => pack[platform]),
    (options.bindings ?? []).map((binding) => ({
      ...binding,
      context: binding.context ?? 'Editor && !EditorWidget',
      source: 'user' as const,
    })),
  )
}
