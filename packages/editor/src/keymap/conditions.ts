import type { EditorCommandId } from '../editor/commands'

/**
 * The editor's own keys, plus any a plugin registered for the state it owns (`findVisible`,
 * `suggestWidgetVisible`). A key nobody registered reads as false.
 */
export type EditorKeymapContext = Readonly<Record<string, boolean>> & {
  readonly writable: boolean
  readonly hasSelection: boolean
  readonly tabFocusMode: boolean
  readonly inlineSuggestionVisible: boolean
}
/** A context key, or `!key` for its negation. */
export type EditorKeyCondition = string
export function editorKeyConditionMatches(
  condition: EditorKeyCondition,
  context: EditorKeymapContext,
): boolean {
  if (condition.startsWith('!')) return context[condition.slice(1)] !== true
  return context[condition] === true
}
const mutations = new Set<EditorCommandId>([
  'merge-conflict.accept.current',
  'merge-conflict.accept.incoming',
  'merge-conflict.accept.both',
  'merge-conflict.accept.selection',
  'merge-conflict.accept.all-current',
  'merge-conflict.accept.all-incoming',
  'merge-conflict.accept.all-both',
  'undo',
  'redo',
  'deleteBackward',
  'deleteForward',
  'deleteWordLeft',
  'deleteWordRight',
  'deleteWordPartLeft',
  'deleteWordPartRight',
  'indentSelection',
  'outdentSelection',
  'replaceOne',
  'replaceAll',
  'editor.action.commentLine',
  'editor.action.blockComment',
  'editor.action.indentLines',
  'editor.action.outdentLines',
  'editor.action.reindentlines',
  'editor.action.reindentselectedlines',
  'editor.action.deleteLines',
  'editor.action.copyLinesUpAction',
  'editor.action.copyLinesDownAction',
  'editor.action.moveLinesUpAction',
  'editor.action.moveLinesDownAction',
  'editor.action.insertLineBefore',
  'editor.action.insertLineAfter',
  'editor.action.trimTrailingWhitespace',
  'editor.action.sortLinesAscending',
  'editor.action.sortLinesDescending',
  'editor.action.joinLines',
  'editor.action.duplicateSelection',
  'editor.action.transformToUppercase',
  'editor.action.transformToLowercase',
  'editor.action.transformToTitlecase',
  'editor.action.formatDocument',
  'editor.action.rename',
  'editor.action.autoFix',
  'editor.action.inlineSuggest.commit',
  'editor.action.inlineSuggest.acceptNextWord',
  'acceptSelectedSuggestion',
])
export function editorCommandMutates(command: EditorCommandId): boolean {
  return mutations.has(command)
}
