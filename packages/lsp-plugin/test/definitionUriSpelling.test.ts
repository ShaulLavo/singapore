import { arrayLspLineStarts, type LspTextDocumentSnapshot } from '@singapore-editor/lsp'
import { describe, expect, it } from 'vitest'

import {
  preferredDefinitionTarget,
  preferredJumpableDefinitionTarget,
} from '../src/definitionNavigation'
import type { LanguageServerDefinitionTarget } from '../src/types'

const OPENED_AS = 'file:///app/(shop)/page.tsx'
const SERVER_SPELLING = 'file:///app/%28shop%29/page.tsx'
const TEXT = 'const price = 1\nprice\n'

const document: LspTextDocumentSnapshot = {
  lineStarts: arrayLspLineStarts([0, 16, 22]),
  textSnapshot: {
    length: TEXT.length,
    readRange: (start, end) => TEXT.slice(start, end),
    forEachTextChunk: (visit) => visit(TEXT, 0, TEXT.length),
  },
}

function target(uri: string, line: number): LanguageServerDefinitionTarget {
  return {
    uri,
    path: 'app/(shop)/page.tsx',
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
  }
}

describe('a definition target the server escaped differently from the open document', () => {
  it('is still preferred as the same document over another file', () => {
    const inNodeModules = target('file:///node_modules/shop/index.d.ts', 0)
    const sameDocument = target(SERVER_SPELLING, 0)

    expect(preferredDefinitionTarget(OPENED_AS, { targets: [inNodeModules, sameDocument] })).toBe(
      sameDocument,
    )
  })

  it('is not offered as a jump when it is the identifier under the pointer', () => {
    const declaration = target(SERVER_SPELLING, 0)
    const usage = target(SERVER_SPELLING, 1)

    expect(
      preferredJumpableDefinitionTarget(
        OPENED_AS,
        document,
        { start: 16, end: 21 },
        {
          targets: [usage, declaration],
        },
      ),
    ).toBe(declaration)
  })
})
