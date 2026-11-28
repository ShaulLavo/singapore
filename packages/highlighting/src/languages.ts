import type { TreeSitterHighlightLanguageMap } from '@singapore-editor/tree-sitter'
import { TREE_SITTER_LANGUAGE_METADATA } from '@singapore-editor/tree-sitter-languages/metadata'

const GRAMMAR_BY_ALIAS: ReadonlyMap<string, string> = new Map(
  TREE_SITTER_LANGUAGE_METADATA.flatMap((info): readonly (readonly [string, string])[] => {
    const base: readonly (readonly [string, string])[] = [[info.id, info.id]]
    return base.concat(info.aliases.map((alias) => [alias.toLowerCase(), info.id] as const))
  }),
)

// Editor language ids and JSX/TSX aliases whose Wave 1 scope pack differs from their base grammar.
const PACK_ALIAS_OVERRIDES: Readonly<Record<string, string>> = {
  javascriptreact: 'jsx',
  jsx: 'jsx',
  tsx: 'tsx',
  typescriptreact: 'tsx',
}

// JavaScript and TypeScript stay out of the document map: `.jsx`/`.tsx` inference runs only when
// the map has no entry for the id.
const EXTENSION_INFERRED_LANGUAGES = new Set(['javascript', 'typescript'])

/** The Tree-sitter grammar or scope-pack id for an editor language id or alias; null when unsupported. */
export function highlightingGrammar(language: string): string | null {
  const key = language.trim().toLowerCase()
  return PACK_ALIAS_OVERRIDES[key] ?? GRAMMAR_BY_ALIAS.get(key) ?? null
}

/** Every editor language id Tree-sitter can color, for the document highlighter's language map. */
export const HIGHLIGHTING_DOCUMENT_LANGUAGES: TreeSitterHighlightLanguageMap = Object.fromEntries(
  Array.from(GRAMMAR_BY_ALIAS)
    .concat(Object.entries(PACK_ALIAS_OVERRIDES))
    .filter(([id]) => !EXTENSION_INFERRED_LANGUAGES.has(id)),
)
