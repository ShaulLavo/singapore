import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import { markdownContribution, markdownInjectionDependencies } from './languages/markdown.generated'
import { createLanguagePlugin } from './plugin'

export const MARKDOWN_TREE_SITTER_LANGUAGE = markdownContribution

/** Markdown syntax. */
export function markdown(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(
    markdownContribution,
    markdownInjectionDependencies,
    'tree-sitter-markdown',
    options,
  )
}
