import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { Language, Parser, Query } from 'web-tree-sitter'
import {
  injectionsStayInRootChildren,
  queryStaysInRootChildren,
} from '../src/treeSitter/injectionLocality'

const languages = resolve(import.meta.dirname, '../../tree-sitter-languages')
const read = (path: string) => readFileSync(resolve(languages, path), 'utf8')
const grammar = (path: string) =>
  Language.load(readFileSync(resolve(languages, 'node_modules', path)))

beforeAll(() => Parser.init())

async function classify(grammarPath: string, source: string, rootType: string) {
  const query = new Query(await grammar(grammarPath), source)
  try {
    return injectionsStayInRootChildren(query, source, rootType)
  } finally {
    query.delete()
  }
}

const JS_INJECTIONS = 'src/queries/javascript-injections.scm'

it.each([
  ['TypeScript', 'tree-sitter-typescript/tree-sitter-typescript.wasm', JS_INJECTIONS, 'program'],
  ['TSX', 'tree-sitter-typescript/tree-sitter-tsx.wasm', JS_INJECTIONS, 'program'],
  ['JavaScript', 'tree-sitter-javascript/tree-sitter-javascript.wasm', JS_INJECTIONS, 'program'],
  [
    'HTML',
    'tree-sitter-html/tree-sitter-html.wasm',
    'node_modules/tree-sitter-html/queries/injections.scm',
    'document',
  ],
])('keeps the bundled %s injections inside root children', async (_name, wasm, query, root) => {
  expect(await classify(wasm, read(query), root)).toBe(true)
})

const TYPESCRIPT = 'tree-sitter-typescript/tree-sitter-typescript.wasm'

it.each([
  [
    'a quantified alternation',
    String.raw`([(comment) @trigger
  (expression_statement (string (string_fragment) @injection.content))]+
 (#any-match? @trigger "^// inject")
 (#set! injection.language "regex"))`,
  ],
  [
    'sibling patterns',
    String.raw`((expression_statement (identifier) @_name)
  (expression_statement (string (string_fragment) @injection.content))
  (#eq? @_name "inject"))`,
  ],
  ['the root node', '(program (comment) @injection.content)'],
  ['a wildcard node', '(_ (comment) @injection.content)'],
])('scans the whole document for %s', async (_name, query) => {
  expect(await classify(TYPESCRIPT, query, 'program')).toBe(false)
})

it('treats a source it cannot read as reaching across the document', () => {
  expect(queryStaysInRootChildren('((comment) @x', 'program')).toBe(false)
})

it('trusts the compiled shape over the source for quantifiers', () => {
  const unrooted = {
    patternCount: () => 1,
    isPatternRooted: () => false,
    isPatternNonLocal: () => false,
  }
  expect(injectionsStayInRootChildren(unrooted, '((comment) @x)+', 'program')).toBe(false)
})
