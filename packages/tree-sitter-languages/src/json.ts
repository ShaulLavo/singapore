import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import { jsonContribution, jsonInjectionDependencies } from './languages/json.generated'
import { createLanguagePlugin } from './plugin'

export const JSON_TREE_SITTER_LANGUAGE = jsonContribution

/** JSON syntax. */
export function json(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(
    jsonContribution,
    jsonInjectionDependencies,
    'tree-sitter-json',
    options,
  )
}
