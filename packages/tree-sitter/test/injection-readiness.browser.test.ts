import { afterEach, expect, it, vi } from 'vitest'
import { createEditorBufferSession, createEditorTextBuffer } from '@singapore-editor/core/document'
import { createEditorDocumentAnalysis } from '@singapore-editor/core/editor'
import { defineStructuralOperation } from '@singapore-editor/core/internal/document-worker'
import { toEditorTokenStore, type EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { createTreeSitterEditPayload, TreeSitterSyntaxSession } from '../src/session'
import { createTreeSource, disposeTreeSources } from './factories/source'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_BOOTSTRAP_UNITS } from '../src/treeSitter/source'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose()
})

const analysisOf = (result: EditorSyntaxResult) => result.projection.analysis?.kind

/** Every style painted over the character at `index`, whichever grammar it came from. */
const stylesAt = (result: EditorSyntaxResult, index: number): readonly string[] =>
  toEditorTokenStore(result.tokens)
    .toTokens()
    .filter((token) => token.start <= index && index < token.end)
    .map((token) => JSON.stringify(token.style))
    .toSorted()

/** A registry whose documentation-comment grammar does not resolve until `release` is called. */
function heldDocumentationGrammar() {
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    resolver: {
      resolveTreeSitterLanguage: async (id: string) => {
        if (id === 'jsdoc') await held
        return registry.resolveTreeSitterLanguage(id)
      },
    },
  }
}

it('gives a large file its documentation colors when their grammar arrives after an edit', async () => {
  const backend = new TreeSitterWorkerClient()
  cleanup.push(() => backend.dispose())
  const grammar = heldDocumentationGrammar()
  const lines: string[] = []
  for (let index = 0; index < 2_500; index += 1) {
    lines.push(
      '/**',
      ` * Value ${index}.`,
      ` * @param {number} input the number ${index}`,
      ' */',
      `export const value_${index} = ${index}`,
    )
  }
  const text = lines.join('\n')
  expect(text.length).toBeGreaterThan(TREE_SITTER_BOOTSTRAP_UNITS)
  const buffer = createEditorTextBuffer(text)
  const view = createEditorBufferSession(buffer)
  const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'held-jsdoc.ts' })
  const lease = analysis.borrowStructural({
    languageId: 'typescript',
    syntaxMode: 'range',
    provider: {
      operation: defineStructuralOperation(
        (context) =>
          new TreeSitterSyntaxSession({
            ...context,
            languageId: 'typescript',
            languageResolver: grammar.resolver,
            backend,
          }),
      ),
    },
  })!
  cleanup.push(() => {
    lease.dispose()
    analysis.dispose()
  })
  const tag = text.lastIndexOf('@param')
  // Past the part a large file is first answered from, so it is answered from the whole tree.
  const far = { startIndex: text.length - 2_000, endIndex: text.length }

  await lease.refresh(buffer.getTextSnapshot())
  const early = await lease.queryRange(far)

  // The whole tree is there and the grammar is not: colored by TypeScript, and not final.
  expect(analysisOf(early)).toBe('partial')
  expect(stylesAt(early, tag).length).toBeGreaterThan(0)

  // Typing in the number on the last line, which is no comment's neighbour: the edit looks for
  // injections inside that number only, and the document is still waiting for the grammar.
  view.applyEdits([{ from: text.length - 1, to: text.length - 1, text: '7' }])
  expect(analysisOf(await lease.refresh(buffer.getTextSnapshot()))).toBe('partial')
  expect(analysisOf(await lease.queryRange(far))).toBe('partial')

  grammar.release()
  await vi.waitFor(async () => expect(analysisOf(await lease.queryRange(far))).toBe('full'), {
    timeout: 60_000,
    interval: 50,
  })

  // The edited version has the documentation layers, and the tag is colored by them.
  const late = await lease.queryRange(far)
  expect(late.injections.some((injection) => injection.languageId === 'jsdoc')).toBe(true)
  expect(stylesAt(late, tag)).not.toEqual(stylesAt(early, tag))
}, 120_000)

it('keeps reporting the grammars an edited document still lacks', async () => {
  const backend = new TreeSitterWorkerClient()
  cleanup.push(() => backend.dispose())
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  const typescript = await registry.resolveTreeSitterLanguage('typescript')
  const jsdoc = await registry.resolveTreeSitterLanguage('jsdoc')
  if (!typescript || !jsdoc) throw new TypeError('The catalog must provide both grammars')
  await backend.registerLanguages([typescript])
  const text = [
    '/** Doc. @param input a number */',
    'export const value = 1',
    'export function later(): string {',
    '  return "text"',
    '}',
    '',
  ].join('\n')
  const source = createTreeSource(backend.sourceEndpoint, text, 'carried.ts')
  cleanup.push(() => disposeTreeSources())
  const identity = {
    documentId: 'carried.ts',
    runtimeSessionId: 'carried',
    languageId: 'typescript',
  }

  const initial = await source.prepare()
  const parsed = await backend.parse({
    ...identity,
    snapshotVersion: 1,
    source: initial.reference,
    resultMode: 'parseOnly',
  })
  await initial.dispose()
  expect(parsed?.missingLanguages).toEqual(['jsdoc'])

  // An edit inside the string looks for injections around the string only. The comment's
  // layer is still lacking afterwards, and the answer must still say which grammar it needs.
  const previousRead = source.buffer.getTextSnapshot()
  const inString = text.indexOf('text"')
  const edit = { from: inString, to: inString, text: 'more ' }
  source.edit([edit])
  const next = await source.prepare()
  const payload = createTreeSitterEditPayload({
    ...identity,
    previousSnapshotVersion: 1,
    snapshotVersion: 2,
    previousRead,
    source: next.reference,
    edits: [edit],
    resultMode: 'parseOnly',
  })
  if (!payload) throw new TypeError('Expected an edit payload')
  expect((await backend.edit(payload))?.missingLanguages).toEqual(['jsdoc'])

  // A caller that loads the grammar and asks for the same version again gets the layer.
  await backend.registerLanguages([jsdoc])
  const completed = await backend.parse({ ...identity, snapshotVersion: 2, source: next.reference })
  await next.dispose()

  const layers = completed && 'injections' in completed ? completed.injections : []
  expect(layers.some((injection) => injection.languageId === 'jsdoc')).toBe(true)
}, 120_000)
