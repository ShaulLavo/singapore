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

  test('clears retained theme caches and ignores late theme refreshes after dispose', async () => {
    const refreshGate = Promise.withResolvers<{
      readonly name: string
      readonly type: 'dark'
      readonly colors: { readonly 'editor.background': string }
    }>()
    let calls = 0
    const service = createHighlightingService({
      resolveTheme: (id) => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve({
            name: id,
            type: 'dark',
            colors: { 'editor.background': '#111111' },
          })
        }
        return refreshGate.promise
      },
    })
    const listeners = new Set<() => void>()
    const provider = service.highlighterProvider({
      current: () => ({ format: 'vscode', id: 'custom-theme' }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    await provider.loadTheme?.().catch(() => undefined)
    expect(calls).toBe(1)

    const documentThemes = Reflect.get(service, 'documentThemes') as Map<string, unknown>
    const documentThemeContent = Reflect.get(service, 'documentThemeContent') as Map<
      string,
      unknown
    >
    const documentThemeRefreshes = Reflect.get(service, 'documentThemeRefreshes') as Map<
      string,
      unknown
    >
    expect(documentThemes.size).toBe(1)
    expect(documentThemeContent.size).toBe(1)

    await service.dispose()
    refreshGate.resolve({
      name: 'custom-theme',
      type: 'dark',
      colors: { 'editor.background': '#222222' },
    })
    await Promise.resolve()

    expect(service.inspect().disposed).toBe(true)
    expect(documentThemes.size).toBe(0)
    expect(documentThemeContent.size).toBe(0)
    expect(documentThemeRefreshes.size).toBe(0)
    expect(Reflect.get(service, 'defaultTheme')).toBeNull()
  })
})

describe('highlightingGrammar', () => {
  test('keeps the wide Shiki language set and its aliases', () => {
    expect(highlightingGrammar('ts')).toBe('typescript')
    expect(highlightingGrammar('typescriptreact')).toBe('tsx')
    expect(highlightingGrammar('javascriptreact')).toBe('jsx')
    expect(highlightingGrammar(' Shell ')).toBe('shellscript')
    // Languages only Shiki supplies stay available to fences.
    expect(highlightingGrammar('haskell')).toBe('haskell')
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
