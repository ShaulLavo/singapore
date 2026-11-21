const COMPARISONS = new Set(['eq?', 'not-eq?', 'any-eq?', 'any-not-eq?'])
const REGULAR_EXPRESSIONS = new Set(['match?', 'not-match?', 'any-match?', 'any-not-match?'])
const METADATA = new Set(['set!', 'is?', 'is-not?'])
const MEMBERSHIP = new Set(['any-of?', 'not-any-of?'])

// Both forms evaluate in linear time for the bounded input. The sequence has at most one
// quantified atom, and the alternation contains only fixed strings anchored at both ends.
const ANCHORED_SEQUENCE = /^\^(?:[\w -]|\[\^?(?:[\w.-]|\\[dws])+\])+(?:[?*+])?\$?$/
const ANCHORED_ALTERNATIVES = /^\^\([\w-]+(?:\|[\w-]+)+\)\$$/
const REGEX_LITERAL = /^"(?:[^"\\]|\\\\)*"$/

export function supportsSlicePredicates(query: string): boolean {
  const tokens = Array.from(
    query.matchAll(/;[^\r\n]*|"(?:[^"\\]|\\[\s\S])*"|[()]|[^\s;"()]+/g),
    ([token]) => token,
  ).filter((token) => !token.startsWith(';'))
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== '(') continue
    const prefix = tokens[index + 1]
    if (!prefix?.startsWith('#') && !prefix?.startsWith('.')) continue
    const operation = prefix.length === 1 ? index + 2 : index + 1
    const name = tokens[operation]?.slice(prefix.length === 1 ? 0 : 1) ?? ''
    if (!supportsPredicate(name, tokens, operation + 1)) return false
  }
  return true
}

function supportsPredicate(name: string, tokens: readonly string[], from: number): boolean {
  if (METADATA.has(name)) return true
  if (!tokens[from]?.startsWith('@')) return false
  if (MEMBERSHIP.has(name)) return stringArguments(tokens, from + 1)
  const value = tokens[from + 1]
  if (!value?.startsWith('"') || tokens[from + 2] !== ')') return false
  if (COMPARISONS.has(name)) return true
  return REGULAR_EXPRESSIONS.has(name) && supportsRegularExpression(value)
}

function stringArguments(tokens: readonly string[], from: number): boolean {
  for (let index = from; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === ')') return true
    if (!token?.startsWith('"')) return false
  }
  return false
}

function supportsRegularExpression(value: string): boolean {
  if (value.length > 128 || !REGEX_LITERAL.test(value)) return false
  const pattern = value.slice(1, -1).replaceAll('\\\\', '\\')
  return ANCHORED_SEQUENCE.test(pattern) || ANCHORED_ALTERNATIVES.test(pattern)
}
