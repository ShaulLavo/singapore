import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, createEditorDocumentAnalysis } from '@singapore-editor/core/editor'
import { createEditorBufferSession, createEditorTextBuffer } from '@singapore-editor/core/document'
import type { VscodeThemeRegistration } from '@singapore-editor/core/rendering'
import githubDark from '@shikijs/themes/github-dark'
import githubLight from '@shikijs/themes/github-light'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import {
  createTreeSitterHighlighterPlugin,
  createTreeSitterHighlighterProvider,
  createTreeSitterLanguageRegistry,
  createTreeSitterWorkerOwner,
  type TreeSitterWorkerOwner,
} from '../src/index'
import type { TreeSitterWorkerRequest } from '../src/treeSitter/types'

const owners: TreeSitterWorkerOwner[] = []
const cleanups: (() => void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
})

function makeRegistry() {
  const registry = createTreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS) {
    registry.registerLanguage(contribution, { replace: true })
  }
  return registry
}

function customTheme(
  name: string,
  keywordColor: string,
  stringColor = '#00AA00',
): VscodeThemeRegistration {
  return {
    name,
    type: 'dark',
    colors: { 'editor.background': '#101010', 'editor.foreground': '#EEEEEE' },
    tokenColors: [
      { scope: ['keyword', 'storage'], settings: { foreground: keywordColor } },
      { scope: ['string'], settings: { foreground: stringColor } },
      { scope: ['comment'], settings: { foreground: '#777777', fontStyle: 'italic' } },
    ],
  }
}

describe('Tree-sitter scope-compat VS Code highlighter', () => {
  it('highlights Wave 1 packs, handles incremental edits, and recolors on theme switch without reparsing', async () => {
    const requestTypes: string[] = []
    const owner = createTreeSitterWorkerOwner({
      workerFactory: () => {
        const worker = new Worker(
          new URL('../src/treeSitter/treeSitter.worker.ts', import.meta.url),
          {
            type: 'module',
          },
        )
        const originalPost = worker.postMessage.bind(worker)
        vi.spyOn(worker, 'postMessage').mockImplementation((message: TreeSitterWorkerRequest) => {
          requestTypes.push(message.payload.type)
          originalPost(message)
        })
        return worker
      },
    })
    owners.push(owner)

    let activeTheme = 'red'
    const listeners = new Set<() => void>()
    const themes: Record<string, VscodeThemeRegistration> = {
      red: customTheme('red', '#FF0000'),
      blue: customTheme('blue', '#0000FF'),
    }

    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: () => activeTheme,
      resolveTheme: async (name) => themes[name]!,
      onThemeChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })

    const buffer = createEditorTextBuffer('const greeting = "hello 🌍"\n// note\n')
    const view = createEditorBufferSession(buffer)
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'sample.ts' })
    cleanups.push(() => analysis.dispose())

    const session = analysis.borrowHighlighter({ provider, languageId: 'typescript' })!
    cleanups.push(() => session.dispose())

    const initial = await session.refresh(buffer.getTextSnapshot())
    const initialTokens = initial.tokens.toTokens()
    expect(initialTokens.find((t) => t.start === 0)?.style.color).toBe('#FF0000')
    expect(initialTokens.some((t) => t.style.color === '#00AA00')).toBe(true)
    expect(initialTokens.some((t) => t.style.fontStyle === 'italic')).toBe(true)
    expect(requestTypes).toContain('highlightOpen')

    // Incremental edit uses highlightEdit
    view.applyEdits([{ from: 0, to: 5, text: 'let' }])
    const edited = await session.refresh(buffer.getTextSnapshot())
    expect(edited.tokens.toTokens().find((t) => t.start === 0)?.style.color).toBe('#FF0000')
    expect(requestTypes).toContain('highlightEdit')

    // Theme switch recolors in-place with highlightRecolor and zero additional highlightOpen
    const opensBefore = requestTypes.filter((t) => t === 'highlightOpen').length
    const notified = new Promise<void>((resolve) => {
      const unsub = session.onDidChangeTheme?.(() => {
        unsub?.()
        resolve()
      })
    })
    activeTheme = 'blue'
    for (const listener of listeners) listener()
    await notified

    const recolored = await session.refresh(buffer.getTextSnapshot())
    expect(recolored.tokens.toTokens().find((t) => t.start === 0)?.style.color).toBe('#0000FF')
    expect(requestTypes).toContain('highlightRecolor')
    expect(requestTypes.filter((t) => t === 'highlightOpen').length).toBe(opensBefore)
  })

  it('highlights non-Wave-1 languages via universal Zed-plus capture fallback and Markdown with fences', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'github-dark',
      resolveTheme: async () => ({ ...githubDark, name: 'github-dark' }),
    })

    const fixtures = [
      { id: 'main.c', lang: 'c', text: 'int main(void) { return 0; }\n' },
      { id: 'query.sql', lang: 'sql', text: "SELECT id FROM users WHERE name = 'ada';\n" },
      { id: 'doc.md', lang: 'markdown', text: '# Heading\n\n```ts\nconst x = 42\n```\n' },
    ] as const

    for (const fixture of fixtures) {
      const buffer = createEditorTextBuffer(fixture.text)
      const analysis = createEditorDocumentAnalysis({ buffer, documentId: fixture.id })
      cleanups.push(() => analysis.dispose())
      const session = analysis.borrowHighlighter({ provider, languageId: fixture.lang })!
      cleanups.push(() => session.dispose())
      const result = await session.refresh(buffer.getTextSnapshot())
      const tokens = result.tokens.toTokens()
      expect(tokens.length, `${fixture.lang} should emit VS Code styled tokens`).toBeGreaterThan(0)
      const uniqueColors = new Set(tokens.map((token) => token.style.color).filter(Boolean))
      expect(
        uniqueColors.size,
        `${fixture.lang} should distinguish multiple theme colors`,
      ).toBeGreaterThan(1)
    }
  })

  it('works on the plain Editor simple path without a document session', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const host = document.createElement('div')
    host.style.cssText = 'width: 600px; height: 240px;'
    document.body.append(host)
    cleanups.push(() => host.remove())

    const editor = new Editor(host, {
      plugins: [
        createTreeSitterHighlighterPlugin({
          workerOwner: owner,
          languageResolver: makeRegistry(),
          theme: 'github-light',
          resolveTheme: async () => ({ ...githubLight, name: 'github-light' }),
        }),
      ],
    })
    cleanups.push(() => editor.dispose())

    editor.setText('export const answer = 42\n', { languageId: 'typescript' })
    await owner.awaitIdleFence()
    await vi.waitFor(() => {
      expect(editor.getState().initialHighlightStatus).toBe('painted')
    })
  })
})
