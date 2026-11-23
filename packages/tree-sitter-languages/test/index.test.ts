import { describe, expect, it, vi } from 'vitest'

import { createEditorTextBuffer } from '@singapore-editor/core/document'
import { createEditorDocumentAnalysis } from '@singapore-editor/core/editor'
import type { EditorPluginContext } from '@singapore-editor/core/extensions'
import type {
  TreeSitterLanguageAssets,
  TreeSitterLanguageContribution,
  TreeSitterSyntaxProvider,
} from '@singapore-editor/tree-sitter'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../src/catalog.generated'
import { css } from '../src/css'
import { html } from '../src/html'
import { JAVASCRIPT_TREE_SITTER_LANGUAGE, javaScript } from '../src/javascript'
import { json } from '../src/json'
import { markdown } from '../src/markdown'
import { tsx } from '../src/tsx'
import { TYPESCRIPT_TREE_SITTER_LANGUAGE, typeScript } from '../src/typescript'
import { createTestPluginContext } from '@singapore-editor/core/testing'

describe('Tree-sitter language contributions', () => {
  it('exports the first-party language descriptors', () => {
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map((contribution) => contribution.id)).toEqual([
      'javascript',
      'typescript',
      'tsx',
      'html',
      'css',
      'json',
      'markdown',
      'astro',
      'python',
      'shellscript',
      'rust',
      'go',
      'yaml',
      'toml',
      'c',
      'cpp',
      'csharp',
      'java',
      'php',
      'lua',
      'svelte',
      'sql',
      'mdx',
      'jsdoc',
      'regex',
    ])
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.every((contribution) => 'load' in contribution)).toBe(
      true,
    )
  })

  it('exports one configurable plugin per language', () => {
    const plugins = [
      javaScript(),
      typeScript({ replace: true }),
      tsx(),
      html(),
      css(),
      json(),
      markdown(),
    ]
    const context = pluginContext()
    const registerSyntaxProvider = vi.mocked(context.registerSyntaxProvider)
    const activations: { dispose(): void }[] = []

    try {
      for (const plugin of plugins) {
        const result = plugin.activate(context)
        if (!result) continue
        if ('dispose' in result) activations.push(result)
        else activations.push(...result)
      }

      expect(plugins.map((plugin) => plugin.name)).toEqual([
        'tree-sitter-javascript',
        'tree-sitter-typescript',
        'tree-sitter-tsx',
        'tree-sitter-html',
        'tree-sitter-css',
        'tree-sitter-json',
        'tree-sitter-markdown',
      ])
      expect(registerSyntaxProvider).toHaveBeenCalledTimes(1)
      expect(registerSyntaxProvider).toHaveBeenCalledWith(
        expect.objectContaining({ operation: expect.any(Object) }),
      )
      const provider = registerSyntaxProvider.mock.calls[0]?.[0]
      if (!provider)
        throw new TypeError('The language plugins must register one typed structural provider')
      const analysis = createEditorDocumentAnalysis({
        buffer: createEditorTextBuffer('const a = 1;'),
        documentId: 'main.ts',
      })
      const lease = analysis.borrowStructural({
        provider,
        languageId: 'typescript',
        includeHighlights: true,
      })
      expect(lease).not.toBeNull()
      lease?.dispose()
      analysis.dispose()
    } finally {
      for (const handle of activations) handle.dispose()
    }
  })

  it.each([
    { id: 'javascript', plugin: () => javaScript() },
    { id: 'typescript', plugin: () => typeScript() },
    { id: 'tsx', plugin: () => tsx() },
    { id: 'html', plugin: () => html() },
    { id: 'css', plugin: () => css() },
    { id: 'json', plugin: () => json() },
  ])(
    'registers the exact manifest transitive injection closure for $id on the simple plugin path',
    async ({ id, plugin }) => {
      const context = pluginContext()
      const handles = plugin().activate(context)
      const provider = vi.mocked(context.registerSyntaxProvider).mock
        .calls[0]![0] as TreeSitterSyntaxProvider
      try {
        const expected = new Set(transitiveInjectionIds(id))
        const resolved = await provider.resolveTreeSitterLanguage(id)
        expect(resolved?.id).toBe(id)
        expect(resolved?.injectionDependencies).toEqual(
          requiredContribution(id).injectionDependencies,
        )
        for (const candidate of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
          const entry = await provider.resolveTreeSitterLanguage(candidate.id)
          if (expected.has(candidate.id)) expect(entry?.id).toBe(candidate.id)
          else expect(entry).toBeNull()
        }
      } finally {
        for (const handle of Array.isArray(handles) ? handles : []) handle.dispose()
      }
    },
  )

  it('uses the catalog contribution on the simple plugin path', () => {
    expect(JAVASCRIPT_TREE_SITTER_LANGUAGE).toBe(requiredContribution('javascript'))
    expect(TYPESCRIPT_TREE_SITTER_LANGUAGE).toBe(requiredContribution('typescript'))
  })

  it('loads JSX folds for JavaScript and TSX but not TypeScript', async () => {
    const [javascriptAssets, typescriptAssets, tsxAssets] = await Promise.all([
      loadAssets(JAVASCRIPT_TREE_SITTER_LANGUAGE),
      loadAssets(TYPESCRIPT_TREE_SITTER_LANGUAGE),
      loadAssets(requiredContribution('tsx')),
    ])

    expect(javascriptAssets.mergeUnitQuerySource).toBeTruthy()
    expect(typescriptAssets.mergeUnitQuerySource).toBeTruthy()
    expect(typescriptAssets.foldQuerySource).not.toContain('jsx_element')
    expect(javascriptAssets.foldQuerySource).toContain('jsx_element')
    expect(javascriptAssets.foldQuerySource).toContain('jsx_self_closing_element')
    expect(tsxAssets.foldQuerySource).toContain('jsx_element')
    expect(tsxAssets.foldQuerySource).toContain('jsx_self_closing_element')
  })

  it('gives Markdown the resolver and math grammars its worker support loads', async () => {
    const assets = await loadAssets(requiredContribution('markdown'))
    expect(Object.keys(assets.extraWasmUrls ?? {}).toSorted()).toEqual(['math', 'resolver'])
  })
})

function transitiveInjectionIds(rootId: string): readonly string[] {
  const seen = new Set([rootId])
  const queue = [rootId]
  for (const current of queue) {
    const contribution = requiredContribution(current)
    for (const dependencyId of contribution.injectionDependencies ?? []) {
      if (seen.has(dependencyId)) continue
      if (!TREE_SITTER_LANGUAGE_CONTRIBUTIONS.some((candidate) => candidate.id === dependencyId))
        continue
      seen.add(dependencyId)
      queue.push(dependencyId)
    }
  }
  return queue
}

function requiredContribution(id: string): TreeSitterLanguageContribution {
  const contribution = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((candidate) => candidate.id === id)
  if (!contribution) throw new Error(`Missing language contribution: ${id}`)
  return contribution
}

async function loadAssets(
  contribution: TreeSitterLanguageContribution,
): Promise<TreeSitterLanguageAssets> {
  if (!contribution.load) throw new Error(`Language contribution is not lazy: ${contribution.id}`)
  return contribution.load()
}

function pluginContext(): EditorPluginContext {
  return createTestPluginContext({
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn<EditorPluginContext['registerSyntaxProvider']>(() => ({
      dispose: vi.fn(),
    })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
  })
}
