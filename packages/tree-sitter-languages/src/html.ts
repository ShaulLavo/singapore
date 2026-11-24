import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import { htmlContribution, htmlInjectionDependencies } from './languages/html.generated'
import { createLanguagePlugin } from './plugin'

export const HTML_TREE_SITTER_LANGUAGE = htmlContribution

/** HTML syntax, with the CSS and JavaScript it embeds. */
export function html(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(
    htmlContribution,
    htmlInjectionDependencies,
    'tree-sitter-html',
    options,
  )
}
