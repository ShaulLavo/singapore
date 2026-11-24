import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import { cssContribution, cssInjectionDependencies } from './languages/css.generated'
import { createLanguagePlugin } from './plugin'

export const CSS_TREE_SITTER_LANGUAGE = cssContribution

/** CSS syntax. */
export function css(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(cssContribution, cssInjectionDependencies, 'tree-sitter-css', options)
}
