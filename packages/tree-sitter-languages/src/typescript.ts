import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguagePluginOptions } from '@singapore-editor/tree-sitter'
import {
  typescriptContribution,
  typescriptInjectionDependencies,
} from './languages/typescript.generated'
import { createLanguagePlugin } from './plugin'

export const TYPESCRIPT_TREE_SITTER_LANGUAGE = typescriptContribution

/** TypeScript syntax (`.ts`, `.mts`, `.cts`). TSX is its own grammar: use `tsx()`. */
export function typeScript(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(
    typescriptContribution,
    typescriptInjectionDependencies,
    'tree-sitter-typescript',
    options,
  )
}
