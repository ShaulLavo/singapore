import type { EditorSnippetTokensFeature } from '@singapore-editor/core/extensions'
import type { EditorToken } from '@singapore-editor/core/syntax'

const MAX_CACHED_SNIPPETS = 64

/**
 * The editor's own tokens for a hover's fenced code. Settled answers are kept because a hover
 * re-renders whole as each participant reports, and a block that repainted from plain on every
 * render would flash. Tokens can carry a theme's literal colours, so a theme change clears them.
 */
export type TooltipCodeTokenizer = {
  cached(text: string, languageId: string): readonly EditorToken[] | null
  tokenize(text: string, languageId: string): Promise<readonly EditorToken[]>
  clear(): void
}

export function createTooltipCodeTokenizer(
  feature: EditorSnippetTokensFeature,
): TooltipCodeTokenizer {
  const settled = new Map<string, readonly EditorToken[]>()
  const keyFor = (text: string, languageId: string): string => `${languageId}\n${text}`

  const remember = (key: string, tokens: readonly EditorToken[]): void => {
    if (settled.size >= MAX_CACHED_SNIPPETS) settled.delete(settled.keys().next().value!)
    settled.set(key, tokens)
  }

  return {
    cached: (text, languageId) => settled.get(keyFor(text, languageId)) ?? null,
    tokenize: async (text, languageId) => {
      const key = keyFor(text, languageId)
      const known = settled.get(key)
      if (known) return known

      const tokens = await feature.tokenize(text, languageId)
      remember(key, tokens)
      return tokens
    },
    clear: () => settled.clear(),
  }
}

export function paintCodeTokens(
  document: Document,
  code: HTMLElement,
  text: string,
  tokens: readonly EditorToken[],
): void {
  if (tokens.length === 0) return

  const nodes: Node[] = []
  let cursor = 0
  for (const token of tokens) {
    const start = Math.max(token.start, cursor)
    const end = Math.min(token.end, text.length)
    if (end <= start) continue

    if (start > cursor) nodes.push(document.createTextNode(text.slice(cursor, start)))
    nodes.push(tokenElement(document, text.slice(start, end), token))
    cursor = end
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)))
  code.replaceChildren(...nodes)
}

function tokenElement(document: Document, text: string, token: EditorToken): HTMLElement {
  const element = document.createElement('span')
  element.textContent = text
  const { color, fontStyle, fontWeight, textDecoration } = token.style
  if (color) element.style.color = color
  if (fontStyle) element.style.fontStyle = fontStyle
  if (fontWeight !== undefined) element.style.fontWeight = String(fontWeight)
  if (textDecoration) element.style.textDecoration = textDecoration
  return element
}
