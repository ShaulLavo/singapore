import { INITIAL } from 'shiki/textmate'
import type { ThemeRegistration } from 'shiki'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerRequestPayload,
} from '../../src/shiki/workerTypes'
import type {
  DocumentWorkerSourceCommand,
  DocumentWorkerPoint,
  DocumentWorkerReadReference,
} from '../../src/document/workerReader'
import type { TextEdit } from '../../src/tokens'
import { unpackEditorTokens } from '../../src/syntax/packedTokens'

const createShikiPrimitiveAsync = vi.hoisted(() => vi.fn())
const createOnigurumaEngine = vi.hoisted(() => vi.fn(() => Promise.resolve('oniguruma')))
const loadOnigWasm = vi.hoisted(() => vi.fn())

/** What a real shiki highlighter exposes for loading grammars and themes after construction. */
function languageApi() {
  const loaded: string[] = []
  const loadedThemes: string[] = []
  return {
    getLoadedLanguages: () => [...loaded],
    getLoadedThemes: () => [...loadedThemes],
    loadLanguage: vi.fn(async (...registrations: { readonly name: string }[]) => {
      loaded.push(...registrations.map((registration) => registration.name))
    }),
    loadTheme: vi.fn(async (...registrations: { readonly name: string }[]) => {
      loadedThemes.push(...registrations.map((registration) => registration.name))
    }),
  }
}

vi.mock('shiki/core', () => ({ createShikiPrimitiveAsync }))
vi.mock('@shikijs/engine-oniguruma', () => ({ createOnigurumaEngine }))
vi.mock('../../src/shiki/onigWasm', () => ({ loadOnigWasm }))

describe('shiki worker', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    createShikiPrimitiveAsync.mockReset()

    vi.unstubAllGlobals()
    scope = null
    point = null
  })

  it('serializes thrown errors into failed worker responses', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockRejectedValue(new Error('load failed'))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: openRequest({
          documentId: 'doc',
          text: 'const value = 1;',
          lang: 'typescript',
          theme: 'github-dark',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: false,
      error: 'load failed',
    } satisfies ShikiWorkerResponse)
  })

  it('disposes cached highlighters on disposeAll', async () => {
    const dispose = vi.fn()
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter({ dispose, ...languageApi() }))

    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: openRequest({
          documentId: 'doc',
          text: '',
          lang: 'typescript',
          theme: 'github-dark',
        }),
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    onmessage(new MessageEvent('message', { data: message({ type: 'dispose' }) }))
    await waitFor(() => dispose.mock.calls.length === 1)

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps an idle fence behind cooperative background language loading without a 1s timer', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const languageLoad = deferred<void>()
    const loadLanguage = vi.fn(() => languageLoad.promise)
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(
      externalHighlighter({
        getLoadedLanguages: () => [],
        loadLanguage,
      }),
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: message({
          type: 'preload',
          languageRegistrations: [languageRegistration('typescript')],
          themeRegistrations: [themeRegistration('github-dark')],
        }),
      }),
    )
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)
    onmessage(
      new MessageEvent('message', {
        data: { ...message({ type: 'idleFence' }), id: 2 },
      }),
    )

    await waitFor(() => loadLanguage.mock.calls.length === 1)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(responseWithId(postMessage, 2)).toBeUndefined()

    languageLoad.resolve(undefined)
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)
    expect(responseWithId(postMessage, 2)).toMatchObject({ id: 2, ok: true })

    onmessage(
      new MessageEvent('message', {
        data: {
          ...message({
            type: 'preload',
            languageRegistrations: [languageRegistration('typescript')],
            themeRegistrations: [themeRegistration('github-dark')],
          }),
          id: 3,
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 3) !== undefined)
    onmessage(
      new MessageEvent('message', {
        data: { ...message({ type: 'idleFence' }), id: 4 },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 4) !== undefined)

    expect(responseWithId(postMessage, 3)).toMatchObject({ id: 3, ok: true })
    expect(createShikiPrimitiveAsync).toHaveBeenCalledOnce()
    expect(loadLanguage).toHaveBeenCalledOnce()
  })

  it('loads preloaded languages cooperatively one-by-one, once each, without setTimeout', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const api = languageApi()
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter(api))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    const preload = (id: number, languages: readonly string[]) =>
      onmessage(
        new MessageEvent('message', {
          data: {
            ...message({
              type: 'preload',
              languageRegistrations: languages.map(languageRegistration),
              themeRegistrations: [themeRegistration('github-dark')],
            }),
            id,
          },
        }),
      )

    preload(1, ['typescript', 'json'])
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)
    onmessage(new MessageEvent('message', { data: { ...message({ type: 'idleFence' }), id: 2 } }))
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)

    preload(3, ['json', 'rust'])
    await waitFor(() => responseWithId(postMessage, 3) !== undefined)
    onmessage(new MessageEvent('message', { data: { ...message({ type: 'idleFence' }), id: 4 } }))
    await waitFor(() => responseWithId(postMessage, 4) !== undefined)

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    const loaded = api.loadLanguage.mock.calls.map((registrations) =>
      registrations.map((registration) => registration.name),
    )
    expect(loaded).toEqual([['typescript'], ['json'], ['rust']])
  })

  it('reuses one shared HighlighterCore across differing theme arrays and loads themes incrementally', async () => {
    const api = languageApi()
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter(api))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: {
          id: 1,
          payload: {
            type: 'theme',
            theme: 'github-dark',
            themeRegistration: themeRegistration('github-dark'),
            themeRegistrations: [themeRegistration('github-dark')],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)

    onmessage(
      new MessageEvent('message', {
        data: {
          id: 2,
          payload: {
            type: 'theme',
            theme: 'github-light',
            themeRegistration: themeRegistration('github-light'),
            themeRegistrations: [
              themeRegistration('github-light'),
              themeRegistration('github-dark'),
            ],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)

    onmessage(
      new MessageEvent('message', {
        data: {
          ...openRequest({
            documentId: 'doc',
            text: 'const x = 1',
            lang: 'typescript',
            theme: 'nord',
          }),
          id: 3,
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 3) !== undefined)

    onmessage(
      new MessageEvent('message', {
        data: { id: 4, payload: { type: 'idleFence', includeRetention: true } },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 4) !== undefined)

    expect(createShikiPrimitiveAsync).toHaveBeenCalledOnce()
    expect(createOnigurumaEngine).toHaveBeenCalledOnce()
    expect(api.loadTheme.mock.calls.map(([registration]) => registration.name)).toEqual([
      'github-light',
      'nord',
    ])
    const retentionResponse = responseWithId(postMessage, 4)
    expect(retentionResponse?.ok && retentionResponse.result?.retention?.shared).toMatchObject({
      highlighterEntries: 1,
      highlighterCount: 1,
    })
  })

  it('reloads a custom theme when the same theme name alternates between definitions', async () => {
    const themesByName = new Map<string, { bg: string; fg: string }>()
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockImplementation(
      async (options: { themes?: { name: string; bg?: string; fg?: string }[] }) => {
        for (const theme of options.themes ?? []) {
          themesByName.set(theme.name, { bg: theme.bg ?? '#000000', fg: theme.fg ?? '#ffffff' })
        }
        return {
          ...externalHighlighter(languageApi()),
          loadTheme: vi.fn(async (theme: { name: string; bg?: string; fg?: string }) => {
            themesByName.set(theme.name, { bg: theme.bg ?? '#000000', fg: theme.fg ?? '#ffffff' })
          }),
          getTheme: (name: string) => {
            const theme = themesByName.get(name) ?? { bg: '#000000', fg: '#ffffff' }
            return {
              ...theme,
              settings: [{ settings: { foreground: theme.fg, background: theme.bg } }],
            }
          },
        }
      },
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    const requestTheme = (id: number, fg: string) =>
      onmessage(
        new MessageEvent('message', {
          data: {
            id,
            payload: {
              type: 'theme',
              theme: 'custom',
              themeRegistration: { name: 'custom', bg: '#111111', fg },
              themeRegistrations: [],
            },
          },
        }),
      )

    requestTheme(1, '#ff0000')
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)
    requestTheme(2, '#00ff00')
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)
    requestTheme(3, '#ff0000')
    await waitFor(() => responseWithId(postMessage, 3) !== undefined)

    expect(createShikiPrimitiveAsync).toHaveBeenCalledOnce()
    expect(
      [1, 2, 3].map((id) => {
        const res = responseWithId(postMessage, id)
        return res?.ok ? res.result?.theme?.foregroundColor : undefined
      }),
    ).toEqual(['#ff0000', '#00ff00', '#ff0000'])
  })

  it('loads embedded grammar dependencies before dependents and keeps cycles atomic during preload', async () => {
    const loaded = new Set<string>()
    const loadOrder: string[][] = []
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(
      externalHighlighter({
        getLoadedLanguages: () => [...loaded],
        loadLanguage: vi.fn(
          async (
            ...registrations: {
              readonly name: string
              readonly embeddedLangs?: readonly string[]
            }[]
          ) => {
            const batchNames = new Set(registrations.map((r) => r.name))
            for (const registration of registrations) {
              for (const dep of registration.embeddedLangs ?? []) {
                if (!loaded.has(dep) && !batchNames.has(dep)) {
                  throw new Error(`Missing languages ${dep}, required by ${registration.name}`)
                }
              }
            }
            for (const registration of registrations) loaded.add(registration.name)
            loadOrder.push(registrations.map((r) => r.name))
          },
        ),
      }),
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: {
          id: 1,
          payload: {
            type: 'preload',
            languageRegistrations: [
              { ...languageRegistration('html'), embeddedLangs: ['css', 'javascript'] },
              languageRegistration('css'),
              languageRegistration('javascript'),
              { ...languageRegistration('cycA'), embeddedLangs: ['cycB'] },
              { ...languageRegistration('cycB'), embeddedLangs: ['cycA'] },
              // Unsatisfiable dependency should be skipped rather than poisoning the registry.
              { ...languageRegistration('orphan'), embeddedLangs: ['missing-dep'] },
            ],
            themeRegistrations: [themeRegistration('github-dark')],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)
    onmessage(new MessageEvent('message', { data: { id: 2, payload: { type: 'idleFence' } } }))
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)

    const flatOrder = loadOrder.flat()
    expect(flatOrder.indexOf('css')).toBeLessThan(flatOrder.indexOf('html'))
    expect(flatOrder.indexOf('javascript')).toBeLessThan(flatOrder.indexOf('html'))
    expect(loadOrder).toContainEqual(['cycB', 'cycA'])
    expect(flatOrder).not.toContain('orphan')
  })

  it('rejects a cycle containing a missing dependency without poisoning subsequent loads', async () => {
    const loaded = new Set<string>()
    const loadOrder: string[][] = []
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(
      externalHighlighter({
        getLoadedLanguages: () => [...loaded],
        loadLanguage: vi.fn(
          async (
            ...registrations: {
              readonly name: string
              readonly embeddedLangs?: readonly string[]
            }[]
          ) => {
            const batchNames = new Set(registrations.map((r) => r.name))
            for (const registration of registrations) {
              for (const dep of registration.embeddedLangs ?? []) {
                if (!loaded.has(dep) && !batchNames.has(dep)) {
                  throw new Error(`Missing languages ${dep}, required by ${registration.name}`)
                }
              }
            }
            for (const registration of registrations) loaded.add(registration.name)
            loadOrder.push(registrations.map((r) => r.name))
          },
        ),
      }),
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: {
          id: 1,
          payload: {
            type: 'preload',
            languageRegistrations: [
              { ...languageRegistration('a'), embeddedLangs: ['b', 'missing'] },
              { ...languageRegistration('b'), embeddedLangs: ['a'] },
              { ...languageRegistration('c'), embeddedLangs: ['b'] },
              languageRegistration('healthy'),
            ],
            themeRegistrations: [themeRegistration('github-dark')],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)
    onmessage(new MessageEvent('message', { data: { id: 2, payload: { type: 'idleFence' } } }))
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)

    expect(loadOrder).toEqual([['healthy']])
  })

  it('keeps distinct custom themes with the same name isolated across concurrent documents on edit', async () => {
    const themesByName = new Map<string, { bg: string; fg: string }>()
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockImplementation(
      async (options: { themes?: { name: string; bg?: string; fg?: string }[] }) => {
        for (const theme of options.themes ?? []) {
          themesByName.set(theme.name, { bg: theme.bg ?? '#000000', fg: theme.fg ?? '#ffffff' })
        }
        return {
          ...externalHighlighter(languageApi(), true),
          loadTheme: vi.fn(async (theme: { name: string; bg?: string; fg?: string }) => {
            themesByName.set(theme.name, { bg: theme.bg ?? '#000000', fg: theme.fg ?? '#ffffff' })
          }),
          getTheme: (name: string) => {
            const theme = themesByName.get(name) ?? { bg: '#000000', fg: '#ffffff' }
            return {
              ...theme,
              settings: [{ settings: { foreground: theme.fg, background: theme.bg } }],
            }
          },
        }
      },
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    const redTheme = { name: 'custom', bg: '#111111', fg: '#ff0000' }
    const greenTheme = { name: 'custom', bg: '#111111', fg: '#00ff00' }

    const openA = openRequest({
      documentId: 'doc-a',
      text: 'const a = 1;',
      lang: 'typescript',
      theme: 'custom',
    })
    onmessage(
      new MessageEvent('message', {
        data: {
          ...openA,
          id: 1,
          payload: {
            ...openA.payload,
            themeRegistration: redTheme,
            themeRegistrations: [redTheme],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 1) !== undefined)

    // Register a distinct worker source identity for doc-b so doc-a's revision point stays intact.
    const identityB = { ...identity, documentId: 'worker-source-b', registrationId: 2 }
    const pointB = { segment: 'worker-source-b-segment', revision: 0, textVersion: 0 }
    sendSource({ kind: 'register', identity: identityB })
    sendSource({
      kind: 'reset',
      identity: identityB,
      base: null,
      target: pointB,
      chunks: ['const b = 2;'],
      lineEnding: '\n',
      byteOrderMark: '',
      containsUnusualLineTerminators: false,
    })
    sendSource({ kind: 'pin', identity: identityB, point: pointB, readId: 'read-doc-b' })
    onmessage(
      new MessageEvent('message', {
        data: {
          id: 2,
          payload: {
            type: 'open',
            documentId: 'doc-b',
            runtimeSessionId: 'doc-b:runtime',
            lang: 'typescript',
            theme: 'custom',
            source: { identity: identityB, point: pointB, readId: 'read-doc-b' },
            maxLineLength: 20000,
            languageRegistrations: [languageRegistration('typescript')],
            themeRegistration: greenTheme,
            themeRegistrations: [greenTheme],
          },
        },
      }),
    )
    await waitFor(() => responseWithId(postMessage, 2) !== undefined)

    const editA = editRequest({
      documentId: 'doc-a',
      lang: 'typescript',
      theme: 'custom',
      edits: [{ from: 6, to: 7, text: 'alpha' }],
    })
    onmessage(new MessageEvent('message', { data: { ...editA, id: 3 } }))
    await waitFor(() => responseWithId(postMessage, 3) !== undefined)

    const resA = responseWithId(postMessage, 1)
    const resB = responseWithId(postMessage, 2)
    const resEditA = responseWithId(postMessage, 3)
    expect(resA?.ok && resA.result?.theme?.foregroundColor).toBe('#ff0000')
    expect(resB?.ok && resB.result?.theme?.foregroundColor).toBe('#00ff00')
    expect(resEditA?.ok && resEditA.result?.theme?.foregroundColor).toBe('#ff0000')
  })

  it('tokenizes opened documents line-by-line without calling materializeFullText', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const api = languageApi()
    const tokenizedLines: string[] = []
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue({
      ...externalHighlighter(api, true),
      getLanguage: () => ({
        tokenizeLine: (line: string) => {
          tokenizedLines.push(line)
          return {
            ruleStack: INITIAL,
            tokens: Array.from(line.matchAll(/\w+/g), (match) => ({
              startIndex: match.index,
              endIndex: match.index + match[0].length,
              scopes: ['keyword'],
            })),
          }
        },
      }),
    })
    const snapshotModule = await import('../../src/documentTextSnapshot')
    const realCreate = snapshotModule.createDocumentTextSnapshot
    vi.spyOn(snapshotModule, 'createDocumentTextSnapshot').mockImplementation(
      (pieceTableSnapshot, materializedText) => {
        const snapshot = realCreate(pieceTableSnapshot, materializedText)
        return {
          ...snapshot,
          get length() {
            return snapshot.length
          },
          get lineCount() {
            return snapshot.lineCount
          },
          lineStart: (line) => snapshot.lineStart(line),
          lineRange: (line) => snapshot.lineRange(line),
          lineAt: (offset) => snapshot.lineAt(offset),
          readRange: (start, end) => snapshot.readRange(start, end),
          forEachTextChunk: (visit) => snapshot.forEachTextChunk(visit),
          materializeFullText: () => {
            throw new Error('shiki.worker must not call materializeFullText')
          },
        }
      },
    )
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: openRequest({
          documentId: 'doc',
          text: 'const a = 1\r\nconst b = 2\nconst c = 3',
          lang: 'typescript',
          theme: 'github-dark',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    const response = postMessage.mock.calls[0]?.[0]
    expect(response?.ok).toBe(true)
    expect(tokenizedLines).toEqual(['const a = 1', 'const b = 2', 'const c = 3'])
  })

  it('returns editor theme colors from the loaded Shiki theme', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const getTheme = vi.fn(() => ({
      bg: '#ffffff',
      fg: '#24292e',
      colors: {
        'editorCursor.foreground': '#044289',
        'editorLineNumber.foreground': '#6e7781',
      },
    }))
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(
      externalHighlighter({ getTheme, ...languageApi() }, true),
    )

    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: openRequest({
          documentId: 'doc',
          text: 'const value',
          lang: 'typescript',
          theme: 'github-light',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    const response = postMessage.mock.calls[0]?.[0]
    expect(response).toMatchObject({
      id: 1,
      ok: true,
      result: {
        documentId: 'doc',
        theme: {
          backgroundColor: '#ffffff',
          foregroundColor: '#24292e',
          gutterBackgroundColor: '#ffffff',
          gutterForegroundColor: '#6e7781',
          caretColor: '#044289',
          minimapBackgroundColor: '#ffffff',
          syntax: { bracket: '#24292e' },
        },
      },
    })
    if (!response?.ok || !response.result?.tokensPacked) {
      throw new Error('Expected a packed Shiki token response')
    }

    const packed = response.result.tokensPacked
    expect(packed.styles).toEqual([{ color: '#FF0000' }])
    expect(Array.from(packed.styleIds)).toEqual([0, 0])
    expect(unpackEditorTokens(packed)).toEqual([
      { end: 5, start: 0, style: { color: '#FF0000' } },
      { end: 11, start: 6, style: { color: '#FF0000' } },
    ])
    expect(postMessage.mock.calls[0]?.[1]).toEqual([
      packed.starts.buffer,
      packed.ends.buffer,
      packed.styleIds.buffer,
    ])
  })

  it('answers an edit batch with the re-tokenized lines instead of the whole document', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(
      externalHighlighter(
        {
          getTheme: () => ({ bg: '#ffffff', fg: '#24292e', colors: {} }),
          ...languageApi(),
        },
        true,
      ),
    )
    await import('../../src/shiki/shiki.worker')
    const onmessage = workerHandler()
    const document = { documentId: 'doc', lang: 'typescript', theme: 'github-light' }

    onmessage(
      new MessageEvent('message', { data: openRequest({ ...document, text: 'const\nvalue' }) }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)
    const edits = [{ from: 6, to: 11, text: 'changed' }]
    onmessage(new MessageEvent('message', { data: editRequest({ ...document, edits }) }))
    await waitFor(() => postMessage.mock.calls.length > 1)

    const response = postMessage.mock.calls[1]?.[0]
    if (!response?.ok || !response.result?.patchesPacked) {
      throw new Error('Expected a packed patch response')
    }
    expect(response.result.tokensPacked).toBeUndefined()
    const [patch] = response.result.patchesPacked
    expect(patch).toMatchObject({ fromOffset: 6, oldEndOffset: 11, newEndOffset: 13 })
    expect(unpackEditorTokens(patch!.tokensPacked)).toEqual([
      { start: 6, end: 13, style: { color: '#00FF00' } },
    ])
    expect(postMessage.mock.calls[1]?.[1]).toEqual([
      patch!.tokensPacked.starts.buffer,
      patch!.tokensPacked.ends.buffer,
      patch!.tokensPacked.styleIds.buffer,
    ])
  })

  it('returns editor theme colors without opening a document', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const getTheme = vi.fn(() => ({
      bg: '#ffffff',
      fg: '#24292e',
    }))
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter({ getTheme, ...languageApi() }))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: themeRequest({
          theme: 'github-light',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    expect(createShikiPrimitiveAsync).toHaveBeenCalledWith({
      engine: expect.any(Promise),
      langs: [],
      themes: [{ name: 'github-light' }],
    })
    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: true,
      result: {
        theme: {
          backgroundColor: '#ffffff',
          foregroundColor: '#24292e',
          gutterBackgroundColor: '#ffffff',
          gutterForegroundColor: undefined,
          caretColor: '#24292e',
          minimapBackgroundColor: '#ffffff',
          syntax: {
            bracket: '#24292e',
          },
        },
      },
    } satisfies ShikiWorkerResponse)
  })

  it('maps Shiki token colors into editor syntax theme colors', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const getTheme = vi.fn(() => ({
      bg: '#0d1117',
      fg: '#c9d1d9',
      tokenColors: [
        { scope: 'comment', settings: { foreground: '#8b949e' } },
        { scope: 'storage.modifier', settings: { foreground: '#ff7b72' } },
        { scope: 'entity.name.function', settings: { foreground: '#d2a8ff' } },
        { scope: 'entity.name.class', settings: { foreground: '#ffa657' } },
        { scope: 'string.quoted', settings: { foreground: '#a5d6ff' } },
        { scope: 'constant.numeric', settings: { foreground: '#79c0ff' } },
      ],
    }))
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter({ getTheme, ...languageApi() }))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: themeRequest({
          theme: 'github-dark',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: true,
      result: {
        theme: {
          backgroundColor: '#0d1117',
          foregroundColor: '#c9d1d9',
          gutterBackgroundColor: '#0d1117',
          gutterForegroundColor: undefined,
          caretColor: '#c9d1d9',
          minimapBackgroundColor: '#0d1117',
          syntax: {
            bracket: '#c9d1d9',
            comment: '#8b949e',
            function: '#d2a8ff',
            keyword: '#ff7b72',
            number: '#79c0ff',
            string: '#a5d6ff',
            type: '#ffa657',
            typeDefinition: '#ffa657',
          },
        },
      },
    } satisfies ShikiWorkerResponse)
  })

  it('prefers editor-relevant Shiki scopes over later specialized child scopes', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const getTheme = vi.fn(() => ({
      bg: '#0d1117',
      fg: '#c9d1d9',
      tokenColors: [
        { scope: 'keyword', settings: { foreground: '#f97583' } },
        { scope: 'entity, entity.name', settings: { foreground: '#b392f0' } },
        { scope: 'string', settings: { foreground: '#9ecbff' } },
        { scope: 'meta.property-name', settings: { foreground: '#79b8ff' } },
        { scope: 'support', settings: { foreground: '#79b8ff' } },
        { scope: 'string.other.link', settings: { foreground: '#dbedff' } },
        { scope: 'punctuation.definition.changed', settings: { foreground: '#ffab70' } },
        { scope: 'storage.modifier.import', settings: { foreground: '#e1e4e8' } },
      ],
    }))
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter({ getTheme, ...languageApi() }))
    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: themeRequest({
          theme: 'github-dark',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: true,
      result: {
        theme: {
          backgroundColor: '#0d1117',
          foregroundColor: '#c9d1d9',
          gutterBackgroundColor: '#0d1117',
          gutterForegroundColor: undefined,
          caretColor: '#c9d1d9',
          minimapBackgroundColor: '#0d1117',
          syntax: {
            attribute: '#b392f0',
            bracket: '#c9d1d9',
            function: '#b392f0',
            keyword: '#f97583',
            keywordDeclaration: '#f97583',
            keywordImport: '#f97583',
            namespace: '#b392f0',
            property: '#79b8ff',
            string: '#9ecbff',
            type: '#79b8ff',
            typeDefinition: '#b392f0',
            typeParameter: '#b392f0',
            variableBuiltin: '#79b8ff',
          },
        },
      },
    } satisfies ShikiWorkerResponse)
  })
})

type Scope = {
  postMessage(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]): void
  onmessage?: (event: MessageEvent<ShikiWorkerRequest>) => void
}
let scope: Scope | null = null
let point: DocumentWorkerPoint | null = null
let sourceId = 1000
const identity = {
  documentId: 'worker-source',
  documentGeneration: 1,
  endpointGeneration: 1,
  registrationId: 1,
}
function setupScope(
  post: (response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void,
) {
  point = null
  scope = {
    postMessage: (response, transfers) => {
      if (response.ok && response.result?.source) {
        expect(response.result.source.kind).not.toBe('rejected')
        return
      }
      if (transfers) post(response, transfers)
      else post(response)
    },
  }
  vi.stubGlobal('self', scope)
}
function workerHandler() {
  const handler = scope?.onmessage
  if (!handler) throw new TypeError('The actual worker handler must be initialized')
  return handler
}
function sendSource(command: DocumentWorkerSourceCommand) {
  workerHandler()(
    new MessageEvent('message', {
      data: { id: sourceId++, payload: { type: 'source', command } } satisfies ShikiWorkerRequest,
    }),
  )
}
function publishSource(text: string | null, edits: readonly TextEdit[] = []) {
  const previous = point
  point = {
    segment: 'worker-source-segment',
    revision: previous ? previous.revision + 1 : 0,
    textVersion: previous ? previous.textVersion + 1 : 0,
  }
  if (!previous) {
    sendSource({ kind: 'register', identity })
    sendSource({
      kind: 'reset',
      identity,
      base: null,
      target: point,
      chunks: [text ?? ''],
      lineEnding: '\n',
      byteOrderMark: '',
      containsUnusualLineTerminators: false,
    })
  } else sendSource({ kind: 'advance', identity, base: previous, target: point, edits })
  const readId = `read-${sourceId}`
  sendSource({ kind: 'pin', identity, point, readId })
  const source: DocumentWorkerReadReference = { identity, point, readId }
  return { source, previousPoint: previous ?? point }
}
const message = (payload: ShikiWorkerRequestPayload): ShikiWorkerRequest => ({ id: 1, payload })
function openRequest(options: { documentId: string; text: string; lang: string; theme: string }) {
  const { source } = publishSource(options.text)
  return message({
    type: 'open',
    documentId: options.documentId,
    runtimeSessionId: `${options.documentId}:runtime`,
    lang: options.lang,
    theme: options.theme,
    source,
    maxLineLength: 20000,
    languageRegistrations: [languageRegistration(options.lang)],
    themeRegistration: themeRegistration(options.theme),
    themeRegistrations: [],
  })
}
function editRequest(options: {
  documentId: string
  edits: readonly TextEdit[]
  lang: string
  theme: string
}) {
  const read = publishSource(null, options.edits)
  return message({
    type: 'edit',
    documentId: options.documentId,
    runtimeSessionId: `${options.documentId}:runtime`,
    lang: options.lang,
    theme: options.theme,
    ...read,
    edits: options.edits,
  })
}
function themeRequest(options: { theme: string }) {
  return message({
    type: 'theme',
    ...options,
    themeRegistration: themeRegistration(options.theme),
    themeRegistrations: [],
  })
}

function externalHighlighter(
  api: {
    getTheme?: () => {
      bg: string
      fg: string
      colors?: Record<string, string>
      tokenColors?: readonly unknown[]
    }
    [key: string]: unknown
  },
  colored = false,
) {
  return {
    ...api,
    getLanguage: () => ({
      tokenizeLine: (line: string) => ({
        ruleStack: INITIAL,
        tokens: Array.from(line.matchAll(/\w+/g), (match) => ({
          startIndex: match.index,
          endIndex: match.index + match[0].length,
          scopes: [match[0] === 'changed' ? 'changed' : 'keyword'],
        })),
      }),
    }),
    getTheme: () => {
      const theme = api.getTheme?.() ?? { bg: '#ffffff', fg: '#24292e' }
      const settings: NonNullable<ThemeRegistration['settings']> = [
        { settings: { foreground: theme.fg, background: theme.bg } },
      ]
      return {
        ...theme,
        settings: settings.concat(
          colored
            ? [
                { scope: 'keyword', settings: { foreground: '#ff0000' } },
                { scope: 'changed', settings: { foreground: '#00ff00' } },
              ]
            : [],
        ),
      }
    },
  }
}

const languageRegistration = (name: string) => ({
  name,
  patterns: [],
  repository: {},
  scopeName: `source.${name}`,
})

const themeRegistration = (name: string) => ({ name })

const realSetTimeout = globalThis.setTimeout

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => realSetTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for worker response')
}

function responseWithId(
  postMessage: ReturnType<
    typeof vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>
  >,
  id: number,
) {
  return postMessage.mock.calls.find(([response]) => response.id === id)?.[0]
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

/**
 * Loading the host's whole preload set before the first paint measured 1 280–1 780 ms for 53
 * grammars, against 49–104 ms for the one grammar the document actually needs.
 */
describe('shiki worker grammar loading', () => {
  it('builds the highlighter with only the document registration before preload', async () => {
    const postMessage =
      vi.fn<(response: ShikiWorkerResponse, transfers?: readonly ArrayBuffer[]) => void>()
    const getTheme = vi.fn(() => ({ bg: '#ffffff', fg: '#24292e', colors: {} }))
    const api = languageApi()
    setupScope(postMessage)
    createShikiPrimitiveAsync.mockResolvedValue(externalHighlighter({ getTheme, ...api }))

    await import('../../src/shiki/shiki.worker')

    const onmessage = workerHandler()
    onmessage(
      new MessageEvent('message', {
        data: openRequest({
          documentId: 'doc',
          text: '',
          lang: 'typescript',
          theme: 'github-light',
        }),
      }),
    )
    await waitFor(() => postMessage.mock.calls.length > 0)

    expect(createShikiPrimitiveAsync).toHaveBeenCalledWith(
      expect.objectContaining({ langs: [languageRegistration('typescript')] }),
    )
    expect(api.loadLanguage).toHaveBeenCalledWith(languageRegistration('typescript'))
  })
})
