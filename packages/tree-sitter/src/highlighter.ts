import type {
  EditorHighlightResult,
  EditorHighlighterProvider,
  EditorPlugin,
} from '@singapore-editor/core/extensions'
import {
  defineHighlighterOperation,
  waitForDocumentWork,
  type DocumentRead,
  type EditorHighlighterRuntime,
  type HighlighterOperationContext,
} from '@singapore-editor/core/internal/document-worker'
import type { EditorTheme, VscodeThemeRegistration } from '@singapore-editor/core/rendering'
import {
  EditorTokenStore,
  createEditorRuntimeSessionId,
  type EditorSyntaxLanguageId,
} from '@singapore-editor/core/syntax'
import { createTreeSitterInputEdits } from './treeSitter/edits'
import {
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageClosure,
  type TreeSitterLanguageDescriptor,
  type TreeSitterLanguageId,
  type TreeSitterLanguageResolver,
} from './treeSitter/registry'
import {
  createTreeSitterWorkerOwner,
  treeSitterBackendForOwner,
  type TreeSitterWorkerClient,
  type TreeSitterWorkerOwner,
} from './treeSitter/workerClient'

export type TreeSitterHighlightLanguageMap = Partial<Record<EditorSyntaxLanguageId, string>>

export type TreeSitterThemeRegistrationResolver = (
  theme: string,
) => Promise<VscodeThemeRegistration>

export type TreeSitterHighlighterProviderOptions = {
  readonly resolveTheme: TreeSitterThemeRegistrationResolver
  readonly theme?: string | (() => string)
  readonly languages?: TreeSitterHighlightLanguageMap
  readonly languageResolver?: TreeSitterLanguageResolver
  readonly onThemeChanged?: (listener: () => void) => (() => void) | void
  readonly workerOwner?: TreeSitterWorkerOwner
  readonly warmLanguages?: () => readonly TreeSitterLanguageId[]
  readonly maxTokenizationLineLength?: () => number
}

export type TreeSitterHighlighterPluginOptions = TreeSitterHighlighterProviderOptions & {
  readonly name?: string
}

export type ResolvedTreeSitterHighlightLanguage = {
  readonly languageId: TreeSitterLanguageId
  readonly packLanguageId?: string
}

const DEFAULT_THEME = 'github-dark'

const DEFAULT_HIGHLIGHTER_WORKER_OWNER_KEY = Symbol.for(
  '@singapore-editor/tree-sitter/default-highlighter-owner',
)

const DEFAULT_LANGUAGE_MAP: TreeSitterHighlightLanguageMap = {
  css: 'css',
  html: 'html',
  javascriptreact: 'jsx',
  javascript: 'javascript',
  json: 'json',
  tsx: 'tsx',
  typescriptreact: 'tsx',
  typescript: 'typescript',
}

export function createTreeSitterHighlighterPlugin(
  options: TreeSitterHighlighterPluginOptions,
): EditorPlugin {
  return {
    name: options.name ?? 'tree-sitter-highlighter',
    activate(context) {
      return context.registerHighlighter(createTreeSitterHighlighterProvider(options))
    },
  }
}

/**
 * Builds a VS Code-theme highlighter provider backed by the shared Tree-sitter worker and
 * `@shaulavo/tree-sitter-scope-compat` (Wave 1 native packs + universal Zed-plus capture fallback).
 */
export function createTreeSitterHighlighterProvider(
  options: TreeSitterHighlighterProviderOptions,
): EditorHighlighterProvider {
  const owner = options.workerOwner ?? defaultHighlighterWorkerOwner()
  const backend = treeSitterBackendForOwner(owner)
  const themeCache = createThemeResolverCache(options.resolveTheme)
  let warmedKey: string | null = null
  const warm = () => {
    const languageIds = options.warmLanguages?.() ?? []
    const key = languageIds.join('\n')
    if (languageIds.length === 0 || key === warmedKey || !options.languageResolver) return
    warmedKey = key
    void warmHighlightLanguages(options.languageResolver, backend, languageIds)
  }

  return {
    loadTheme: () => loadConfiguredTheme(options, themeCache, backend),
    operation: defineHighlighterOperation((context) =>
      createSession(context, options, themeCache, backend, warm),
    ),
  }
}

export const treeSitterHighlightLanguageForDocument = (
  options: Pick<HighlighterOperationContext, 'documentId' | 'languageId'>,
  languages: TreeSitterHighlightLanguageMap | undefined,
  languageResolver?: TreeSitterLanguageResolver,
): ResolvedTreeSitterHighlightLanguage | null => {
  if (!options.languageId) return null

  const configured = languages?.[options.languageId]
  const raw =
    configured ??
    languageForDocumentExtension(options.documentId, options.languageId) ??
    DEFAULT_LANGUAGE_MAP[options.languageId] ??
    options.languageId

  if (raw === 'jsx' || raw === 'javascriptreact') {
    return { languageId: 'javascript', packLanguageId: 'jsx' }
  }
  if (raw === 'tsx' || raw === 'typescriptreact') {
    return { languageId: 'tsx', packLanguageId: 'tsx' }
  }
  const resolverAlias =
    languageResolver && 'resolveLanguageAlias' in languageResolver
      ? (
          languageResolver as { resolveLanguageAlias(alias: string): string | null }
        ).resolveLanguageAlias(raw)
      : null
  const canonical = resolverAlias ?? resolveTreeSitterLanguageAlias(raw) ?? raw
  return { languageId: canonical }
}

const defaultHighlighterWorkerOwner = (): TreeSitterWorkerOwner => {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[DEFAULT_HIGHLIGHTER_WORKER_OWNER_KEY] as TreeSitterWorkerOwner | undefined
  if (existing && existing.inspect().lifecycle !== 'disposed') return existing

  const owner = createTreeSitterWorkerOwner()
  state[DEFAULT_HIGHLIGHTER_WORKER_OWNER_KEY] = owner
  return owner
}

type ThemeResolverCache = {
  resolve(theme: string): Promise<VscodeThemeRegistration>
}

const createThemeResolverCache = (
  resolveTheme: TreeSitterThemeRegistrationResolver,
): ThemeResolverCache => {
  const inflight = new Map<string, Promise<VscodeThemeRegistration>>()
  return {
    resolve(theme: string): Promise<VscodeThemeRegistration> {
      const existing = inflight.get(theme)
      if (existing) return existing
      const pending = resolveTheme(theme).then((registration) => {
        if (!registration.name) {
          throw new Error('Tree-sitter highlight themes require a non-empty name')
        }
        return registration
      })
      inflight.set(theme, pending)
      void pending.catch(() => inflight.delete(theme))
      return pending
    },
  }
}

const configuredThemeName = (options: TreeSitterHighlighterProviderOptions): string => {
  const theme = options.theme
  if (typeof theme === 'function') return theme()
  return theme ?? DEFAULT_THEME
}

const loadConfiguredTheme = async (
  options: TreeSitterHighlighterProviderOptions,
  themeCache: ThemeResolverCache,
  backend: TreeSitterWorkerClient,
): Promise<EditorTheme | null | undefined> => {
  const themeRevision = configuredThemeName(options)
  const themeRegistration = await themeCache.resolve(themeRevision)
  if (!backend.canUseWorker()) return undefined
  const result = await backend.highlightTheme({ themeRevision, themeRegistration })
  return result?.theme
}

const createSession = (
  context: HighlighterOperationContext,
  options: TreeSitterHighlighterProviderOptions,
  themeCache: ThemeResolverCache,
  backend: TreeSitterWorkerClient,
  onFirstHighlight: () => void,
): EditorHighlighterRuntime | null => {
  if (!backend.canUseWorker()) return null
  const resolved = treeSitterHighlightLanguageForDocument(
    context,
    options.languages,
    options.languageResolver,
  )
  if (!resolved) return null

  return new TreeSitterHighlighterSession({
    context,
    languageId: resolved.languageId,
    packLanguageId: resolved.packLanguageId,
    options,
    themeCache,
    backend,
    onFirstHighlight,
  })
}

type SessionInit = {
  readonly context: HighlighterOperationContext
  readonly languageId: TreeSitterLanguageId
  readonly packLanguageId?: string
  readonly options: TreeSitterHighlighterProviderOptions
  readonly themeCache: ThemeResolverCache
  readonly backend: TreeSitterWorkerClient
  readonly onFirstHighlight: () => void
}

class TreeSitterHighlighterSession implements EditorHighlighterRuntime {
  private readonly documentId: string
  private readonly runtimeSessionId: string
  private readonly languageId: TreeSitterLanguageId
  private readonly packLanguageId: string | undefined
  public readonly onDidChangeTheme: TreeSitterHighlighterProviderOptions['onThemeChanged']
  private themeRevision: string
  private themeRegistration: Promise<VscodeThemeRegistration>
  private analysedRead: DocumentRead | null = null
  private store: EditorTokenStore | null = null
  private currentTheme: EditorTheme | null | undefined
  private opened = false
  private workerGeneration = 0
  private registeredGeneration: number | null = null
  private openedLineLimit = 0
  private firstHighlightFired = false
  private disposed = false
  private readonly lifetime = new AbortController()
  private task: Promise<void> = Promise.resolve()

  public constructor(private readonly init: SessionInit) {
    this.documentId = init.context.documentId
    this.runtimeSessionId = init.context.runtimeSessionId ?? createEditorRuntimeSessionId()
    this.languageId = init.languageId
    this.packLanguageId = init.packLanguageId
    this.onDidChangeTheme = init.options.onThemeChanged
    this.themeRevision = configuredThemeName(init.options)
    this.themeRegistration = init.themeCache.resolve(this.themeRevision)
    void this.themeRegistration.catch(() => undefined)
  }

  public configurationKey(): number | null {
    return this.disposed ? null : this.lineLimit()
  }

  public async analyze(read: DocumentRead, signal?: AbortSignal): Promise<EditorHighlightResult> {
    const work = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    work.throwIfAborted()
    if (this.init.context.source.read(read.revision) !== read) {
      throw new DOMException('Document revision belongs to another source', 'InvalidStateError')
    }
    return this.enqueueRequest(() => this.runAnalyze(read, work))
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.opened = false
    this.init.backend.setHighlightUntokenizedLines(this.runtimeSessionId, null)
    const release = this.task.then(
      () => this.init.backend.disposeDocument(this.runtimeSessionId),
      () => this.init.backend.disposeDocument(this.runtimeSessionId),
    )
    this.task = release.then(
      () => undefined,
      () => undefined,
    )
  }

  private enqueueRequest(
    run: () => Promise<EditorHighlightResult>,
  ): Promise<EditorHighlightResult> {
    const result = this.task.then(run)
    this.task = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runAnalyze(read: DocumentRead, work: AbortSignal): Promise<EditorHighlightResult> {
    work.throwIfAborted()
    const recolored = await this.synchronizeTheme(read, work)
    if (recolored) return recolored

    await this.ensureLanguageRegistered(work)
    const themeRegistration = await waitForDocumentWork(this.themeRegistration, work)
    const maxLineLength = this.lineLimit()
    work.throwIfAborted()

    const prepared = await this.init.context.source.prepareReader(
      this.init.backend.sourceEndpoint,
      read,
      work,
    )
    if (!prepared || this.disposed) {
      await prepared?.dispose()
      throw new DOMException('Document source was released', 'AbortError')
    }

    try {
      work.throwIfAborted()
      const result = await this.dispatchHighlight(
        read,
        prepared.reference,
        themeRegistration,
        maxLineLength,
        work,
      )
      this.lifetime.signal.throwIfAborted()
      this.adoptResult(result, read, maxLineLength)
      work.throwIfAborted()
      return { tokens: this.store ?? EditorTokenStore.empty(), theme: this.currentTheme }
    } finally {
      await prepared.dispose()
    }
  }

  private async dispatchHighlight(
    read: DocumentRead,
    source: Parameters<TreeSitterWorkerClient['highlightOpen']>[0]['source'],
    themeRegistration: VscodeThemeRegistration,
    maxLineLength: number,
    work: AbortSignal,
  ) {
    const changes = this.analysedRead
      ? this.init.context.source.changesBetween(this.analysedRead.revision, read.revision)
      : null
    if (
      this.opened &&
      changes?.edits &&
      this.analysedRead &&
      this.openedLineLimit === maxLineLength
    ) {
      const inputEdits = createTreeSitterInputEdits(this.analysedRead.text, changes.edits)
      return this.init.backend.highlightEdit(
        {
          documentId: this.documentId,
          runtimeSessionId: this.runtimeSessionId,
          languageId: this.languageId,
          packLanguageId: this.packLanguageId,
          themeRevision: this.themeRevision,
          themeRegistration,
          maxLineLength,
          source,
          previousPoint: {
            ...source.point,
            revision: this.analysedRead.revision.point.revision,
            textVersion: this.analysedRead.revision.point.textVersion,
          },
          edits: changes.edits,
          inputEdits,
        },
        work,
      )
    }
    return this.init.backend.highlightOpen(
      {
        documentId: this.documentId,
        runtimeSessionId: this.runtimeSessionId,
        languageId: this.languageId,
        packLanguageId: this.packLanguageId,
        themeRevision: this.themeRevision,
        themeRegistration,
        maxLineLength,
        source,
      },
      work,
    )
  }

  private async synchronizeTheme(
    read: DocumentRead,
    signal: AbortSignal,
  ): Promise<EditorHighlightResult | null> {
    signal.throwIfAborted()
    const snapshot = this.init.backend.inspect()
    if (snapshot.lifecycle !== 'ready' || snapshot.workerGeneration !== this.workerGeneration) {
      this.opened = false
    }
    const maxLineLength = this.lineLimit()
    const limitChanged = this.opened && this.openedLineLimit !== maxLineLength
    if (limitChanged) this.opened = false

    const nextTheme = configuredThemeName(this.init.options)
    const themeChanged = nextTheme !== this.themeRevision
    if (!themeChanged) return null

    const nextRegistration = await waitForDocumentWork(
      this.init.themeCache.resolve(nextTheme),
      signal,
    )
    if (this.disposed) return null

    this.themeRevision = nextTheme
    this.themeRegistration = Promise.resolve(nextRegistration)
    if (!this.opened) return null

    const result = await this.init.backend.highlightRecolor(
      {
        runtimeSessionId: this.runtimeSessionId,
        themeRevision: nextTheme,
        themeRegistration: nextRegistration,
        maxLineLength,
      },
      signal,
    )
    if (this.disposed) return null
    if (!result) {
      this.opened = false
      return null
    }

    this.adoptRecolorResult(result)
    signal.throwIfAborted()
    if (this.analysedRead === read) {
      return { tokens: this.store ?? EditorTokenStore.empty(), theme: this.currentTheme }
    }
    return null
  }

  private async ensureLanguageRegistered(signal: AbortSignal): Promise<void> {
    const resolver = this.init.options.languageResolver
    if (!resolver) return
    const currentGen = this.init.backend.generation
    if (this.registeredGeneration !== null && this.registeredGeneration === currentGen) return

    const descriptors = await waitForDocumentWork(
      resolveTreeSitterLanguageClosure(resolver, this.languageId),
      signal,
    )
    if (descriptors.length === 0) {
      throw new Error(`No Tree-sitter grammar registered for ${this.languageId}`)
    }
    await waitForDocumentWork(this.init.backend.registerLanguages(descriptors), signal)
    this.registeredGeneration = this.init.backend.generation
  }

  private adoptResult(
    result: Awaited<ReturnType<TreeSitterWorkerClient['highlightOpen']>>,
    read: DocumentRead,
    maxLineLength: number,
  ): void {
    this.analysedRead = read
    this.opened = true
    this.openedLineLimit = maxLineLength
    this.workerGeneration = this.init.backend.inspect().workerGeneration
    this.adoptRecolorResult(result)
    if (!this.firstHighlightFired) {
      this.firstHighlightFired = true
      this.init.onFirstHighlight()
    }
  }

  private adoptRecolorResult(
    result: Awaited<ReturnType<TreeSitterWorkerClient['highlightOpen']>>,
  ): void {
    if (result?.theme !== undefined) this.currentTheme = result.theme
    if (result?.untokenizedLines !== undefined) {
      this.init.backend.setHighlightUntokenizedLines(this.runtimeSessionId, result.untokenizedLines)
    }
    if (result?.tokensPacked) {
      this.store = EditorTokenStore.fromPacked(result.tokensPacked)
    }
  }

  private lineLimit(): number {
    const configured = this.init.options.maxTokenizationLineLength?.()
    if (configured !== undefined && Number.isInteger(configured) && configured >= 1) {
      return configured
    }
    return this.init.backend.maxTokenizationLineLength()
  }
}

const warmHighlightLanguages = async (
  resolver: TreeSitterLanguageResolver,
  backend: TreeSitterWorkerClient,
  languageIds: readonly TreeSitterLanguageId[],
): Promise<void> => {
  const closures = await Promise.allSettled(
    languageIds.map((languageId) => resolveTreeSitterLanguageClosure(resolver, languageId)),
  )
  const descriptors = new Map<TreeSitterLanguageId, TreeSitterLanguageDescriptor>()
  for (const closure of closures) {
    if (closure.status === 'rejected') continue
    for (const descriptor of closure.value) {
      if (!descriptors.has(descriptor.id)) descriptors.set(descriptor.id, descriptor)
    }
  }
  await backend.warmLanguages([...descriptors.values()]).catch(() => undefined)
}

const languageForDocumentExtension = (
  documentId: string,
  languageId: EditorSyntaxLanguageId,
): string | null => {
  const extension = extensionForDocumentId(documentId)
  if (languageId === 'typescript' && extension === '.tsx') return 'tsx'
  if (languageId === 'javascript' && extension === '.jsx') return 'jsx'
  return null
}

const extensionForDocumentId = (documentId: string): string | null => {
  const path = documentId.split(/[?#]/, 1)[0] ?? documentId
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex <= slashIndex) return null
  return path.slice(dotIndex).toLowerCase()
}
