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
  flushDefaultTreeSitterProvider,
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

  it('recovers exact offsets after an aborted edit that already ran in the worker', async () => {
    let onFirstEditPosted: (() => void) | null = null
    const owner = createTreeSitterWorkerOwner({
      workerFactory: () => {
        const worker = new Worker(
          new URL('../src/treeSitter/treeSitter.worker.ts', import.meta.url),
          { type: 'module' },
        )
        const originalPost = worker.postMessage.bind(worker)
        vi.spyOn(worker, 'postMessage').mockImplementation((message: TreeSitterWorkerRequest) => {
          originalPost(message)
          if (message.payload.type === 'highlightEdit' && onFirstEditPosted) {
            const fire = onFirstEditPosted
            onFirstEditPosted = null
            fire()
          }
        })
        return worker
      },
    })
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'red',
      resolveTheme: async () => customTheme('red', '#FF0000'),
    })

    const buffer = createEditorTextBuffer('const answer = 42\n')
    const view = createEditorBufferSession(buffer)
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'abort.ts' })
    cleanups.push(() => analysis.dispose())
    const session = analysis.borrowHighlighter({ provider, languageId: 'typescript' })!
    cleanups.push(() => session.dispose())

    await session.refresh(buffer.getTextSnapshot())

    // Apply `const` -> `let` (-2 chars) and supersede right after `highlightEdit` posts so the
    // worker applies edit 1 while the client drops its reply and sends cumulative edits next.
    view.applyEdits([{ from: 0, to: 5, text: 'let' }])
    const editPosted = new Promise<void>((resolve) => {
      onFirstEditPosted = resolve
    })
    const first = session.refresh(buffer.getTextSnapshot()).catch(() => undefined)
    await editPosted
    view.applyEdits([{ from: 13, to: 15, text: '99' }])
    const secondSnap = buffer.getTextSnapshot()
    const finalText = secondSnap.readRange(0, secondSnap.length)
    expect(finalText).toBe('let answer = 99\n')
    const afterAbort = await session.refresh(secondSnap)
    await first

    // Compare against a fresh parse of the exact same text.
    const freshBuffer = createEditorTextBuffer(finalText)
    const freshAnalysis = createEditorDocumentAnalysis({
      buffer: freshBuffer,
      documentId: 'fresh.ts',
    })
    cleanups.push(() => freshAnalysis.dispose())
    const freshSession = freshAnalysis.borrowHighlighter({ provider, languageId: 'typescript' })!
    cleanups.push(() => freshSession.dispose())
    const fresh = await freshSession.refresh(freshBuffer.getTextSnapshot())

    expect(afterAbort.tokens.toTokens()).toEqual(fresh.tokens.toTokens())
  })

  it('keeps open packs alive when unrelated grammars register on the same worker', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'red',
      resolveTheme: async () => customTheme('red', '#FF0000'),
    })

    const ts1Buffer = createEditorTextBuffer('const first = 1\n')
    const ts1View = createEditorBufferSession(ts1Buffer)
    const ts1Analysis = createEditorDocumentAnalysis({ buffer: ts1Buffer, documentId: 'one.ts' })
    cleanups.push(() => ts1Analysis.dispose())
    const ts1Session = ts1Analysis.borrowHighlighter({ provider, languageId: 'typescript' })!
    cleanups.push(() => ts1Session.dispose())
    await ts1Session.refresh(ts1Buffer.getTextSnapshot())

    // Highlight an unrelated grammar (C), which registers a new language on the worker.
    const cBuffer = createEditorTextBuffer('int main(void) { return 0; }\n')
    const cAnalysis = createEditorDocumentAnalysis({ buffer: cBuffer, documentId: 'main.c' })
    cleanups.push(() => cAnalysis.dispose())
    const cSession = cAnalysis.borrowHighlighter({ provider, languageId: 'c' })!
    cleanups.push(() => cSession.dispose())
    await cSession.refresh(cBuffer.getTextSnapshot())

    // Open a second TS document, then incrementally edit the first TS document.
    const ts2Buffer = createEditorTextBuffer('const second = 2\n')
    const ts2Analysis = createEditorDocumentAnalysis({ buffer: ts2Buffer, documentId: 'two.ts' })
    cleanups.push(() => ts2Analysis.dispose())
    const ts2Session = ts2Analysis.borrowHighlighter({ provider, languageId: 'typescript' })!
    cleanups.push(() => ts2Session.dispose())
    await ts2Session.refresh(ts2Buffer.getTextSnapshot())

    ts1View.applyEdits([{ from: 0, to: 5, text: 'let' }])
    const edited = await ts1Session.refresh(ts1Buffer.getTextSnapshot())
    expect(edited.tokens.toTokens().find((token) => token.start === 0)?.style.color).toBe('#FF0000')
  })

  it('handles >32 concurrent distinct themes on a cold worker without disposing in-use themes', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const registry = makeRegistry()

    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const hex = `#${((index * 17) % 256).toString(16).padStart(2, '0').toUpperCase()}88CC`
        const name = `theme-${index}`
        const provider = createTreeSitterHighlighterProvider({
          workerOwner: owner,
          languageResolver: registry,
          theme: name,
          resolveTheme: async () => customTheme(name, hex),
        })
        const buffer = createEditorTextBuffer(`const v${index} = ${index}\n`)
        const analysis = createEditorDocumentAnalysis({ buffer, documentId: `t${index}.ts` })
        cleanups.push(() => analysis.dispose())
        const session = analysis.borrowHighlighter({ provider, languageId: 'typescript' })!
        cleanups.push(() => session.dispose())
        const result = await session.refresh(buffer.getTextSnapshot())
        return {
          expected: hex,
          actual: result.tokens.toTokens().find((token) => token.start === 0)?.style.color,
        }
      }),
    )

    for (const item of results) {
      expect(item.actual).toBe(item.expected)
    }
  })

  it('isolates token colors between providers sharing a worker with the same theme name', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const registry = makeRegistry()

    const providerA = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: registry,
      theme: 'github-dark',
      resolveTheme: async () => customTheme('github-dark', '#FF1122'),
    })
    const providerB = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: registry,
      theme: 'github-dark',
      resolveTheme: async () => customTheme('github-dark', '#22CCFF'),
    })

    const bufA = createEditorTextBuffer('const a = 1\n')
    const analysisA = createEditorDocumentAnalysis({ buffer: bufA, documentId: 'a.ts' })
    cleanups.push(() => analysisA.dispose())
    const sessionA = analysisA.borrowHighlighter({ provider: providerA, languageId: 'typescript' })!
    cleanups.push(() => sessionA.dispose())
    const resA = await sessionA.refresh(bufA.getTextSnapshot())

    const bufB = createEditorTextBuffer('const b = 2\n')
    const analysisB = createEditorDocumentAnalysis({ buffer: bufB, documentId: 'b.ts' })
    cleanups.push(() => analysisB.dispose())
    const sessionB = analysisB.borrowHighlighter({ provider: providerB, languageId: 'typescript' })!
    cleanups.push(() => sessionB.dispose())
    const resB = await sessionB.refresh(bufB.getTextSnapshot())

    expect(resA.tokens.toTokens().find((token) => token.start === 0)?.style.color).toBe('#FF1122')
    expect(resB.tokens.toTokens().find((token) => token.start === 0)?.style.color).toBe('#22CCFF')
  })

  it('opens unsupported document languages as plain text instead of throwing', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'github-dark',
      resolveTheme: async () => ({ ...githubDark, name: 'github-dark' }),
    })

    const buffer = createEditorTextBuffer('puts "hello"\n')
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'lookup.rb' })
    cleanups.push(() => analysis.dispose())
    const session = analysis.borrowHighlighter({ provider, languageId: 'ruby' })!
    cleanups.push(() => session.dispose())

    const result = await session.refresh(buffer.getTextSnapshot())
    expect(result.tokens.toTokens()).toEqual([])
    expect(result.theme?.backgroundColor).toBeDefined()
  })

  it('highlights embedded JavaScript and CSS inside HTML under VS Code themes', async () => {
    const owner = createTreeSitterWorkerOwner()
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'github-dark',
      resolveTheme: async () => ({ ...githubDark, name: 'github-dark' }),
    })

    const html = '<style>body { color: red; }</style>\n<script>const x = 42;</script>\n'
    const buffer = createEditorTextBuffer(html)
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'page.html' })
    cleanups.push(() => analysis.dispose())
    const session = analysis.borrowHighlighter({ provider, languageId: 'html' })!
    cleanups.push(() => session.dispose())

    const result = await session.refresh(buffer.getTextSnapshot())
    const tokens = result.tokens.toTokens()
    const defaultFg = result.theme?.foregroundColor?.toUpperCase()
    const colorOf = (needle: string) => {
      const start = html.indexOf(needle)
      return tokens
        .find((token) => token.start <= start && token.end >= start + needle.length)
        ?.style.color?.toUpperCase()
    }

    expect(colorOf('const')).toBeDefined()
    expect(colorOf('const')).not.toBe(defaultFg)
    expect(colorOf('42')).toBeDefined()
    expect(colorOf('42')).not.toBe(defaultFg)
    expect(colorOf('color')).toBeDefined()
    expect(colorOf('color')).not.toBe(defaultFg)
  })

  it('masks oversized lines before multi-layer fallback parsing so comments do not bleed', async () => {
    const owner = createTreeSitterWorkerOwner({ maxTokenizationLineLength: () => 25 })
    owners.push(owner)
    const provider = createTreeSitterHighlighterProvider({
      workerOwner: owner,
      languageResolver: makeRegistry(),
      theme: 'custom',
      resolveTheme: async () => ({
        name: 'custom',
        type: 'dark',
        colors: { 'editor.background': '#101010', 'editor.foreground': '#EEEEEE' },
        tokenColors: [
          { scope: ['comment'], settings: { foreground: '#777777' } },
          { scope: ['entity.name.tag'], settings: { foreground: '#22CC66' } },
        ],
      }),
    })

    const svelte = `<!-- ${'x'.repeat(40)}\n<div>ok</div>\n`
    const buffer = createEditorTextBuffer(svelte)
    const analysis = createEditorDocumentAnalysis({ buffer, documentId: 'App.svelte' })
    cleanups.push(() => analysis.dispose())
    const session = analysis.borrowHighlighter({ provider, languageId: 'svelte' })!
    cleanups.push(() => session.dispose())

    const result = await session.refresh(buffer.getTextSnapshot())
    const tokens = result.tokens.toTokens()
    const divIndex = svelte.indexOf('div')
    const divToken = tokens.find((token) => token.start <= divIndex && token.end >= divIndex + 3)
    expect(divToken?.style.color).toBe('#22CC66')
  })

  it('releases the shared default worker owner when a standalone highlighter plugin disposes', async () => {
    await flushDefaultTreeSitterProvider()
    const key = Symbol.for('@singapore-editor/tree-sitter/default-provider')
    const state = globalThis as Record<PropertyKey, unknown>
    expect(state[key]).toBeUndefined()

    const host = document.createElement('div')
    host.style.cssText = 'width: 400px; height: 200px;'
    document.body.append(host)
    cleanups.push(() => host.remove())

    const editor = new Editor(host, {
      plugins: [
        createTreeSitterHighlighterPlugin({
          languageResolver: makeRegistry(),
          theme: 'github-light',
          resolveTheme: async () => ({ ...githubLight, name: 'github-light' }),
        }),
      ],
    })
    editor.setText('const ok = 1\n', { languageId: 'typescript' })
    await vi.waitFor(() => {
      expect(editor.getState().initialHighlightStatus).toBe('painted')
    })
    expect(state[key]).toBeDefined()

    editor.dispose()
    await flushDefaultTreeSitterProvider()
    expect(state[key]).toBeUndefined()
  })
})
