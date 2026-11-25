import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import wasm from '@shikijs/engine-oniguruma/wasm-inlined'
import {
  createHighlighterCore,
  type HighlighterGeneric,
  type LanguageRegistration,
  type ThemeRegistrationAny,
} from 'shiki/core'
import { createIncrementalTokenizer, type CreateIncrementalTokenizerResult } from './tokenizer'
import { packTokenLines } from './editor-tokens'
import type { EditorTheme } from '../theme'
import { packedEditorTokenTransfers } from '../syntax/packedTokens'
import {
  DocumentWorkerReader,
  documentWorkerPointsEqual,
  type DocumentWorkerRead,
} from '../document/workerReader'
import { editorThemeFromShikiTheme, type ShikiThemeLike } from './theme-extract'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerEditRequest,
  ShikiWorkerLanguageRegistration,
  ShikiWorkerOpenRequest,
  ShikiWorkerPreloadRequest,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerRetentionSnapshot,
  ShikiWorkerTransportResult,
  ShikiWorkerThemeRegistration,
  ShikiWorkerThemeRequest,
  ShikiWorkerRecolorRequest,
} from './workerTypes'

type DocumentState = {
  readonly documentId: string
  readonly runtimeSessionId: string
  readonly lang: string
  theme: string
  themeRegistration: ShikiWorkerThemeRegistration
  readonly highlighter: HighlighterGeneric<string, string>
  readonly tokenizer: CreateIncrementalTokenizerResult['tokenizer']
  source: DocumentWorkerRead
}

const sourceReader = new DocumentWorkerReader()
const documents = new Map<string, DocumentState>()
const documentTasks = new Map<string, Promise<ShikiWorkerTransportResult | undefined>>()
const disposedRuntimeSessions = new Set<string>()
const activeWorkerTasks = new Set<Promise<void>>()
let sharedHighlighterPromise: Promise<HighlighterGeneric<string, string>> | null = null
const loadedThemeKeyByName = new Map<string, string>()
const pendingThemeLoadsByName = new Map<string, Promise<void>>()
const pendingLanguageLoads = new Map<string, Promise<void>>()
const scheduledPreloadLanguages = new Set<string>()
const preloadLanguageQueue: {
  readonly highlighter: HighlighterGeneric<string, string>
  readonly group: readonly ShikiWorkerLanguageRegistration[]
}[] = []
let preloadRunner: Promise<void> | null = null
let workerGeneration = 0
let yieldChannel: MessageChannel | null = null
let pendingYieldResolvers: (() => void)[] = []
const MAX_DISPOSED_RUNTIME_SESSIONS = 1_024

self.onmessage = (event: MessageEvent<ShikiWorkerRequest>): void => {
  const task = handleRequest(event.data)
  if (event.data.payload.type === 'idleFence') return

  trackWorkerTask(task)
}

const trackWorkerTask = (task: Promise<void>): void => {
  activeWorkerTasks.add(task)
  void task.finally(() => activeWorkerTasks.delete(task)).catch(() => undefined)
}

const handleRequest = async (request: ShikiWorkerRequest): Promise<void> => {
  try {
    const result = await runRequest(request.payload)
    postResponse({ id: request.id, ok: true, result })
  } catch (error) {
    postResponse({ id: request.id, ok: false, error: createErrorMessage(error) })
  }
}

const runRequest = (
  payload: ShikiWorkerRequest['payload'],
): Promise<ShikiWorkerTransportResult | undefined> => {
  if (payload.type === 'source')
    return Promise.resolve({ source: sourceReader.apply(payload.command) })
  if (payload.type === 'open' || payload.type === 'edit') {
    const source = sourceReader.acquire(payload.source)
    if (!source)
      return Promise.reject(new DOMException('Document source read is unavailable', 'AbortError'))
    return runDocumentTask(payload.runtimeSessionId, () =>
      payload.type === 'open' ? openDocument(payload, source) : editDocument(payload, source),
    ).finally(() => source.dispose())
  }
  if (payload.type === 'recolor') {
    return runDocumentTask(payload.runtimeSessionId, () => recolorDocument(payload))
  }
  if (payload.type === 'disposeDocument') {
    return runDocumentTask(payload.runtimeSessionId, () => {
      disposeDocument(payload.runtimeSessionId)
      return Promise.resolve(undefined)
    })
  }
  if (payload.type === 'runtimeBarrier') {
    return runDocumentTask(payload.runtimeSessionId, () => Promise.resolve(undefined))
  }
  if (payload.type === 'idleFence') {
    return awaitWorkerTasks().then(() =>
      payload.includeRetention ? inspectRetention() : undefined,
    )
  }
  if (payload.type === 'theme') {
    return loadTheme(payload)
  }
  if (payload.type === 'preload') {
    return preloadRegistrations(payload)
  }

  return Promise.allSettled(Array.from(activeWorkerTasks)).then(() => {
    disposeAll()
    return undefined
  })
}

const awaitWorkerTasks = async (): Promise<void> => {
  while (activeWorkerTasks.size > 0) {
    await Promise.allSettled(Array.from(activeWorkerTasks))
  }
}

const inspectRetention = async (): Promise<ShikiWorkerTransportResult> => {
  const highlighterPromise = sharedHighlighterPromise
  const highlighterResults = highlighterPromise
    ? await Promise.allSettled([highlighterPromise])
    : []
  const highlighters = new Set<HighlighterGeneric<string, string>>()
  for (const result of highlighterResults) {
    if (result.status === 'fulfilled') highlighters.add(result.value)
  }
  const retainedDocuments = Array.from(documents.values(), (state) => {
    return {
      documentId: state.documentId,
      runtimeSessionId: state.runtimeSessionId,
      ...state.tokenizer.inspectRetention(),
    }
  })
  const retention: ShikiWorkerRetentionSnapshot = {
    source: sourceReader.inspect(),
    documentCount: documents.size,
    tokenizerCount: new Set(Array.from(documents.values(), (state) => state.tokenizer)).size,
    retiredRuntimeCount: disposedRuntimeSessions.size,
    retiredRuntimeLimit: MAX_DISPOSED_RUNTIME_SESSIONS,
    lineCount: retainedDocuments.reduce((sum, state) => sum + state.lineCount, 0),
    tokenCount: retainedDocuments.reduce((sum, state) => sum + state.tokenCount, 0),
    documents: retainedDocuments,
    shared: {
      highlighterEntries: sharedHighlighterPromise ? 1 : 0,
      highlighterCount: highlighters.size,
      highlighters: Array.from(highlighters, (highlighter) => ({
        languageNames: highlighter.getLoadedLanguages(),
        themeNames: highlighter.getLoadedThemes(),
      })),
    },
    unmeasuredBytes: [
      'javascript-objects',
      'source-strings',
      'tokenizer-states',
      'grammars-and-themes',
      'worker-heap',
      'wasm-committed',
      'wasm-allocator-live',
    ],
  }
  return { retention }
}

const runDocumentTask = (
  runtimeSessionId: string,
  task: () => Promise<ShikiWorkerTransportResult | undefined>,
): Promise<ShikiWorkerTransportResult | undefined> => {
  const previous = documentTasks.get(runtimeSessionId) ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(task)
  documentTasks.set(runtimeSessionId, next)
  void next.finally(() => clearDocumentTask(runtimeSessionId, next)).catch(() => undefined)
  return next
}

const clearDocumentTask = (
  runtimeSessionId: string,
  task: Promise<ShikiWorkerTransportResult | undefined>,
): void => {
  if (documentTasks.get(runtimeSessionId) !== task) return
  documentTasks.delete(runtimeSessionId)
}

const openDocument = async (
  payload: ShikiWorkerOpenRequest,
  source: DocumentWorkerRead,
): Promise<ShikiWorkerTransportResult> => {
  if (disposedRuntimeSessions.has(payload.runtimeSessionId)) {
    return { documentId: payload.documentId }
  }

  const highlighter = await ensureHighlighter(payload)
  assertSource(source)
  const { tokenizer } = await createIncrementalTokenizer({
    lang: payload.lang,
    theme: payload.theme,
    source: source.text,
    highlighter,
    maxLineLength: payload.maxLineLength,
  })

  assertSource(source)
  const retained = source.retain()
  if (!retained) throw new DOMException('Document source scope was released', 'AbortError')
  const state = {
    source: retained,
    documentId: payload.documentId,
    runtimeSessionId: payload.runtimeSessionId,
    lang: payload.lang,
    theme: payload.theme,
    themeRegistration: payload.themeRegistration,
    highlighter,
    tokenizer,
  }
  if (!disposedRuntimeSessions.has(payload.runtimeSessionId)) {
    documents.get(payload.runtimeSessionId)?.source.dispose()
    documents.set(payload.runtimeSessionId, state)
  } else retained.dispose()
  return resultFromState(state)
}

const editDocument = async (
  payload: ShikiWorkerEditRequest,
  source: DocumentWorkerRead,
): Promise<ShikiWorkerTransportResult> => {
  const existing = documents.get(payload.runtimeSessionId)
  if (!existing) throw new Error('Unable to edit unopened Shiki document without text')
  if (!documentMatches(existing, payload)) {
    throw new Error('Unable to reopen Shiki document without text')
  }

  assertSource(source)
  if (
    !existing.source.isValid() ||
    !documentWorkerPointsEqual(existing.source.point, payload.previousPoint)
  )
    throw new DOMException('Shiki analysed source base is stale', 'InvalidStateError')
  const retained = source.retain()
  if (!retained) throw new DOMException('Document source scope was released', 'AbortError')
  let patches: ReturnType<DocumentState['tokenizer']['applyEdits']>
  try {
    patches = existing.tokenizer.applyEdits(payload.edits)
  } catch (error) {
    retained.dispose()
    throw error
  }
  existing.source.dispose()
  existing.source = retained
  return {
    documentId: existing.documentId,
    patchesPacked: patches.map((patch) => ({
      fromOffset: patch.fromOffset,
      oldEndOffset: patch.oldEndOffset,
      newEndOffset: patch.newEndOffset,
      tokensPacked: packTokenLines(patch.lines, patch.fromOffset),
    })),
    untokenizedLines: existing.tokenizer.untokenizedLineCount(),
    theme: editorThemeFromHighlighter(
      existing.highlighter,
      existing.theme,
      existing.themeRegistration,
    ),
  }
}

const recolorDocument = async (
  payload: ShikiWorkerRecolorRequest,
): Promise<ShikiWorkerTransportResult | undefined> => {
  const state = documents.get(payload.runtimeSessionId)
  if (!state) return undefined

  await ensureThemes(state.highlighter, [payload.themeRegistration])
  state.tokenizer.setTheme(payload.theme)
  state.theme = payload.theme
  state.themeRegistration = payload.themeRegistration
  return resultFromState(state)
}

/**
 * The worker keeps one shared Oniguruma highlighter and loads themes and grammars incrementally
 * on demand so theme-array permutations never duplicate WASM engines.
 */
const ensureHighlighter = async (
  options: ShikiWorkerDocumentOptions,
): Promise<HighlighterGeneric<string, string>> => {
  const languages = uniqueLanguageRegistrations(options.languageRegistrations)
  const themes = uniqueThemeRegistrations(
    [options.themeRegistration].concat(options.themeRegistrations),
  )
  const highlighter = await ensureSharedHighlighter(languages, themes)
  await ensureLanguages(highlighter, languages)

  return highlighter
}

const ensureLanguages = async (
  highlighter: HighlighterGeneric<string, string>,
  registrations: readonly ShikiWorkerLanguageRegistration[],
): Promise<void> => {
  const unique = uniqueLanguageRegistrations(registrations)
  const loaded = new Set(highlighter.getLoadedLanguages())
  const toWait: Promise<void>[] = []
  const missing: ShikiWorkerLanguageRegistration[] = []

  for (const registration of unique) {
    if (loaded.has(registration.name)) continue
    const key = languageRegistrationKey(registration)
    const pending = pendingLanguageLoads.get(key)
    if (pending) {
      toWait.push(pending)
      continue
    }
    missing.push(registration)
  }

  if (missing.length > 0) {
    const keys = missing.map(languageRegistrationKey)
    const load = Promise.resolve(
      highlighter.loadLanguage(...(missing as unknown as LanguageRegistration[])),
    ).finally(() => {
      for (const key of keys) {
        if (pendingLanguageLoads.get(key) === load) pendingLanguageLoads.delete(key)
      }
    })
    for (const key of keys) pendingLanguageLoads.set(key, load)
    toWait.push(load)
  }

  if (toWait.length > 0) await Promise.all(toWait)
}

const ensureThemes = async (
  highlighter: HighlighterGeneric<string, string>,
  registrations: readonly ShikiWorkerThemeRegistration[],
): Promise<void> => {
  const unique = uniqueThemesByName(registrations)
  if (unique.length === 0) return

  await Promise.all(unique.map((registration) => ensureThemeByName(highlighter, registration)))
}

const ensureThemeByName = async (
  highlighter: HighlighterGeneric<string, string>,
  registration: ShikiWorkerThemeRegistration,
): Promise<void> => {
  const name = registration.name
  const key = themeRegistrationKey(registration)

  while (true) {
    const pending = pendingThemeLoadsByName.get(name)
    if (pending) {
      await pending.catch(() => undefined)
      continue
    }
    if (loadedThemeKeyByName.get(name) === key) return

    const generation = workerGeneration
    if (typeof highlighter.loadTheme !== 'function') {
      if (generation === workerGeneration) loadedThemeKeyByName.set(name, key)
      return
    }
    const load = Promise.resolve(highlighter.loadTheme(registration as ThemeRegistrationAny))
      .then(() => {
        if (generation === workerGeneration) loadedThemeKeyByName.set(name, key)
      })
      .finally(() => {
        if (pendingThemeLoadsByName.get(name) === load) pendingThemeLoadsByName.delete(name)
      })
    pendingThemeLoadsByName.set(name, load)
    await load
    return
  }
}

/**
 * Loads explicitly requested preload grammars cooperatively in dependency-safe groups
 * (dependencies before dependents; mutual cycles atomic), yielding via MessageChannel between
 * groups so urgent open/edit requests preempt warming and never observe half-loaded dependencies.
 */
const scheduleCooperativeLanguagePreload = (
  highlighter: HighlighterGeneric<string, string>,
  registrations: readonly ShikiWorkerLanguageRegistration[],
): void => {
  const alreadyAvailable = new Set(highlighter.getLoadedLanguages())
  for (const name of scheduledPreloadLanguages) alreadyAvailable.add(name)
  const groups = planCooperativeLanguageGroups(registrations, alreadyAvailable)
  if (groups.length === 0) return

  for (const group of groups) {
    for (const registration of group) {
      scheduledPreloadLanguages.add(registration.name)
      for (const alias of registration.aliases ?? []) scheduledPreloadLanguages.add(alias)
    }
    preloadLanguageQueue.push({ highlighter, group })
  }

  if (preloadRunner) return
  const generation = workerGeneration
  const runner = (async () => {
    try {
      while (preloadLanguageQueue.length > 0) {
        await yieldWorkerMacrotask()
        if (generation !== workerGeneration) return
        const next = preloadLanguageQueue.shift()
        if (!next) return
        try {
          await ensureLanguages(next.highlighter, next.group)
        } catch {
          // Failed background warming never fails paint; opening a document retries on demand.
        }
      }
    } finally {
      if (generation === workerGeneration) preloadRunner = null
    }
  })()
  preloadRunner = runner
  trackWorkerTask(runner)
}

const ensureSharedHighlighter = async (
  languages: readonly ShikiWorkerLanguageRegistration[],
  themes: readonly ShikiWorkerThemeRegistration[],
): Promise<HighlighterGeneric<string, string>> => {
  const uniqueThemes = uniqueThemesByName(themes)
  if (!sharedHighlighterPromise) {
    const uniqueLanguages = uniqueLanguageRegistrations(languages)
    const initialThemeEntries = uniqueThemes.map(
      (theme) => [theme.name, themeRegistrationKey(theme)] as const,
    )
    const generation = workerGeneration
    const created = (
      createHighlighterCore({
        engine: createOnigurumaEngine(wasm),
        langs: uniqueLanguages as unknown as LanguageRegistration[],
        themes: uniqueThemes as unknown as ThemeRegistrationAny[],
      }) as Promise<HighlighterGeneric<string, string>>
    ).then(
      (highlighter) => {
        if (generation === workerGeneration) {
          for (const [name, key] of initialThemeEntries) loadedThemeKeyByName.set(name, key)
        }
        return highlighter
      },
      (error: unknown) => {
        if (sharedHighlighterPromise === created) sharedHighlighterPromise = null
        throw error
      },
    )
    sharedHighlighterPromise = created
  }

  const highlighter = await sharedHighlighterPromise
  await ensureThemes(highlighter, uniqueThemes)
  return highlighter
}

const loadTheme = async (payload: ShikiWorkerThemeRequest): Promise<ShikiWorkerTransportResult> => {
  const themes = uniqueThemeRegistrations(
    [payload.themeRegistration].concat(payload.themeRegistrations),
  )
  const highlighter = await ensureSharedHighlighter([], themes)
  return {
    theme: editorThemeFromHighlighter(highlighter, payload.theme, payload.themeRegistration),
  }
}

const preloadRegistrations = async (payload: ShikiWorkerPreloadRequest): Promise<undefined> => {
  const themes = uniqueThemeRegistrations(payload.themeRegistrations)
  const highlighter = await ensureSharedHighlighter([], themes)
  scheduleCooperativeLanguagePreload(
    highlighter,
    uniqueLanguageRegistrations(payload.languageRegistrations),
  )
  return undefined
}

const resultFromState = (state: DocumentState): ShikiWorkerTransportResult => ({
  documentId: state.documentId,
  tokensPacked: packTokenLines(state.tokenizer.getLineSnapshots(), 0),
  untokenizedLines: state.tokenizer.untokenizedLineCount(),
  theme: editorThemeFromHighlighter(state.highlighter, state.theme, state.themeRegistration),
})

const documentMatches = (state: DocumentState, payload: ShikiWorkerEditRequest): boolean =>
  state.lang === payload.lang && state.theme === payload.theme

const disposeDocument = (runtimeSessionId: string): void => {
  markRuntimeSessionDisposed(runtimeSessionId)
  documents.get(runtimeSessionId)?.source.dispose()
  documents.delete(runtimeSessionId)
}

const markRuntimeSessionDisposed = (runtimeSessionId: string): void => {
  disposedRuntimeSessions.add(runtimeSessionId)
  if (disposedRuntimeSessions.size <= MAX_DISPOSED_RUNTIME_SESSIONS) return

  const oldest = disposedRuntimeSessions.values().next().value
  if (oldest) disposedRuntimeSessions.delete(oldest)
}

const disposeAll = (): void => {
  workerGeneration += 1
  closeYieldChannel()
  for (const state of documents.values()) state.source.dispose()
  documents.clear()
  sourceReader.dispose()
  documentTasks.clear()
  activeWorkerTasks.clear()
  disposedRuntimeSessions.clear()
  loadedThemeKeyByName.clear()
  pendingThemeLoadsByName.clear()
  pendingLanguageLoads.clear()
  scheduledPreloadLanguages.clear()
  preloadLanguageQueue.length = 0
  preloadRunner = null
  const promise = sharedHighlighterPromise
  sharedHighlighterPromise = null
  if (promise) {
    void promise.then((highlighter) => highlighter.dispose()).catch(() => undefined)
  }
}

const yieldWorkerMacrotask = (): Promise<void> => {
  if (typeof MessageChannel !== 'function') return Promise.resolve()
  if (!yieldChannel) {
    yieldChannel = new MessageChannel()
    yieldChannel.port1.onmessage = () => {
      const next = pendingYieldResolvers.shift()
      next?.()
    }
  }
  return new Promise<void>((resolve) => {
    pendingYieldResolvers.push(resolve)
    yieldChannel!.port2.postMessage(undefined)
  })
}

const closeYieldChannel = (): void => {
  if (yieldChannel) {
    yieldChannel.port1.onmessage = null
    yieldChannel.port1.close()
    yieldChannel.port2.close()
    yieldChannel = null
  }
  if (pendingYieldResolvers.length > 0) {
    const resolvers = pendingYieldResolvers
    pendingYieldResolvers = []
    for (const resolve of resolvers) resolve()
  }
}

const postResponse = (response: ShikiWorkerResponse): void => {
  const transfers = responseTransfers(response)
  const workerScope = self as unknown as {
    postMessage(response: ShikiWorkerResponse, transfer?: Transferable[]): void
  }
  if (transfers.length === 0) {
    workerScope.postMessage(response)
    return
  }
  workerScope.postMessage(response, transfers)
}

function responseTransfers(response: ShikiWorkerResponse): Transferable[] {
  if (!response.ok || !response.result) return []
  const result = response.result
  const transfers = result.tokensPacked ? packedEditorTokenTransfers(result.tokensPacked) : []
  for (const patch of result.patchesPacked ?? []) {
    transfers.push(...packedEditorTokenTransfers(patch.tokensPacked))
  }
  return transfers
}

const themeRegistrationKey = (theme: ShikiWorkerThemeRegistration): string => JSON.stringify(theme)

const languageRegistrationKey = (registration: ShikiWorkerLanguageRegistration): string =>
  `${registration.name}\u0000${registration.scopeName}`

const uniqueLanguageRegistrations = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
): ShikiWorkerLanguageRegistration[] => uniqueBy(registrations, languageRegistrationKey)

const uniqueThemeRegistrations = (
  registrations: readonly ShikiWorkerThemeRegistration[],
): ShikiWorkerThemeRegistration[] => uniqueBy(registrations, themeRegistrationKey)

/** First registration per theme name wins so the active document's own theme takes precedence. */
const uniqueThemesByName = (
  registrations: readonly ShikiWorkerThemeRegistration[],
): ShikiWorkerThemeRegistration[] => uniqueBy(registrations, (theme) => theme.name)

/**
 * Orders unloaded preload grammars into strongly connected dependency groups (dependencies before
 * dependents) and skips grammars whose embedded dependencies are absent from both the highlighter
 * and the preload batch so partial loads never poison Shiki's shared language graph.
 */
const planCooperativeLanguageGroups = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
  loaded: ReadonlySet<string>,
): readonly (readonly ShikiWorkerLanguageRegistration[])[] => {
  const byName = new Map<string, ShikiWorkerLanguageRegistration>()
  const unloaded: ShikiWorkerLanguageRegistration[] = []
  for (const registration of registrations) {
    byName.set(registration.name, registration)
    for (const alias of registration.aliases ?? []) {
      if (!byName.has(alias)) byName.set(alias, registration)
    }
    if (!loaded.has(registration.name)) unloaded.push(registration)
  }
  if (unloaded.length === 0) return []

  const embeddedNames = (registration: ShikiWorkerLanguageRegistration): readonly string[] =>
    registration.embeddedLanguages ?? registration.embeddedLangs ?? []

  // Determine which registrations have all transitive embedded dependencies satisfiable.
  const satisfiable = new Map<ShikiWorkerLanguageRegistration, boolean>()
  const checking = new Set<ShikiWorkerLanguageRegistration>()
  const isSatisfiable = (registration: ShikiWorkerLanguageRegistration): boolean => {
    const cached = satisfiable.get(registration)
    if (cached !== undefined) return cached
    if (checking.has(registration)) return true
    checking.add(registration)
    let ok = true
    for (const depName of embeddedNames(registration)) {
      if (loaded.has(depName)) continue
      const dep = byName.get(depName)
      if (!dep || !isSatisfiable(dep)) {
        ok = false
        break
      }
    }
    checking.delete(registration)
    satisfiable.set(registration, ok)
    return ok
  }

  const eligible = unloaded.filter(isSatisfiable)
  if (eligible.length === 0) return []
  const eligibleSet = new Set(eligible)

  // Tarjan's SCC outputs components in reverse topological order (dependencies first).
  let nextIndex = 0
  const indices = new Map<ShikiWorkerLanguageRegistration, number>()
  const lowlink = new Map<ShikiWorkerLanguageRegistration, number>()
  const onStack = new Set<ShikiWorkerLanguageRegistration>()
  const stack: ShikiWorkerLanguageRegistration[] = []
  const groups: ShikiWorkerLanguageRegistration[][] = []

  const strongConnect = (node: ShikiWorkerLanguageRegistration): void => {
    const nodeIndex = nextIndex++
    indices.set(node, nodeIndex)
    lowlink.set(node, nodeIndex)
    stack.push(node)
    onStack.add(node)

    for (const depName of embeddedNames(node)) {
      if (loaded.has(depName)) continue
      const dep = byName.get(depName)
      if (!dep || dep === node || !eligibleSet.has(dep)) continue
      if (!indices.has(dep)) {
        strongConnect(dep)
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(dep)!))
      } else if (onStack.has(dep)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(dep)!))
      }
    }

    if (lowlink.get(node) === nodeIndex) {
      const component: ShikiWorkerLanguageRegistration[] = []
      while (stack.length > 0) {
        const member = stack.pop()!
        onStack.delete(member)
        component.push(member)
        if (member === node) break
      }
      groups.push(component)
    }
  }

  for (const registration of eligible) {
    if (!indices.has(registration)) strongConnect(registration)
  }

  return groups
}

const uniqueBy = <T>(items: readonly T[], keyFor: (item: T) => string): T[] => {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    const key = keyFor(item)
    if (seen.has(key)) continue

    seen.add(key)
    unique.push(item)
  }
  return unique
}

const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

function editorThemeFromHighlighter(
  highlighter: HighlighterGeneric<string, string>,
  themeName: string,
  registration: ShikiWorkerThemeRegistration,
): EditorTheme | undefined {
  const getTheme = (highlighter as Partial<Pick<HighlighterGeneric<string, string>, 'getTheme'>>)
    .getTheme
  if (getTheme) {
    const theme = getTheme.call(highlighter, themeName) as ShikiThemeLike | undefined
    if (theme) return editorThemeFromShikiTheme(theme)
  }

  if (registration.name === themeName) {
    return editorThemeFromShikiTheme(registration)
  }
  return undefined
}

function assertSource(source: DocumentWorkerRead): void {
  if (!source.isValid()) throw new DOMException('Document source scope was released', 'AbortError')
}
