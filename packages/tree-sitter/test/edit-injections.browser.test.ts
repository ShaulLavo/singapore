import { afterEach, expect, it } from 'vitest'
import type { EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { createDocumentSession, createDocumentTextSnapshot } from '@singapore-editor/core/document'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { readAll } from '../../editor/test/factories/snapshotText'
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

// Every block carries the three TypeScript injections: JSDoc, a regex, and a template string.
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

const SOURCE = Array.from({ length: 400 }, (_, index) => block(index)).join('')

type Change = { readonly from: number; readonly to: number; readonly text: string }
type Edit = {
  readonly name: string
  readonly local: boolean
  readonly at: (text: string) => Change
}

const at = (text: string, needle: string): number => {
  const index = text.indexOf(needle)
  if (index < 0) throw new Error(`Missing ${needle}`)
  return index
}

// Local edits must rescan only their surroundings for injections; the others move injection
// boundaries across the rest of the document and only have to stay correct.
const EDITS: readonly Edit[] = [
  { name: 'line at the top', local: true, at: () => ({ from: 0, to: 0, text: 'debugger;\n' }) },
  {
    name: 'line between two blocks',
    local: true,
    at: (text) => {
      const from = at(text, block(200))
      return { from, to: from, text: 'const extra = /x+/g\n' }
    },
  },
  {
    name: 'JSDoc tag edit',
    local: true,
    at: (text) => {
      const index = at(text, ' * Block 300 doubles')
      const from = index + text.slice(index).indexOf('@param')
      return { from, to: from + 6, text: '@returns' }
    },
  },
  { name: 'backtick at the top', local: false, at: () => ({ from: 0, to: 0, text: '`' }) },
  { name: 'backtick removed', local: false, at: () => ({ from: 0, to: 1, text: '' }) },
  {
    name: 'JSDoc opener turned into a plain comment',
    local: false,
    at: (text) => {
      const from = at(text, '/**\n * Block 150 ')
      return { from, to: from + 3, text: '/*' }
    },
  },
  {
    name: 'plain comment turned back into JSDoc',
    local: false,
    at: (text) => {
      const from = at(text, '/*\n * Block 150 ')
      return { from, to: from + 2, text: '/**' }
    },
  },
  {
    name: 'unclosed JSDoc swallows code up to the next close',
    local: false,
    at: (text) => {
      const from = at(text, 'export function block100(')
      return { from, to: from, text: '/** open ' }
    },
  },
  {
    name: 'unclosed JSDoc removed',
    local: false,
    at: (text) => {
      const from = at(text, '/** open ')
      return { from, to: from + 9, text: '' }
    },
  },
]

function registry() {
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  return registry
}

browserTest.each(['full', 'range'] as const)(
  'matches a fresh parse after edits that move injection boundaries, rescanning only local edits (%s mode)',
  async (syntaxMode) => {
    const backend = new TreeSitterWorkerClient()
    clients.add(backend)
    const scans: number[] = []
    const edit = backend.edit.bind(backend)
    backend.edit = async (...args) => {
      const result = await edit(...args)
      scans.push(result?.statistics?.injectionScanUnits ?? Number.NaN)
      return result
    }
    const languageResolver = registry()
    const options = { languageId: 'typescript', languageResolver, backend, syntaxMode } as const
    const document = createDocumentSession(SOURCE)
    let text = SOURCE
    const session = createTreeDocument({ ...options, documentId: 'edits.ts', text })
    const read = async (result: EditorSyntaxResult) =>
      syntaxMode === 'full'
        ? result
        : session.runtime.queryRange({ startIndex: 0, endIndex: text.length })

    const initial = await read(await session.run())
    expect(initial.injections.map((injection) => injection.languageId)).toEqual(
      expect.arrayContaining(['jsdoc', 'regex']),
    )
    for (const step of EDITS) {
      const next = step.at(text)
      const change = document.applyEdits([next])
      text = text.slice(0, next.from) + next.text + text.slice(next.to)
      scans.length = 0
      const actual = await read(await session.edit(change.edits))
      const fresh = createTreeDocument({
        ...options,
        documentId: 'fresh.ts',
        text: readAll(createDocumentTextSnapshot(change.snapshot)),
      })
      const expected = await (async () => {
        const result = await fresh.run()
        return syntaxMode === 'full'
          ? result
          : fresh.runtime.queryRange({ startIndex: 0, endIndex: text.length })
      })()
      expect(actual.captures, step.name).toEqual(expected.captures)
      expect(tokenValues(actual), step.name).toEqual(tokenValues(expected))
      expect(actual.injections, step.name).toEqual(expected.injections)
      fresh.dispose()
      expect(scans.length, step.name).toBe(1)
      if (step.local) expect(scans[0], step.name).toBeLessThan(2_000)
    }
    session.dispose()
  },
)

function tokenValues(result: EditorSyntaxResult) {
  return 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
}
