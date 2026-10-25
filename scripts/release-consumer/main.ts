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
import type { EditorPlugin } from '@singapore-editor/core/extensions'
import type { TreeSitterLanguageAssets, TreeSitterSyntaxProvider } from '@singapore-editor/tree-sitter'
import { Language, Parser, Query } from 'web-tree-sitter'
import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm?url'
import { NATIVE_FIXTURES } from './native'

const samples = new Map(NATIVE_FIXTURES.map((fixture) => [fixture.id, fixture.text]))
samples.set('mdx', '# Title\n\n<Note value={1}>Hello</Note>\n')
samples.set('jsdoc', '/** @param {string} name greeting */')
samples.set('regex', '(?<name>[a-z]+)')

async function qualifyAssets(id: string, assets: TreeSitterLanguageAssets): Promise<number> {
  const source = samples.get(id)
  if (!source) throw new Error(`Missing packed grammar sample: ${id}`)
  const language = await Language.load(assets.wasmUrl)
  const parser = new Parser().setLanguage(language)
  const tree = parser.parse(source)
  if (!tree) throw new Error(`Packed grammar did not parse: ${id}`)
  let queries = 0
  try {
    if (tree.rootNode.hasError) throw new Error(`Packed grammar parse has errors: ${id}`)
    for (const [kind, querySource] of Object.entries(assets)) {
      if (kind === 'wasmUrl' || !querySource) continue
      const query = new Query(language, querySource)
      try {
        const captures = query.captures(tree.rootNode)
        if (kind === 'highlightQuerySource' && captures.length === 0)
          throw new Error(`Packed highlight query has no captures: ${id}`)
        queries += 1
      } finally {
        query.delete()
      }
    }
  } finally {
    tree.delete()
    parser.delete()
  }
  return queries
}

async function qualifyPlugin(plugin: EditorPlugin, id: string): Promise<number> {
  let provider: TreeSitterSyntaxProvider | undefined
  const context = createTestPluginContext({
    registerSyntaxProvider(value) {
      if ('resolveTreeSitterLanguage' in value) provider = value
      return { dispose() {} }
    },
  })
  const handles = plugin.activate(context)
  try {
    const assets = await provider?.resolveTreeSitterLanguage(id)
    if (!assets) throw new Error(`Packed plugin did not register language: ${id}`)
    return await qualifyAssets(id, assets)
  } finally {
    for (const handle of Array.isArray(handles) ? handles : []) handle.dispose()
  }
}

async function qualify(): Promise<void> {
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
  for (const contribution of [JAVASCRIPT_TREE_SITTER_LANGUAGE, TYPESCRIPT_TREE_SITTER_LANGUAGE])
    queries += await qualifyAssets(contribution.id, await contribution.load!())
  queries += await qualifyPlugin(javaScript({ jsx: true }), 'javascript')
  queries += await qualifyPlugin(typeScript({ tsx: true }), 'tsx')
  document.body.textContent = JSON.stringify({ catalog: ids, simpleVariants: 4, queries })
  document.body.dataset.status = 'passed'
}

qualify().catch((error: unknown) => {
  document.body.textContent = error instanceof Error ? error.stack ?? error.message : String(error)
  document.body.dataset.status = 'failed'
})
