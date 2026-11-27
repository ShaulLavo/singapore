import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import {
  createShikiPrimitiveAsync,
  type LanguageRegistration,
  type ShikiPrimitive,
  type ThemeRegistrationAny,
} from 'shiki/core'
import { instantiateOnigWasmModule, loadOnigWasmModule } from './onigWasm'
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
  readonly internalLang: string
  theme: string
  internalTheme: string
  themeRegistration: ShikiWorkerThemeRegistration
  readonly highlighter: ShikiPrimitive<string, string>
  readonly tokenizer: CreateIncrementalTokenizerResult['tokenizer']
  source: DocumentWorkerRead
}

const sourceReader = new DocumentWorkerReader()
const documents = new Map<string, DocumentState>()
const documentTasks = new Map<string, Promise<ShikiWorkerTransportResult | undefined>>()
const disposedRuntimeSessions = new Set<string>()
const activeWorkerTasks = new Set<Promise<void>>()
let sharedHighlighterPromise: Promise<ShikiPrimitive<string, string>> | null = null
const themeKeyCache = new WeakMap<ShikiWorkerThemeRegistration, string>()
const languageKeyCache = new WeakMap<ShikiWorkerLanguageRegistration, string>()
const internalThemeNameByKey = new Map<string, string>()
const themeKeyByInternalName = new Map<string, string>()
const loadedInternalThemes = new Set<string>()
const pendingThemeLoadsByInternalName = new Map<string, Promise<void>>()
const internalLangNameByKey = new Map<string, string>()
const internalScopeNameByKey = new Map<string, string>()
const langKeyByInternalName = new Map<string, string>()
const langKeyByScopeName = new Map<string, string>()
const claimedLangNamesAndAliases = new Set<string>()
const canonicalNameByAlias = new Map<string, string>()
const pendingLanguageLoads = new Map<string, Promise<void>>()
const scheduledPreloadLanguages = new Set<string>()
const preloadLanguageQueue: {
  readonly highlighter: ShikiPrimitive<string, string>
  readonly group: readonly ShikiWorkerLanguageRegistration[]
}[] = []
let preloadRunner: Promise<void> | null = null
let workerGeneration = 0
let nextInternalThemeVariant = 1
let nextInternalLangVariant = 1
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
  const highlighters = new Set<ShikiPrimitive<string, string>>()
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

  const { highlighter, internalLang, internalTheme } = await ensureHighlighter(payload)
  assertSource(source)
  const { tokenizer } = await createIncrementalTokenizer({
    lang: internalLang,
    theme: internalTheme,
    source: source.text,
    highlighter,
    maxLineLength: payload.maxLineLength,
  })

  assertSource(source)
  const retained = source.retain()
  if (!retained) throw new DOMException('Document source scope was released', 'AbortError')
  const state: DocumentState = {
    source: retained,
    documentId: payload.documentId,
    runtimeSessionId: payload.runtimeSessionId,
    lang: payload.lang,
    internalLang,
    theme: payload.theme,
    internalTheme,
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
      existing.internalTheme,
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

  const resolvedTheme = resolveThemeRegistration(payload.themeRegistration)
  await ensureThemes(state.highlighter, [resolvedTheme.registration])
  const internalTheme =
    payload.theme === payload.themeRegistration.name ? resolvedTheme.internalName : payload.theme
  state.tokenizer.setTheme(internalTheme)
  state.theme = payload.theme
  state.internalTheme = internalTheme
  state.themeRegistration = payload.themeRegistration
  return resultFromState(state)
}

type ResolvedHighlighterDocument = {
  readonly highlighter: ShikiPrimitive<string, string>
  readonly internalLang: string
  readonly internalTheme: string
}

/**
 * The worker keeps one shared Oniguruma highlighter and loads themes and grammars incrementally
 * on demand so theme-array permutations never duplicate WASM engines.
 */
const ensureHighlighter = async (
  options: ShikiWorkerDocumentOptions,
): Promise<ResolvedHighlighterDocument> => {
  const resolvedLanguages = resolveLanguageBatch(options.languageRegistrations)
  const uniqueThemes = uniqueThemeRegistrations(
    [options.themeRegistration].concat(options.themeRegistrations),
  )
  const resolvedThemes = uniqueThemes.map(resolveThemeRegistration)
  const highlighter = await ensureSharedHighlighter(
    resolvedLanguages.registrations,
    resolvedThemes.map((entry) => entry.registration),
  )
  await ensureLanguages(highlighter, resolvedLanguages.registrations)

  const internalLang = resolvedLanguages.nameMap.get(options.lang) ?? options.lang
  const internalTheme = resolveRequestedInternalTheme(
    options.theme,
    options.themeRegistration,
    uniqueThemes,
    resolvedThemes,
  )

  return { highlighter, internalLang, internalTheme }
}

const canonicalLoadedLanguages = (highlighter: ShikiPrimitive<string, string>): Set<string> => {
  const canonical = new Set<string>()
  for (const name of highlighter.getLoadedLanguages()) {
    if (!canonicalNameByAlias.has(name)) canonical.add(name)
  }
  return canonical
}

const recordLoadedLanguages = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
  generation: number,
): void => {
  if (generation !== workerGeneration) return
  for (const registration of registrations) {
    for (const alias of registration.aliases ?? []) {
      if (alias !== registration.name) canonicalNameByAlias.set(alias, registration.name)
    }
  }
}

const assertEmbeddedDependenciesSatisfiable = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
  canonicalLoaded: ReadonlySet<string>,
): void => {
  const batchCanonicalNames = new Set(registrations.map((registration) => registration.name))
  const missingDeps: string[] = []
  const missingDepSet = new Set<string>()
  const dependents: string[] = []
  const dependentSet = new Set<string>()

  for (const registration of registrations) {
    for (const depName of embeddedLanguageNames(registration)) {
      if (canonicalLoaded.has(depName) || batchCanonicalNames.has(depName)) continue
      if (!missingDepSet.has(depName)) {
        missingDepSet.add(depName)
        missingDeps.push(depName)
      }
      if (!dependentSet.has(registration.name)) {
        dependentSet.add(registration.name)
        dependents.push(registration.name)
      }
    }
  }

  if (missingDeps.length > 0) {
    throw new Error(
      `Missing languages ${missingDeps.join(', ')}, required by ${dependents.join(', ')}`,
    )
  }
}

const ensureLanguages = async (
  highlighter: ShikiPrimitive<string, string>,
  registrations: readonly ShikiWorkerLanguageRegistration[],
): Promise<void> => {
  const unique = uniqueBy(registrations, (registration) => registration.name)

  while (true) {
    const loaded = canonicalLoadedLanguages(highlighter)
    const toWait: Promise<void>[] = []
    const missing: ShikiWorkerLanguageRegistration[] = []

    for (const registration of unique) {
      if (loaded.has(registration.name)) continue
      const pending = pendingLanguageLoads.get(registration.name)
      if (pending) {
        toWait.push(pending)
        continue
      }
      missing.push(registration)
    }

    if (toWait.length > 0) {
      await Promise.all(toWait)
      if (missing.length === 0) return
      continue
    }

    if (missing.length === 0) return

    assertEmbeddedDependenciesSatisfiable(missing, loaded)

    const generation = workerGeneration
    const names = missing.map((registration) => registration.name)
    const load = Promise.resolve(
      highlighter.loadLanguage(...(missing as unknown as LanguageRegistration[])),
    )
      .then(() => {
        recordLoadedLanguages(missing, generation)
      })
      .finally(() => {
        for (const name of names) {
          if (pendingLanguageLoads.get(name) === load) pendingLanguageLoads.delete(name)
        }
      })
    for (const name of names) pendingLanguageLoads.set(name, load)
    await load
    return
  }
}

const ensureThemes = async (
  highlighter: ShikiPrimitive<string, string>,
  registrations: readonly ShikiWorkerThemeRegistration[],
): Promise<void> => {
  const unique = uniqueBy(registrations, (theme) => theme.name)
  if (unique.length === 0) return

  await Promise.all(
    unique.map((registration) => ensureThemeByInternalName(highlighter, registration)),
  )
}

const ensureThemeByInternalName = async (
  highlighter: ShikiPrimitive<string, string>,
  registration: ShikiWorkerThemeRegistration,
): Promise<void> => {
  const name = registration.name
  if (loadedInternalThemes.has(name)) return

  const pending = pendingThemeLoadsByInternalName.get(name)
  if (pending) {
    await pending
    return
  }

  const generation = workerGeneration
  if (typeof highlighter.loadTheme !== 'function') {
    if (generation === workerGeneration) loadedInternalThemes.add(name)
    return
  }
  const load = Promise.resolve(highlighter.loadTheme(registration as ThemeRegistrationAny))
    .then(() => {
      if (generation === workerGeneration) loadedInternalThemes.add(name)
    })
    .finally(() => {
      if (pendingThemeLoadsByInternalName.get(name) === load)
        pendingThemeLoadsByInternalName.delete(name)
    })
  pendingThemeLoadsByInternalName.set(name, load)
  await load
}

/**
 * Loads explicitly requested preload grammars cooperatively in dependency-safe groups
 * (dependencies before dependents; mutual cycles atomic), yielding via MessageChannel between
 * groups so urgent open/edit requests preempt warming and never observe half-loaded dependencies.
 */
const scheduleCooperativeLanguagePreload = (
  highlighter: ShikiPrimitive<string, string>,
  registrations: readonly ShikiWorkerLanguageRegistration[],
): void => {
  const alreadyAvailable = canonicalLoadedLanguages(highlighter)
  for (const name of scheduledPreloadLanguages) alreadyAvailable.add(name)
  const groups = planCooperativeLanguageGroups(registrations, alreadyAvailable)
  if (groups.length === 0) return

  const acceptedFlat = groups.flat()
  const resolvedBatch = resolveLanguageBatch(acceptedFlat)
  const resolvedByKey = new Map<string, ShikiWorkerLanguageRegistration>()
  for (let index = 0; index < acceptedFlat.length; index += 1) {
    const resolved = resolvedBatch.registrations[index]
    if (resolved) resolvedByKey.set(languageRegistrationKey(acceptedFlat[index]!), resolved)
  }

  for (const group of groups) {
    const resolvedGroup = group.map(
      (registration) => resolvedByKey.get(languageRegistrationKey(registration)) ?? registration,
    )
    for (const registration of resolvedGroup) {
      scheduledPreloadLanguages.add(registration.name)
    }
    preloadLanguageQueue.push({ highlighter, group: resolvedGroup })
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
        const loadedNow = canonicalLoadedLanguages(next.highlighter)
        const groupCanonicalNames = new Set(next.group.map((registration) => registration.name))
        const canLoad = next.group.every((registration) =>
          embeddedLanguageNames(registration).every(
            (depName) => loadedNow.has(depName) || groupCanonicalNames.has(depName),
          ),
        )
        if (!canLoad) {
          for (const name of groupCanonicalNames) scheduledPreloadLanguages.delete(name)
          continue
        }
        try {
          await ensureLanguages(next.highlighter, next.group)
        } catch {
          for (const name of groupCanonicalNames) scheduledPreloadLanguages.delete(name)
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
): Promise<ShikiPrimitive<string, string>> => {
  const uniqueThemes = uniqueBy(themes, (theme) => theme.name)
  if (!sharedHighlighterPromise) {
    const uniqueLanguages = uniqueBy(languages, (registration) => registration.name)
    assertEmbeddedDependenciesSatisfiable(uniqueLanguages, new Set())
    const initialThemeNames = uniqueThemes.map((theme) => theme.name)
    const generation = workerGeneration
    const created = (
      createShikiPrimitiveAsync({
        engine: loadOnigWasmModule().then((module) =>
          createOnigurumaEngine(instantiateOnigWasmModule(module)),
        ),
        langs: uniqueLanguages as unknown as LanguageRegistration[],
        themes: uniqueThemes as unknown as ThemeRegistrationAny[],
      }) as Promise<ShikiPrimitive<string, string>>
    ).then(
      (highlighter) => {
        if (generation === workerGeneration) {
          for (const name of initialThemeNames) loadedInternalThemes.add(name)
          recordLoadedLanguages(uniqueLanguages, generation)
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
  const uniqueThemes = uniqueThemeRegistrations(
    [payload.themeRegistration].concat(payload.themeRegistrations),
  )
  const resolvedThemes = uniqueThemes.map(resolveThemeRegistration)
  const highlighter = await ensureSharedHighlighter(
    [],
    resolvedThemes.map((entry) => entry.registration),
  )
  const internalTheme = resolveRequestedInternalTheme(
    payload.theme,
    payload.themeRegistration,
    uniqueThemes,
    resolvedThemes,
  )
  return {
    theme: editorThemeFromHighlighter(
      highlighter,
      internalTheme,
      payload.theme,
      payload.themeRegistration,
    ),
  }
}

const preloadRegistrations = async (payload: ShikiWorkerPreloadRequest): Promise<undefined> => {
  const resolvedThemes = uniqueThemeRegistrations(payload.themeRegistrations).map(
    resolveThemeRegistration,
  )
  const highlighter = await ensureSharedHighlighter(
    [],
    resolvedThemes.map((entry) => entry.registration),
  )
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
  theme: editorThemeFromHighlighter(
    state.highlighter,
    state.internalTheme,
    state.theme,
    state.themeRegistration,
  ),
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
  nextInternalThemeVariant = 1
  nextInternalLangVariant = 1
  closeYieldChannel()
  for (const state of documents.values()) state.source.dispose()
  documents.clear()
  sourceReader.dispose()
  documentTasks.clear()
  activeWorkerTasks.clear()
  disposedRuntimeSessions.clear()
  internalThemeNameByKey.clear()
  themeKeyByInternalName.clear()
  loadedInternalThemes.clear()
  pendingThemeLoadsByInternalName.clear()
  internalLangNameByKey.clear()
  internalScopeNameByKey.clear()
  langKeyByInternalName.clear()
  langKeyByScopeName.clear()
  claimedLangNamesAndAliases.clear()
  canonicalNameByAlias.clear()
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

const themeRegistrationKey = (theme: ShikiWorkerThemeRegistration): string => {
  const cached = themeKeyCache.get(theme)
  if (cached !== undefined) return cached
  const key = JSON.stringify(theme)
  themeKeyCache.set(theme, key)
  return key
}

const languageRegistrationKey = (registration: ShikiWorkerLanguageRegistration): string => {
  const cached = languageKeyCache.get(registration)
  if (cached !== undefined) return cached
  const key = JSON.stringify(registration)
  languageKeyCache.set(registration, key)
  return key
}

const embeddedLanguageNames = (registration: ShikiWorkerLanguageRegistration): readonly string[] =>
  registration.embeddedLanguages ?? registration.embeddedLangs ?? []

const uniqueLanguageRegistrations = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
): ShikiWorkerLanguageRegistration[] => uniqueBy(registrations, languageRegistrationKey)

const uniqueThemeRegistrations = (
  registrations: readonly ShikiWorkerThemeRegistration[],
): ShikiWorkerThemeRegistration[] => uniqueBy(registrations, themeRegistrationKey)

type ResolvedThemeEntry = {
  readonly internalName: string
  readonly registration: ShikiWorkerThemeRegistration
}

/**
 * Maps each distinct theme registration to a stable internal name inside the single shared
 * highlighter so custom themes that share a public name coexist without overwriting each other.
 */
const resolveThemeRegistration = (
  registration: ShikiWorkerThemeRegistration,
): ResolvedThemeEntry => {
  const key = themeRegistrationKey(registration)
  const existingName = internalThemeNameByKey.get(key)
  if (existingName !== undefined) {
    return {
      internalName: existingName,
      registration:
        existingName === registration.name ? registration : { ...registration, name: existingName },
    }
  }

  let internalName = registration.name
  const existingKeyForName = themeKeyByInternalName.get(internalName)
  if (existingKeyForName !== undefined && existingKeyForName !== key) {
    do {
      nextInternalThemeVariant += 1
      internalName = `${registration.name}#${nextInternalThemeVariant}`
    } while (themeKeyByInternalName.has(internalName))
  }

  internalThemeNameByKey.set(key, internalName)
  themeKeyByInternalName.set(internalName, key)
  return {
    internalName,
    registration:
      internalName === registration.name ? registration : { ...registration, name: internalName },
  }
}

const resolveRequestedInternalTheme = (
  requestedTheme: string,
  primaryRegistration: ShikiWorkerThemeRegistration,
  uniqueThemes: readonly ShikiWorkerThemeRegistration[],
  resolvedThemes: readonly ResolvedThemeEntry[],
): string => {
  if (requestedTheme === primaryRegistration.name) {
    return resolvedThemes[0]?.internalName ?? requestedTheme
  }
  const index = uniqueThemes.findIndex((theme) => theme.name === requestedTheme)
  return index >= 0 ? (resolvedThemes[index]?.internalName ?? requestedTheme) : requestedTheme
}

type ResolvedLanguageBatch = {
  readonly registrations: readonly ShikiWorkerLanguageRegistration[]
  readonly nameMap: ReadonlyMap<string, string>
}

/**
 * Maps each distinct grammar registration to a unique internal name (and scopeName when two
 * distinct grammars also share a scopeName) inside the single shared highlighter so custom
 * grammars that share a public name or embedded scope never shadow each other across documents.
 *
 * Dependencies are resolved before dependents so parent grammars rewrite their `embeddedLangs`
 * and TextMate `include`/`injectTo` scope references onto the batch's resolved variants and fold
 * those resolved dependencies into their own cache key.
 */
const resolveLanguageBatch = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
): ResolvedLanguageBatch => {
  const unique = uniqueLanguageRegistrations(registrations)
  if (unique.length === 0) return { registrations: [], nameMap: new Map() }

  const order = dependencyFirstIndices(unique)
  const originalCandidates = unique.slice()

  let batchNameToInternal = new Map<string, string>()
  let batchScopeToInternal = new Map<string, string>()
  let assigned: {
    readonly original: ShikiWorkerLanguageRegistration
    readonly candidate: ShikiWorkerLanguageRegistration
    readonly key: string
    readonly internalName: string
    readonly internalScopeName: string
  }[] = []
  let tentativeNameByKey = new Map<string, string>()
  let tentativeScopeByKey = new Map<string, string>()
  let tentativeKeyByName = new Map<string, string>()
  let tentativeKeyByScope = new Map<string, string>()
  let tentativeClaimed = new Set<string>()
  let nextVariantPreview = nextInternalLangVariant

  // Run at most `unique.length + 1` fixpoint passes (1 pass for acyclic batches; 2 passes for
  // mutually cyclic colliding batches) without mutating global maps until convergence.
  const maxPasses = Math.max(2, unique.length + 1)
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const prevNameMap = batchNameToInternal
    const prevScopeMap = batchScopeToInternal
    batchNameToInternal = new Map<string, string>()
    batchScopeToInternal = new Map<string, string>()
    tentativeNameByKey = new Map<string, string>()
    tentativeScopeByKey = new Map<string, string>()
    tentativeKeyByName = new Map<string, string>()
    tentativeKeyByScope = new Map<string, string>()
    tentativeClaimed = new Set<string>()
    nextVariantPreview = nextInternalLangVariant
    assigned = new Array(unique.length)

    let changed = false
    const activeNameMap = (name: string): string | undefined =>
      batchNameToInternal.get(name) ?? prevNameMap.get(name) ?? canonicalNameByAlias.get(name)
    const activeScopeRenames = (): Map<string, string> => {
      const merged = new Map<string, string>()
      for (const [scope, target] of prevScopeMap) {
        if (scope !== target) merged.set(scope, target)
      }
      for (const [scope, target] of batchScopeToInternal) {
        if (scope !== target) merged.set(scope, target)
        else merged.delete(scope)
      }
      return merged
    }

    for (const index of order) {
      const original = originalCandidates[index]!
      const scopeRenames = activeScopeRenames()
      const candidate = rewriteGrammarDependencies(original, activeNameMap, scopeRenames)
      const key = languageRegistrationKey(candidate)

      let internalName = internalLangNameByKey.get(key) ?? tentativeNameByKey.get(key)
      let internalScopeName = internalScopeNameByKey.get(key) ?? tentativeScopeByKey.get(key)

      if (internalName === undefined || internalScopeName === undefined) {
        if (
          !claimedLangNamesAndAliases.has(original.name) &&
          !tentativeClaimed.has(original.name)
        ) {
          internalName = original.name
        } else {
          do {
            nextVariantPreview += 1
            internalName = `${original.name}#${nextVariantPreview}`
          } while (
            claimedLangNamesAndAliases.has(internalName) ||
            tentativeClaimed.has(internalName)
          )
        }

        const existingScopeOwner =
          langKeyByScopeName.get(original.scopeName) ?? tentativeKeyByScope.get(original.scopeName)
        if (existingScopeOwner === undefined || existingScopeOwner === key) {
          internalScopeName = original.scopeName
        } else {
          do {
            nextVariantPreview += 1
            internalScopeName = `${original.scopeName}.shiki-variant-${nextVariantPreview}`
          } while (
            langKeyByScopeName.has(internalScopeName) ||
            tentativeKeyByScope.has(internalScopeName)
          )
        }

        tentativeNameByKey.set(key, internalName)
        tentativeScopeByKey.set(key, internalScopeName)
        tentativeKeyByName.set(internalName, key)
        tentativeKeyByScope.set(internalScopeName, key)
        tentativeClaimed.add(internalName)
      }

      if (prevNameMap.get(original.name) !== internalName) changed = true
      if (prevScopeMap.get(original.scopeName) !== internalScopeName) changed = true

      batchNameToInternal.set(original.name, internalName)
      for (const alias of original.aliases ?? []) {
        if (!batchNameToInternal.has(alias)) batchNameToInternal.set(alias, internalName)
      }
      batchScopeToInternal.set(original.scopeName, internalScopeName)
      assigned[index] = { original, candidate, key, internalName, internalScopeName }
    }

    if (!changed) break
  }

  nextInternalLangVariant = nextVariantPreview
  for (const [key, internalName] of tentativeNameByKey) {
    internalLangNameByKey.set(key, internalName)
  }
  for (const [key, internalScopeName] of tentativeScopeByKey) {
    internalScopeNameByKey.set(key, internalScopeName)
  }
  for (const [internalName, key] of tentativeKeyByName) {
    langKeyByInternalName.set(internalName, key)
  }
  for (const [internalScopeName, key] of tentativeKeyByScope) {
    langKeyByScopeName.set(internalScopeName, key)
  }
  for (const name of tentativeClaimed) claimedLangNamesAndAliases.add(name)

  const finalScopeRenames = new Map<string, string>()
  for (const [scope, target] of batchScopeToInternal) {
    if (scope !== target) finalScopeRenames.set(scope, target)
  }
  const finalNameLookup = (name: string): string | undefined =>
    batchNameToInternal.get(name) ?? canonicalNameByAlias.get(name)

  const resolvedRegistrations = assigned.map(
    ({ original, key, internalName, internalScopeName }) => {
      const rewritten = rewriteGrammarDependencies(original, finalNameLookup, finalScopeRenames)
      let aliasesChanged = false
      let nextAliases: readonly string[] | undefined = rewritten.aliases
      if (rewritten.aliases && rewritten.aliases.length > 0) {
        if (internalName !== original.name) {
          aliasesChanged = true
          nextAliases = undefined
        } else {
          const kept: string[] = []
          for (const alias of rewritten.aliases) {
            const owner = langKeyByInternalName.get(alias)
            if (owner !== undefined && owner !== key) {
              aliasesChanged = true
              continue
            }
            langKeyByInternalName.set(alias, key)
            claimedLangNamesAndAliases.add(alias)
            kept.push(alias)
          }
          if (aliasesChanged) nextAliases = kept.length > 0 ? kept : undefined
        }
      }

      if (
        rewritten === original &&
        internalName === original.name &&
        internalScopeName === original.scopeName &&
        !aliasesChanged
      ) {
        return original
      }

      const updated: Record<string, unknown> = {
        ...rewritten,
        name: internalName,
        scopeName: internalScopeName,
      }
      if (aliasesChanged) {
        if (nextAliases) updated.aliases = nextAliases
        else delete updated.aliases
      }
      return updated as ShikiWorkerLanguageRegistration
    },
  )

  return { registrations: resolvedRegistrations, nameMap: batchNameToInternal }
}

const dependencyFirstIndices = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
): number[] => {
  const indexByName = new Map<string, number>()
  const indexByScope = new Map<string, number>()
  for (let index = 0; index < registrations.length; index += 1) {
    const registration = registrations[index]!
    indexByName.set(registration.name, index)
    for (const alias of registration.aliases ?? []) {
      if (!indexByName.has(alias)) indexByName.set(alias, index)
    }
    if (!indexByScope.has(registration.scopeName)) {
      indexByScope.set(registration.scopeName, index)
    }
  }

  const visited = new Uint8Array(registrations.length)
  const order: number[] = []
  const visit = (index: number): void => {
    if (visited[index]) return
    visited[index] = 1
    const registration = registrations[index]!
    for (const depName of embeddedLanguageNames(registration)) {
      const depIndex = indexByName.get(depName)
      if (depIndex !== undefined && depIndex !== index) visit(depIndex)
    }
    for (const scope of collectIncludedScopes(registration)) {
      const depIndex = indexByScope.get(scope)
      if (depIndex !== undefined && depIndex !== index) visit(depIndex)
    }
    order.push(index)
  }

  for (let index = 0; index < registrations.length; index += 1) visit(index)
  return order
}

const collectIncludedScopes = (registration: ShikiWorkerLanguageRegistration): Set<string> => {
  const scopes = new Set<string>()
  const record = registration as Record<string, unknown>
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const obj = value as Record<string, unknown>
    const include = obj.include
    if (typeof include === 'string' && !include.startsWith('#') && !include.startsWith('$')) {
      const hashIndex = include.indexOf('#')
      scopes.add(hashIndex >= 0 ? include.slice(0, hashIndex) : include)
    }
    for (const key of Object.keys(obj)) {
      if (key === 'include') continue
      walk(obj[key])
    }
  }
  walk(record.patterns)
  walk(record.repository)
  walk(record.injections)
  if (Array.isArray(record.injectTo)) {
    for (const scope of record.injectTo) {
      if (typeof scope === 'string') scopes.add(scope)
    }
  }
  return scopes
}

const rewriteGrammarDependencies = (
  registration: ShikiWorkerLanguageRegistration,
  nameLookup: (name: string) => string | undefined,
  scopeRenames: ReadonlyMap<string, string>,
): ShikiWorkerLanguageRegistration => {
  const embeddedLangs = rewriteEmbeddedNames(registration.embeddedLangs, nameLookup)
  const embeddedLanguages = rewriteEmbeddedNames(registration.embeddedLanguages, nameLookup)
  const record = registration as Record<string, unknown>
  const embeddedLangsLazy = Array.isArray(record.embeddedLangsLazy)
    ? rewriteEmbeddedNames(record.embeddedLangsLazy as readonly string[], nameLookup)
    : record.embeddedLangsLazy

  const hasScopeRenames = scopeRenames.size > 0
  const patterns = hasScopeRenames
    ? rewriteIncludedScopes(record.patterns, scopeRenames)
    : record.patterns
  const repository = hasScopeRenames
    ? rewriteIncludedScopes(record.repository, scopeRenames)
    : record.repository
  const injections = hasScopeRenames
    ? rewriteIncludedScopes(record.injections, scopeRenames)
    : record.injections
  const injectTo =
    hasScopeRenames && Array.isArray(record.injectTo)
      ? rewriteScopeList(record.injectTo as readonly string[], scopeRenames)
      : record.injectTo

  if (
    embeddedLangs === registration.embeddedLangs &&
    embeddedLanguages === registration.embeddedLanguages &&
    embeddedLangsLazy === record.embeddedLangsLazy &&
    patterns === record.patterns &&
    repository === record.repository &&
    injections === record.injections &&
    injectTo === record.injectTo
  ) {
    return registration
  }

  const updated: Record<string, unknown> = { ...registration }
  if (embeddedLangs !== registration.embeddedLangs) updated.embeddedLangs = embeddedLangs
  if (embeddedLanguages !== registration.embeddedLanguages)
    updated.embeddedLanguages = embeddedLanguages
  if (embeddedLangsLazy !== record.embeddedLangsLazy) updated.embeddedLangsLazy = embeddedLangsLazy
  if (patterns !== record.patterns) updated.patterns = patterns
  if (repository !== record.repository) updated.repository = repository
  if (injections !== record.injections) updated.injections = injections
  if (injectTo !== record.injectTo) updated.injectTo = injectTo
  return updated as ShikiWorkerLanguageRegistration
}

const rewriteScopeRef = (value: string, scopeRenames: ReadonlyMap<string, string>): string => {
  if (value.startsWith('#') || value.startsWith('$')) return value
  const hashIndex = value.indexOf('#')
  const baseScope = hashIndex >= 0 ? value.slice(0, hashIndex) : value
  const renamed = scopeRenames.get(baseScope)
  if (!renamed) return value
  return hashIndex >= 0 ? `${renamed}${value.slice(hashIndex)}` : renamed
}

const rewriteScopeList = (
  scopes: readonly string[],
  scopeRenames: ReadonlyMap<string, string>,
): readonly string[] => {
  let changed = false
  const mapped = scopes.map((scope) => {
    const next = scopeRenames.get(scope) ?? scope
    if (next !== scope) changed = true
    return next
  })
  return changed ? mapped : scopes
}

const rewriteIncludedScopes = (
  value: unknown,
  scopeRenames: ReadonlyMap<string, string>,
): unknown => {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let changed = false
    const mapped = value.map((item) => {
      const next = rewriteIncludedScopes(item, scopeRenames)
      if (next !== item) changed = true
      return next
    })
    return changed ? mapped : value
  }
  const obj = value as Record<string, unknown>
  let changed = false
  const nextObj: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    const current = obj[key]
    if (key === 'include' && typeof current === 'string') {
      const next = rewriteScopeRef(current, scopeRenames)
      if (next !== current) changed = true
      nextObj[key] = next
      continue
    }
    const next = rewriteIncludedScopes(current, scopeRenames)
    if (next !== current) changed = true
    nextObj[key] = next
  }
  return changed ? nextObj : value
}

const rewriteEmbeddedNames = (
  names: readonly string[] | undefined,
  nameLookup: (name: string) => string | undefined,
): readonly string[] | undefined => {
  if (!names || names.length === 0) return names
  let changed = false
  const mapped = names.map((name) => {
    const replacement = nameLookup(name)
    if (replacement && replacement !== name) {
      changed = true
      return replacement
    }
    return name
  })
  return changed ? mapped : names
}

/**
 * Orders unloaded preload grammars into strongly connected dependency groups (dependencies before
 * dependents) and rejects any SCC (and its transitive dependents) whose embedded dependencies are
 * absent from both the highlighter and earlier satisfiable SCCs so partial loads never poison
 * Shiki's shared language graph.
 */
const planCooperativeLanguageGroups = (
  registrations: readonly ShikiWorkerLanguageRegistration[],
  loadedCanonical: ReadonlySet<string>,
): readonly (readonly ShikiWorkerLanguageRegistration[])[] => {
  const byName = new Map<string, ShikiWorkerLanguageRegistration>()
  const unloaded: ShikiWorkerLanguageRegistration[] = []
  for (const registration of registrations) {
    byName.set(registration.name, registration)
    for (const alias of registration.aliases ?? []) {
      if (!byName.has(alias)) byName.set(alias, registration)
    }
    const canonicalName = canonicalNameByAlias.get(registration.name) ?? registration.name
    if (!loadedCanonical.has(canonicalName)) unloaded.push(registration)
  }
  if (unloaded.length === 0) return []
  const unloadedSet = new Set(unloaded)

  const canonicalDepName = (depName: string): string =>
    byName.get(depName)?.name ?? canonicalNameByAlias.get(depName) ?? depName

  // Tarjan's SCC outputs components in reverse topological order (dependencies first).
  let nextIndex = 0
  const indices = new Map<ShikiWorkerLanguageRegistration, number>()
  const lowlink = new Map<ShikiWorkerLanguageRegistration, number>()
  const onStack = new Set<ShikiWorkerLanguageRegistration>()
  const stack: ShikiWorkerLanguageRegistration[] = []
  const components: ShikiWorkerLanguageRegistration[][] = []

  const strongConnect = (node: ShikiWorkerLanguageRegistration): void => {
    const nodeIndex = nextIndex++
    indices.set(node, nodeIndex)
    lowlink.set(node, nodeIndex)
    stack.push(node)
    onStack.add(node)

    for (const rawDepName of embeddedLanguageNames(node)) {
      const depName = canonicalDepName(rawDepName)
      if (loadedCanonical.has(depName)) continue
      const dep = byName.get(rawDepName) ?? byName.get(depName)
      if (!dep || dep === node || !unloadedSet.has(dep)) continue
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
      components.push(component)
    }
  }

  for (const registration of unloaded) {
    if (!indices.has(registration)) strongConnect(registration)
  }

  // Evaluate satisfiability per SCC bottom-up using canonical names so a cycle containing any
  // missing dependency rejects the entire SCC and all transitive dependents cleanly.
  const available = new Set<string>(loadedCanonical)
  const groups: ShikiWorkerLanguageRegistration[][] = []
  for (const component of components) {
    const componentCanonicalNames = new Set(component.map((registration) => registration.name))
    const satisfiable = component.every((registration) =>
      embeddedLanguageNames(registration).every((rawDepName) => {
        const depName = canonicalDepName(rawDepName)
        return available.has(depName) || componentCanonicalNames.has(depName)
      }),
    )
    if (!satisfiable) continue
    for (const name of componentCanonicalNames) available.add(name)
    groups.push(component)
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
  highlighter: ShikiPrimitive<string, string>,
  internalThemeName: string,
  publicThemeName: string,
  registration: ShikiWorkerThemeRegistration,
): EditorTheme | undefined {
  const getTheme = (highlighter as Partial<Pick<ShikiPrimitive<string, string>, 'getTheme'>>)
    .getTheme
  if (getTheme) {
    const theme = getTheme.call(highlighter, internalThemeName) as ShikiThemeLike | undefined
    if (theme) return editorThemeFromShikiTheme(theme)
  }

  if (registration.name === publicThemeName) {
    return editorThemeFromShikiTheme(registration)
  }
  return undefined
}

function assertSource(source: DocumentWorkerRead): void {
  if (!source.isValid()) throw new DOMException('Document source scope was released', 'AbortError')
}
