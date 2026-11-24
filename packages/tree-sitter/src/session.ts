import { createTreeSitterInputEdits } from './treeSitter/edits'
import { TREE_SITTER_BOOTSTRAP_UNITS } from './treeSitter/source'
import { waitForDocumentWork } from '@singapore-editor/core/internal/document-worker'
import { type TextEdit, type TextReadSnapshot } from '@singapore-editor/core/document'
import {
  createEmptySyntaxResult,
  createEditorRuntimeSessionId,
  type EditorSyntaxAnalysis,
  type EditorSyntaxDegradedState,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
  type EditorSyntaxRuntime,
  type EditorSyntaxFoldingSupport,
  treeSitterCapturesToEditorTokens,
  EditorTokenStore,
} from '@singapore-editor/core/syntax'
import type {
  DocumentContributionSource,
  DocumentRead,
  DocumentWorkerReadReference,
} from '@singapore-editor/core/internal/document-worker'
import type {
  TreeSitterDegradedState,
  TreeSitterLanguageId,
  TreeSitterParseAckResult,
  TreeSitterParseResult,
  TreeSitterRangeResult,
} from './treeSitter/types'
import type {
  TreeSitterLanguageDescriptor,
  TreeSitterLanguageResolver,
} from './treeSitter/registry'
import {
  TreeSitterWorkerClient,
  type TreeSitterBackend,
  type TreeSitterBackendEditPayload,
  type TreeSitterEditPayload,
} from './treeSitter/workerClient'

export type TreeSitterSyntaxSessionOptions = {
  readonly documentId: string
  readonly runtimeSessionId?: string
  readonly languageId: TreeSitterLanguageId
  readonly languageResolver?: TreeSitterLanguageResolver
  readonly foldingSupport?: Exclude<EditorSyntaxFoldingSupport, 'pending'>
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly syntaxMode?: 'full' | 'range'
  readonly source: DocumentContributionSource
  readonly initialRead: DocumentRead
  readonly backend?: TreeSitterBackend
  /** Called once, after the session's first parse answers. */
  readonly onFirstParse?: () => void
}

type LanguageRegistration =
  | { readonly kind: 'pending'; readonly promise: Promise<boolean> }
  | {
      readonly kind: 'ready'
      readonly promise: Promise<boolean>
      readonly generation: number | null
    }

export class TreeSitterSyntaxSession implements EditorSyntaxRuntime {
  private readonly documentId: string
  private runtimeSessionId: string
  private readonly languageId: TreeSitterLanguageId
  private readonly languageResolver: TreeSitterLanguageResolver | undefined
  private readonly includeHighlights: boolean
  private readonly includeCaptures: boolean
  private readonly syntaxMode: 'full' | 'range'
  private readonly backend: TreeSitterBackend
  private snapshotVersion = 0
  /** Range requests issued, and the newest of them whose answer became `result`. */
  private rangeRequests = 0
  private publishedRangeRequest = 0
  private parsedSnapshotVersion = 0
  private analysedRead: DocumentRead | null = null
  private analysedSourceGeneration: number | null = null
  private readonly source: DocumentContributionSource
  private initialLength: number
  private result: EditorSyntaxResult
  private currentFoldingSupport: EditorSyntaxFoldingSupport
  private languageRegistration: LanguageRegistration | null = null
  private readonly pendingLanguages = new Map<
    string,
    Promise<readonly TreeSitterLanguageDescriptor[]>
  >()
  private background: {
    readonly controller: AbortController
    readonly promise: Promise<void>
    /** Settles when the worker holds the whole tree, which is before injected grammars are in. */
    readonly hostTree: Promise<void>
  } | null = null
  /**
   * The worker holds the whole tree of the current version, not only a large file's first part.
   * Edits are applied to that tree, and every range is answered from it, whatever the state of
   * the injected grammars.
   */
  private hostTreeComplete = false
  /**
   * The current version lacks injected layers whose grammars are still to load. Its results say
   * `partial`, as a large document's first screen does, until the complete analysis publishes
   * the one that has them or reports why it has not.
   */
  private awaitingInjections = false
  /** Why an injected grammar of the current version could not be loaded; its results carry it. */
  private injectionFailure: EditorSyntaxDegradedState | null = null
  /**
   * Injected languages nothing provides (null) or whose assets failed to load (the reason). They
   * are asked for once: a document that names one is not held back or parsed again for it.
   */
  private readonly unloadableLanguages = new Map<string, string | null>()
  /** The read the last background result was published against. */
  private publishedRead: DocumentRead | null = null
  private readonly resultListeners = new Set<
    (read: DocumentRead, result: EditorSyntaxResult) => void
  >()
  private disposed = false
  private onFirstParse: (() => void) | undefined

  public constructor(options: TreeSitterSyntaxSessionOptions) {
    this.documentId = options.documentId
    this.runtimeSessionId = options.runtimeSessionId ?? createEditorRuntimeSessionId()
    this.languageId = options.languageId
    this.languageResolver = options.languageResolver
    this.currentFoldingSupport = options.languageResolver
      ? 'pending'
      : (options.foldingSupport ?? 'supported')
    this.includeHighlights = options.includeHighlights ?? true
    this.includeCaptures = options.includeCaptures ?? true
    this.syntaxMode = options.syntaxMode ?? 'full'
    this.source = options.source
    this.initialLength = options.initialRead.text.length
    this.backend = options.backend ?? new TreeSitterWorkerClient()
    this.onFirstParse = options.onFirstParse
    this.result = this.createEmptyResult({ length: this.initialLength, snapshotVersion: 0 })
    // The editor schedules the first analysis after it has built the document's view. The
    // grammar's queries and its download start now, so they load while that view is built.
    if (this.languageResolver) void this.ensureLanguageRegistered().catch(() => undefined)
  }

  public get foldingSupport(): EditorSyntaxFoldingSupport {
    if (this.result.projection.analysis && this.result.projection.analysis.kind !== 'full')
      return 'pending'
    return this.currentFoldingSupport
  }

  public async analyze(read: DocumentRead, signal?: AbortSignal): Promise<EditorSyntaxResult> {
    if (this.disposed) return this.result
    signal?.throwIfAborted()
    if (this.source.read(read.revision) !== read)
      throw new DOMException('Document revision belongs to another source', 'InvalidStateError')
    if (!(await waitForDocumentWork(this.ensureLanguageRegistered(), signal)))
      return this.updateFromUnavailableLanguage(read)
    if (this.disposed) return this.result

    const prepared = await this.source.prepareReader(this.backend.sourceEndpoint, read, signal)
    if (!prepared || this.disposed) {
      await prepared?.dispose()
      throw new DOMException('Document source was released', 'AbortError')
    }
    try {
      signal?.throwIfAborted()
      if (this.analysedSourceGeneration !== prepared.reference.identity.endpointGeneration)
        this.parsedSnapshotVersion = 0
      const result = await this.analyzePrepared(read, prepared.reference, signal)
      this.analysedSourceGeneration = prepared.reference.identity.endpointGeneration
      return result
    } finally {
      await prepared.dispose()
    }
  }

  private async analyzePrepared(
    read: DocumentRead,
    source: DocumentWorkerReadReference,
    signal?: AbortSignal,
  ): Promise<EditorSyntaxResult> {
    const changed = this.analysedRead
      ? this.source.changesBetween(this.analysedRead.revision, read.revision)
      : null
    if (this.parsedSnapshotVersion > 0 && changed?.edits?.length === 0) {
      // The text is the same, so the parse of it stands and background work on it carries on:
      // aborting it here would leave a first answer that nothing ever completes.
      const previous = this.analysedRead
      this.analysedRead = read
      if (previous !== read) this.republishBackgroundResult(read)
      return this.result
    }
    this.background?.controller.abort()
    // An edit is applied to the whole tree whenever the worker has one. Whether the injected
    // grammars are in does not matter: a grammar still downloading must not turn a keystroke
    // into a parse of the whole file.
    if (
      this.parsedSnapshotVersion > 0 &&
      changed?.edits &&
      this.analysedRead &&
      this.hostTreeComplete
    ) {
      this.background = null
      this.beginVersion()
      const payload = {
        documentId: this.documentId,
        runtimeSessionId: this.runtimeSessionId,
        languageId: this.languageId,
        previousSnapshotVersion: this.parsedSnapshotVersion,
        snapshotVersion: ++this.snapshotVersion,
        previousRead: this.analysedRead.text,
        source,
        edits: changed.edits,
        includeHighlights: this.includeHighlights,
        includeCaptures: this.includeCaptures,
      }
      const edit =
        this.syntaxMode === 'range'
          ? createTreeSitterEditPayload({ ...payload, resultMode: 'parseOnly' })
          : createTreeSitterEditPayload({ ...payload, resultMode: 'full' })
      if (edit) return await this.applyIncrementalEdit(edit, read, signal)
    }
    return await this.parseRead(read, source, signal)
  }

  private async parseRead(
    read: DocumentRead,
    source: DocumentWorkerReadReference,
    signal?: AbortSignal,
  ): Promise<EditorSyntaxResult> {
    this.background?.controller.abort()
    this.background = null
    this.beginVersion()
    this.hostTreeComplete = false
    const snapshotVersion = ++this.snapshotVersion
    const parsePayload = {
      documentId: this.documentId,
      runtimeSessionId: this.runtimeSessionId,
      snapshotVersion,
      languageId: this.languageId,
      includeHighlights: this.includeHighlights,
      includeCaptures: this.includeCaptures,
      source,
    }
    let result = await this.backend.parse(
      this.syntaxMode === 'range'
        ? { ...parsePayload, resultMode: this.initialParseMode(read) }
        : { ...parsePayload, resultMode: 'full' },
      signal,
    )
    if (this.syntaxMode === 'range' && this.hasLoadableLanguages(result?.missingLanguages)) {
      // The document's own grammar can color the text now. Injected grammars (a regex, a
      // documentation comment) download behind this answer, which says `partial` until the
      // complete analysis publishes the result that has them.
      signal?.throwIfAborted()
      this.updateFromTreeSitterResult(result, snapshotVersion, read)
      if (this.disposed || this.parsedSnapshotVersion !== snapshotVersion) return this.result
      this.hostTreeComplete = holdsWholeTree(result)
      return this.awaitInjections(read)
    }
    for (let depth = 0; depth < 8 && result?.missingLanguages?.length; depth += 1) {
      if (
        !(await waitForDocumentWork(
          this.registerMissingLanguages(result.missingLanguages, snapshotVersion),
          signal,
        ))
      )
        break
      if (this.disposed || !this.isCurrentSnapshotVersion(snapshotVersion)) return this.result
      result = await this.backend.parse(
        this.syntaxMode === 'range'
          ? { ...parsePayload, resultMode: this.initialParseMode(read) }
          : { ...parsePayload, resultMode: 'full' },
        signal,
      )
    }
    signal?.throwIfAborted()
    if (this.isCurrentSnapshotVersion(snapshotVersion))
      this.injectionFailure = this.injectionFailureFor(result?.missingLanguages)
    const next = this.updateFromTreeSitterResult(result, snapshotVersion, read)
    if (this.parsedSnapshotVersion === snapshotVersion)
      this.hostTreeComplete = holdsWholeTree(result)
    if (result && !this.disposed && result.analysis?.kind !== 'partial') this.notifyFirstParse()
    return next
  }

  /**
   * A new version of the text: what was pending or known about the previous one's injections is
   * not about it. Whether the worker holds the whole tree carries over an edit, which is applied
   * to that tree, and is reset by a parse from the start.
   */
  private beginVersion(): void {
    this.awaitingInjections = false
    this.injectionFailure = null
    this.publishedRead = null
  }

  /**
   * The current version is answered from the document's own grammar, and the grammars its
   * injections need load behind that answer. Its results say `partial` from here on.
   */
  private awaitInjections(read: DocumentRead): EditorSyntaxResult {
    this.awaitingInjections = true
    if (this.result.projection.analysis?.kind === 'full')
      this.result = partialSyntaxResult(this.result, read.text.length)
    void this.startCompleteAnalysis()
    return this.result
  }

  private hasLoadableLanguages(languageIds: readonly string[] | undefined): boolean {
    return languageIds?.some((id) => !this.unloadableLanguages.has(id)) ?? false
  }

  private injectionFailureFor(
    languageIds: readonly string[] | undefined,
  ): EditorSyntaxDegradedState | null {
    for (const id of languageIds ?? []) {
      const reason = this.unloadableLanguages.get(id)
      if (!reason) continue
      return {
        kind: 'optional-phase-failed',
        phase: 'load injected languages',
        message: `Tree-sitter language "${id}" failed to load: ${reason}`,
      }
    }
    return null
  }

  private initialParseMode(read: DocumentRead): 'parseOnly' | 'bootstrap' {
    if (
      read.text.length <= TREE_SITTER_BOOTSTRAP_UNITS ||
      this.languageId === 'markdown' ||
      this.languageId === 'mdx'
    )
      return 'parseOnly'
    return 'bootstrap'
  }

  public subscribeResults(
    listener: (read: DocumentRead, result: EditorSyntaxResult) => void,
  ): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  private startCompleteAnalysis(): Promise<void> {
    if (this.background) return this.background.promise
    const read = this.analysedRead
    if (!read || this.disposed || this.result.projection.analysis?.kind !== 'partial')
      return Promise.resolve()
    const controller = new AbortController()
    const version = this.snapshotVersion
    let hostTreeSettled!: () => void
    const hostTree = new Promise<void>((resolve) => {
      hostTreeSettled = resolve
    })
    const promise = this.completeAnalysis(version, controller.signal, hostTreeSettled)
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.disposed || this.snapshotVersion !== version) return
        this.publishFailedAnalysis(this.analysedRead ?? read, error)
      })
      .finally(hostTreeSettled)
    this.background = { controller, promise, hostTree }
    return promise
  }

  /** Resolves when the worker holds the whole tree, or when the attempt to get it has ended. */
  private async wholeTree(): Promise<void> {
    void this.startCompleteAnalysis()
    await this.background?.hostTree
  }

  private publishFailedAnalysis(read: DocumentRead, error: unknown): void {
    const degraded: EditorSyntaxDegradedState = { kind: 'request-failed', message: String(error) }
    if (this.awaitingInjections) {
      // The answer already given is complete apart from the injected grammars, and stays.
      this.awaitingInjections = false
      this.injectionFailure = degraded
      this.result = fullSyntaxResult(this.result, read.text.length)
    }
    this.result = { ...this.result, degraded }
    this.publishBackgroundResult(read, this.result)
  }

  private async completeAnalysis(
    version: number,
    signal: AbortSignal,
    hostTreeSettled: () => void,
  ): Promise<void> {
    // The visible response is delivered before the complete analysis enters the worker queue.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal.throwIfAborted()
    // The latest read of this text: a revision that left the text unchanged may have replaced the
    // one the first answer was given for.
    const read = this.analysedRead
    if (!read) return
    const prepared = await this.source.prepareReader(this.backend.sourceEndpoint, read, signal)
    if (!prepared) return
    try {
      const payload: import('./treeSitter/workerClient').TreeSitterParseOnlyPayload = {
        documentId: this.documentId,
        runtimeSessionId: this.runtimeSessionId,
        snapshotVersion: version,
        languageId: this.languageId,
        includeHighlights: this.includeHighlights,
        includeCaptures: this.includeCaptures,
        source: prepared.reference,
        resultMode: 'parseOnly',
      }
      let result = await this.backend.parse(payload, signal)
      signal.throwIfAborted()
      if (this.disposed || this.snapshotVersion !== version) return
      this.wholeTreeAnswered(result)
      hostTreeSettled()
      for (let depth = 0; depth < 8 && result?.missingLanguages?.length; depth++) {
        if (!(await this.registerMissingLanguages(result.missingLanguages, version))) break
        signal.throwIfAborted()
        result = await this.backend.parse(payload, signal)
      }
      signal.throwIfAborted()
      if (this.disposed || this.snapshotVersion !== version || !result) return
      this.settleCompleteAnalysis(result, version, this.analysedRead ?? read)
    } finally {
      await prepared.dispose()
    }
  }

  /**
   * The complete parse has answered. From here the worker holds the whole tree: edits are applied
   * to it and every range is answered from it. Nothing is published yet when injected grammars
   * are still loading: what is on screen is replaced once, by the complete result.
   */
  private wholeTreeAnswered(
    result: TreeSitterParseAckResult | TreeSitterParseResult | undefined,
  ): void {
    if (!holdsWholeTree(result)) return
    this.hostTreeComplete = true
    if (this.hasLoadableLanguages(result?.missingLanguages)) this.awaitingInjections = true
  }

  private settleCompleteAnalysis(
    result: TreeSitterParseAckResult | TreeSitterParseResult,
    version: number,
    read: DocumentRead,
  ): void {
    if (result.analysis?.kind === 'cancelled') {
      this.settleCancelledAnalysis(result.analysis, read)
      return
    }
    this.awaitingInjections = false
    this.injectionFailure = this.injectionFailureFor(result.missingLanguages)
    this.publishBackgroundResult(read, this.updateFromTreeSitterResult(result, version, read))
  }

  /**
   * The worker gave up on the background parse. Both outcomes are final for this version of the
   * text; the next edit starts over.
   */
  private settleCancelledAnalysis(
    cancellation: Extract<EditorSyntaxAnalysis, { kind: 'cancelled' }>,
    read: DocumentRead,
  ): void {
    const analysis = this.result.projection.analysis
    if (this.hostTreeComplete) {
      // The tree is whole and its colors stand. Only the injected layers were given up on, so
      // the result is complete and says what it lacks instead of promising more.
      this.awaitingInjections = false
      this.injectionFailure = {
        kind: 'optional-phase-failed',
        phase: 'load injected languages',
        message: `Injected grammars were not ready within the worker's parse limit (${cancellation.reason})`,
      }
      this.result = this.withInjectionFailure(fullSyntaxResult(this.result, read.text.length))
      this.publishBackgroundResult(read, this.result)
      return
    }
    if (analysis?.kind !== 'partial') return
    // A large file whose whole tree did not arrive keeps its first part.
    this.result = {
      ...this.result,
      projection: {
        ...this.result.projection,
        analysis: { ...analysis, background: cancellation },
      },
    }
    this.publishBackgroundResult(read, this.result)
  }

  private publishBackgroundResult(read: DocumentRead, result: EditorSyntaxResult): void {
    this.publishedRead = read
    this.notifyResults(read, result)
  }

  /**
   * A background result is published against the read the session had analysed. A listener that
   * had already moved to a newer revision of the same text ignores it, and nothing else would
   * tell it: the first analysis of that revision publishes the result again, once.
   */
  private republishBackgroundResult(read: DocumentRead): void {
    if (!this.publishedRead || this.publishedRead === read) return
    this.publishedRead = null
    // @justification Publishes after the analysis that noticed the newer revision has returned
    // and its caller has stored the result; it re-checks that the read is still the current one.
    setTimeout(() => {
      if (this.disposed || this.analysedRead !== read) return
      this.notifyResults(read, this.result)
    }, 0)
  }

  private notifyResults(read: DocumentRead, result: EditorSyntaxResult): void {
    for (const listener of this.resultListeners) listener(read, result)
  }

  private notifyFirstParse(): void {
    const onFirstParse = this.onFirstParse
    this.onFirstParse = undefined
    onFirstParse?.()
  }

  public async queryRange(
    range: EditorSyntaxRange,
    signal?: AbortSignal,
  ): Promise<EditorSyntaxResult> {
    if (this.disposed) return this.result
    signal?.throwIfAborted()
    if (!this.backend.queryRange) {
      return this.createRangeUnavailableResult(range, 'Tree-sitter range queries are unavailable')
    }
    if (this.backend.generation !== this.analysedSourceGeneration && this.analysedRead) {
      const read = this.analysedRead
      this.parsedSnapshotVersion = 0
      await this.analyze(read, signal)
      signal?.throwIfAborted()
    }

    if (!this.canQueryRange()) {
      return this.createRangeUnavailableResult(range, 'Tree-sitter document has not been parsed')
    }

    const request = ++this.rangeRequests
    let result = await this.backend.queryRange(
      {
        documentId: this.documentId,
        runtimeSessionId: this.runtimeSessionId,
        snapshotVersion: this.parsedSnapshotVersion,
        languageId: this.languageId,
        includeHighlights: this.includeHighlights,
        includeCaptures: this.includeCaptures,
        range,
      },
      signal,
    )

    signal?.throwIfAborted()
    for (let depth = 0; depth < 8 && result?.missingLanguages?.length; depth++) {
      if (!(await this.registerMissingLanguages(result.missingLanguages, this.snapshotVersion)))
        break
      signal?.throwIfAborted()
      result = await this.backend.queryRange(
        {
          documentId: this.documentId,
          runtimeSessionId: this.runtimeSessionId,
          snapshotVersion: this.parsedSnapshotVersion,
          languageId: this.languageId,
          includeHighlights: this.includeHighlights,
          includeCaptures: this.includeCaptures,
          range,
        },
        signal,
      )
    }

    if (!result && this.result.projection.analysis?.kind === 'partial') {
      // A range past a large file's first part needs the whole tree, and only that: it does not
      // wait for the injected grammars the complete analysis goes on to load.
      await this.wholeTree()
      signal?.throwIfAborted()
      result = await this.backend.queryRange(
        {
          documentId: this.documentId,
          runtimeSessionId: this.runtimeSessionId,
          snapshotVersion: this.parsedSnapshotVersion,
          languageId: this.languageId,
          includeHighlights: this.includeHighlights,
          includeCaptures: this.includeCaptures,
          range,
        },
        signal,
      )
    }
    if (!result)
      return this.createRangeUnavailableResult(range, 'Complete syntax analysis is pending')
    const background = this.result.projection.analysis
    let answer = this.updateFromTreeSitterRangeResult(result, range, request)
    if (answer.projection.analysis?.kind === 'cancelled') return answer
    if (this.awaitingInjections && answer.projection.analysis?.kind === 'full') {
      // The tree is whole, but its injected layers are not there yet.
      answer = this.replaceRangeAnswer(
        answer,
        provisionalRangeAnswer(answer, this.analysedRead?.text.length ?? this.initialLength),
      )
    }
    if (
      background?.kind === 'partial' &&
      background.background &&
      answer.projection.analysis?.kind === 'partial'
    ) {
      answer = this.replaceRangeAnswer(answer, {
        ...answer,
        projection: {
          ...answer.projection,
          analysis: { ...answer.projection.analysis, background: background.background },
        },
      })
    }
    if (result?.analysis?.kind === 'partial' || this.awaitingInjections) {
      this.notifyFirstParse()
      void this.startCompleteAnalysis()
    }
    return answer
  }

  /** An amended range answer; it also replaces the session's result when the answer was that. */
  private replaceRangeAnswer(
    answer: EditorSyntaxResult,
    amended: EditorSyntaxResult,
  ): EditorSyntaxResult {
    if (this.result === answer) this.result = amended
    return amended
  }

  public canQueryRange(): boolean {
    return (
      this.result.projection.analysis?.kind !== 'cancelled' &&
      this.parsedSnapshotVersion !== 0 &&
      this.parsedSnapshotVersion === this.snapshotVersion
    )
  }

  public getResult(): EditorSyntaxResult {
    return this.result
  }

  public getTokens(): EditorSyntaxResult['tokens'] {
    return this.result.tokens
  }

  public getSnapshotVersion(): number {
    return this.snapshotVersion
  }

  public dispose(): void {
    if (this.disposed) return

    this.background?.controller.abort()
    this.resultListeners.clear()
    this.disposed = true
    this.backend.disposeDocument(this.runtimeSessionId)
  }

  private async applyIncrementalEdit(
    payload: TreeSitterBackendEditPayload,
    read: DocumentRead,
    signal?: AbortSignal,
  ): Promise<EditorSyntaxResult> {
    try {
      const result = await this.backend.edit(payload, signal)
      signal?.throwIfAborted()
      if (this.disposed) return this.result
      if (!this.isCurrentSnapshotVersion(payload.snapshotVersion)) {
        return this.result
      }

      if (!result) {
        return this.reparseAfterIncrementalFailure(read, signal)
      }

      if (result.snapshotVersion !== payload.snapshotVersion) {
        return this.reparseAfterIncrementalFailure(read, signal)
      }

      // A cancelled edit was not applied, so the worker has no tree of this version to edit next.
      if (result.analysis?.kind === 'cancelled') this.hostTreeComplete = false
      if (this.syntaxMode === 'range') return this.updateFromRangeModeEdit(result, payload, read)
      if (
        await this.registerMissingLanguages(result.missingLanguages ?? [], payload.snapshotVersion)
      ) {
        if (this.disposed || !this.isCurrentSnapshotVersion(payload.snapshotVersion))
          return this.result
        return this.parseRead(read, payload.source, signal)
      }

      this.injectionFailure = this.injectionFailureFor(result.missingLanguages)
      return this.updateFromTreeSitterResult(result, payload.snapshotVersion, read)
    } catch {
      signal?.throwIfAborted()
      if (this.disposed) return this.result
      if (!this.isCurrentSnapshotVersion(payload.snapshotVersion)) {
        return this.result
      }

      return this.reparseAfterIncrementalFailure(read, signal)
    }
  }

  /**
   * The edit is applied to the document's own tree and answered at once. Injected layers the new
   * version lacks, because their grammar is still loading or because the edit added the first
   * use of one, follow in the background: the result says `partial` until they are in.
   */
  private updateFromRangeModeEdit(
    result: TreeSitterParseAckResult | TreeSitterParseResult,
    payload: TreeSitterBackendEditPayload,
    read: DocumentRead,
  ): EditorSyntaxResult {
    this.injectionFailure = this.injectionFailureFor(result.missingLanguages)
    this.updateFromTreeSitterResult(result, payload.snapshotVersion, read)
    if (!this.hostTreeComplete || !this.hasLoadableLanguages(result.missingLanguages))
      return this.result
    return this.awaitInjections(read)
  }

  private reparseAfterIncrementalFailure(
    read: DocumentRead,
    signal?: AbortSignal,
  ): Promise<EditorSyntaxResult> {
    if (this.disposed) return Promise.resolve(this.result)

    this.parsedSnapshotVersion = 0
    const disposedRuntimeSessionId = this.runtimeSessionId
    this.runtimeSessionId = createEditorRuntimeSessionId()
    this.backend.disposeDocument(disposedRuntimeSessionId)
    return this.analyze(read, signal)
  }

  private isCurrentSnapshotVersion(snapshotVersion: number): boolean {
    return snapshotVersion === this.snapshotVersion
  }

  private ensureLanguageRegistered(): Promise<boolean> {
    if (!this.languageResolver) return Promise.resolve(true)
    const current = this.languageRegistration
    if (current?.kind === 'pending') return current.promise
    if (current?.kind === 'ready' && current.generation === this.backend.generation)
      return current.promise
    const pending: LanguageRegistration = {
      kind: 'pending',
      promise: this.registerResolvedLanguage(),
    }
    this.languageRegistration = pending
    void pending.promise.then(
      (available) => {
        if (this.languageRegistration !== pending) return
        const generation = this.backend.generation
        if (available && generation === null) {
          this.languageRegistration = null
          return
        }
        this.languageRegistration = {
          kind: 'ready',
          promise: pending.promise,
          generation,
        }
      },
      () => {
        if (this.languageRegistration === pending) this.languageRegistration = null
      },
    )
    return pending.promise
  }

  private async registerResolvedLanguage(): Promise<boolean> {
    const descriptor = await this.languageResolver?.resolveTreeSitterLanguage(this.languageId)
    if (!descriptor) {
      this.currentFoldingSupport = 'unsupported'
      return false
    }
    this.currentFoldingSupport = descriptor.foldQuerySource?.trim() ? 'supported' : 'unsupported'

    if (this.disposed) return false
    await this.backend.registerLanguages([descriptor])
    return true
  }

  private async registerMissingLanguages(
    languageIds: readonly string[],
    version: number,
  ): Promise<boolean> {
    if (this.disposed || !this.isCurrentSnapshotVersion(version)) return false
    // Their assets load together and they are registered in one message: registered one by one,
    // each waited for the worker to answer the one before, behind whatever it was running.
    const ids = Array.from(new Set(languageIds)).filter((id) => !this.unloadableLanguages.has(id))
    const loads = await Promise.allSettled(ids.map((id) => this.requestedLanguage(id)))
    if (this.disposed || !this.isCurrentSnapshotVersion(version)) return false
    const descriptors: TreeSitterLanguageDescriptor[] = []
    for (const [index, load] of loads.entries()) {
      const id = ids[index]!
      // One grammar that fails to load does not keep the others from the document.
      if (load.status === 'rejected') this.unloadableLanguages.set(id, String(load.reason))
      else if (load.value.length === 0) this.unloadableLanguages.set(id, null)
      else for (const descriptor of load.value) descriptors.push(descriptor)
    }
    if (descriptors.length === 0) return false
    await this.backend.registerLanguages(descriptors)
    return true
  }

  private requestedLanguage(id: string): Promise<readonly TreeSitterLanguageDescriptor[]> {
    const pending = this.pendingLanguages.get(id) ?? this.resolveRequestedLanguage(id)
    this.pendingLanguages.set(id, pending)
    return pending
  }

  private async resolveRequestedLanguage(
    id: string,
  ): Promise<readonly TreeSitterLanguageDescriptor[]> {
    if (!this.languageResolver) return []
    const descriptor = await this.languageResolver.resolveTreeSitterLanguage(id)
    return descriptor && !this.disposed ? [descriptor] : []
  }

  private updateFromUnavailableLanguage(read: DocumentRead): EditorSyntaxResult {
    if (this.disposed) return this.result

    this.analysedRead = read
    this.result = this.createEmptyResult({
      degraded: {
        kind: 'language-unavailable',
        message: `Tree-sitter language "${this.languageId}" is unavailable`,
      },
      length: read.text.length,
      snapshotVersion: this.snapshotVersion,
    })
    return this.result
  }

  private updateFromTreeSitterResult(
    result: TreeSitterParseResult | TreeSitterParseAckResult | undefined,
    snapshotVersion: number,
    read: DocumentRead,
  ): EditorSyntaxResult {
    if (this.disposed) return this.result
    if (!result) return this.result
    if (result.snapshotVersion !== snapshotVersion) return this.result
    if (result.snapshotVersion !== this.snapshotVersion) return this.result

    this.analysedRead = read
    this.parsedSnapshotVersion = result.snapshotVersion
    if (isTreeSitterParseAckResult(result)) {
      this.result = this.createEmptyResult({
        degraded:
          treeSitterDegradedStateToEditorSyntaxState(result.degraded) ?? this.injectionFailure,
        length: read.text.length,
        snapshotVersion: result.snapshotVersion,
      })
      this.result = {
        ...this.result,
        projection: {
          ...this.result.projection,
          source: result.source,
          analysis: result.analysis ?? {
            kind: 'full',
            coveredRange: { startIndex: 0, endIndex: read.text.length },
          },
        },
      }
      return this.result
    }

    this.result = this.withInjectionFailure(
      treeSitterParseResultToEditorSyntaxResult(result, this.resultContext(read.text.length, [])),
    )
    return this.result
  }

  /** A grammar that could not be loaded stays reported on every result of its version. */
  private withInjectionFailure(result: EditorSyntaxResult): EditorSyntaxResult {
    if (result.degraded || !this.injectionFailure) return result
    return { ...result, degraded: this.injectionFailure }
  }

  private updateFromTreeSitterRangeResult(
    result: TreeSitterRangeResult | undefined,
    range: EditorSyntaxRange,
    request: number,
  ): EditorSyntaxResult {
    if (this.disposed) return this.result
    if (!result) return this.result
    if (result.snapshotVersion !== this.snapshotVersion) return this.result
    if (result.snapshotVersion !== this.parsedSnapshotVersion) return this.result
    if (!sameSyntaxRange(result.range, range)) return this.result

    const next = this.withInjectionFailure(
      treeSitterParseResultToEditorSyntaxResult(
        result,
        this.resultContext(this.analysedRead?.text.length ?? this.initialLength, [range]),
      ),
    )
    // A failed range operation does not retire the document's usable tree or colors.
    if (next.projection.analysis?.kind === 'cancelled') return next
    // Answers can arrive out of order: a long range runs in slices, and a short one asked after
    // it finishes first. Each caller gets its own answer; the session's result stays the answer
    // to the newest request.
    if (request < this.publishedRangeRequest) return next
    this.publishedRangeRequest = request
    this.result = next
    return next
  }

  private createRangeUnavailableResult(
    range: EditorSyntaxRange,
    message: string,
  ): EditorSyntaxResult {
    const result = this.createEmptyResult({
      degraded: { kind: 'range-unavailable', message },
      requestedRanges: [range],
      length: this.analysedRead?.text.length ?? this.initialLength,
      snapshotVersion: this.parsedSnapshotVersion,
    })
    return {
      ...result,
      projection: {
        ...result.projection,
        source: this.result.projection.source,
        analysis: this.result.projection.analysis,
      },
    }
  }

  private createEmptyResult(options: {
    readonly degraded?: EditorSyntaxDegradedState | null
    readonly requestedRanges?: readonly EditorSyntaxRange[]
    readonly length: number
    readonly snapshotVersion: number
  }): EditorSyntaxResult {
    return createEmptySyntaxResult({
      degraded: options.degraded,
      language: this.languageConfiguration(),
      requestedRanges: options.requestedRanges,
      snapshot: this.snapshotTag(options.length, options.snapshotVersion),
    })
  }

  private resultContext(
    length: number,
    requestedRanges: readonly EditorSyntaxRange[],
  ): TreeSitterSyntaxResultContext {
    return {
      includeCaptures: this.includeCaptures,
      includeHighlights: this.includeHighlights,
      mode: this.syntaxMode,
      requestedRanges,
      snapshotLength: length,
    }
  }

  private languageConfiguration() {
    return {
      includeCaptures: this.includeCaptures,
      includeHighlights: this.includeHighlights,
      languageId: this.languageId,
      mode: this.syntaxMode,
    }
  }

  private snapshotTag(length: number, snapshotVersion: number) {
    return {
      documentId: this.documentId,
      length,
      version: snapshotVersion,
    }
  }
}

type TreeSitterBaseEditPayloadOptions = {
  readonly documentId: string
  readonly runtimeSessionId: string
  readonly languageId: TreeSitterLanguageId
  readonly previousSnapshotVersion: number
  readonly snapshotVersion: number
  readonly previousRead: TextReadSnapshot
  readonly source: DocumentWorkerReadReference
  readonly edits: readonly TextEdit[]
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
}

type TreeSitterEditPayloadOptions = TreeSitterBaseEditPayloadOptions & {
  readonly resultMode?: 'full'
}

type TreeSitterParseOnlyEditPayloadOptions = TreeSitterBaseEditPayloadOptions & {
  readonly resultMode: 'parseOnly'
}

export function createTreeSitterEditPayload(
  options: TreeSitterParseOnlyEditPayloadOptions,
): TreeSitterBackendEditPayload | null
export function createTreeSitterEditPayload(
  options: TreeSitterEditPayloadOptions,
): TreeSitterEditPayload | null
export function createTreeSitterEditPayload(
  options: TreeSitterEditPayloadOptions | TreeSitterParseOnlyEditPayloadOptions,
): TreeSitterBackendEditPayload | null {
  if (options.edits.length === 0) return null

  return {
    documentId: options.documentId,
    runtimeSessionId: options.runtimeSessionId,
    previousSnapshotVersion: options.previousSnapshotVersion,
    snapshotVersion: options.snapshotVersion,
    languageId: options.languageId,
    includeHighlights: options.includeHighlights ?? true,
    includeCaptures: options.includeCaptures,
    resultMode: options.resultMode,
    source: options.source,
    edits: options.edits,
    inputEdits: createTreeSitterInputEdits(options.previousRead, options.edits),
  }
}

type TreeSitterSyntaxResultContext = {
  readonly includeCaptures: boolean
  readonly includeHighlights: boolean
  readonly mode: 'full' | 'range'
  readonly requestedRanges: readonly EditorSyntaxRange[]
  readonly snapshotLength: number
}

const treeSitterParseResultToEditorSyntaxResult: typeof treeSitterParseResultToEditorSyntaxResultInner =
  (result, context) => {
    recordParseResultPayload(result)
    return treeSitterParseResultToEditorSyntaxResultInner(result, context)
  }

const treeSitterParseResultToEditorSyntaxResultInner = (
  result: TreeSitterParseResult,
  context: TreeSitterSyntaxResultContext,
): EditorSyntaxResult => ({
  captures: result.captures,
  records: result.records,
  degraded: treeSitterDegradedStateToEditorSyntaxState(result.degraded),
  folds: result.folds,
  brackets: result.brackets,
  errors: result.errors,
  injections: result.injections,
  projection: {
    source: result.source,
    analysis: result.analysis ?? {
      kind: 'full',
      coveredRange: { startIndex: 0, endIndex: context.snapshotLength },
    },
    language: {
      includeCaptures: context.includeCaptures,
      includeHighlights: context.includeHighlights,
      languageId: result.languageId,
      mode: context.mode,
    },
    requestedRanges: context.requestedRanges,
    snapshot: {
      documentId: result.documentId,
      length: context.snapshotLength,
      version: result.snapshotVersion,
    },
  },
  tokens: resultTokens(result),
})

function resultTokens(result: TreeSitterParseResult): EditorTokenStore {
  if (result.tokensPacked) return EditorTokenStore.fromPacked(result.tokensPacked)
  return EditorTokenStore.fromTokens(
    result.tokens ?? treeSitterCapturesToEditorTokens(result.captures),
  )
}

function recordParseResultPayload(result: TreeSitterParseResult): void {
  const sink = (
    globalThis as {
      __EDITOR_PERFORMANCE_DIAGNOSTICS__?: {
        enabled: boolean
        record(diagnostic: { name: string; detail?: Record<string, unknown> }): void
      } | null
    }
  ).__EDITOR_PERFORMANCE_DIAGNOSTICS__
  if (!sink?.enabled) return

  sink.record({
    name: 'treeSitter.parseResult.payload',
    detail: {
      captures: result.captures.length,
      tokens: result.tokens?.length ?? result.tokensPacked?.starts.length ?? -1,
      folds: result.folds.length,
      brackets: result.brackets.length,
      errors: result.errors.length,
      injections: result.injections.length,
    },
  })
}

const treeSitterDegradedStateToEditorSyntaxState = (
  degraded: readonly TreeSitterDegradedState[] | undefined,
): EditorSyntaxDegradedState | null => {
  const first = degraded?.[0]
  if (!first) return null

  return {
    kind: first.kind,
    phase: first.phase,
    message:
      degraded.length === 1
        ? first.message
        : `${first.message} (${degraded.length} Tree-sitter phases degraded)`,
  }
}

const isTreeSitterParseAckResult = (
  result: TreeSitterParseResult | TreeSitterParseAckResult,
): result is TreeSitterParseAckResult =>
  'status' in result && (result.status === 'parsed' || result.status === 'cancelled')

/**
 * A parse answer after which the worker holds the document's whole tree. A large file's first
 * answer covers only its first part, and a cancelled parse leaves no tree of that version.
 */
const holdsWholeTree = (
  result: TreeSitterParseAckResult | TreeSitterParseResult | undefined,
): boolean => {
  if (!result) return false
  return result.analysis?.kind !== 'partial' && result.analysis?.kind !== 'cancelled'
}

/** The result marked as one that a complete analysis of the same text will replace. */
const partialSyntaxResult = (result: EditorSyntaxResult, length: number): EditorSyntaxResult =>
  withSyntaxAnalysis(result, { kind: 'partial', coveredRange: { startIndex: 0, endIndex: length } })

/**
 * A range answered from the whole tree while injected grammars are still loading. Like a large
 * file's first part, a `partial` answer carries colors only: the folds, brackets, errors and
 * injected spans come once, with the complete result, so nothing structural is shown and then
 * changed under the reader.
 */
const provisionalRangeAnswer = (result: EditorSyntaxResult, length: number): EditorSyntaxResult =>
  partialSyntaxResult({ ...result, folds: [], brackets: [], errors: [], injections: [] }, length)

const fullSyntaxResult = (result: EditorSyntaxResult, length: number): EditorSyntaxResult =>
  withSyntaxAnalysis(result, { kind: 'full', coveredRange: { startIndex: 0, endIndex: length } })

const withSyntaxAnalysis = (
  result: EditorSyntaxResult,
  analysis: NonNullable<EditorSyntaxResult['projection']['analysis']>,
): EditorSyntaxResult => ({ ...result, projection: { ...result.projection, analysis } })

const sameSyntaxRange = (left: EditorSyntaxRange, right: EditorSyntaxRange): boolean =>
  left.startIndex === right.startIndex && left.endIndex === right.endIndex
