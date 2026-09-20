import { expect, it } from 'vitest'
import { styleForTreeSitterCapture, type EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { createDocumentSession, createPieceTableSnapshot } from '@singapore-editor/core/document'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterSyntaxSession } from '../src/session'
import { NATIVE_FIXTURES } from '../../tree-sitter-languages/test/fixtures/native'
import {
  TREE_SITTER_LANGUAGE_CONTRIBUTIONS,
  TREE_SITTER_LANGUAGE_METADATA,
} from '../../tree-sitter-languages/src/index'

const browserTest = it.skipIf(typeof Worker === 'undefined')

const astro =
  '---\r\nconst title: string = "שלום 🪐"\r\n---\r\n<!-- greeting -->\n<Card title={title}>{title}</Card>\n<script>const n = 1</script>\n<style>h1 { color: red }</style>\n'

function registry(loads: string[]) {
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
    registry.registerLanguage({
      ...contribution,
      async load() {
        loads.push(contribution.id)
        return contribution.load!()
      },
    })
  }
  return registry
}

browserTest(
  'loads only TypeScript on a cold open and preserves angle-bracket assertions',
  async () => {
    const backend = new TreeSitterWorkerClient()
    const loads: string[] = []
    const snapshot = createPieceTableSnapshot('const n = <number>value\n')
    const session = new TreeSitterSyntaxSession({
      documentId: 'cold.ts',
      languageId: 'typescript',
      languageResolver: registry(loads),
      backend,
      snapshot,
    })
    try {
      const result = await session.refresh(snapshot)
      expect(loads).toEqual(['typescript'])
      expect(result.errors).toEqual([])
      expect(result.captures.some((capture) => capture.captureName === 'type.builtin')).toBe(true)
    } finally {
      session.dispose()
      await backend.dispose()
    }
  },
)

browserTest.each(['full', 'range'] as const)(
  'loads an Astro fence and its nested languages in %s mode',
  async (syntaxMode) => {
    const backend = new TreeSitterWorkerClient()
    const loads: string[] = []
    const snapshot = createPieceTableSnapshot(
      '# **Heading**\n\n```astro\n' + astro + '```\n\nAfter the fence.\n',
    )
    const session = new TreeSitterSyntaxSession({
      documentId: 'mixed.md',
      languageId: 'markdown',
      languageResolver: registry(loads),
      backend,
      snapshot,
      syntaxMode,
    })
    try {
      let result = await session.refresh(snapshot)
      if (syntaxMode === 'range')
        result = await session.queryRange({ startIndex: 0, endIndex: snapshot.length })
      expect(result.degraded).toBeNull()
      expect(new Set(loads)).toEqual(
        new Set([
          'markdown',
          'markdown_inline',
          'html',
          'javascript',
          'css',
          'astro',
          'typescript',
        ]),
      )
      expect(loads.length).toBe(new Set(loads).size)
      expect(result.injections.some((injection) => injection.languageId === 'astro')).toBe(true)
      expect(
        result.injections.some(
          (injection) => injection.parentLanguageId === 'astro' && injection.languageId === 'css',
        ),
      ).toBe(true)
      expect(result.captures.some((capture) => capture.captureName === 'text.strong')).toBe(true)
      expect(
        result.captures.some(
          (capture) =>
            capture.languageId === 'typescript' && capture.captureName === 'keyword.declaration',
        ),
      ).toBe(true)
      expect(result.captures.some((capture) => capture.languageId === 'css')).toBe(true)
      const comment = result.captures.find(
        (capture) => capture.languageId === 'astro' && capture.captureName === 'comment',
      )!
      const tokens = 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
      const painted = tokens.find(
        (token) => token.start <= comment.startIndex && token.end > comment.startIndex,
      )
      expect(painted?.style).toEqual(styleForTreeSitterCapture('comment'))
    } finally {
      session.dispose()
      await backend.dispose()
    }
  },
)

browserTest(
  'matches fresh output through injection creation, Unicode replacement and delimiter removal',
  async () => {
    const backend = new TreeSitterWorkerClient()
    const languageResolver = registry([])
    let text = '```plain\n' + astro + '```\n'
    const document = createDocumentSession(text)
    let snapshot = document.getSnapshot()
    const session = new TreeSitterSyntaxSession({
      documentId: 'edits.md',
      languageId: 'markdown',
      languageResolver,
      backend,
      snapshot,
    })
    try {
      await session.refresh(snapshot)
      for (const [before, after] of [
        ['plain', 'astro'],
        ['title', 'heading'],
        ['🪐', '🌍🌏'],
        ['</style>', ''],
        ['```astro', '```python'],
        ['```python', '```astro'],
      ]) {
        const from = text.indexOf(before!)
        const edits = [{ from, to: from + before!.length, text: after! }]
        const change = document.applyEdits(edits)
        snapshot = change.snapshot
        text = text.slice(0, from) + after! + text.slice(from + before!.length)
        const incremental = await session.applyChange(change)
        const fresh = new TreeSitterSyntaxSession({
          documentId: 'fresh.md',
          languageId: 'markdown',
          languageResolver,
          backend,
          snapshot,
        })
        const expected = await fresh.refresh(snapshot)
        expect(incremental.captures).toEqual(expected.captures)
        expect(tokenValues(incremental)).toEqual(tokenValues(expected))
        expect(incremental.injections).toEqual(expected.injections)
        expect(incremental.folds).toEqual(expected.folds)
        fresh.dispose()
      }
    } finally {
      session.dispose()
      await backend.dispose()
    }
  },
)

browserTest.each(NATIVE_FIXTURES)(
  'paints $id with only its dependency assets and matches fresh edits',
  async (fixture) => {
    const backend = new TreeSitterWorkerClient()
    const loads: string[] = []
    const languageResolver = registry(loads)
    const document = createDocumentSession(fixture.text)
    const session = new TreeSitterSyntaxSession({
      documentId: fixture.id,
      languageId: fixture.id,
      languageResolver,
      backend,
      snapshot: document.getSnapshot(),
    })
    try {
      const result = await session.refresh(document.getSnapshot())
      expect(result.degraded).toBeNull()
      expect(result.tokens.length).toBeGreaterThan(0)
      expect(result.captures.map((capture) => capture.captureName)).toEqual(
        expect.arrayContaining(fixture.captures),
      )
      const from = fixture.text.indexOf('🪐')
      const change = document.applyEdits([{ from, to: from + 2, text: '🌍 unicode' }])
      const incremental = await session.applyChange(change)
      const fresh = new TreeSitterSyntaxSession({
        documentId: `fresh-${fixture.id}`,
        languageId: fixture.id,
        languageResolver,
        backend,
        snapshot: change.snapshot,
      })
      const expected = await fresh.refresh(change.snapshot)
      expect(incremental.captures).toEqual(expected.captures)
      expect(tokenValues(incremental)).toEqual(tokenValues(expected))
      expect(incremental.folds).toEqual(expected.folds)
      expect(incremental.injections).toEqual(expected.injections)
      expect(loads.length).toBe(new Set(loads).size)
      expect(new Set(loads)).toEqual(requiredLanguages(fixture.id))
      fresh.dispose()
    } finally {
      session.dispose()
      await backend.dispose()
    }
  },
)

browserTest('reports unsupported style preprocessors without treating them as CSS', async () => {
  const backend = new TreeSitterWorkerClient()
  const languageResolver = registry([])
  const descriptor = await languageResolver.resolveTreeSitterLanguage('astro')
  await backend.registerLanguages([descriptor!])
  try {
    const snapshot = createPieceTableSnapshot(
      '<style lang="scss">$color: red; h1 { color: $color }</style>',
    )
    const result = await backend.parse({
      documentId: 'style.astro',
      runtimeSessionId: 'preprocessor',
      languageId: 'astro',
      snapshotVersion: 1,
      snapshot,
    })
    expect(result?.missingLanguages).toContain('scss')
    expect(result?.injections.some((injection) => injection.languageId === 'css')).toBe(false)
  } finally {
    await backend.dispose()
  }
})

function tokenValues(result: EditorSyntaxResult) {
  return 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
}

function requiredLanguages(id: string): Set<string> {
  const required = new Set<string>()
  const pending = [id]
  for (let index = 0; index < pending.length; index += 1) {
    const entry = TREE_SITTER_LANGUAGE_METADATA.find((language) => language.id === pending[index])
    if (!entry || required.has(entry.id)) continue
    required.add(entry.id)
    pending.push(...entry.injectionDependencies)
  }
  return required
}
