import type { DocumentSessionChange } from '../documentSession'
import type { DocumentTextSnapshot } from '../documentTextSnapshot'
import type { EditorInitialHighlightStatus } from '../plugins'
import type { EditorSyntaxInjection, BracketInfo } from '../syntax/session'
import { EditorTokenStore } from '../syntax/tokenStore'
import type { EditorDocumentAnalysis } from './documentAnalysis'
import { recordEditorPerformanceDiagnostic } from './performanceDiagnostics'
import type { EditorPreparedTagValue } from './preparedDocument'
import type {
  EditorFallbackFoldReason,
  EditorPlainSyntaxState,
  EditorSyntaxController,
  EditorSyntaxControllerFactory,
  EditorSyntaxControllerOptions,
  EditorSyntaxDocumentStartOptions,
  EditorSyntaxRefreshOptions,
} from './syntaxController'
import { installedEditorSyntaxRuntime } from './syntaxRuntime'

/**
 * What the editor asks of its syntax and highlighting machinery. Until a syntax or highlighter
 * provider brings the full controller it is {@link EditorPlainSyntax}, which knows only plain text.
 */
export type EditorSyntaxPipeline = Pick<
  EditorSyntaxController,
  Exclude<keyof EditorSyntaxController, 'adoptPlainState'>
>

type PendingInitialHighlightReplacement = NonNullable<EditorPlainSyntaxState['pendingReplacement']>
type InitialHighlightReplacement = PendingInitialHighlightReplacement['kind']

/**
 * The syntax controller is kept out of an editor that only ever shows plain text. The helpers that
 * build syntax and highlighter providers install it (see `syntaxOperations.ts`), so the provider's
 * own bundle carries that code, and the plugin host refuses a provider registered before it is
 * installed. An editor given a provider therefore always finds the controller already loaded: no
 * request, and no frame where the provider waits for code.
 */
function syntaxControllerFactory(): EditorSyntaxControllerFactory | null {
  return installedEditorSyntaxRuntime() as EditorSyntaxControllerFactory | null
}

export function createEditorSyntaxPipeline(
  options: EditorSyntaxControllerOptions,
): EditorSyntaxPipeline {
  return syntaxControllerFactory()?.(options) ?? new EditorPlainSyntax(options)
}

/**
 * The full controller in place of a plain pipeline, carrying on from where the plain one was, once
 * the full one is installed. Anything else comes back unchanged.
 */
export function upgradeEditorSyntaxPipeline(
  current: EditorSyntaxPipeline,
  options: EditorSyntaxControllerOptions,
): EditorSyntaxPipeline {
  if (!(current instanceof EditorPlainSyntax)) return current
  const create = syntaxControllerFactory()
  if (!create) return current

  const controller = create(options)
  controller.adoptPlainState(current.handOver())
  return controller
}

const NO_BRACKETS: readonly BracketInfo[] = []
const NO_INJECTIONS: readonly EditorSyntaxInjection[] = []

const replacementPriority = (replacement: InitialHighlightReplacement): number => {
  if (replacement === 'all') return 2
  if (replacement === 'syntax') return 1
  return 0
}

const ignoresChange = (change: DocumentSessionChange): boolean =>
  change.kind === 'none' || change.kind === 'selection' || change.kind === 'synchronize'

/**
 * The syntax controller of an editor with no syntax or highlighter provider. It does exactly what
 * the full controller does when it has none, without carrying the code for sessions, ranges and
 * results: the document is plain, tokens come only from the host, and the initial-paint events and
 * statuses settle the same way.
 */
export class EditorPlainSyntax implements EditorSyntaxPipeline {
  #analysis: EditorDocumentAnalysis | null = null
  #structuralConfigurationTag: readonly EditorPreparedTagValue[] = []
  #highlighterConfigurationTag: readonly EditorPreparedTagValue[] = []
  #disposed = false
  #initialHighlightState: EditorInitialHighlightStatus = 'idle'
  #initialPaintDocumentVersion = 0
  #initialTextPainted = false
  #initialTextPaintEmitted = false
  #initialHighlightPaintEmitted = false
  #configurationGeneration = 0
  #pendingReplacement: PendingInitialHighlightReplacement | null = null
  #includesCaptures = false
  #contentVersion = 0
  #tokens = EditorTokenStore.empty()
  #acceptedCopyTokens = EditorTokenStore.empty()
  #acceptedTokensDocumentVersion = -1
  #acceptedTokensTextVersion = -1
  #copyOwner: 'none' | 'external' = 'none'
  #externalBaseTokens: {
    readonly store: EditorTokenStore
    readonly snapshot: DocumentTextSnapshot
  } | null = null
  // Set once the full controller has taken the document. A handover can happen inside one of this
  // pipeline's own callbacks (a host adding a highlighter when the text paints), so every step that
  // follows a callback checks it and stops rather than publish state that is no longer the editor's.
  #handedOver = false

  constructor(private readonly options: EditorSyntaxControllerOptions) {}

  handOver(): EditorPlainSyntaxState {
    this.#handedOver = true
    return {
      analysis: this.#analysis,
      structuralConfigurationTag: this.#structuralConfigurationTag,
      highlighterConfigurationTag: this.#highlighterConfigurationTag,
      disposed: this.#disposed,
      initialHighlightState: this.#initialHighlightState,
      initialPaintDocumentVersion: this.#initialPaintDocumentVersion,
      initialTextPainted: this.#initialTextPainted,
      initialTextPaintEmitted: this.#initialTextPaintEmitted,
      initialHighlightPaintEmitted: this.#initialHighlightPaintEmitted,
      configurationGeneration: this.#configurationGeneration,
      pendingReplacement: this.#pendingReplacement,
      includesCaptures: this.#includesCaptures,
      contentVersion: this.#contentVersion,
      tokens: this.#tokens,
      acceptedCopyTokens: this.#acceptedCopyTokens,
      acceptedTokensDocumentVersion: this.#acceptedTokensDocumentVersion,
      acceptedTokensTextVersion: this.#acceptedTokensTextVersion,
      copyOwner: this.#copyOwner,
      externalBaseTokens: this.#externalBaseTokens,
    }
  }

  setDisplayDemand(): void {}

  get status(): EditorSyntaxController['status'] {
    return 'plain'
  }

  get usesFallbackFolds(): boolean {
    return true
  }

  get fallbackFoldReason(): EditorFallbackFoldReason {
    return this.options.getLanguageId() ? 'no-session' : 'no-language'
  }

  get fallbackFoldSelection(): EditorSyntaxController['fallbackFoldSelection'] {
    return {
      reason: this.fallbackFoldReason,
      provider: this.options.pluginHost.hasSyntaxProviders() ? 'plugin' : null,
      foldingSupport: null,
      structuralStatus: 'plain',
      structuralSession: false,
      structuralSuppression: false,
      configurationGeneration: this.#configurationGeneration,
    }
  }

  get renderDataReady(): boolean {
    return this.#initialHighlightState !== 'loading'
  }

  get initialHighlightStatus(): EditorInitialHighlightStatus {
    return this.#initialHighlightState
  }

  get awaitingFirstHighlight(): boolean {
    return false
  }

  claimUndebouncedRefresh(): boolean {
    return false
  }

  get copyTokens(): EditorTokenStore {
    if (
      this.#acceptedTokensDocumentVersion !== this.options.getDocumentVersion() ||
      this.#acceptedTokensTextVersion !== this.options.getTextVersion()
    )
      return EditorTokenStore.empty()
    return this.#acceptedCopyTokens
  }

  get tokens(): EditorTokenStore {
    return this.#tokens
  }

  get brackets(): readonly BracketInfo[] {
    return NO_BRACKETS
  }

  get injections(): readonly EditorSyntaxInjection[] {
    return NO_INJECTIONS
  }

  get providerTheme(): null {
    return null
  }

  get theme(): null {
    return null
  }

  setTokens(tokens: EditorTokenStore, current = true, copyTokens = tokens): void {
    if (!current && tokens !== this.#tokens) this.#acceptedCopyTokens = EditorTokenStore.empty()
    this.#tokens = tokens
    if (current) {
      this.#copyOwner = 'external'
      const snapshot = this.options.getSession()?.getTextSnapshot() ?? null
      this.#externalBaseTokens = snapshot ? { store: tokens, snapshot } : null
      this.#acceptedCopyTokens = copyTokens
      this.#acceptedTokensDocumentVersion = this.options.getDocumentVersion()
      this.#acceptedTokensTextVersion = this.options.getTextVersion()
    }
    this.options.adoptTokens(tokens)
  }

  setExternalTokens(tokens: EditorTokenStore): void {
    this.setTokens(tokens)
  }

  // A prepared document is made by `createEditorPreparedDocument`, which installs the full
  // controller, and the editor takes that one before it borrows the document.
  stagePreparedReadyTokens(): never {
    throw new Error('Prepared documents are opened by the full syntax controller')
  }

  borrowPreparedDocument(): never {
    throw new Error('Prepared documents are opened by the full syntax controller')
  }

  startDocument(document: EditorSyntaxDocumentStartOptions): void {
    if (this.#disposed) return

    this.#configurationGeneration += 1
    this.#contentVersion += 1
    this.#copyOwner = 'none'
    this.#externalBaseTokens = null
    this.#analysis = document.analysis ?? null
    this.#structuralConfigurationTag = document.structuralConfigurationTag ?? []
    this.#highlighterConfigurationTag = document.highlighterConfigurationTag ?? []
    this.#includesCaptures = document.languageId ? this.#needsCaptures() : false
    this.#initialPaintDocumentVersion = this.options.getDocumentVersion()
    this.#initialTextPainted = false
    this.#initialTextPaintEmitted = false
    this.#initialHighlightPaintEmitted = false
    this.#pendingReplacement = null
    this.#initialHighlightState = 'plain'
    this.#logStatus('editor.syntax.document_started')
  }

  adoptPreparedReadyResults(): void {}

  adoptReadyAnalysis(): void {}

  notifyBaseTextPainted(): void {
    if (this.#initialPaintDocumentVersion !== this.options.getDocumentVersion()) return

    this.#initialTextPainted = true
    if (!this.#initialTextPaintEmitted) {
      this.#initialTextPaintEmitted = true
      this.options.onInitialPaint?.({ ...this.#initialPaintEventBase(), phase: 'text' })
    }
    this.#emitInitialHighlightPaintIfReady()
  }

  clearDocument(): void {
    this.#configurationGeneration += 1
    this.#initialHighlightState = 'idle'
    this.#initialPaintDocumentVersion = this.options.getDocumentVersion()
    this.#initialTextPainted = false
    this.#initialTextPaintEmitted = false
    this.#initialHighlightPaintEmitted = false
    this.#pendingReplacement = null
    this.#contentVersion += 1
    this.#copyOwner = 'none'
    this.#externalBaseTokens = null
    this.#includesCaptures = false
    this.#analysis = null
    this.#settlePlainInitialHighlight()
    if (this.#handedOver) return
    this.#logStatus('editor.syntax.document_cleared')
  }

  dispose(): void {
    this.#disposed = true
    this.#analysis = null
  }

  syncCaptureRequirement(): void {
    if (this.#disposed) return
    if (this.#needsCaptures() === this.#includesCaptures) return

    this.reloadSyntaxSession()
  }

  // Reached only with no provider registered (the plugin host refuses one until the full controller
  // is installed, and the editor hands over before telling it about a provider).
  reloadHighlighterAndSyntax(): void {
    this.#beginInitialHighlightReplacement('all')
    if (this.#handedOver) return
    if (!this.#disposed && this.options.getSession()) this.#settlePlainInitialHighlight()
    if (this.#handedOver) return
    this.reloadSyntaxSession(false)
    if (this.#handedOver) return
    this.#settlePlainInitialHighlight()
  }

  reloadSyntaxSession(resetInitialHighlight = true): void {
    if (this.#disposed) return

    if (resetInitialHighlight) this.#beginInitialHighlightReplacement('syntax')
    if (this.#handedOver) return
    this.#includesCaptures = false
    if (!this.options.getSession()) {
      this.#settlePlainInitialHighlight()
      return
    }

    if (this.options.getLanguageId()) this.#includesCaptures = this.#needsCaptures()
    this.options.clearSyntaxFolds()
    if (this.#handedOver) return
    this.#logStatus('editor.syntax.reloaded')
    if (resetInitialHighlight) this.refresh(this.options.getDocumentVersion(), null)
    this.options.notifyChange(null)
    if (this.#handedOver) return
    this.#settlePlainInitialHighlight()
  }

  beginThemeReplacement(): number {
    return this.#beginInitialHighlightReplacement('theme')
  }

  completeThemeReplacement(configurationGeneration: number): boolean {
    if (!this.options.getSession()) return false
    const pending = this.#pendingReplacement
    if (pending?.generation !== configurationGeneration || pending.kind !== 'theme') return false

    this.#commitInitialHighlightStatus(
      () => this.setTokens(this.#tokens, false),
      configurationGeneration,
    )
    return true
  }

  refreshHighlighterTheme(): void {
    this.#settlePlainInitialHighlight()
  }

  refresh(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.options.getSession()) return
    if (change && ignoresChange(change)) return

    this.options.log?.({
      action: 'editor.syntax.refresh_scheduled',
      level: 'debug',
      syntax: {
        ...this.fallbackFoldSelection,
        changeKind: change?.kind ?? null,
        documentVersion,
        range: options.range ?? null,
      },
    })
  }

  acceptChange(change: DocumentSessionChange): void {
    if (ignoresChange(change)) return
    this.#contentVersion += 1
    this.#copyOwner = 'none'
    this.#externalBaseTokens = null
    this.#pendingReplacement = null
  }

  refreshVisibleRange(): void {}

  prefetchVisibleRange(): boolean {
    return false
  }

  warmSyntaxAroundRange(): void {}

  #needsCaptures(): boolean {
    return this.options.needsSyntaxCaptures?.() ?? false
  }

  #beginInitialHighlightReplacement(replacement: InitialHighlightReplacement): number {
    if (!this.options.getSession()) return this.#configurationGeneration

    const pending = this.#pendingReplacement
    if (!pending && this.#initialHighlightState === 'loading' && replacement !== 'all') {
      return this.#configurationGeneration
    }
    if (pending && replacementPriority(replacement) < replacementPriority(pending.kind)) {
      return pending.generation
    }

    if (replacement !== 'theme') {
      this.#configurationGeneration += 1
      this.#initialHighlightPaintEmitted = false
    }
    const generation = this.#configurationGeneration
    this.#pendingReplacement = { generation, kind: replacement }
    this.#initialHighlightState = 'loading'
    this.options.notifyViewUpdate()
    return generation
  }

  #settlePlainInitialHighlight(): void {
    if (!this.options.getSession()) return

    this.#commitInitialHighlightStatus(
      () => this.options.notifyViewUpdate(),
      this.#configurationGeneration,
    )
  }

  #commitInitialHighlightStatus(publish: () => void, configurationGeneration: number): void {
    if (configurationGeneration !== this.#configurationGeneration) return

    this.#initialHighlightState = 'plain'
    this.#pendingReplacement = null
    publish()
    this.#emitInitialHighlightPaintIfReady()
  }

  #emitInitialHighlightPaintIfReady(): void {
    if (this.#handedOver) return
    if (!this.#initialTextPainted || this.#initialHighlightPaintEmitted) return
    if (this.#initialHighlightState === 'loading' || this.#initialHighlightState === 'idle') return
    if (this.#initialPaintDocumentVersion !== this.options.getDocumentVersion()) return

    this.#initialHighlightPaintEmitted = true
    this.options.onInitialPaint?.({
      ...this.#initialPaintEventBase(),
      phase: 'highlight-settled',
      status: this.#initialHighlightState,
    })
  }

  #initialPaintEventBase() {
    return {
      documentId: this.options.getDocumentId(),
      documentGeneration: this.#initialPaintDocumentVersion,
      textVersion: this.options.getTextVersion(),
    }
  }

  #logStatus(action: string): void {
    const context = () => this.#debugContext()
    recordEditorPerformanceDiagnostic(action, context)
    this.options.log?.({ action, level: 'info', syntax: context() })
  }

  #debugContext(): Record<string, unknown> {
    const session = this.options.getSession()
    const documentVersion = this.options.getDocumentVersion()
    return {
      currentDocumentVersion: documentVersion,
      documentId: this.options.getCurrentSessionDocumentId(),
      documentLength: session?.getSnapshot().length ?? null,
      documentVersion,
      hasHighlighterSession: false,
      hasSyntaxSession: false,
      languageId: this.options.getLanguageId(),
      syntaxStatus: 'plain',
      ...this.fallbackFoldSelection,
    }
  }
}
