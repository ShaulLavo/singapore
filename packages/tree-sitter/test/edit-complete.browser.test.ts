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

// Large enough that a reparse of everything after an edit at the top takes far longer than one
// frame, the case where answering early from part of the text is tempting.
const TAIL = Array.from({ length: 5000 }, (_, index) => block(index)).join('')

function rangeDocument(documentId: string, text: string) {
  const backend = new TreeSitterWorkerClient()
  clients.add(backend)
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  const document = createTreeDocument({
    documentId,
    languageId: 'typescript',
    languageResolver: registry,
    backend,
    syntaxMode: 'range',
    text,
  })
  return { document, backend }
}

// A range past the bootstrap prefix waits for the complete analysis.
async function settle(document: ReturnType<typeof rangeDocument>['document'], length: number) {
  const tail = await document.runtime.queryRange({ startIndex: length - 100, endIndex: length })
  expect(tail.projection.analysis?.kind).toBe('full')
}

async function expectFresh(actual: EditorSyntaxResult, text: string, range: EditorSyntaxRange) {
  const { document: fresh } = rangeDocument('fresh.ts', text)
  await fresh.run()
  await settle(fresh, text.length)
  const expected = await fresh.runtime.queryRange(range)
  expect(actual.captures).toEqual(expected.captures)
  expect(tokenValues(actual)).toEqual(tokenValues(expected))
  fresh.dispose()
}

browserTest(
  'colors a block comment longer than any lookahead as a comment right after an edit',
  async () => {
    // The whole file is one string. Removing its backticks turns the first 25,000 units into one
    // comment and the rest back into code, which a reparse takes far longer than a frame to read.
    const comment = '/*\n' + 'let apparentlyCode = 5;\n'.repeat(1000) + '*/\n'
    const code = TAIL.replaceAll('`', "'")
    let text = '`' + comment + code + '`\n'
    const buffer = createDocumentSession(text)
    const { document } = rangeDocument('comment.ts', text)
    await document.run()
    await settle(document, text.length)
    const close = text.length - 2
    const edits: TextEdit[] = [
      { from: close, to: close + 1, text: '' },
      { from: 0, to: 1, text: '' },
    ]
    const change = buffer.applyEdits(edits)
    text = comment + code + '\n'
    await document.edit(change.edits)
    const visible = { startIndex: 0, endIndex: 1_000 }
    const answer = await document.runtime.queryRange(visible)
    await expectFresh(answer, text, visible)
  },
)

browserTest('follows every partial answer to an edit with the complete one', async () => {
  let text = TAIL
  const buffer = createDocumentSession(text)
  const { document, backend } = rangeDocument('complete.ts', text)
  await document.run()
  await settle(document, text.length)
  const published: EditorSyntaxResult[] = []
  document.runtime.subscribeResults((_read, result) => published.push(result))
  const change = buffer.applyEdits([{ from: 0, to: 0, text: '`' }])
  text = '`' + text
  const answered = await document.edit(change.edits)
  // The worker finishes before anything asks for a range.
  await backend.awaitIdleFence()
  await document.runtime.queryRange({ startIndex: 0, endIndex: 20_000 })
  await backend.awaitIdleFence()
  const last = published.at(-1) ?? answered
  expect(last.projection.analysis?.kind).not.toBe('partial')
})

function tokenValues(result: EditorSyntaxResult) {
  return 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
}
