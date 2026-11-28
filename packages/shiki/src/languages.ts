import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs'

import type { ShikiLanguageMap } from './plugin'
import type { ShikiWorkerLanguageRegistration } from './workerTypes'

type BundledShikiLanguageId = keyof typeof bundledLanguages

const GRAMMAR_BY_ALIAS: ReadonlyMap<string, BundledShikiLanguageId> = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    [[info.id, info.id as BundledShikiLanguageId] as const].concat(
      (info.aliases ?? []).map((alias) => [alias, info.id as BundledShikiLanguageId] as const),
    ),
  ),
)

// Editor language ids whose grammar name differs from every Shiki alias.
const EDITOR_LANGUAGE_GRAMMARS: ReadonlyMap<string, BundledShikiLanguageId> = new Map([
  ['javascriptreact', 'jsx'],
  ['typescriptreact', 'tsx'],
])

// JavaScript and TypeScript stay out of the document map: `.jsx`/`.tsx` inference runs only when
// the map has no entry for the id.
const EXTENSION_INFERRED_LANGUAGES = new Set(['javascript', 'typescript'])

/** The Shiki grammar for an editor language id, fence label, or alias; null when Shiki has none. */
export function shikiHighlightingGrammar(language: string): BundledShikiLanguageId | null {
  const key = language.trim().toLowerCase()
  return EDITOR_LANGUAGE_GRAMMARS.get(key) ?? GRAMMAR_BY_ALIAS.get(key) ?? null
}

/** Every editor language id Shiki can color, for the Shiki document highlighter's language map. */
export const SHIKI_DOCUMENT_LANGUAGES: ShikiLanguageMap = Object.fromEntries(
  Array.from(GRAMMAR_BY_ALIAS)
    .concat(Array.from(EDITOR_LANGUAGE_GRAMMARS))
    .filter(([id]) => !EXTENSION_INFERRED_LANGUAGES.has(id)),
)

/** Loads the bundled Shiki TextMate grammar registration for a language id or alias. */
export async function loadShikiGrammar(
  language: string,
): Promise<readonly ShikiWorkerLanguageRegistration[]> {
  const grammar = shikiHighlightingGrammar(language)
  if (!grammar) throw new Error(`No Shiki grammar for ${language}`)

  const module = await bundledLanguages[grammar]()
  return module.default as unknown as readonly ShikiWorkerLanguageRegistration[]
}
