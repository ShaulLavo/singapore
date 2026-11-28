export {
  applyEditorTheme,
  darkenEditorColor,
  editorColorReference,
  editorColorValue,
  editorThemesEqual,
  effectiveEditorTheme,
  resolveEditorThemeColor,
  firstEditorColor,
  lightenEditorColor,
  mergeEditorThemes,
  registerEditorColor,
  transparentEditorColor,
} from '../theme'
export type {
  EditorColorDefaults,
  EditorColorId,
  EditorColorTransform,
  EditorColorValue,
  EditorThemeType,
} from '../theme'
export {
  createInlineMap,
  inlineReplacementsForBufferRow,
  inlineRowForBufferRow,
  revealInlineMap,
  updateInlineMapForEdit,
} from '../inlineMap'
export type {
  InlineMap,
  InlineMapUpdate,
  InlineReplacementRange,
  InlineReplacementReveal,
  InlineReplacementSpec,
} from '../inlineMap'
export type {
  InlineColumnRange,
  InlineCursorStops,
  InlineReplacement,
  InlineReplacementRender,
  InlineRow,
  InlineRowSegment,
  MaterializedInlineRow,
} from '../displayTransforms'
export type { RangeText, TextContent } from '../textContent'
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from '../theme'
export { EDITOR_SYNTAX_COLOR_VARIABLES } from '../theme'
export {
  EDITOR_VSCODE_SYNTAX_SCOPE_MAPPINGS,
  editorThemeFromVscodeTheme,
  VSCODE_THEMES,
} from '../vscodeThemes'
export type {
  EditorVscodeSyntaxScopeMapping,
  VscodeThemeColorMode,
  VscodeThemeDefinition,
  VscodeThemeLike,
  VscodeThemeRegistration,
  VscodeThemeTokenSetting,
} from '../vscodeThemes'
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  VirtualizedFoldMarker,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRowDecoration,
} from '../virtualization'
export { scheduleFrame, type ScheduledFrame } from '../editor/scheduleFrame'
