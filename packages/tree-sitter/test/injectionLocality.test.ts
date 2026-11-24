import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { queryStaysInRootChildren } from '../src/treeSitter/injectionLocality'

const read = (path: string) =>
  readFileSync(resolve(import.meta.dirname, '../../tree-sitter-languages', path), 'utf8')

it('keeps the bundled JavaScript-family and HTML injection queries inside root children', () => {
  expect(queryStaysInRootChildren(read('src/queries/javascript-injections.scm'), 'program')).toBe(
    true,
  )
  expect(
    queryStaysInRootChildren(
      read('node_modules/tree-sitter-html/queries/injections.scm'),
      'document',
    ),
  ).toBe(true)
})

it.each([
  ['a node pattern', '((comment) @injection.content (#set! injection.language "jsdoc"))'],
  ['an alternation', '[(regex_pattern) (template_string)] @injection.content'],
  ['a field and a quantifier', '(call_expression function: (identifier) arguments: (_)* @x)'],
  ['a string inside a pattern', '(call_expression "(" @x)'],
  [
    'parentheses inside strings and comments',
    '; (a) (b)\n((comment) @x (#match? @x "^/\\\\*\\\\*("))',
  ],
])('scopes %s to one root child', (_name, query) => {
  expect(queryStaysInRootChildren(query, 'program')).toBe(true)
})

it.each([
  [
    'sibling patterns',
    '((identifier) @a (#eq? @a "inject") . (expression_statement (string (string_fragment) @injection.content)))',
  ],
  ['the root node', '(program (comment) @injection.content)'],
  ['a wildcard node', '(_ (comment) @injection.content)'],
  ['a sibling pair inside an alternation', '[((a) (b)) (c)] @x'],
  ['unbalanced lists', '((comment) @x'],
])('scans the whole document for %s', (_name, query) => {
  expect(queryStaysInRootChildren(query, 'program')).toBe(false)
})
