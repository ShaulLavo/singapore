import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import {
  javascriptContribution,
  javascriptInjectionDependencies,
} from './languages/javascript.generated'
import { createLanguagePlugin } from './plugin'

export const JAVASCRIPT_TREE_SITTER_LANGUAGE = javascriptContribution

/** JavaScript syntax, JSX included (`.js`, `.jsx`, `.mjs`, `.cjs`). */
export function javaScript(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(
    javascriptContribution,
    javascriptInjectionDependencies,
    'tree-sitter-javascript',
    options,
  )
}
