import { describe, expect, test } from 'vitest'

import { createHighlightingService, highlightingGrammar, HighlightingError } from '../src/index'

describe('highlighting service without a worker', () => {
  test('reports an unavailable worker instead of tokenizing on the main thread', async () => {
    const service = createHighlightingService()
    const failure = await service.highlight('const a = 1', { language: 'ts' }).catch((e) => e)
    expect(failure).toBeInstanceOf(HighlightingError)
    expect(failure.code).toBe('unavailable')
  })

  test('rejects an aborted request before any work starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const service = createHighlightingService()
    const failure = await service
      .highlight('x', { language: 'ts', signal: controller.signal })
      .catch((e) => e)
    expect(failure.code).toBe('aborted')
    expect(failure.name).toBe('AbortError')
  })

  test('refuses work after disposal, and disposing twice is safe', async () => {
    const service = createHighlightingService()
    await service.dispose()
    await service.dispose()
    const failure = await service.highlight('x', { language: 'ts' }).catch((e) => e)
    expect(failure.code).toBe('disposed')
    expect(() => service.syntaxProvider()).toThrow(HighlightingError)
  })

  test('clears retained theme caches and prevents late theme loads or notifications from repopulating them after dispose', async () => {
    const lateTheme = Promise.withResolvers<{
      readonly name: string
      readonly type: 'dark'
      readonly colors: { readonly 'editor.background': string }
    }>()
    let resolveCalls = 0
    const service = createHighlightingService({
      resolveTheme: (id) => {
        resolveCalls += 1
        if (id === 'late-theme') return lateTheme.promise
        return Promise.resolve({
          name: id,
          type: 'dark',
          colors: { 'editor.background': '#111111' },
        })
      },
    })
    // Populate defaultTheme via highlight() (which loads github-dark before checking Worker).
    await service.highlight('const x = 1', { language: 'ts' }).catch(() => undefined)
    // Populate documentThemes and documentThemeContent via provider.loadTheme().
    const listeners = new Set<() => void>()
    const initialSource = {
      current: () => ({ format: 'vscode' as const, id: 'custom-theme' }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const initialProvider = service.highlighterProvider(initialSource)
    await initialProvider.loadTheme?.().catch(() => undefined)

    const documentThemes = Reflect.get(service, 'documentThemes') as Map<string, unknown>
    const documentThemeContent = Reflect.get(service, 'documentThemeContent') as Map<
      string,
      unknown
    >
    const documentThemeRefreshes = Reflect.get(service, 'documentThemeRefreshes') as Map<
      string,
      unknown
    >
    expect(Reflect.get(service, 'defaultTheme')).not.toBeNull()
    expect(documentThemes.size).toBe(1)
    expect(documentThemeContent.size).toBe(1)

    // Start a pending theme load that will settle only after disposal.
    const lateProvider = service.highlighterProvider({
      current: () => ({ format: 'vscode', id: 'late-theme' }),
    })
    const pendingLateLoad = lateProvider.loadTheme?.().catch(() => undefined)
    // Register a subscriber to verify post-dispose theme notifications do not restart work.
    const unsubscribe = (
      Reflect.get(service, 'onDocumentTheme') as (
        theme: typeof initialSource,
        listener: () => void,
      ) => () => void
    ).call(service, initialSource, () => undefined)

    await service.dispose()
    const callsAfterDispose = resolveCalls
    lateTheme.resolve({
      name: 'late-theme',
      type: 'dark',
      colors: { 'editor.background': '#222222' },
    })
    for (const listener of listeners) listener()
    await pendingLateLoad
    // Flush multi-hop async continuations inside resolveImported -> importedTheme.
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()

    expect(service.inspect().disposed).toBe(true)
    expect(resolveCalls).toBe(callsAfterDispose)
    expect(documentThemes.size).toBe(0)
    expect(documentThemeContent.size).toBe(0)
    expect(documentThemeRefreshes.size).toBe(0)
    expect(Reflect.get(service, 'defaultTheme')).toBeNull()
  })
})

describe('highlightingGrammar', () => {
  test('resolves Tree-sitter languages and aliases without Shiki', () => {
    expect(highlightingGrammar('ts')).toBe('typescript')
    expect(highlightingGrammar('typescriptreact')).toBe('tsx')
    expect(highlightingGrammar('javascriptreact')).toBe('jsx')
    expect(highlightingGrammar(' Bash ')).toBe('shellscript')
    expect(highlightingGrammar('rs')).toBe('rust')
    expect(highlightingGrammar('py')).toBe('python')
    expect(highlightingGrammar('no-such-language')).toBeNull()
  })
})

test('terminal disposal rejects reentrant diff callbacks and shares one completion', async () => {
  const service = createHighlightingService()
  const { createTextDiff } = await import('@singapore-editor/diff')
  const file = createTextDiff({
    oldFile: { path: 'terminal.js', text: 'const a = 1;' },
    newFile: { path: 'terminal.js', text: 'const a = 2;' },
  })
  const observed: unknown[] = []
  let nested: Promise<void> | undefined
  service.showDiff(
    {
      setFile() {},
      releaseSyntax() {
        observed.push(service.inspect().disposed)
        try {
          service.syntaxProvider()
          observed.push('admitted')
        } catch (error) {
          observed.push(error)
        }
        nested = service.dispose()
      },
    },
    file,
    'stacked',
    { current: () => ({ format: 'editor' }) },
  )
  const disposal = service.dispose()
  await disposal
  await nested
  expect(observed).toEqual([true, expect.objectContaining({ code: 'disposed' })])
  expect(nested).toBe(disposal)
})
