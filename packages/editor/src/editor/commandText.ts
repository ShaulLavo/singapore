import {
  EDITOR_COMMAND_IDS,
  editorCommandMutates,
  type EditorCommandDeclaration,
  type EditorCommandId,
} from './commandCatalog'

type CommandText = Omit<EditorCommandDeclaration, 'id' | 'mutates'>

/**
 * What palettes, shortcut recorders and the command reference show for each built-in command. The
 * editor never loads this table; only `EDITOR_COMMANDS` and `editorCommandDeclaration` read it.
 */
const TEXT: Readonly<Record<EditorCommandId, CommandText>> = {
  insertNewlineAndIndent: { title: 'Insert newline', category: 'text-editing' },
  copy: { title: 'Copy', category: 'selection' },
  cut: { title: 'Cut', category: 'text-editing' },
  paste: { title: 'Paste', category: 'text-editing' },
  'markdown.indentListItem': { title: 'Indent Markdown list item', category: 'markdown' },
  'markdown.outdentListItem': { title: 'Outdent Markdown list item', category: 'markdown' },
  'lsp.rename.accept': { title: 'Accept symbol name', category: 'widget' },
  'lsp.rename.cancel': { title: 'Cancel symbol rename', category: 'widget' },
  'tooltip.hide': { title: 'Close tooltip', category: 'widget' },
  'tooltip.scrollUp': { title: 'Scroll tooltip up', category: 'widget' },
  'tooltip.scrollDown': { title: 'Scroll tooltip down', category: 'widget' },
  'tooltip.pageUp': { title: 'Page tooltip up', category: 'widget' },
  'tooltip.pageDown': { title: 'Page tooltip down', category: 'widget' },
  'tooltip.scrollStart': { title: 'Scroll tooltip to start', category: 'widget' },
  'tooltip.scrollEnd': { title: 'Scroll tooltip to end', category: 'widget' },
  'markdown.openLink': { title: 'Open Markdown link', category: 'widget' },
  'markdown.bold': { title: 'Toggle Markdown bold', category: 'markdown' },
  'markdown.italic': { title: 'Toggle Markdown italic', category: 'markdown' },
  'markdown.strikethrough': { title: 'Toggle Markdown strikethrough', category: 'markdown' },
  'markdown.code': { title: 'Toggle Markdown inline code', category: 'markdown' },
  'markdown.link': { title: 'Insert Markdown link', category: 'markdown' },
  'markdown.heading': { title: 'Toggle Markdown heading', category: 'markdown' },
  'markdown.bulletList': { title: 'Toggle Markdown bullet list', category: 'markdown' },
  'markdown.orderedList': { title: 'Toggle Markdown numbered list', category: 'markdown' },
  'markdown.taskList': { title: 'Toggle Markdown task list', category: 'markdown' },
  'markdown.toggleTask': { title: 'Toggle Markdown task completion', category: 'markdown' },
  'markdown.quote': { title: 'Toggle Markdown quote', category: 'markdown' },
  'markdown.codeBlock': { title: 'Insert Markdown code block', category: 'markdown' },
  undo: { title: 'Undo', category: 'text-editing', vscodeCommandIds: ['undo'] },
  redo: { title: 'Redo', category: 'text-editing', vscodeCommandIds: ['redo'] },
  jumpBack: {
    title: 'Go back',
    category: 'text-editing',
    vscodeCommandIds: ['workbench.action.navigateBack'],
  },
  jumpForward: {
    title: 'Go forward',
    category: 'text-editing',
    vscodeCommandIds: ['workbench.action.navigateForward'],
  },
  cursorUndo: {
    title: 'Undo cursor movement',
    category: 'text-editing',
    vscodeCommandIds: ['cursorUndo'],
  },
  cursorRedo: {
    title: 'Redo cursor movement',
    category: 'text-editing',
    vscodeCommandIds: ['cursorRedo'],
  },
  find: { title: 'Find', category: 'find', vscodeCommandIds: ['actions.find'] },
  findReplace: {
    title: 'Find and replace',
    category: 'text-editing',
    vscodeCommandIds: ['editor.action.startFindReplaceAction'],
  },
  findNext: {
    title: 'Find next',
    category: 'find',
    vscodeCommandIds: ['editor.action.nextMatchFindAction'],
  },
  findPrevious: {
    title: 'Find previous',
    category: 'find',
    vscodeCommandIds: ['editor.action.previousMatchFindAction'],
  },
  'editor.action.goToDefinition': {
    title: 'Go to definition',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.goToDefinition'],
  },
  'editor.action.goToReferences': {
    title: 'Find references',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.goToReferences'],
  },
  'editor.action.peekDefinition': {
    title: 'Peek definition',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.peekDefinition'],
  },
  'editor.action.revealDefinitionAside': {
    title: 'Open definition to the side',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.revealDefinitionAside'],
  },
  'editor.action.goToImplementation': {
    title: 'Go to implementation',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.goToImplementation'],
  },
  'editor.action.goToTypeDefinition': {
    title: 'Go to type definition',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.goToTypeDefinition'],
  },
  'editor.action.showHover': {
    title: 'Show hover',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.showHover'],
  },
  'editor.action.marker.next': {
    title: 'Next diagnostic',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.marker.next'],
  },
  'editor.action.marker.prev': {
    title: 'Previous diagnostic',
    category: 'lsp-navigation',
    vscodeCommandIds: ['editor.action.marker.prev'],
  },
  'merge-conflict.accept.current': {
    title: 'Merge conflict: accept current',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.current'],
  },
  'merge-conflict.accept.incoming': {
    title: 'Merge conflict: accept incoming',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.incoming'],
  },
  'merge-conflict.accept.both': {
    title: 'Merge conflict: accept both',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.both'],
  },
  'merge-conflict.accept.selection': {
    title: 'Merge conflict: accept selection',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.selection'],
  },
  'merge-conflict.accept.all-current': {
    title: 'Merge conflict: accept all current',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.all-current'],
  },
  'merge-conflict.accept.all-incoming': {
    title: 'Merge conflict: accept all incoming',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.all-incoming'],
  },
  'merge-conflict.accept.all-both': {
    title: 'Merge conflict: accept all both',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.accept.all-both'],
  },
  'merge-conflict.next': {
    title: 'Merge conflict: next conflict',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.next'],
  },
  'merge-conflict.previous': {
    title: 'Merge conflict: previous conflict',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.previous'],
  },
  'merge-conflict.compare': {
    title: 'Merge conflict: compare current conflict',
    category: 'merge-conflict',
    vscodeCommandIds: ['merge-conflict.compare'],
  },
  closeFind: { title: 'Close find', category: 'find', vscodeCommandIds: ['closeFindWidget'] },
  toggleFindCaseSensitive: {
    title: 'Toggle case sensitive find',
    category: 'find',
    vscodeCommandIds: ['toggleFindCaseSensitive'],
  },
  toggleFindWholeWord: {
    title: 'Toggle whole word find',
    category: 'find',
    vscodeCommandIds: ['toggleFindWholeWord'],
  },
  toggleFindRegex: {
    title: 'Toggle regex find',
    category: 'find',
    vscodeCommandIds: ['toggleFindRegex'],
  },
  toggleFindInSelection: {
    title: 'Toggle find in selection',
    category: 'find',
    vscodeCommandIds: ['toggleFindInSelection'],
  },
  togglePreserveCase: {
    title: 'Toggle preserve case',
    category: 'find',
    vscodeCommandIds: ['togglePreserveCase'],
  },
  replaceOne: {
    title: 'Replace',
    category: 'text-editing',
    vscodeCommandIds: ['editor.action.replaceOne'],
  },
  replaceAll: {
    title: 'Replace all',
    category: 'text-editing',
    vscodeCommandIds: ['editor.action.replaceAll'],
  },
  selectAllMatches: {
    title: 'Select all matches',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.selectAllMatches'],
  },
  selectAll: {
    title: 'Select all',
    category: 'selection',
    vscodeCommandIds: ['editor.action.selectAll'],
  },
  'editor.action.smartSelect.expand': {
    title: 'Expand selection',
    category: 'selection',
    vscodeCommandIds: ['editor.action.smartSelect.expand'],
  },
  'editor.action.smartSelect.shrink': {
    title: 'Shrink selection',
    category: 'selection',
    vscodeCommandIds: ['editor.action.smartSelect.shrink'],
  },
  addNextOccurrence: {
    title: 'Add next occurrence',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.addSelectionToNextFindMatch'],
  },
  clearSecondarySelections: {
    title: 'Clear secondary selections',
    category: 'multi-cursor',
    vscodeCommandIds: ['removeSecondaryCursors'],
  },
  'editor.action.insertCursorAbove': {
    title: 'Add cursor above',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.insertCursorAbove'],
  },
  'editor.action.insertCursorBelow': {
    title: 'Add cursor below',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.insertCursorBelow'],
  },
  'editor.action.selectHighlights': {
    title: 'Select all occurrences',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.selectHighlights'],
  },
  'editor.action.changeAll': {
    title: 'Change all occurrences',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.changeAll'],
  },
  'editor.action.jumpToBracket': {
    title: 'Go to bracket',
    category: 'navigation',
    vscodeCommandIds: ['editor.action.jumpToBracket'],
  },
  'editor.action.toggleWordWrap': {
    title: 'Toggle word wrap',
    category: 'navigation',
    vscodeCommandIds: ['editor.action.toggleWordWrap'],
  },
  'editor.action.toggleTabFocusMode': {
    title: 'Toggle Tab focus mode',
    category: 'text-editing',
    vscodeCommandIds: ['editor.action.toggleTabFocusMode'],
  },
  'editor.action.formatDocument': {
    title: 'Format document',
    category: 'lsp-editing',
    vscodeCommandIds: ['editor.action.formatDocument'],
  },
  'editor.action.rename': {
    title: 'Rename symbol',
    category: 'lsp-editing',
    vscodeCommandIds: ['editor.action.rename'],
  },
  'editor.action.autoFix': {
    title: 'Apply auto fix',
    category: 'lsp-editing',
    vscodeCommandIds: ['editor.action.autoFix'],
  },
  'editor.action.inlineSuggest.commit': {
    title: 'Accept inline suggestion',
    category: 'inline-suggest',
    vscodeCommandIds: ['editor.action.inlineSuggest.commit'],
  },
  'editor.action.inlineSuggest.acceptNextWord': {
    title: 'Accept next word of inline suggestion',
    category: 'inline-suggest',
    vscodeCommandIds: ['editor.action.inlineSuggest.acceptNextWord'],
  },
  'editor.action.triggerSuggest': {
    title: 'Trigger suggest',
    category: 'suggest',
    vscodeCommandIds: ['editor.action.triggerSuggest'],
  },
  selectNextSuggestion: {
    title: 'Select next suggestion',
    category: 'suggest',
    vscodeCommandIds: ['selectNextSuggestion'],
  },
  selectPrevSuggestion: {
    title: 'Select previous suggestion',
    category: 'suggest',
    vscodeCommandIds: ['selectPrevSuggestion'],
  },
  selectNextPageSuggestion: {
    title: 'Select next page of suggestions',
    category: 'suggest',
    vscodeCommandIds: ['selectNextPageSuggestion'],
  },
  selectPrevPageSuggestion: {
    title: 'Select previous page of suggestions',
    category: 'suggest',
    vscodeCommandIds: ['selectPrevPageSuggestion'],
  },
  acceptSelectedSuggestion: {
    title: 'Accept selected suggestion',
    category: 'suggest',
    vscodeCommandIds: ['acceptSelectedSuggestion'],
  },
  hideSuggestWidget: {
    title: 'Hide suggestions',
    category: 'suggest',
    vscodeCommandIds: ['hideSuggestWidget'],
  },
  closeParameterHints: {
    title: 'Close parameter hints',
    category: 'suggest',
    vscodeCommandIds: ['closeParameterHints'],
  },
  showNextParameterHint: {
    title: 'Show next parameter hint',
    category: 'suggest',
    vscodeCommandIds: ['showNextParameterHint'],
  },
  showPrevParameterHint: {
    title: 'Show previous parameter hint',
    category: 'suggest',
    vscodeCommandIds: ['showPrevParameterHint'],
  },
  'editor.action.moveSelectionToNextFindMatch': {
    title: 'Move last selection to next find match',
    category: 'multi-cursor',
    vscodeCommandIds: ['editor.action.moveSelectionToNextFindMatch'],
  },
  'editor.fold': { title: 'Fold', category: 'folding', vscodeCommandIds: ['editor.fold'] },
  'editor.unfold': { title: 'Unfold', category: 'folding', vscodeCommandIds: ['editor.unfold'] },
  'editor.foldRecursively': {
    title: 'Fold recursively',
    category: 'folding',
    vscodeCommandIds: ['editor.foldRecursively'],
  },
  'editor.unfoldRecursively': {
    title: 'Unfold recursively',
    category: 'folding',
    vscodeCommandIds: ['editor.unfoldRecursively'],
  },
  'editor.foldAll': {
    title: 'Fold all',
    category: 'folding',
    vscodeCommandIds: ['editor.foldAll'],
  },
  'editor.unfoldAll': {
    title: 'Unfold all',
    category: 'folding',
    vscodeCommandIds: ['editor.unfoldAll'],
  },
  'editor.foldLevel1': {
    title: 'Fold level1',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel1'],
  },
  'editor.foldLevel2': {
    title: 'Fold level2',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel2'],
  },
  'editor.foldLevel3': {
    title: 'Fold level3',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel3'],
  },
  'editor.foldLevel4': {
    title: 'Fold level4',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel4'],
  },
  'editor.foldLevel5': {
    title: 'Fold level5',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel5'],
  },
  'editor.foldLevel6': {
    title: 'Fold level6',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel6'],
  },
  'editor.foldLevel7': {
    title: 'Fold level7',
    category: 'folding',
    vscodeCommandIds: ['editor.foldLevel7'],
  },
  'editor.createFoldingRangeFromSelection': {
    title: 'Fold selection',
    category: 'folding',
    vscodeCommandIds: ['editor.createFoldingRangeFromSelection'],
  },
  'editor.removeManualFoldingRanges': {
    title: 'Remove manual folding ranges',
    category: 'folding',
    vscodeCommandIds: ['editor.removeManualFoldingRanges'],
  },
  deleteBackward: { title: 'Delete backward', category: 'text-editing' },
  deleteForward: { title: 'Delete forward', category: 'text-editing' },
  deleteWordLeft: {
    title: 'Delete word left',
    category: 'advanced-editing',
    vscodeCommandIds: ['deleteWordLeft'],
  },
  deleteWordRight: {
    title: 'Delete word right',
    category: 'advanced-editing',
    vscodeCommandIds: ['deleteWordRight'],
  },
  deleteWordPartLeft: {
    title: 'Delete word part left',
    category: 'advanced-editing',
    vscodeCommandIds: ['deleteWordPartLeft'],
  },
  deleteWordPartRight: {
    title: 'Delete word part right',
    category: 'advanced-editing',
    vscodeCommandIds: ['deleteWordPartRight'],
  },
  'editor.action.commentLine': {
    title: 'Toggle line comment',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.commentLine'],
  },
  'editor.action.blockComment': {
    title: 'Toggle block comment',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.blockComment'],
  },
  'editor.action.indentLines': {
    title: 'Indent line',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.indentLines'],
  },
  'editor.action.outdentLines': {
    title: 'Outdent line',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.outdentLines'],
  },
  'editor.action.reindentlines': {
    title: 'Reindent lines',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.reindentlines'],
  },
  'editor.action.reindentselectedlines': {
    title: 'Reindent selected lines',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.reindentselectedlines'],
  },
  'editor.action.deleteLines': {
    title: 'Delete line',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.deleteLines'],
  },
  'editor.action.copyLinesUpAction': {
    title: 'Copy line up',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.copyLinesUpAction'],
  },
  'editor.action.copyLinesDownAction': {
    title: 'Copy line down',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.copyLinesDownAction'],
  },
  'editor.action.moveLinesUpAction': {
    title: 'Move line up',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.moveLinesUpAction'],
  },
  'editor.action.moveLinesDownAction': {
    title: 'Move line down',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.moveLinesDownAction'],
  },
  'editor.action.insertLineBefore': {
    title: 'Insert line above',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.insertLineBefore'],
  },
  'editor.action.insertLineAfter': {
    title: 'Insert line below',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.insertLineAfter'],
  },
  'editor.action.trimTrailingWhitespace': {
    title: 'Trim trailing whitespace',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.trimTrailingWhitespace'],
  },
  'editor.action.sortLinesAscending': {
    title: 'Sort lines ascending',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.sortLinesAscending'],
  },
  'editor.action.sortLinesDescending': {
    title: 'Sort lines descending',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.sortLinesDescending'],
  },
  'editor.action.joinLines': {
    title: 'Join lines',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.joinLines'],
  },
  'editor.action.duplicateSelection': {
    title: 'Duplicate selection',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.duplicateSelection'],
  },
  'editor.action.transformToUppercase': {
    title: 'Transform to uppercase',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.transformToUppercase'],
  },
  'editor.action.transformToLowercase': {
    title: 'Transform to lowercase',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.transformToLowercase'],
  },
  'editor.action.transformToTitlecase': {
    title: 'Transform to title case',
    category: 'advanced-editing',
    vscodeCommandIds: ['editor.action.transformToTitlecase'],
  },
  cursorWordPartLeft: {
    title: 'Cursor word part left',
    category: 'navigation',
    vscodeCommandIds: ['cursorWordPartLeft'],
  },
  cursorWordPartRight: {
    title: 'Cursor word part right',
    category: 'navigation',
    vscodeCommandIds: ['cursorWordPartRight'],
  },
  cursorWordPartLeftSelect: {
    title: 'Cursor word part left select',
    category: 'selection',
    vscodeCommandIds: ['cursorWordPartLeftSelect'],
  },
  cursorWordPartRightSelect: {
    title: 'Cursor word part right select',
    category: 'selection',
    vscodeCommandIds: ['cursorWordPartRightSelect'],
  },
  indentSelection: {
    title: 'Indent selection',
    category: 'text-editing',
    vscodeCommandIds: ['tab'],
  },
  outdentSelection: {
    title: 'Outdent selection',
    category: 'text-editing',
    vscodeCommandIds: ['outdent'],
  },
  cursorLeft: {
    title: 'Move cursor left',
    category: 'navigation',
    vscodeCommandIds: ['cursorLeft'],
  },
  cursorRight: {
    title: 'Move cursor right',
    category: 'navigation',
    vscodeCommandIds: ['cursorRight'],
  },
  cursorUp: { title: 'Move cursor up', category: 'navigation', vscodeCommandIds: ['cursorUp'] },
  cursorDown: {
    title: 'Move cursor down',
    category: 'navigation',
    vscodeCommandIds: ['cursorDown'],
  },
  selectLeft: {
    title: 'Select left',
    category: 'selection',
    vscodeCommandIds: ['cursorLeftSelect'],
  },
  selectRight: {
    title: 'Select right',
    category: 'selection',
    vscodeCommandIds: ['cursorRightSelect'],
  },
  selectUp: { title: 'Select up', category: 'selection', vscodeCommandIds: ['cursorUpSelect'] },
  selectDown: {
    title: 'Select down',
    category: 'selection',
    vscodeCommandIds: ['cursorDownSelect'],
  },
  cursorWordLeft: {
    title: 'Move cursor word left',
    category: 'navigation',
    vscodeCommandIds: ['cursorWordLeft'],
  },
  cursorWordRight: {
    title: 'Move cursor word right',
    category: 'navigation',
    vscodeCommandIds: ['cursorWordRight', 'cursorWordEndRight'],
  },
  selectWordLeft: {
    title: 'Select word left',
    category: 'selection',
    vscodeCommandIds: ['cursorWordLeftSelect'],
  },
  selectWordRight: {
    title: 'Select word right',
    category: 'selection',
    vscodeCommandIds: ['cursorWordRightSelect', 'cursorWordEndRightSelect'],
  },
  cursorLineStart: {
    title: 'Move cursor to line start',
    category: 'navigation',
    vscodeCommandIds: ['cursorHome', 'cursorLineStart'],
  },
  cursorLineEnd: {
    title: 'Move cursor to line end',
    category: 'navigation',
    vscodeCommandIds: ['cursorEnd', 'cursorLineEnd'],
  },
  selectLineStart: {
    title: 'Select to line start',
    category: 'selection',
    vscodeCommandIds: ['cursorHomeSelect', 'cursorLineStartSelect'],
  },
  selectLineEnd: {
    title: 'Select to line end',
    category: 'selection',
    vscodeCommandIds: ['cursorEndSelect', 'cursorLineEndSelect'],
  },
  cursorPageUp: {
    title: 'Move cursor page up',
    category: 'navigation',
    vscodeCommandIds: ['cursorPageUp'],
  },
  cursorPageDown: {
    title: 'Move cursor page down',
    category: 'navigation',
    vscodeCommandIds: ['cursorPageDown'],
  },
  selectPageUp: {
    title: 'Select page up',
    category: 'selection',
    vscodeCommandIds: ['cursorPageUpSelect'],
  },
  selectPageDown: {
    title: 'Select page down',
    category: 'selection',
    vscodeCommandIds: ['cursorPageDownSelect'],
  },
  cursorDocumentStart: {
    title: 'Move cursor to document start',
    category: 'navigation',
    vscodeCommandIds: ['cursorTop'],
  },
  cursorDocumentEnd: {
    title: 'Move cursor to document end',
    category: 'navigation',
    vscodeCommandIds: ['cursorBottom'],
  },
  selectDocumentStart: {
    title: 'Select to document start',
    category: 'selection',
    vscodeCommandIds: ['cursorTopSelect'],
  },
  selectDocumentEnd: {
    title: 'Select to document end',
    category: 'selection',
    vscodeCommandIds: ['cursorBottomSelect'],
  },
  cursorColumnSelectLeft: {
    title: 'Cursor column select left',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectLeft'],
  },
  cursorColumnSelectRight: {
    title: 'Cursor column select right',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectRight'],
  },
  cursorColumnSelectUp: {
    title: 'Cursor column select up',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectUp'],
  },
  cursorColumnSelectDown: {
    title: 'Cursor column select down',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectDown'],
  },
  cursorColumnSelectPageUp: {
    title: 'Cursor column select page up',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectPageUp'],
  },
  cursorColumnSelectPageDown: {
    title: 'Cursor column select page down',
    category: 'selection',
    vscodeCommandIds: ['cursorColumnSelectPageDown'],
  },
}

/** Every built-in command, once, with the text a palette or reference shows. */
export const EDITOR_COMMANDS: readonly EditorCommandDeclaration<EditorCommandId>[] =
  EDITOR_COMMAND_IDS.map((id) => ({ id, ...TEXT[id], mutates: editorCommandMutates(id) }))

const declarations = new Map(EDITOR_COMMANDS.map((declaration) => [declaration.id, declaration]))

export function editorCommandDeclaration(
  command: EditorCommandId,
): EditorCommandDeclaration<EditorCommandId> {
  return declarations.get(command)!
}
