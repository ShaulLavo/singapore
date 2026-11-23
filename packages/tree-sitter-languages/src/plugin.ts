import { createTreeSitterLanguagePlugin } from '@singapore-editor/tree-sitter'
import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type {
  TreeSitterLanguageContribution,
  TreeSitterLanguagePluginOptions,
} from '@singapore-editor/tree-sitter'

export function createLanguagePlugin(
  root: TreeSitterLanguageContribution,
  dependencies: readonly TreeSitterLanguageContribution[],
  name: string,
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin {
  return createTreeSitterLanguagePlugin([root].concat(dependencies), {
    ...options,
    name: options.name ?? name,
  })
}
