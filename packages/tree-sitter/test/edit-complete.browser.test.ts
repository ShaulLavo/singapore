import { afterEach, expect, it } from 'vitest'
import type { EditorSyntaxRange, EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { createDocumentSession, type TextEdit } from '@singapore-editor/core/document'
import {
  commitPreparedDocumentTransaction,
  prepareDocumentTransaction,
} from '@singapore-editor/core'
import { Editor } from '@singapore-editor/core/editor'
import { createTreeSitterLanguagePlugin } from '../src/index'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TreeSitterLanguageRegistry } from '../src/treeSitter/registry'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { createTreeDocument, disposeTreeDocuments } from './factories/document'
import { disposeTreeSources } from './factories/source'

const browserTest = it.skipIf(typeof Worker === 'undefined')

const clients = new Set<TreeSitterWorkerClient>()
afterEach(async () => {
  disposeTreeDocuments()
  disposeTreeSources()
  for (const client of clients) await client.dispose()
  clients.clear()
})

function block(index: number): string {
  return [
    '/**',
    ` * Block ${index} doubles {@link value}.`,
    ' * @param {number} value the input',
    ' */',
    `export function block${index}(value: number): string {`,
    `  const pattern = /^[a-z]+${index}$/giu`,
    `  const label = \`item ${index}: \${value * 2}\``,
    '  return pattern.test(label) ? label : String(value / 2)',
    '}',
    '',
  ].join('\n')
}

// Large enough that a reparse of everything after an edit at the top takes far longer than one
// frame, the case where answering early from part of the text is tempting.
const TAIL = Array.from({ length: 5000 }, (_, index) => block(index)).join('')

function rangeDocument(documentId: string, text: string) {
  const backend = new TreeSitterWorkerClient()
  clients.add(backend)
  const registry = new TreeSitterLanguageRegistry()
  for (const contribution of TREE_SITTER_LANGUAGE_CONTRIBUTIONS)
    registry.registerLanguage(contribution)
  const document = createTreeDocument({
    documentId,
    languageId: 'typescript',
    languageResolver: registry,
    backend,
    syntaxMode: 'range',
    text,
  })
  return { document, backend }
}

// A range past the bootstrap prefix waits for the complete analysis.
async function settle(document: ReturnType<typeof rangeDocument>['document'], length: number) {
  const tail = await document.runtime.queryRange({ startIndex: length - 100, endIndex: length })
  expect(tail.projection.analysis?.kind).toBe('full')
}

async function expectFresh(actual: EditorSyntaxResult, text: string, range: EditorSyntaxRange) {
  const { document: fresh } = rangeDocument('fresh.ts', text)
  await fresh.run()
  await settle(fresh, text.length)
  const expected = await fresh.runtime.queryRange(range)
  expect(actual.captures).toEqual(expected.captures)
  expect(tokenValues(actual)).toEqual(tokenValues(expected))
  fresh.dispose()
}

browserTest(
  'colors a block comment longer than any lookahead as a comment right after an edit',
  async () => {
    // The whole file is one string. Removing its backticks turns the first 25,000 units into one
    // comment and the rest back into code, which a reparse takes far longer than a frame to read.
    const comment = '/*\n' + 'let apparentlyCode = 5;\n'.repeat(1000) + '*/\n'
    const code = TAIL.replaceAll('`', "'")
    let text = '`' + comment + code + '`\n'
    const buffer = createDocumentSession(text)
    const { document } = rangeDocument('comment.ts', text)
    await document.run()
    await settle(document, text.length)
    const close = text.length - 2
    const edits: TextEdit[] = [
      { from: close, to: close + 1, text: '' },
      { from: 0, to: 1, text: '' },
    ]
    const change = buffer.applyEdits(edits)
    text = comment + code + '\n'
    await document.edit(change.edits)
    const visible = { startIndex: 0, endIndex: 1_000 }
    const answer = await document.runtime.queryRange(visible)
    await expectFresh(answer, text, visible)
  },
)

browserTest('follows every partial answer to an edit with the complete one', async () => {
  let text = TAIL
  const buffer = createDocumentSession(text)
  const { document, backend } = rangeDocument('complete.ts', text)
  await document.run()
  await settle(document, text.length)
  const published: EditorSyntaxResult[] = []
  document.runtime.subscribeResults((_read, result) => published.push(result))
  const change = buffer.applyEdits([{ from: 0, to: 0, text: '`' }])
  text = '`' + text
  const answered = await document.edit(change.edits)
  // The worker finishes before anything asks for a range.
  await backend.awaitIdleFence()
  await document.runtime.queryRange({ startIndex: 0, endIndex: 20_000 })
  await backend.awaitIdleFence()
  const last = published.at(-1) ?? answered
  expect(last.projection.analysis?.kind).not.toBe('partial')
})

// The grammars TAIL injects are loaded at open, so an edit that reveals their layers needs no
// second parse to load them.
const HEAD = '/** Flips {@link value}. */\nconst head = /^[a-z]+$/u\n'
const FLIPPED = HEAD + '`' + TAIL
const UNFLIPPED = HEAD + TAIL

async function openDocument(documentId: string, text: string) {
  const buffer = createDocumentSession(text)
  const { document, backend } = rangeDocument(documentId, text)
  await document.run()
  await settle(document, text.length)
  return { document, buffer, backend }
}

// Deleting the backtick in front of TAIL turns every string in the file back into code and every
// code span back into a string: the reparse reads the whole file, many parse slices long.
async function unflip(documentId: string, text = FLIPPED) {
  const { document, buffer, backend } = await openDocument(documentId, text)
  const change = buffer.applyEdits([{ from: HEAD.length, to: HEAD.length + 1, text: '' }])
  return { document, buffer, backend, answered: await document.edit(change.edits) }
}

type HeldParse = { readonly release: () => void }

/** Holds each complete analysis the client is asked for until `release`. */
function holdCompleteAnalyses(backend: TreeSitterWorkerClient): HeldParse[] {
  const held: HeldParse[] = []
  const parse = backend.parse.bind(backend) as (...args: unknown[]) => Promise<unknown>
  ;(backend as { parse: unknown }).parse = (...args: unknown[]) => {
    const payload = args[0] as { readonly resultMode?: string }
    if (payload.resultMode !== 'parseOnly') return parse(...args)
    return new Promise((resolve) => held.push({ release: () => resolve(parse(...args)) }))
  }
  return held
}

function rootCaptures(result: EditorSyntaxResult) {
  return result.captures.filter((capture) => !capture.injectionDepth)
}

browserTest('answers an edit that reparses the whole file from the text above it', async () => {
  const { document, answered } = await unflip('flip.ts')
  expect(answered.projection.analysis?.kind).toBe('partial')

  const visible = { startIndex: 0, endIndex: 2_000 }
  const preview = await document.runtime.queryRange(visible)
  expect(preview.projection.analysis?.kind).toBe('partial')
  const { document: fresh } = rangeDocument('flip-fresh.ts', UNFLIPPED)
  await fresh.run()
  await settle(fresh, UNFLIPPED.length)
  const expected = await fresh.runtime.queryRange(visible)
  expect(rootCaptures(preview)).toEqual(rootCaptures(expected))
  fresh.dispose()

  // The complete analysis replaces the preview, injected languages included.
  await settle(document, UNFLIPPED.length)
  await expectFresh(await document.runtime.queryRange(visible), UNFLIPPED, visible)
})

browserTest('answers a small edit to a large file completely', async () => {
  const { document, buffer } = await openDocument('small.ts', UNFLIPPED)
  const change = buffer.applyEdits([{ from: 0, to: 0, text: 'debugger;\n' }])
  const answered = await document.edit(change.edits)
  expect(answered.projection.analysis?.kind).toBe('full')
})

browserTest('completes an edit made while a slow edit before it is still partial', async () => {
  const { document, buffer, answered } = await unflip('typing.ts')
  expect(answered.projection.analysis?.kind).toBe('partial')
  const second = buffer.applyEdits([{ from: 0, to: 0, text: 'const typed = 1\n' }])
  await document.edit(second.edits)
  const text = 'const typed = 1\n' + UNFLIPPED
  await settle(document, text.length)
  const visible = { startIndex: 0, endIndex: 2_000 }
  await expectFresh(await document.runtime.queryRange(visible), text, visible)
})

browserTest(
  'keeps the folds on screen while an edit is answered from a prefix',
  async () => {
    const host = globalThis.document.createElement('div')
    host.style.cssText = 'width:1000px;height:600px;display:flex;flex-direction:column'
    globalThis.document.body.append(host)
    const editor = new Editor(host, {
      plugins: [createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)],
    })
    const prototype = TreeSitterWorkerClient.prototype as unknown as {
      parse: (...args: unknown[]) => Promise<unknown>
    }
    const parse = prototype.parse
    let holding = false
    const held: HeldParse[] = []
    prototype.parse = function (this: unknown, ...args: unknown[]) {
      const payload = args[0] as { readonly resultMode?: string }
      if (!holding || payload.resultMode !== 'parseOnly') return parse.apply(this, args)
      return new Promise((resolve) =>
        held.push({ release: () => resolve(parse.apply(this, args)) }),
      )
    }
    const analysis = () => editor['syntax']['syntaxSession']?.getResult().projection.analysis?.kind
    try {
      const folded = 'function folded() {\n  return 1\n}\n'
      editor.setText(folded + FLIPPED, { languageId: 'typescript' })
      await expect.poll(analysis, { timeout: 20_000 }).toBe('full')
      await expect.poll(() => editor['syntaxFoldProjection']().length).toBeGreaterThan(0)
      expect(editor.fold(0)).toBe(true)
      const folds = editor['syntaxFoldProjection']()

      holding = true
      const at = folded.length + HEAD.length
      editor.edit({ from: at, to: at + 1, text: '' })
      // The complete analysis is asked for once the partial answer is in.
      await expect.poll(() => held.length, { timeout: 20_000 }).toBeGreaterThan(0)
      await nextFrame()
      await nextFrame()
      expect(editor['syntaxFoldProjection']()).toEqual(folds)

      holding = false
      for (const parked of held) parked.release()
      await expect.poll(analysis, { timeout: 20_000 }).toBe('full')
      // The text below the function is code again, with folds of its own.
      await expect.poll(() => editor['syntaxFoldProjection']().length).toBeGreaterThan(folds.length)
      expect(editor['syntaxFoldProjection']()).toEqual(expect.arrayContaining(folds))
    } finally {
      prototype.parse = parse
      for (const parked of held) parked.release()
      editor.dispose()
      host.remove()
    }
  },
  60_000,
)

browserTest('completes a partial edit answer across a revision that keeps the text', async () => {
  const { document, backend, answered } = await unflip('same-text.ts')
  expect(answered.projection.analysis?.kind).toBe('partial')
  const published: EditorSyntaxResult[] = []
  document.runtime.subscribeResults((_read, result) => published.push(result))
  const held = holdCompleteAnalyses(backend)
  const preview = await document.runtime.queryRange({ startIndex: 0, endIndex: 2_000 })
  expect(preview.projection.analysis?.kind).toBe('partial')
  await expect.poll(() => held.length).toBeGreaterThan(0)

  // A revision that keeps the text, while the complete analysis is under way.
  const same = [{ from: 0, to: 1, text: UNFLIPPED.slice(0, 1) }]
  const committed = commitPreparedDocumentTransaction(
    { buffer: document.buffer, sourceView: null },
    prepareDocumentTransaction(document.buffer, same, 1, null),
    { history: { kind: 'external-barrier', groupId: 'same-text' } },
  )
  expect(committed.status).toBe('logical-only')
  await document.run()
  for (const parked of held) parked.release()
  await backend.awaitIdleFence()
  await expect
    .poll(() => published.some((result) => result.projection.analysis?.kind === 'full'))
    .toBe(true)
  expect(document.runtime.getResult().projection.analysis?.kind).not.toBe('partial')
})

browserTest(
  'waits for the complete tree below a block comment that runs past the prefix',
  async () => {
    // The comment opens above the requested range and closes past the prefix, so every prefix cut
    // reads its body as code, with the recovery error at its opener, above the range.
    const comment = '/*\n' + 'let apparentlyCode = 5;\n'.repeat(4_000) + '*/\n'
    const { document, answered } = await unflip('comment-below.ts', HEAD + '`' + comment + TAIL)
    expect(answered.projection.analysis?.kind).toBe('partial')
    const range = { startIndex: 4_000, endIndex: 45_000 }
    const answer = await document.runtime.queryRange(range)
    await expectFresh(answer, HEAD + comment + TAIL, range)
  },
)

browserTest(
  'highlights typed keywords without typing-debounce delay and settles rapid bursts on the simple Editor API',
  async () => {
    const host = document.createElement('div')
    host.style.width = '720px'
    host.style.height = '400px'
    document.body.appendChild(host)
    const editor = new Editor(host, {
      plugins: [createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)],
    })
    const type = (data: string) =>
      editor.getInputElement().dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data,
          inputType: 'insertText',
        }),
      )
    try {
      editor.setText('debugge\nconst x = 1;\n', { languageId: 'typescript' })
      await expect.poll(() => editor.getState().syntaxStatus, { timeout: 20_000 }).toBe('ready')
      editor.setSelection(7, 7)

      // Completing `debugger` via a real beforeinput event must re-highlight promptly without
      // waiting behind the old 150 ms rapid-input debounce.
      const startedAt = performance.now()
      type('r')
      await expect
        .poll(
          () => {
            const tokens = editor['tokens'].toTokens() as readonly {
              readonly start: number
              readonly end: number
              readonly style: { readonly color?: string }
            }[]
            const kw = tokens.find((token) => token.start === 0 && token.end === 8)
            return kw?.style.color ?? null
          },
          { interval: 5, timeout: 10_000 },
        )
        .toContain('keyword')
      const elapsedMs = performance.now() - startedAt
      expect(elapsedMs).toBeLessThan(2000)
      await expect.poll(() => editor.getState().syntaxStatus, { timeout: 10_000 }).toBe('ready')

      // Rapid burst via beforeinput settles cleanly with accurate final tokens.
      editor.setSelection(8, 8)
      for (const ch of ';\nreturn 42;') type(ch)
      await expect.poll(() => editor.getState().syntaxStatus, { timeout: 10_000 }).toBe('ready')
      await expect
        .poll(
          () => {
            const snapshot = editor.getTextSnapshot()
            const text = snapshot.readRange(0, snapshot.length)
            const retIndex = text.indexOf('return')
            const tokens = editor['tokens'].toTokens() as readonly {
              readonly start: number
              readonly end: number
              readonly style: { readonly color?: string }
            }[]
            const ret = tokens.find(
              (token) => token.start === retIndex && token.end === retIndex + 6,
            )
            return ret?.style.color ?? null
          },
          { interval: 10, timeout: 10_000 },
        )
        .toContain('keyword')
    } finally {
      editor.dispose()
      host.remove()
    }
  },
  30_000,
)

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function tokenValues(result: EditorSyntaxResult) {
  return 'toTokens' in result.tokens ? result.tokens.toTokens() : result.tokens
}
