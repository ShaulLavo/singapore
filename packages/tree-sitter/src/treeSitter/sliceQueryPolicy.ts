const COMPARISONS = new Set(['eq?', 'not-eq?', 'any-eq?', 'any-not-eq?'])
const REGULAR_EXPRESSIONS = new Set(['match?', 'not-match?', 'any-match?', 'any-not-match?'])
const METADATA = new Set(['set!', 'is?', 'is-not?'])
const MEMBERSHIP = new Set(['any-of?', 'not-any-of?'])

// Both forms evaluate in linear time for the bounded input. The sequence has at most one
// quantified atom, and the alternation contains only fixed strings anchored at both ends.
const ANCHORED_SEQUENCE = /^\^(?:[\w -]|\[\^?(?:[\w.-]|\\[dws])+\])+(?:[?*+])?\$?$/
const ANCHORED_ALTERNATIVES = /^\^\([\w-]+(?:\|[\w-]+)+\)\$$/
const REGEX_LITERAL = /^"(?:[^"\\]|\\\\)*"$/
export const OMIT_SLICE_PATTERN = 'omit!'

export function prepareSliceQuery(query: string): string | null {
  if (query.includes('\0')) return null
  const tokens = tokenize(query)
  if (!tokens) return null
  const parts: string[] = []
  let copied = 0
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text !== '(') continue
    const operation = tokens[index + 1]
    if (!operation || !/^[#.]/.test(operation.text)) continue
    if (supportsPredicate(operation.text.slice(1), tokens, index + 2)) continue
    const start = operation.start + 1
    parts.push(query.slice(copied, start), OMIT_SLICE_PATTERN)
    copied = operation.start + operation.text.length
  }
  if (!parts.length) return query
  parts.push(query.slice(copied))
  return parts.join('')
}

type QueryToken = { readonly text: string; readonly start: number }

function tokenize(query: string): QueryToken[] | null {
  const tokens: QueryToken[] = []
  // Tree-sitter's semicolon comments end at LF. Inside a quoted literal only an escaped LF is valid.
  for (const { 0: text, index } of query.matchAll(
    /;[^\n]*|"(?:[^"\\\n]|\\[\s\S])*"|[()]|[^ \t\r\n\v\f;"()]+|"/g,
  )) {
    if (text.startsWith(';')) continue
    if (text === '"' || (!text.startsWith('"') && !/^[!-~]+$/.test(text))) return null
    tokens.push({ text, start: index })
  }
  return tokens
}

function supportsPredicate(name: string, tokens: readonly QueryToken[], from: number): boolean {
  if (METADATA.has(name)) return true
  if (!tokens[from]?.text.startsWith('@')) return false
  if (MEMBERSHIP.has(name)) return stringArguments(tokens, from + 1)
  const value = tokens[from + 1]?.text
  if (!value?.startsWith('"') || tokens[from + 2]?.text !== ')') return false
  if (COMPARISONS.has(name)) return true
  return REGULAR_EXPRESSIONS.has(name) && supportsRegularExpression(value)
}

function stringArguments(tokens: readonly QueryToken[], from: number): boolean {
  for (let index = from; index < tokens.length; index++) {
    const token = tokens[index]?.text
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
