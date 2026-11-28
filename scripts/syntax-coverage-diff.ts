import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { highlightingGrammar } from '../packages/highlighting/src/languages'
import { TREE_SITTER_LANGUAGE_METADATA } from '../packages/tree-sitter-languages/src/metadata'

const repoRoot = resolve(import.meta.dirname, '..')
const treeSitterRequire = createRequire(resolve(repoRoot, 'packages/tree-sitter/package.json'))
const shikiRequire = createRequire(resolve(repoRoot, 'packages/shiki/package.json'))
const { BUILTIN_PACKS } = (await import(
  pathToFileURL(treeSitterRequire.resolve('@shaulavo/tree-sitter-scope-compat')).href
)) as { readonly BUILTIN_PACKS: Readonly<Record<string, { readonly languageId: string }>> }
const { bundledLanguagesInfo } = (await import(
  pathToFileURL(shikiRequire.resolve('shiki/langs')).href
)) as {
  readonly bundledLanguagesInfo: readonly {
    readonly id: string
    readonly aliases?: readonly string[]
  }[]
}

type LanguageRow = {
  readonly id: string
  readonly aliases: readonly string[]
  readonly afterGrammar: string | null
  readonly tier: 'wave1-native-pack' | 'zed-plus-fallback' | 'opt-in-shiki-only'
}

const DEFAULT_FREGAT_PATH = '/work/projects/platform/packages/client-core/src/files/language.ts'

const parseArgs = () => {
  const args = process.argv.slice(2)
  let fregatPath = DEFAULT_FREGAT_PATH
  let outPath: string | null = null
  let format: 'json' | 'markdown' = 'markdown'
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--fregat' && args[index + 1]) fregatPath = args[++index]!
    else if (arg === '--out' && args[index + 1]) outPath = args[++index]!
    else if (arg === '--json') format = 'json'
  }
  return { fregatPath, outPath, format }
}

const extractFregatLanguages = (filePath: string): readonly string[] => {
  if (!existsSync(filePath)) return []
  const source = readFileSync(filePath, 'utf8')
  const ids = new Set<string>()
  const pattern = /:\s*'([a-z0-9+#-]+)'/gi
  for (const match of source.matchAll(pattern)) {
    const id = match[1]?.toLowerCase()
    if (!id || id === 'plaintext' || id === 'text') continue
    ids.add(id)
  }
  return Array.from(ids).sort()
}

const classifyLanguage = (
  languageId: string,
): { readonly grammar: string | null; readonly tier: LanguageRow['tier'] } => {
  const grammar = highlightingGrammar(languageId)
  if (!grammar) return { grammar: null, tier: 'opt-in-shiki-only' }
  if (Object.hasOwn(BUILTIN_PACKS, grammar)) {
    return { grammar, tier: 'wave1-native-pack' }
  }
  return { grammar, tier: 'zed-plus-fallback' }
}

const buildCoverageDiff = (fregatPath: string) => {
  const shikiCanonical: LanguageRow[] = bundledLanguagesInfo
    .map((info) => {
      const { grammar, tier } = classifyLanguage(info.id)
      return {
        id: info.id,
        aliases: (info.aliases ?? []).toSorted(),
        afterGrammar: grammar,
        tier,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))

  const shikiAllIdentifiers = new Map<string, string>()
  for (const info of bundledLanguagesInfo) {
    shikiAllIdentifiers.set(info.id.toLowerCase(), info.id)
    for (const alias of info.aliases ?? []) {
      shikiAllIdentifiers.set(alias.toLowerCase(), info.id)
    }
  }
  shikiAllIdentifiers.set('javascriptreact', 'jsx')
  shikiAllIdentifiers.set('typescriptreact', 'tsx')

  const coveredIdentifiers: string[] = []
  const droppedIdentifiers: string[] = []
  for (const id of Array.from(shikiAllIdentifiers.keys()).sort()) {
    if (highlightingGrammar(id) !== null) coveredIdentifiers.push(id)
    else droppedIdentifiers.push(id)
  }

  const afterMetadata = TREE_SITTER_LANGUAGE_METADATA.map((entry) => ({
    id: entry.id,
    aliases: entry.aliases,
    tier: Object.hasOwn(BUILTIN_PACKS, entry.id) ? 'wave1-native-pack' : 'zed-plus-fallback',
  }))

  const fregatIds = extractFregatLanguages(fregatPath)
  const fregatWave1: string[] = []
  const fregatFallback: string[] = []
  const fregatDropped: string[] = []
  for (const id of fregatIds) {
    const { tier } = classifyLanguage(id)
    if (tier === 'wave1-native-pack') fregatWave1.push(id)
    else if (tier === 'zed-plus-fallback') fregatFallback.push(id)
    else fregatDropped.push(id)
  }

  const wave1Canonical = shikiCanonical.filter((row) => row.tier === 'wave1-native-pack')
  const fallbackCanonical = shikiCanonical.filter((row) => row.tier === 'zed-plus-fallback')
  const droppedCanonical = shikiCanonical.filter((row) => row.tier === 'opt-in-shiki-only')

  return {
    summary: {
      beforeShikiCanonicalIds: shikiCanonical.length,
      beforeShikiTotalIdentifiers: shikiAllIdentifiers.size,
      afterTreeSitterGrammars: afterMetadata.length,
      afterWave1NativePacks: Object.keys(BUILTIN_PACKS).length,
      afterCoveredShikiCanonicalIds: wave1Canonical.length + fallbackCanonical.length,
      afterDroppedShikiCanonicalIds: droppedCanonical.length,
      afterCoveredShikiIdentifiers: coveredIdentifiers.length,
      afterDroppedShikiIdentifiers: droppedIdentifiers.length,
      fregatTotalIds: fregatIds.length,
      fregatCoveredTotal: fregatWave1.length + fregatFallback.length,
      fregatCoveredWave1: fregatWave1.length,
      fregatCoveredFallback: fregatFallback.length,
      fregatDropped: fregatDropped.length,
    },
    fregat: {
      coveredWave1: fregatWave1,
      coveredFallback: fregatFallback,
      dropped: fregatDropped,
    },
    shikiCanonical: {
      wave1: wave1Canonical.map((row) => row.id),
      fallback: fallbackCanonical.map((row) => row.id),
      dropped: droppedCanonical.map((row) => row.id),
    },
    shikiIdentifiers: {
      covered: coveredIdentifiers,
      dropped: droppedIdentifiers,
    },
  }
}

const formatMarkdown = (diff: ReturnType<typeof buildCoverageDiff>): string => {
  const s = diff.summary
  const lines: string[] = [
    '# Singapore Tree-sitter Default Cutover — Language & Alias Coverage Diff',
    '',
    '## Summary',
    '',
    '| Surface | Before (Shiki default) | After (Tree-sitter default) | Delta / Notes |',
    '| --- | ---: | ---: | --- |',
    `| Singapore canonical language IDs | ${s.beforeShikiCanonicalIds} | ${s.afterCoveredShikiCanonicalIds} (+${s.afterTreeSitterGrammars - s.afterCoveredShikiCanonicalIds} internal: jsdoc, regex) | ${s.afterDroppedShikiCanonicalIds} Shiki-only IDs moved to optional \`@singapore-editor/shiki\` |`,
    `| Singapore total accepted identifiers (IDs + aliases) | ${s.beforeShikiTotalIdentifiers} | ${s.afterCoveredShikiIdentifiers} | ${s.afterDroppedShikiIdentifiers} Shiki-only identifiers moved to optional \`@singapore-editor/shiki\` |`,
    `| Wave 1 native C scope-compat packs | 0 | ${s.afterWave1NativePacks} | \`json\`, \`javascript\`, \`jsx\`, \`typescript\`, \`tsx\`, \`css\`, \`html\`, \`shellscript\`, \`rust\`, \`python\`, \`go\`, \`yaml\`, \`toml\` |`,
    `| Fregat file-map language IDs | ${s.fregatTotalIds} | ${s.fregatCoveredTotal} (${s.fregatCoveredWave1} Wave 1 + ${s.fregatCoveredFallback} Zed-plus fallback) | **${s.fregatDropped} Fregat IDs** not in Tree-sitter catalog (opt-in \`@singapore-editor/shiki\` preserves all ${s.fregatTotalIds}) |`,
    '',
    `## Fregat File Map (${s.fregatTotalIds} IDs)`,
    '',
    `- **Covered by Wave 1 native C scope-compat packs (${s.fregatCoveredWave1}):** ${diff.fregat.coveredWave1.map((id) => `\`${id}\``).join(', ')}`,
    `- **Covered by universal Zed-plus capture fallback (${s.fregatCoveredFallback}):** ${diff.fregat.coveredFallback.map((id) => `\`${id}\``).join(', ')}`,
    `- **Not in Tree-sitter catalog / requires optional \`@singapore-editor/shiki\` or new grammars (${s.fregatDropped}):** ${diff.fregat.dropped.map((id) => `\`${id}\``).join(', ')}`,
    '',
    `## Outgoing Shiki Resolver Canonical IDs (${s.beforeShikiCanonicalIds} total)`,
    '',
    `- **Wave 1 native packs (${diff.shikiCanonical.wave1.length}):** ${diff.shikiCanonical.wave1.map((id) => `\`${id}\``).join(', ')}`,
    `- **Universal Zed-plus fallback (${diff.shikiCanonical.fallback.length}):** ${diff.shikiCanonical.fallback.map((id) => `\`${id}\``).join(', ')}`,
    `- **Moved to optional \`@singapore-editor/shiki\` (${diff.shikiCanonical.dropped.length}):** ${diff.shikiCanonical.dropped.map((id) => `\`${id}\``).join(', ')}`,
    '',
    `## Outgoing Shiki Resolver Identifiers — IDs + Aliases (${s.beforeShikiTotalIdentifiers} total)`,
    '',
    `- **Covered by default Tree-sitter resolver (${diff.shikiIdentifiers.covered.length}):** ${diff.shikiIdentifiers.covered.map((id) => `\`${id}\``).join(', ')}`,
    `- **Moved to optional \`@singapore-editor/shiki\` (${diff.shikiIdentifiers.dropped.length}):** ${diff.shikiIdentifiers.dropped.map((id) => `\`${id}\``).join(', ')}`,
    '',
  ]
  return lines.join('\n')
}

const { fregatPath, outPath, format } = parseArgs()
const diff = buildCoverageDiff(resolve(fregatPath))
const output = format === 'json' ? JSON.stringify(diff, null, 2) + '\n' : formatMarkdown(diff)
if (outPath) {
  writeFileSync(outPath, output, 'utf8')
} else {
  process.stdout.write(output)
}
