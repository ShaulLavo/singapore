import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import { tsxContribution, tsxInjectionDependencies } from './languages/tsx.generated'
import { createLanguagePlugin } from './plugin'

export const TSX_TREE_SITTER_LANGUAGE = tsxContribution

/** TypeScript with JSX (`.tsx`). */
export function tsx(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(tsxContribution, tsxInjectionDependencies, 'tree-sitter-tsx', options)
}
