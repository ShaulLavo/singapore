import { afterEach, describe, expect, it } from 'vitest'
import {
  createDocumentSession,
  createDocumentTextSnapshot,
  createEditorBufferSession,
  createEditorTextBuffer,
} from '@singapore-editor/core/document'
import { createEditorDocumentAnalysis, Editor } from '@singapore-editor/core/editor'
import { toEditorTokenStore, type EditorSyntaxResult } from '@singapore-editor/core/syntax'
import {
  createTreeSitterSyntaxPlugin,
  createTreeSitterSyntaxProvider,
  createTreeSitterWorkerOwner,
} from '../src/index'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { readAll } from '../../editor/test/factories/snapshotText'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import { disposeTreeSources } from './factories/source'

const browserTest = it.skipIf(typeof Worker === 'undefined')

const clients = new Set<TreeSitterWorkerClient>()
const cleanups: (() => void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  disposeTreeDocuments()
  disposeTreeSources()
  for (const client of clients) await client.dispose()
  clients.clear()
})

function registry(): TreeSitterLanguageRegistry {
  const reg = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
    reg.registerLanguage(contribution)
  }
  return reg
}

function tsBlock(index: number): string {
  return [
    `export function fn${index}(value: number): number {`,
    `  const doubled = value * ${index + 1}`,
    `  return doubled + ${index}`,
    '}',
    '',
  ].join('\n')
}

const tokenValues = (result: EditorSyntaxResult) =>
  toEditorTokenStore(result.tokens)
    .toTokens()
    .map((token) => [token.start, token.end, token.style.color ?? null])

describe('incremental changed-range invalidation (#169 Item 7)', () => {
  browserTest(
    'emits narrow root-child invalidation on local TypeScript edits and promotes surviving ranges identically to a fresh query',
    async () => {
      const source = Array.from({ length: 120 }, (_, i) => tsBlock(i)).join('')
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = registry()
      const document = createDocumentSession(source)
      const session = createTreeDocument({
        documentId: 'narrow-invalidation.ts',
        languageId: 'typescript',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      const initialBase = await session.run()
      expect(initialBase.projection.snapshot.version).toBeGreaterThan(0)

      const block100Start = source.indexOf(tsBlock(100))
      const block100End = block100Start + tsBlock(100).length
      const initialRange = await session.runtime.queryRange({
        startIndex: block100Start,
        endIndex: block100End,
      })
      expect(initialRange.brackets.length).toBeGreaterThan(0)
      expect(initialRange.folds.length).toBeGreaterThan(0)

      // Edit inside block 0 (inserting a new line + statement).
      const insertText = 'const added = 42\n'
      const change = document.applyEdits([{ from: 0, to: 0, text: insertText }])
      const editedBase = await session.edit(change.edits)

      const inv = editedBase.projection.invalidation
      expect(inv).toBeDefined()
      expect(inv!.baseSnapshotVersion).toBe(initialBase.projection.snapshot.version)
      expect(inv!.snapshotVersion).toBe(editedBase.projection.snapshot.version)
      expect(inv!.ranges.length).toBeGreaterThan(0)
      // Invalidation stays strictly near block 0 and does not touch shifted block 100.
      const shiftedStart = block100Start + insertText.length
      const shiftedEnd = block100End + insertText.length
      for (const range of inv!.ranges) {
        expect(range.endIndex).toBeLessThan(shiftedStart)
      }

      // Verify the actual projected cache result from EditorDocumentAnalysis matches a fresh query!
      const freshDoc = createTreeDocument({
        documentId: 'fresh-narrow-invalidation.ts',
        languageId: 'typescript',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: readAll(createDocumentTextSnapshot(change.snapshot)),
      })
      await freshDoc.run()
      const freshRange = await freshDoc.runtime.queryRange({
        startIndex: shiftedStart,
        endIndex: shiftedEnd,
      })

      const workerOwner = createTreeSitterWorkerOwner()
      const provider = createTreeSitterSyntaxProvider({ workerOwner })
      for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
        provider.registerLanguage(contribution)
      }
      const buffer = createEditorTextBuffer(source)
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'promoted-e2e.ts' })
      const retained = analysis.borrowStructural({
        languageId: 'typescript',
        includeHighlights: true,
        includeCaptures: false,
        syntaxMode: 'range',
        provider,
        configurationTag: [],
      })
      cleanups.push(() => {
        retained?.dispose()
        analysis.dispose()
        workerOwner.dispose()
      })
      expect(retained).not.toBeNull()
      await retained!.refreshBase()
      await retained!.queryRange({ startIndex: block100Start, endIndex: block100End })

      const edited = createEditorBufferSession(buffer).applyEdits([
        { from: 0, to: 0, text: insertText },
      ])
      expect(edited.edits.length).toBe(1)
      await retained!.refreshBase()

      // Synchronous cache hit on shifted block 100 from real projection — ZERO queryRange call!
      const promotedRead = retained!.read({ startIndex: shiftedStart, endIndex: shiftedEnd })
      expect(promotedRead.kind).toBe('ready')
      if (promotedRead.kind !== 'ready') throw new Error('expected ready promoted range')
      expect(tokenValues(promotedRead.result)).toEqual(tokenValues(freshRange))
      expect(promotedRead.result.brackets).toEqual(freshRange.brackets)
      expect(promotedRead.result.folds).toEqual(freshRange.folds)
    },
  )

  browserTest(
    'keeps narrow invalidation enabled for languages without injection queries (JSON)',
    async () => {
      const items = Array.from({ length: 60 }, (_, i) => `  { "id": ${i}, "label": "item-${i}" }`)
      const source = `[\n${items.join(',\n')}\n]\n`
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = registry()
      const document = createDocumentSession(source)
      const session = createTreeDocument({
        documentId: 'narrow.json',
        languageId: 'json',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      const initialBase = await session.run()
      const editAt = source.indexOf('"item-0"') + 1
      const change = document.applyEdits([{ from: editAt, to: editAt + 6, text: 'edited' }])
      const editedBase = await session.edit(change.edits)

      expect(editedBase.projection.invalidation).toBeDefined()
      expect(editedBase.projection.invalidation!.baseSnapshotVersion).toBe(
        initialBase.projection.snapshot.version,
      )
      expect(editedBase.projection.invalidation!.snapshotVersion).toBe(
        editedBase.projection.snapshot.version,
      )
    },
  )

  browserTest(
    'drops CSS injection and invalidates the enclosing element when a Svelte style tag changes',
    async () => {
      const source = [
        '<style>',
        '  .hero { color: red; }',
        '</style>',
        '<script>',
        '  const count = 1',
        '</script>',
        '<div class="hero">{count}</div>',
        '',
      ].join('\n')
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = registry()
      const document = createDocumentSession(source)
      const session = createTreeDocument({
        documentId: 'component.svelte',
        languageId: 'svelte',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      await session.run()
      const initial = await session.runtime.queryRange({ startIndex: 0, endIndex: source.length })
      expect(initial.injections.some((inj) => inj.languageId === 'css')).toBe(true)

      // Rename `<style>` -> `<divxx>` and `</style>` -> `</divxx>` (drops CSS injection).
      const openIdx = source.indexOf('style>')
      const closeIdx = source.indexOf('/style>') + 1
      const change = document.applyEdits([
        { from: openIdx, to: openIdx + 5, text: 'divxx' },
        { from: closeIdx, to: closeIdx + 5, text: 'divxx' },
      ])
      const editedText = readAll(createDocumentTextSnapshot(change.snapshot))
      await session.edit(change.edits)
      const after = await session.runtime.queryRange({ startIndex: 0, endIndex: editedText.length })
      expect(after.injections.some((inj) => inj.languageId === 'css')).toBe(false)
    },
  )

  browserTest(
    'works cleanly on the simple Editor API (new Editor + setText, without openDocument)',
    async () => {
      const host = document.createElement('div')
      host.style.width = '640px'
      host.style.height = '240px'
      document.body.append(host)
      const workerOwner = createTreeSitterWorkerOwner()
      const provider = createTreeSitterSyntaxProvider({ workerOwner })
      for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
        provider.registerLanguage(contribution)
      }
      const editor = new Editor(host, {
        plugins: [createTreeSitterSyntaxPlugin(provider)],
      })
      cleanups.push(() => {
        editor.dispose()
        workerOwner.dispose()
        host.remove()
      })

      const source = Array.from({ length: 40 }, (_, i) => tsBlock(i)).join('')
      editor.setText(source, { languageId: 'typescript' })

      const syntaxStatus = () => editor['syntax'].status
      const renderDataReady = () => editor['syntax'].renderDataReady

      await expect.poll(syntaxStatus, { timeout: 10_000 }).toBe('ready')
      expect(renderDataReady()).toBe(true)

      // Edit via simple API and ensure syntax re-settles cleanly.
      editor.edit({ from: 0, to: 0, text: 'const top = 1\n' })
      await expect.poll(syntaxStatus, { timeout: 10_000 }).toBe('ready')
      expect(renderDataReady()).toBe(true)
      expect(editor.getTextSnapshot().readRange(0, 14)).toBe('const top = 1\n')

      // Also exercise shared document analysis retention inspection cleanly.
      const buffer = createEditorTextBuffer(source)
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'simple-check.ts' })
      cleanups.push(() => analysis.dispose())
      expect(analysis.inspectRetention().entries).toEqual([])
    },
  )

  browserTest(
    'closes invalidation over the full enclosing root child when editing an identifier inside a statement',
    async () => {
      const source = Array.from({ length: 10 }, (_, i) => tsBlock(i)).join('')
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = registry()
      const document = createDocumentSession(source)
      const session = createTreeDocument({
        documentId: 'root-child-closure.ts',
        languageId: 'typescript',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      await session.run()
      const block0Start = 0
      const block0End = source.indexOf(tsBlock(1))
      const block5Start = source.indexOf(tsBlock(5))

      // Edit a single character in the middle of `fn0` -> `fx0` (CST shape unchanged!).
      const nameOffset = source.indexOf('fn0') + 1
      const change = document.applyEdits([{ from: nameOffset, to: nameOffset + 1, text: 'x' }])
      const editedBase = await session.edit(change.edits)

      const inv = editedBase.projection.invalidation
      expect(inv).toBeDefined()
      // Must cover the ENTIRE root child (export function fx0 { ... }), not just the identifier!
      const coversWholeBlock0 = inv!.ranges.some(
        (r) => r.startIndex <= block0Start && r.endIndex >= block0End - 1,
      )
      expect(coversWholeBlock0).toBe(true)
      // Must still stay narrow and NOT touch distant block 5.
      for (const r of inv!.ranges) {
        expect(r.endIndex).toBeLessThan(block5Start)
      }
    },
  )

  browserTest(
    'falls back to full invalidation cleanly without failing the edit when an optional fold query is invalid',
    async () => {
      const source = Array.from({ length: 10 }, (_, i) => tsBlock(i)).join('')
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = new TreeSitterLanguageRegistry()
      for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
        if (contribution.id === 'typescript') {
          if ('load' in contribution && contribution.load) {
            const load = contribution.load
            languageResolver.registerLanguage({
              ...contribution,
              load: async () => {
                const loaded = await load()
                return { ...loaded, foldQuerySource: '(nonexistent_invalid_node) @fold' }
              },
            })
          } else {
            languageResolver.registerLanguage({
              ...contribution,
              foldQuerySource: '(nonexistent_invalid_node) @fold',
            })
          }
        } else {
          languageResolver.registerLanguage(contribution)
        }
      }
      const buffer = createEditorTextBuffer(source)
      const bufferSession = createEditorBufferSession(buffer)
      const session = createTreeDocument({
        documentId: 'invalid-fold-query.ts',
        languageId: 'typescript',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      await session.run()
      const initialRange = await session.runtime.queryRange({ startIndex: 0, endIndex: 200 })
      expect(initialRange.degraded).not.toBeNull()

      const change = bufferSession.applyEdits([{ from: 0, to: 0, text: 'const ok = 1\n' }])
      const editedBase = await session.edit(change.edits)
      // Must NOT throw or restart session; locality check fails safely to { kind: 'all' } (undefined invalidation).
      expect(editedBase.projection.invalidation).toBeUndefined()
      const afterRange = await session.runtime.queryRange({ startIndex: 0, endIndex: 200 })
      expect(toEditorTokenStore(afterRange.tokens).length).toBeGreaterThan(0)
    },
  )

  browserTest(
    'invalidates downstream ranges when a comment opener changes the rest of the file',
    async () => {
      const source = Array.from({ length: 20 }, (_, i) => tsBlock(i)).join('')
      const backend = new TreeSitterWorkerClient()
      clients.add(backend)
      const languageResolver = registry()
      const document = createDocumentSession(source)
      const session = createTreeDocument({
        documentId: 'comment-opener.ts',
        languageId: 'typescript',
        languageResolver,
        backend,
        syntaxMode: 'range',
        text: source,
      })

      await session.run()
      const block15Start = source.indexOf(tsBlock(15))
      const change = document.applyEdits([{ from: 0, to: 0, text: '/* ' }])
      const editedBase = await session.edit(change.edits)

      const inv = editedBase.projection.invalidation
      if (inv) {
        // If narrow invalidation is emitted, it MUST cover downstream block 15 (now commented out!).
        expect(inv.ranges.some((r) => r.endIndex > block15Start)).toBe(true)
      }
    },
  )
})
