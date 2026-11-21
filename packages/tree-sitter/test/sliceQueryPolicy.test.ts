import { expect, it } from 'vitest'
import { prepareSliceQuery } from '../src/treeSitter/sliceQueryPolicy'

it('accepts bounded highlight predicates and skips strings and comments when looking for operators', () => {
  const query = String.raw`
      ; ((identifier) @type (#match? @type "^(a+)+$"))
      "(#unknown?" @punctuation
      ((identifier) @type (#match? @type "^[A-Z_][A-Z\\d_]+$"))
      ((identifier) @tag (#match? @tag "^[a-z][^.]*$"))
      ((identifier) @keyword (#any-of? @keyword "const" "let"))
    `
  expect(prepareSliceQuery(query)).toBe(query)
})

it.each([
  '(#match? @tag "^(a+)+$")',
  '(.match? @tag "^(a+)+$")',
  String.raw`(#match? @tag "\u005e[a-z][^.]*$")`,
  '(#eq? @tag @other)',
])('marks a predicate outside the bounded query policy %s', (predicate) => {
  const query = `((identifier) @tag ${predicate})`
  expect(prepareSliceQuery(query)).toBe(query.replace(/([#.])[a-z?-]+/, '$1omit!'))
})

it('keeps a bare CR inside a comment and checks predicates after the actual LF', () => {
  const comment = '; A comment with a quote after CR\r"\n'
  const pattern = '((identifier) @tag (#match? @tag "^a|b$"))'
  expect(prepareSliceQuery(comment + pattern)).toBe(comment + pattern.replace('#match?', '#omit!'))
})

it('refuses ambiguous query delimiters outside string literals and comments', () => {
  expect(prepareSliceQuery('(\u00a0#match? @tag "^a|b$")')).toBeNull()
  expect(prepareSliceQuery('; comment\0\n(identifier) @tag')).toBeNull()
})
