import { afterEach, expect, it } from 'vitest'
import type { EditorSyntaxRange, EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { createDocumentSession, type TextEdit } from '@singapore-editor/core/document'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import { disposeTreeSources } from './factories/source'

const browserTest = it.skipIf(typeof Worker === 'undefined')

const clients = new Set<TreeSitterWorkerClient>()
afterEach(async () => {
  disposeTreeDocuments()
  disposeTreeSources()
  for (const client of clients) await client.dispose()
  clients.clear()
})

function block(index: number): string {
  return [
    '/**',
    ` * Block ${index} doubles {@link value}.`,
    ' * @param {number} value the input',
    ' */',
    `export function block${index}(value: number): string {`,
    `  const pattern = /^[a-z]+${index}$/giu`,
    `  const label = \`item ${index}: \${value * 2}\``,
    '  return pattern.test(label) ? label : String(value / 2)',
    '}',
    '',
  ].join('\n')
}

// Large enough that turning the rest of the file into a string can never reparse inside the
// edit's first slice, so these edits always answer before their reparse finishes.
const SOURCE = Array.from({ length: 5000 }, (_, index) => block(index)).join('')
const VISIBLE = 20_000

function registry() {
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  return registry
}

function rangeDocument(documentId: string, text: string) {
  const backend = new TreeSitterWorkerClient()
  clients.add(backend)
  return createTreeDocument({
    documentId,
    languageId: 'typescript',
    languageResolver: registry(),
    backend,
    syntaxMode: 'range',
    text,
  })
}

type RangeDocument = ReturnType<typeof rangeDocument>

// A range past every preview waits for the complete analysis.
async function settle(document: RangeDocument, length: number): Promise<void> {
  const tail = await document.runtime.queryRange({ startIndex: length - 100, endIndex: length })
  expect(tail.projection.analysis?.kind).toBe('full')
}

async function expectFresh(
  actual: EditorSyntaxResult,
  text: string,
  range: EditorSyntaxRange,
  label: string,
): Promise<void> {
  const fresh = rangeDocument(`fresh-${label}`, text)
  await fresh.run()
  await settle(fresh, text.length)
  const expected = await fresh.runtime.queryRange(range)
  expect(expected.projection.analysis?.kind, label).toBe('full')
  expect(actual.captures, label).toEqual(expected.captures)
  expect(tokenValues(actual), label).toEqual(tokenValues(expected))
  fresh.dispose()
}

browserTest(
  'answers the visible range of an edit that flips the rest of a large file as a fresh parse would',
  async () => {
    const buffer = createDocumentSession(SOURCE)
    let text = SOURCE
    const document = rangeDocument('preview.ts', text)
    await document.run()
    await settle(document, text.length)
    const apply = async (edit: TextEdit) => {
      const change = buffer.applyEdits([edit])
      text = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
      return document.edit(change.edits)
    }
    const visible = { startIndex: 0, endIndex: VISIBLE }

    for (const [label, edit] of [
      ['backtick at the top', { from: 0, to: 0, text: '`' }],
      ['backtick removed', { from: 0, to: 1, text: '' }],
    ] as const) {
      const answered = await apply(edit)
      expect(answered.projection.analysis?.kind, label).toBe('partial')
      const preview = await document.runtime.queryRange(visible)
      expect(preview.projection.analysis?.kind, label).toBe('partial')
      await expectFresh(preview, text, visible, `${label}, preview`)
      await settle(document, text.length)
      await expectFresh(await document.runtime.queryRange(visible), text, visible, label)
    }

    // An edit on top of one still reparsing continues from it.
    await apply({ from: 0, to: 0, text: '`' })
    await apply({ from: 1, to: 1, text: 'x' })
    await expectFresh(await document.runtime.queryRange(visible), text, visible, 'chained')
    await settle(document, text.length)
    const tail = { startIndex: text.length - VISIBLE, endIndex: text.length }
    await expectFresh(await document.runtime.queryRange(tail), text, tail, 'chained, tail')
  },
)

browserTest('previews an edit in the middle of a large file from the node before it', async () => {
  const buffer = createDocumentSession(SOURCE)
  let text = SOURCE
  const document = rangeDocument('middle.ts', text)
  await document.run()
  await settle(document, text.length)
  const from = text.indexOf(block(2500))
  const change = buffer.applyEdits([{ from, to: from, text: '`' }])
  text = text.slice(0, from) + '`' + text.slice(from)
  const answered = await document.edit(change.edits)
  expect(answered.projection.analysis?.kind).toBe('partial')
  const visible = { startIndex: from - 5_000, endIndex: from + 15_000 }
  const preview = await document.runtime.queryRange(visible)
  expect(preview.projection.analysis?.kind).toBe('partial')
  await expectFresh(preview, text, visible, 'middle, preview')
  await settle(document, text.length)
  await expectFresh(await document.runtime.queryRange(visible), text, visible, 'middle')
})

function tokenValues(result: EditorSyntaxResult) {
  return 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
}
