import * as highlighting from '@singapore-editor/highlighting'
import {
  JAVASCRIPT_TREE_SITTER_LANGUAGE,
  TYPESCRIPT_TREE_SITTER_LANGUAGE,
  TREE_SITTER_LANGUAGE_CONTRIBUTIONS,
  javaScript,
  typeScript,
} from '@singapore-editor/tree-sitter-languages'
import { TREE_SITTER_LANGUAGE_METADATA } from '@singapore-editor/tree-sitter-languages/metadata'
import { createTestPluginContext } from '@singapore-editor/core/testing'
import type { EditorSyntaxProvider } from '@singapore-editor/core/syntax'
import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type {
  TreeSitterLanguageAssets,
  TreeSitterSyntaxProvider,
} from '@singapore-editor/tree-sitter'
import { Language, Parser, Query } from 'web-tree-sitter'
import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm?url'
import { NATIVE_FIXTURES } from './native'

const samples = new Map(NATIVE_FIXTURES.map((fixture) => [fixture.id, fixture.text]))
samples.set('mdx', '# Title\n\n<Note value={1}>Hello</Note>\n')
samples.set('jsdoc', '/** @param {string} name greeting */')
samples.set('regex', '(?<name>[a-z]+)')

async function qualifyAssets(
  id: string,
  assets: TreeSitterLanguageAssets,
  source = samples.get(id),
): Promise<number> {
  if (!source) throw new Error(`Missing packed grammar sample: ${id}`)
  const language = await Language.load(assets.wasmUrl)
  const parser = new Parser().setLanguage(language)
  const tree = parser.parse(source)
  if (!tree) throw new Error(`Packed grammar did not parse: ${id}`)
  let queries = 0
  try {
    if (tree.rootNode.hasError) throw new Error(`Packed grammar parse has errors: ${id}`)
    for (const kind of [
      'highlightQuerySource',
      'foldQuerySource',
      'injectionQuerySource',
      'mergeUnitQuerySource',
    ] as const) {
      const querySource = assets[kind]
      if (!querySource) continue
      qualifyQuery(language, tree.rootNode, querySource, kind, id)
      queries += 1
    }
  } finally {
    tree.delete()
    parser.delete()
  }
  return queries
}

function qualifyQuery(
  language: Language,
  node: Parameters<Query['captures']>[0],
  source: string,
  kind: string,
  id: string,
): void {
  const query = new Query(language, source)
  try {
    const captures = query.captures(node)
    if (kind === 'highlightQuerySource' && captures.length === 0)
      throw new Error(`Packed highlight query has no captures: ${id}`)
  } finally {
    query.delete()
  }
}

function isLanguageProvider(value: EditorSyntaxProvider): value is TreeSitterSyntaxProvider {
  return (
    'resolveTreeSitterLanguage' in value &&
    typeof value.resolveTreeSitterLanguage === 'function' &&
    'registerLanguage' in value &&
    typeof value.registerLanguage === 'function'
  )
}

async function qualifyPlugin(plugin: EditorPlugin, id: string, source?: string): Promise<number> {
  let provider: TreeSitterSyntaxProvider | undefined
  const context = createTestPluginContext({
    registerSyntaxProvider(value) {
      if (isLanguageProvider(value)) provider = value
      return { dispose() {} }
    },
  })
  const handles = plugin.activate(context)
  try {
    const assets = await provider?.resolveTreeSitterLanguage(id)
    if (!assets) throw new Error(`Packed plugin did not register language: ${id}`)
    return await qualifyAssets(id, assets, source)
  } finally {
    for (const handle of Array.isArray(handles) ? handles : []) handle.dispose()
  }
}

async function qualify() {
  if (Object.keys(highlighting).length === 0) throw new Error('Empty packed highlighting entry')
  const ids = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map((item) => item.id)
  if (ids.join('\0') !== TREE_SITTER_LANGUAGE_METADATA.map((item) => item.id).join('\0'))
    throw new Error('Packed catalog and metadata differ')
  await Parser.init({ locateFile: () => runtimeWasm })
  let queries = 0
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
    const assets = contribution.load ? await contribution.load() : contribution
    queries += await qualifyAssets(contribution.id, assets)
  }
  for (const contribution of [JAVASCRIPT_TREE_SITTER_LANGUAGE, TYPESCRIPT_TREE_SITTER_LANGUAGE]) {
    const assets = contribution.load ? await contribution.load() : contribution
    queries += await qualifyAssets(contribution.id, assets)
  }
  queries += await qualifyPlugin(
    javaScript({ jsx: true }),
    'javascript',
    'const node = <div>Hello</div>;',
  )
  queries += await qualifyPlugin(typeScript({ tsx: true }), 'tsx')
  return { catalog: ids, simpleVariants: 4, queries }
}

qualify().then(
  (result) => postMessage({ passed: true, detail: JSON.stringify(result) }),
  (error: unknown) =>
    postMessage({
      passed: false,
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
)
