export { createIncrementalTokenizer } from './tokenizer'
export {
  createShikiHighlighterPlugin,
  createShikiHighlighterProvider,
  shikiLanguageForDocument,
} from './plugin'
export { loadShikiGrammar, SHIKI_DOCUMENT_LANGUAGES, shikiHighlightingGrammar } from './languages'
export {
  EDITOR_SHIKI_SYNTAX_SCOPE_MAPPINGS,
  editorThemeToShikiTheme,
  editorThemeToShikiTokenColors,
} from './theme'
export { editorThemeFromShikiTheme } from './theme-extract'
export {
  editorThemeFromVscodeTheme,
  VSCODE_THEMES,
  type VscodeThemeDefinition,
  type VscodeThemeRegistration,
} from '@singapore-editor/core/rendering'
export {
  canUseShikiWorker,
  createShikiWorkerOwner,
  DEFAULT_SHIKI_MAX_TOKENIZATION_LINE_LENGTH,
  ShikiWorkerOwner,
} from './workerClient'

export { snapshotToEditorTokens, tokenLinesToEditorTokens } from './editor-tokens'

export type {
  CreateIncrementalTokenizerOptions,
  CreateIncrementalTokenizerResult,
  IncrementalTokenizer,
  IncrementalTokenizerSnapshot,
  IncrementalTokenizerRetentionSnapshot,
  LineTokens,
  StatesEqualFn,
  TokenizeLineFn,
  TokenLineSnapshot,
  TokenPatch,
} from './tokenizer'
export type {
  ShikiHighlighterPluginOptions,
  ShikiLanguageMap,
  ShikiLanguageRegistrationResolver,
  ShikiThemeRegistrationResolver,
} from './plugin'
export type {
  EditorShikiSyntaxScopeMapping,
  EditorShikiTheme,
  EditorShikiThemeColorMode,
  EditorShikiThemeSettingLike,
  EditorThemeToShikiThemeOptions,
} from './theme'
export type { ShikiThemeLike } from './theme-extract'
export type {
  ShikiWorkerLanguageRegistration,
  ShikiWorkerThemeRegistration,
  ShikiWorkerTransportResult,
  ShikiWorkerRetentionSnapshot,
} from './workerTypes'
export type {
  ShikiPreloadRegistrations,
  ShikiResolvedRegistrations,
  ShikiThemeOptions,
  ShikiWorkerCacheSnapshot,
  ShikiWorkerLifecycleState,
  ShikiWorkerOwnerOptions,
  ShikiWorkerOwnerSnapshot,
} from './workerClient'
