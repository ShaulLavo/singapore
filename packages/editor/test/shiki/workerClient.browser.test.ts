import type { ShikiWorkerRequest, ShikiWorkerRequestPayload } from '../../src/shiki/workerTypes'
import { createHighlighterDocument } from './documentFixture'
import { readAll } from '../factories/snapshotText'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentTextSnapshot,
  createPieceTableSnapshot,
  type DocumentSessionChange,
} from '../../src'

import {
  createShikiWorkerOwner,
  type ShikiResolvedRegistrations,
  type ShikiWorkerOwner,
} from '../../src/shiki'

const createChange = (
  text: string,
  ...edits: readonly { from: number; to: number; text: string }[]
) =>
  ((snapshot = createPieceTableSnapshot(text)) => ({
    kind: 'edit',
    edits,
    transaction: null,
    textSnapshot: createDocumentTextSnapshot(snapshot, text),
    snapshot,
    selections: { selections: [], normalized: true },
    timings: [],
    canUndo: false,
    canRedo: false,
    isDirty: true,
    logicalRevisionCount: 1,
    logicalRevisionScope: null,
  }))() satisfies DocumentSessionChange

describe.skipIf(typeof Worker === 'undefined')('Shiki worker highlighter', () => {
  let workerOwner: ShikiWorkerOwner
  const requestsObserved = vi.fn<(payload: ShikiWorkerRequestPayload) => void>()
  const actualWorkers: Worker[] = []
  const nativePosts = new Map<Worker, (request: ShikiWorkerRequest) => void>()
  function observedOwner(options: Parameters<typeof createShikiWorkerOwner>[0] = {}) {
    return createShikiWorkerOwner({
      ...options,
      workerFactory: () => {
        const worker =
          options.workerFactory?.() ??
          new Worker(new URL('../../src/shiki/shiki.worker.ts', import.meta.url), {
            type: 'module',
          })
        actualWorkers.push(worker)
        const post = worker.postMessage.bind(worker)
        nativePosts.set(worker, post)
        vi.spyOn(worker, 'postMessage').mockImplementation((request: ShikiWorkerRequest) => {
          if (['open', 'edit', 'recolor'].includes(request.payload.type))
            requestsObserved(request.payload)
          post(request)
        })
        return worker
      },
    })
  }

  /** What a session opened directly on `text` reports, to compare a spliced answer against. */
  async function fullTokens(text: string) {
    const fresh = createHighlighterDocument(workerOwner, {
      documentId: 'fresh.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text), text)),
    })
    const result = await fresh!.run()
    fresh!.dispose()
    return result.tokens.toTokens()
  }

  beforeEach(() => {
    requestsObserved.mockClear()
    actualWorkers.length = 0
    nativePosts.clear()
    workerOwner = observedOwner()
  })

  afterEach(async () => {
    await workerOwner.dispose()
  })

  it('recolors the same worker document and keeps subsequent edits incremental', async () => {
    const dark = await resolveRegistrations()
    const lightTheme = (await import('@shikijs/themes/github-light')).default
    const light = { ...dark, themeRegistration: { ...lightTheme, name: 'github-light' } }
    let selected = { theme: 'github-dark', registrations: dark }
    const text = 'const value = `hello ${42}`;'
    const snapshot = createPieceTableSnapshot(text)
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'recolor.ts',
      lang: 'typescript',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(snapshot, text)),
      ...selected,
      resolveTheme: () => selected,
    })!
    const requests = requestsObserved
    requests.mockClear()
    const initial = (await session.run()).tokens.toTokens()
    selected = { theme: 'github-light', registrations: light }
    const recolored = (await session.run()).tokens.toTokens()
    expect(recolored).not.toEqual(initial)
    const editedText = text.replace('42', 'value')
    const edited = await session.edit(
      createChange(editedText, {
        from: text.indexOf('42'),
        to: text.indexOf('42') + 2,
        text: 'value',
      }).edits,
    )
    expect(requests.mock.calls.map(([payload]) => payload.type)).toEqual([
      'open',
      'recolor',
      'edit',
      'edit',
    ])
    const fresh = createHighlighterDocument(workerOwner, {
      documentId: 'fresh-light.ts',
      lang: 'typescript',
      languageId: 'typescript',
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(editedText), editedText)),
      ...selected,
    })!
    expect(edited.tokens.toTokens()).toEqual((await fresh.run()).tokens.toTokens())
    selected = { theme: 'github-dark', registrations: dark }
    await session.run()
    expect(requests.mock.calls.slice(-2).map(([payload]) => payload.type)).toEqual([
      'recolor',
      'edit',
    ])
    session.dispose()
    fresh.dispose()
  })

  it('tokenizes code through the real browser Worker', async () => {
    const text = 'const value = 1;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text), text)),
    })

    expect(session).not.toBeNull()

    const result = await session!.run()

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(
      result.tokens.toTokens().every((token) => token.start >= 0 && token.end <= text.length),
    ).toBe(true)
    session!.dispose()
  })

  it('loads theme colors without a highlighter session', async () => {
    const theme = await workerOwner.loadTheme({
      theme: 'github-dark',
      registrations: resolveRegistrations(),
    })

    expect(theme?.backgroundColor).toBeTruthy()
    expect(theme?.foregroundColor).toBeTruthy()
  })

  it('updates tokens after an incremental edit', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(initialText), initialText)),
    })

    expect(session).not.toBeNull()

    await session!.run()
    const result = await session!.edit(
      createChange(nextText, { from: 6, to: 7, text: 'answer' }).edits,
    )

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.toTokens().some((token) => token.end > initialText.length)).toBe(true)
    // The edit answered with its own lines only; spliced in, they equal a full tokenization.
    expect(result.tokens.toTokens()).toEqual(await fullTokens(nextText))
    session!.dispose()
  })

  it('composes skipped canonical edits before updating worker tokens', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(initialText), initialText)),
    })

    expect(session).not.toBeNull()

    await session!.run()
    session.view.applyEdits([{ from: 6, to: 7, text: 'answe' }])
    const result = await session!.edit(
      createChange(nextText, { from: 11, to: 11, text: 'r' }).edits,
    )

    expect(result.tokens.toTokens().some((token) => token.start === 6 && token.end === 12)).toBe(
      true,
    )
    session!.dispose()
  })

  it('catches up and changes history branches without reading or sending whole text', async () => {
    const original = 'const value = "😀";\nconst other = 2;'
    const initial = createPieceTableSnapshot(original)
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'catch-up.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(initial, original)),
    })!
    await session.run()
    const requests = requestsObserved
    requests.mockClear()
    session.view.applyEdits([{ from: 6, to: 11, text: 'answer' }])
    session.view.applyEdits([{ from: 12, to: 12, text: 'X' }])
    const changedText = 'const answerX = "😀";\nconst other = 2;'
    const materialize = vi.spyOn(session.buffer, 'materializeFullText')
    const caughtUp = await session.run()
    session.view.undo()
    const restored = await session.undo()
    const unchanged = await session.run()
    expect(materialize).not.toHaveBeenCalled()
    const payloads = requests.mock.calls.map(([payload]) => payload)
    expect(payloads).toMatchObject([
      { type: 'edit', edits: [{ from: 6, to: 11, text: 'answerX' }] },
      { type: 'edit', edits: [{ from: 6, to: 13, text: 'value' }] },
      { type: 'edit', edits: [] },
    ])
    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual(
        [
          'documentId',
          'edits',
          'lang',
          'runtimeSessionId',
          'theme',
          'type',
          'source',
          'previousPoint',
        ].sort(),
      )
    }
    expect(caughtUp.tokens.toTokens()).toEqual(await fullTokens(changedText))
    expect(restored.tokens.toTokens()).toEqual(await fullTokens(original))
    expect(unchanged.tokens.toTokens()).toEqual(restored.tokens.toTokens())
    session.dispose()
  })

  it('opens from the latest snapshot when a change arrives before refresh', async () => {
    const text = 'const value = 1;'
    const nextText = 'const answer = 1;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'unopened.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text), text)),
    })!
    const result = await session.edit([{ from: 6, to: 11, text: 'answer' }])
    expect(result.tokens.toTokens()).toEqual(await fullTokens(nextText))
    session.dispose()
  })

  it.each(['refresh', 'change'] as const)(
    'reopens after a worker generation changes during %s',
    async (operation) => {
      const workers: Worker[] = []
      workerOwner = observedOwner({
        workerFactory: () => {
          const worker = new Worker(new URL('../../src/shiki/shiki.worker.ts', import.meta.url), {
            type: 'module',
          })
          workers.push(worker)
          return worker
        },
      })
      const text = 'const value = 1;'
      const initial = createPieceTableSnapshot(text)
      const registrations = await resolveRegistrations()
      const session = createHighlighterDocument(workerOwner, {
        documentId: 'restart.ts',
        languageId: 'typescript',
        lang: 'typescript',
        theme: 'github-dark',
        registrations,
        text: readAll(createDocumentTextSnapshot(initial, text)),
      })!
      await session.run()
      workers[0]!.dispatchEvent(new ErrorEvent('error', { message: 'controlled worker loss' }))
      // Another consumer can restart the owner before this session next runs.
      await workerOwner.loadTheme({ theme: 'github-dark', registrations })
      const requests = requestsObserved
      requests.mockClear()
      requests.mockClear()
      const result =
        operation === 'refresh' ? await session.run() : await session.edit(createChange(text).edits)
      expect(requests.mock.calls[0]?.[0]).toMatchObject({
        type: 'open',
        source: { point: { revision: 0 } },
      })
      expect(result.tokens.toTokens()).toEqual(await fullTokens(text))
      session.dispose()
    },
  )

  it('queues catch-up behind a slow request and drops work after disposal', async () => {
    const text = 'const value = 1;'
    const initial = createPieceTableSnapshot(text)
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'queued.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(initial, text)),
    })!
    await session.run()
    const firstEdit = { from: 6, to: 11, text: 'answer' }
    const worker = actualWorkers.at(-1)!
    const post = nativePosts.get(worker)!
    let release: () => void = () => expect.unreachable('The domain request was not held')
    let holding = true
    const requests = requestsObserved
    requests.mockClear()
    vi.spyOn(worker, 'postMessage').mockImplementation((request: ShikiWorkerRequest) => {
      if (request.payload.type === 'edit' && holding) {
        holding = false
        requestsObserved(request.payload)
        release = () => post(request)
        return
      }
      post(request)
    })
    const first = session.edit([firstEdit])
    const next = session.undo()
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1))
    release()
    await first
    expect((await next).tokens.toTokens()).toEqual(await fullTokens(text))
    session.dispose()
    await expect(session.run()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('applies a multi-edit change as one batch of incremental edits', async () => {
    const initialText = 'const a = 1;\nconst b = 2;'
    const nextText = 'const answer = 1;\nconst basis = 2;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(initialText), initialText)),
    })

    expect(session).not.toBeNull()

    await session!.run()
    const result = await session!.edit(
      createChange(
        nextText,
        { from: 6, to: 7, text: 'answer' },
        { from: 19, to: 20, text: 'basis' },
      ).edits,
    )

    expect(result.tokens.toTokens().some((token) => token.start === 6 && token.end === 12)).toBe(
      true,
    )
    expect(result.tokens.toTokens().some((token) => token.start === 24 && token.end === 29)).toBe(
      true,
    )
    expect(result.tokens.toTokens()).toEqual(await fullTokens(nextText))
    session!.dispose()
  })

  it('disposes document tokenizer state', async () => {
    const text = 'const value = 1;'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text), text)),
    })

    expect(session).not.toBeNull()

    await session!.run()
    session!.dispose()

    const nextText = 'const nextValue = 1;'
    const nextSession = createHighlighterDocument(workerOwner, {
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(nextText), nextText)),
    })

    expect(nextSession).not.toBeNull()

    const next = await nextSession!.run()

    expect(next.tokens.length).toBeGreaterThan(0)
    nextSession!.dispose()
  })

  it('isolates equal logical documents by runtime session', async () => {
    const firstText = 'const first = 1;'
    const secondText = 'const second = 2;'
    const first = createHighlighterDocument(workerOwner, {
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-first',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(firstText), firstText)),
    })
    const second = createHighlighterDocument(workerOwner, {
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-second',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(firstText), secondText)),
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    await Promise.all([first!.run(), second!.run()])
    first!.dispose()
    await workerOwner.awaitRuntimeSessionIdle('runtime-shiki-first')

    const nextText = 'const secondValue = 2;'
    const result = await second!.edit(
      createChange(nextText, { from: 6, to: 12, text: 'secondValue' }).edits,
    )

    expect(result.tokens.toTokens().some((token) => token.end > secondText.length)).toBe(true)
    second!.dispose()
  })

  it('skips cyclic preloads with a missing dependency, resolves alias deps, and isolates foreground missing-dep failures', async () => {
    const baseTheme = {
      name: 'custom-base',
      type: 'dark',
      colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee' },
      tokenColors: [
        { scope: 'token.healthy', settings: { foreground: '#33aa55' } },
        { scope: 'token.base', settings: { foreground: '#5588ff' } },
      ],
    }
    const baseGrammar = {
      name: 'base-lang',
      aliases: ['base-alias'],
      scopeName: 'source.base-lang',
      patterns: [{ match: '\\bbase\\b', name: 'token.base' }],
    }
    const aliasDependentGrammar = {
      name: 'uses-base-alias',
      scopeName: 'source.uses-base-alias',
      embeddedLangs: ['base-alias'],
      patterns: [{ include: 'source.base-lang' }],
    }
    const grammarA = {
      name: 'cycle-a',
      scopeName: 'source.cycle-a',
      embeddedLangs: ['cycle-b', 'missing-lang'],
      patterns: [{ match: '\\ba\\b', name: 'token.a' }],
    }
    const grammarB = {
      name: 'cycle-b',
      scopeName: 'source.cycle-b',
      embeddedLangs: ['cycle-a'],
      patterns: [{ match: '\\bb\\b', name: 'token.b' }],
    }
    const brokenForegroundGrammar = {
      name: 'broken-fg',
      scopeName: 'source.broken-fg',
      embeddedLangs: ['definitely-missing'],
      patterns: [{ match: '\\bbroken\\b', name: 'token.broken' }],
    }
    const healthyGrammar = {
      name: 'healthy',
      scopeName: 'source.healthy',
      patterns: [{ match: '\\bword\\b', name: 'token.healthy' }],
    }

    // Start the real worker before calling preload() so the preload queue actually runs.
    const baseSession = createHighlighterDocument(workerOwner, {
      documentId: 'base.txt',
      languageId: 'base-lang',
      lang: 'base-lang',
      theme: 'custom-base',
      registrations: {
        languageRegistrations: [baseGrammar],
        themeRegistration: baseTheme,
        themeRegistrations: [baseTheme],
      },
      text: 'base',
    })!
    await baseSession.run()
    expect(actualWorkers).toHaveLength(1)

    await workerOwner.preload({
      languageRegistrations: [grammarA, grammarB, aliasDependentGrammar],
      themeRegistrations: [baseTheme],
    })
    await workerOwner.awaitIdleFence()

    // A foreground open with a missing embedded dependency must fail without poisoning the worker.
    const brokenSession = createHighlighterDocument(workerOwner, {
      documentId: 'broken.txt',
      languageId: 'broken-fg',
      lang: 'broken-fg',
      theme: 'custom-base',
      registrations: {
        languageRegistrations: [brokenForegroundGrammar],
        themeRegistration: baseTheme,
        themeRegistrations: [baseTheme],
      },
      text: 'broken',
    })!
    await expect(brokenSession.run()).rejects.toThrow(/Missing languages/i)
    brokenSession.dispose()

    const text = 'word'
    const session = createHighlighterDocument(workerOwner, {
      documentId: 'healthy.txt',
      languageId: 'healthy',
      lang: 'healthy',
      theme: 'custom-base',
      registrations: {
        languageRegistrations: [healthyGrammar],
        themeRegistration: baseTheme,
        themeRegistrations: [baseTheme],
      },
      text: readAll(createDocumentTextSnapshot(createPieceTableSnapshot(text), text)),
    })!

    const result = await session.run()
    expect(result.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#33AA55' } },
    ])
    session.dispose()
    baseSession.dispose()
  })

  it('isolates embedded grammars sharing a colliding scopeName across documents on the shared worker', async () => {
    const theme = {
      name: 'embed-theme',
      type: 'dark',
      colors: { 'editor.background': '#111111', 'editor.foreground': '#dddddd' },
      tokenColors: [
        { scope: 'token.red', settings: { foreground: '#ff0000' } },
        { scope: 'token.green', settings: { foreground: '#00ff00' } },
      ],
    }
    const hostGrammar = {
      name: 'host-lang',
      scopeName: 'source.host',
      embeddedLangs: ['shared-embed'],
      patterns: [{ include: 'source.shared' }],
    }
    const sharedRed = {
      name: 'shared-embed',
      scopeName: 'source.shared',
      patterns: [{ match: '\\bword\\b', name: 'token.red' }],
    }
    const sharedGreen = {
      name: 'shared-embed',
      scopeName: 'source.shared',
      patterns: [{ match: '\\bword\\b', name: 'token.green' }],
    }

    const docRed = createHighlighterDocument(workerOwner, {
      documentId: 'red.host',
      runtimeSessionId: 'rt-embed-red',
      languageId: 'host-lang',
      lang: 'host-lang',
      theme: 'embed-theme',
      registrations: {
        languageRegistrations: [hostGrammar, sharedRed],
        themeRegistration: theme,
        themeRegistrations: [theme],
      },
      text: 'word',
    })!
    const docGreen = createHighlighterDocument(workerOwner, {
      documentId: 'green.host',
      runtimeSessionId: 'rt-embed-green',
      languageId: 'host-lang',
      lang: 'host-lang',
      theme: 'embed-theme',
      registrations: {
        languageRegistrations: [hostGrammar, sharedGreen],
        themeRegistration: theme,
        themeRegistrations: [theme],
      },
      text: 'word',
    })!

    const resRed = await docRed.run()
    const resGreen = await docGreen.run()
    expect(resRed.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#FF0000' } },
    ])
    expect(resGreen.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#00FF00' } },
    ])

    const retention = await workerOwner.inspectRetention()
    expect(retention?.shared.highlighterCount).toBe(1)

    docRed.dispose()
    docGreen.dispose()
  })

  it('isolates custom themes and custom grammars sharing the same name across documents on the shared worker', async () => {
    const redTheme = {
      name: 'custom',
      type: 'dark',
      colors: { 'editor.background': '#111111', 'editor.foreground': '#dddddd' },
      tokenColors: [
        { scope: 'token.a', settings: { foreground: '#ff0000' } },
        { scope: 'token.b', settings: { foreground: '#00ff00' } },
      ],
    }
    const greenTheme = {
      name: 'custom',
      type: 'dark',
      colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee' },
      tokenColors: [
        { scope: 'token.a', settings: { foreground: '#ff0000' } },
        { scope: 'token.b', settings: { foreground: '#00ff00' } },
      ],
    }
    const grammarA = {
      name: 'custom-lang',
      scopeName: 'source.custom-a',
      patterns: [{ match: '\\bword\\b', name: 'token.a' }],
    }
    const grammarB = {
      name: 'custom-lang',
      scopeName: 'source.custom-b',
      patterns: [{ match: '\\bword\\b', name: 'token.b' }],
    }

    const docA = createHighlighterDocument(workerOwner, {
      documentId: 'a.custom',
      runtimeSessionId: 'rt-custom-a',
      languageId: 'custom-lang',
      lang: 'custom-lang',
      theme: 'custom',
      registrations: {
        languageRegistrations: [grammarA],
        themeRegistration: redTheme,
        themeRegistrations: [redTheme],
      },
      text: 'word',
    })!
    const docB = createHighlighterDocument(workerOwner, {
      documentId: 'b.custom',
      runtimeSessionId: 'rt-custom-b',
      languageId: 'custom-lang',
      lang: 'custom-lang',
      theme: 'custom',
      registrations: {
        languageRegistrations: [grammarB],
        themeRegistration: greenTheme,
        themeRegistrations: [greenTheme],
      },
      text: 'word',
    })!

    const resA = await docA.run()
    const resB = await docB.run()
    expect(resA.theme?.foregroundColor).toBe('#dddddd')
    expect(resB.theme?.foregroundColor).toBe('#eeeeee')
    expect(resA.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#FF0000' } },
    ])
    expect(resB.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#00FF00' } },
    ])

    // Editing docA must keep docA's red palette and grammar rather than adopting docB's theme.
    const editedA = await docA.edit([{ from: 4, to: 4, text: ' word' }])
    expect(editedA.theme?.foregroundColor).toBe('#dddddd')
    expect(editedA.tokens.toTokens()).toMatchObject([
      { start: 0, end: 4, style: { color: '#FF0000' } },
      { start: 4, end: 5, style: { color: '#DDDDDD' } },
      { start: 5, end: 9, style: { color: '#FF0000' } },
    ])

    const retention = await workerOwner.inspectRetention()
    expect(retention?.shared.highlighterCount).toBe(1)

    docA.dispose()
    docB.dispose()
  })
})

async function resolveRegistrations(): Promise<ShikiResolvedRegistrations> {
  const [language, theme] = await Promise.all([
    import('@shikijs/langs/typescript'),
    import('@shikijs/themes/github-dark'),
  ])
  return {
    languageRegistrations: language.default,
    themeRegistration: {
      ...theme.default,
      name: theme.default.name ?? 'github-dark',
    },
    themeRegistrations: [],
  }
}
