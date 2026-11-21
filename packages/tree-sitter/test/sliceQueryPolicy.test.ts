import { expect, it } from 'vitest'
import { supportsSlicePredicates } from '../src/treeSitter/sliceQueryPolicy'

it('accepts bounded highlight predicates and skips strings and comments when looking for operators', () => {
  expect(
    supportsSlicePredicates(String.raw`
      ; ((identifier) @type (#match? @type "^(a+)+$"))
      "(#unknown?" @punctuation
      ((identifier) @type (#match? @type "^[A-Z_][A-Z\\d_]+$"))
      ((identifier) @tag (#match? @tag "^[a-z][^.]*$"))
      ((identifier) @keyword (#any-of? @keyword "const" "let"))
    `),
  ).toBe(true)
})

it.each([
  '(#match? @tag "^(a+)+$")',
  '(.match? @tag "^(a+)+$")',
  String.raw`(#match? @tag "\u005e[a-z][^.]*$")`,
  '(#eq? @tag @other)',
])('rejects a predicate outside the bounded query policy %s', (predicate) => {
  expect(supportsSlicePredicates(`((identifier) @tag ${predicate})`)).toBe(false)
})
