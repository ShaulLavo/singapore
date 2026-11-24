/** A group of commands a keymap installs or withholds together. */
export type EditorCommandPack =
  | 'navigation'
  | 'selection'
  | 'find'
  | 'text-editing'
  | 'advanced-editing'
  | 'multi-cursor'
  | 'folding'
  | 'lsp-navigation'
  | 'lsp-editing'
  | 'inline-suggest'
  | 'suggest'
  | 'markdown'

/**
 * What a command is for, as a keymap groups it: the command packs, plus merge conflicts, whose
 * commands have no default key.
 */
export type EditorCommandCategory = EditorCommandPack | 'merge-conflict' | 'widget'

/**
 * One command's facts, known before any editor exists: its id, the name and description a palette,
 * shortcut recorder and reference show, what it is for, whether it changes the document, and the
 * VS Code commands it stands for. `EDITOR_COMMANDS` in `commandText.ts` lists them.
 */
export type EditorCommandDeclaration<Id extends string = string> = {
  readonly id: Id
  readonly title: string
  readonly description?: string
  readonly category: EditorCommandCategory
  /** Changes the document, so a readonly view refuses it. */
  readonly mutates: boolean
  readonly vscodeCommandIds?: readonly string[]
}

/**
 * Every built-in command id, once, with 1 when it changes the document (so a readonly view
 * refuses it). The editor needs only this; titles, categories and VS Code ids live in
 * `commandText.ts`, which palette, shortcut and reference UIs load through the keymap entry.
 */
const COMMANDS = [
  ['insertNewlineAndIndent', 1],
  ['copy', 0],
  ['cut', 1],
  ['paste', 1],
  ['markdown.indentListItem', 1],
  ['markdown.outdentListItem', 1],
  ['lsp.rename.accept', 1],
  ['lsp.rename.cancel', 0],
  ['tooltip.hide', 0],
  ['tooltip.scrollUp', 0],
  ['tooltip.scrollDown', 0],
  ['tooltip.pageUp', 0],
  ['tooltip.pageDown', 0],
  ['tooltip.scrollStart', 0],
  ['tooltip.scrollEnd', 0],
  ['markdown.openLink', 0],
  ['markdown.bold', 1],
  ['markdown.italic', 1],
  ['markdown.strikethrough', 1],
  ['markdown.code', 1],
  ['markdown.link', 1],
  ['markdown.heading', 1],
  ['markdown.bulletList', 1],
  ['markdown.orderedList', 1],
  ['markdown.taskList', 1],
  ['markdown.toggleTask', 1],
  ['markdown.quote', 1],
  ['markdown.codeBlock', 1],
  ['undo', 1],
  ['redo', 1],
  ['jumpBack', 0],
  ['jumpForward', 0],
  ['cursorUndo', 0],
  ['cursorRedo', 0],
  ['find', 0],
  ['findReplace', 0],
  ['findNext', 0],
  ['findPrevious', 0],
  ['editor.action.goToDefinition', 0],
  ['editor.action.goToReferences', 0],
  ['editor.action.peekDefinition', 0],
  ['editor.action.revealDefinitionAside', 0],
  ['editor.action.goToImplementation', 0],
  ['editor.action.goToTypeDefinition', 0],
  ['editor.action.showHover', 0],
  ['editor.action.marker.next', 0],
  ['editor.action.marker.prev', 0],
  ['merge-conflict.accept.current', 1],
  ['merge-conflict.accept.incoming', 1],
  ['merge-conflict.accept.both', 1],
  ['merge-conflict.accept.selection', 1],
  ['merge-conflict.accept.all-current', 1],
  ['merge-conflict.accept.all-incoming', 1],
  ['merge-conflict.accept.all-both', 1],
  ['merge-conflict.next', 0],
  ['merge-conflict.previous', 0],
  ['merge-conflict.compare', 0],
  ['closeFind', 0],
  ['toggleFindCaseSensitive', 0],
  ['toggleFindWholeWord', 0],
  ['toggleFindRegex', 0],
  ['toggleFindInSelection', 0],
  ['togglePreserveCase', 0],
  ['replaceOne', 1],
  ['replaceAll', 1],
  ['selectAllMatches', 0],
  ['selectAll', 0],
  ['editor.action.smartSelect.expand', 0],
  ['editor.action.smartSelect.shrink', 0],
  ['addNextOccurrence', 0],
  ['clearSecondarySelections', 0],
  ['editor.action.insertCursorAbove', 0],
  ['editor.action.insertCursorBelow', 0],
  ['editor.action.selectHighlights', 0],
  ['editor.action.changeAll', 0],
  ['editor.action.jumpToBracket', 0],
  ['editor.action.toggleWordWrap', 0],
  ['editor.action.toggleTabFocusMode', 0],
  ['editor.action.formatDocument', 1],
  ['editor.action.rename', 1],
  ['editor.action.autoFix', 1],
  ['editor.action.inlineSuggest.commit', 1],
  ['editor.action.inlineSuggest.acceptNextWord', 1],
  ['editor.action.triggerSuggest', 0],
  ['selectNextSuggestion', 0],
  ['selectPrevSuggestion', 0],
  ['selectNextPageSuggestion', 0],
  ['selectPrevPageSuggestion', 0],
  ['acceptSelectedSuggestion', 1],
  ['hideSuggestWidget', 0],
  ['closeParameterHints', 0],
  ['showNextParameterHint', 0],
  ['showPrevParameterHint', 0],
  ['editor.action.moveSelectionToNextFindMatch', 0],
  ['editor.fold', 0],
  ['editor.unfold', 0],
  ['editor.foldRecursively', 0],
  ['editor.unfoldRecursively', 0],
  ['editor.foldAll', 0],
  ['editor.unfoldAll', 0],
  ['editor.foldLevel1', 0],
  ['editor.foldLevel2', 0],
  ['editor.foldLevel3', 0],
  ['editor.foldLevel4', 0],
  ['editor.foldLevel5', 0],
  ['editor.foldLevel6', 0],
  ['editor.foldLevel7', 0],
  ['editor.createFoldingRangeFromSelection', 0],
  ['editor.removeManualFoldingRanges', 0],
  ['deleteBackward', 1],
  ['deleteForward', 1],
  ['deleteWordLeft', 1],
  ['deleteWordRight', 1],
  ['deleteWordPartLeft', 1],
  ['deleteWordPartRight', 1],
  ['editor.action.commentLine', 1],
  ['editor.action.blockComment', 1],
  ['editor.action.indentLines', 1],
  ['editor.action.outdentLines', 1],
  ['editor.action.reindentlines', 1],
  ['editor.action.reindentselectedlines', 1],
  ['editor.action.deleteLines', 1],
  ['editor.action.copyLinesUpAction', 1],
  ['editor.action.copyLinesDownAction', 1],
  ['editor.action.moveLinesUpAction', 1],
  ['editor.action.moveLinesDownAction', 1],
  ['editor.action.insertLineBefore', 1],
  ['editor.action.insertLineAfter', 1],
  ['editor.action.trimTrailingWhitespace', 1],
  ['editor.action.sortLinesAscending', 1],
  ['editor.action.sortLinesDescending', 1],
  ['editor.action.joinLines', 1],
  ['editor.action.duplicateSelection', 1],
  ['editor.action.transformToUppercase', 1],
  ['editor.action.transformToLowercase', 1],
  ['editor.action.transformToTitlecase', 1],
  ['cursorWordPartLeft', 0],
  ['cursorWordPartRight', 0],
  ['cursorWordPartLeftSelect', 0],
  ['cursorWordPartRightSelect', 0],
  ['indentSelection', 1],
  ['outdentSelection', 1],
  ['cursorLeft', 0],
  ['cursorRight', 0],
  ['cursorUp', 0],
  ['cursorDown', 0],
  ['selectLeft', 0],
  ['selectRight', 0],
  ['selectUp', 0],
  ['selectDown', 0],
  ['cursorWordLeft', 0],
  ['cursorWordRight', 0],
  ['selectWordLeft', 0],
  ['selectWordRight', 0],
  ['cursorLineStart', 0],
  ['cursorLineEnd', 0],
  ['selectLineStart', 0],
  ['selectLineEnd', 0],
  ['cursorPageUp', 0],
  ['cursorPageDown', 0],
  ['selectPageUp', 0],
  ['selectPageDown', 0],
  ['cursorDocumentStart', 0],
  ['cursorDocumentEnd', 0],
  ['selectDocumentStart', 0],
  ['selectDocumentEnd', 0],
  ['cursorColumnSelectLeft', 0],
  ['cursorColumnSelectRight', 0],
  ['cursorColumnSelectUp', 0],
  ['cursorColumnSelectDown', 0],
  ['cursorColumnSelectPageUp', 0],
  ['cursorColumnSelectPageDown', 0],
] as const satisfies readonly (readonly [string, 0 | 1])[]

export type EditorCommandId = (typeof COMMANDS)[number][0]

/** A plugin's own command id: the plugin's name, a dot, then the command's own name. */
export type EditorContributedCommandId = `${string}.${string}`

/** Any command an editor can dispatch: a built-in, or one a plugin contributed. */
export type EditorAnyCommandId = EditorCommandId | EditorContributedCommandId

/** A plugin's own command, declared as data so hosts can list it before any editor exists. */
export type EditorContributedCommandDeclaration = {
  readonly id: EditorContributedCommandId
  readonly title: string
  readonly description?: string
  /** Changes the document, so a readonly view refuses it. */
  readonly mutates: boolean
}

/** The built-in command ids, in catalog order. */
export const EDITOR_COMMAND_IDS: readonly EditorCommandId[] = COMMANDS.map(([id]) => id)

const mutating = new Set<string>(COMMANDS.flatMap(([id, mutates]) => (mutates ? [id] : [])))
const known = new Set<string>(EDITOR_COMMAND_IDS)

export function isEditorCommandId(command: string): command is EditorCommandId {
  return known.has(command)
}

export function editorCommandMutates(command: EditorCommandId): boolean {
  return mutating.has(command)
}
