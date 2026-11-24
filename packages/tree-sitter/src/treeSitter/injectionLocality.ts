/** The compiled query's own account of how each pattern is shaped. */
export type CompiledPatternShapes = {
  patternCount(): number
  isPatternRooted(patternIndex: number): boolean
  isPatternNonLocal(patternIndex: number): boolean
}

/**
 * Whether every match of a query lies inside one child of the root. An edit can then look for
 * injections in the root children it touches; any other query may pair a node the edit changed
 * with one far away, and is scanned over the whole document.
 *
 * The compiled query decides the shape: every pattern must have a single root node, which rules
 * out sibling groups and quantified alternations however they are written. The source decides
 * what that root node may be: neither the document's root type nor a wildcard. Anything the
 * source check cannot read counts as reaching across the document.
 */
export function injectionsStayInRootChildren(
  query: CompiledPatternShapes,
  source: string,
  rootType: string,
): boolean {
  for (let index = 0; index < query.patternCount(); index++) {
    if (!query.isPatternRooted(index) || query.isPatternNonLocal(index)) return false
  }
  return queryStaysInRootChildren(source, rootType)
}

/**
 * The source half of `injectionsStayInRootChildren`: no pattern names the root's node type or a
 * wildcard as its outermost node, and none is a group of sibling patterns. Quantifiers are not
 * read here; the compiled query's rootedness covers them.
 */
export function queryStaysInRootChildren(source: string, rootType: string): boolean {
  const items = parseQuery(source)
  if (!items) return false
  return items.every((item) => patternStaysInRootChildren(item, rootType))
}

type QueryItem = string | { readonly open: '(' | '['; readonly items: readonly QueryItem[] }

function patternStaysInRootChildren(item: QueryItem, rootType: string): boolean {
  if (typeof item === 'string') return !isWildcard(item)
  if (item.open === '[')
    return item.items.every((child) => patternStaysInRootChildren(child, rootType))
  const head = item.items[0]
  if (head === undefined) return true
  if (typeof head === 'string' && head.startsWith('#')) return true
  if (typeof head === 'string' && !head.startsWith('"'))
    return head !== rootType && !isWildcard(head)
  // A group: one pattern with its predicates, or several sibling patterns.
  const patterns = item.items.filter(isPattern)
  if (patterns.length !== 1) return false
  return patternStaysInRootChildren(patterns[0]!, rootType)
}

function isPattern(item: QueryItem): boolean {
  if (typeof item !== 'string') {
    const head = item.items[0]
    return !(typeof head === 'string' && head.startsWith('#'))
  }
  return item.startsWith('"') || isWildcard(item)
}

function isWildcard(atom: string): boolean {
  return atom === '_'
}

/** Nested lists of atoms, or null when the source does not tokenize into balanced lists. */
function parseQuery(source: string): QueryItem[] | null {
  const root: QueryItem[] = []
  const stack: { open: '(' | '['; items: QueryItem[] }[] = []
  let items = root
  for (const { 0: token } of source.matchAll(
    /;[^\n]*|"(?:[^"\\]|\\[\s\S])*"|[()[\]]|[^\s()[\];"]+/g,
  )) {
    if (token.startsWith(';')) continue
    if (token === '(' || token === '[') {
      const list: { open: '(' | '['; items: QueryItem[] } = { open: token, items: [] }
      items.push(list)
      stack.push(list)
      items = list.items
      continue
    }
    if (token === ')' || token === ']') {
      const closed = stack.pop()
      if (!closed || (closed.open === '(') !== (token === ')')) return null
      items = stack.at(-1)?.items ?? root
      continue
    }
    if (isStructural(token)) continue
    items.push(token)
  }
  return stack.length === 0 ? root : null
}

// Captures, quantifiers, anchors, negated fields and field names carry no node of their own.
function isStructural(token: string): boolean {
  return /^(?:@|[*+?.!]$|!|[\w-]+:$)/.test(token)
}
