import { lspPositionToOffset } from '@singapore-editor/lsp'
import type { PublishDiagnosticsNotificationParams } from '@singapore-editor/lsp/types'
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from '@typescript/vfs'
import ts from 'typescript'
import type * as lsp from 'vscode-languageserver-protocol'
import {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptLspSourceFileName,
  sourcePathToFileName,
} from '../paths'
import type { TypeScriptLspSourceFile } from '../types'
import { codeActions, resolveCodeAction } from './codeActions'
import {
  completion,
  COMPLETION_TRIGGER_CHARACTERS,
  emptyCompletionList,
  resolveCompletionItem,
} from './completion'
import type { DocumentContext, ServiceContext, WorkerDocument } from './context'
import { collectDiagnostics, documentDiagnosticReport } from './diagnostics'
import {
  defaultFormatSettings,
  formatSettingsFor,
  formatting,
  ON_TYPE_FORMATTING_FIRST_TRIGGER,
  ON_TYPE_FORMATTING_MORE_TRIGGERS,
  onTypeFormatting,
  rangeFormatting,
} from './formatting'
import { hover } from './hover'
import { LineIndex } from './lineIndex'
import {
  definition,
  documentHighlight,
  implementation,
  references,
  typeDefinition,
} from './navigation'
import {
  projectFileMap,
  readProjectConfig,
  resolvedCompilerOptions,
  rootFileNames,
  vfsLibraryCompilerOptions,
  workspaceFileNameForResult,
} from './project'
import {
  didChangeParams,
  errorMessage,
  isNotificationMessage,
  isRecord,
  isRequestMessage,
  JSON_RPC_VERSION,
  METHOD_NOT_FOUND,
  parseIncomingMessage,
  requestId,
  responseErrorFromThrown,
  rpcError,
  textDocumentItemFromParams,
  textDocumentUri,
  type JsonRpcRequestId,
} from './protocol'
import { prepareRename, rename } from './rename'
import { SEMANTIC_TOKEN_LEGEND, semanticTokensFull, semanticTokensRange } from './semanticTokens'
import {
  SIGNATURE_HELP_RETRIGGER_CHARACTERS,
  SIGNATURE_HELP_TRIGGER_CHARACTERS,
  signatureHelp,
} from './signatureHelp'
import { documentSymbol, workspaceSymbol } from './symbols'

const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2
const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const LOG_MESSAGE_ERROR = 1
const LINE_INDEX_CACHE_LIMIT = 256
const DIAGNOSTIC_REFRESH = 'workspace/diagnostic/refresh'

const CODE_ACTION_KINDS = [
  'quickfix',
  'refactor',
  'refactor.extract',
  'refactor.inline',
  'refactor.move',
  'refactor.rewrite',
  'source',
  'source.organizeImports',
]

const DEFAULT_PREFERENCES: ts.UserPreferences = {
  quotePreference: 'auto',
  importModuleSpecifierPreference: 'shortest',
  includeCompletionsForModuleExports: true,
  includeCompletionsForImportStatements: true,
  includePackageJsonAutoImports: 'auto',
  providePrefixAndSuffixTextForRename: true,
  allowRenameOfImportPath: false,
}

export type LibraryFileLoader = (
  compilerOptions: ts.CompilerOptions,
) => Promise<ReadonlyMap<string, string>>

export type TypeScriptLanguageSessionOptions = {
  /** Sends one JSON-RPC message to the client. */
  post(message: unknown): void
  /** The `lib.*.d.ts` set, keyed `/lib.es5.d.ts`. The default fetches it from the TypeScript CDN. */
  loadLibraryFiles?: LibraryFileLoader
}

/** A TypeScript language server with no transport of its own: messages in, messages out. */
export type TypeScriptLanguageSession = {
  receive(data: unknown): void
  dispose(): void
}

type ServiceState = {
  readonly env: VirtualTypeScriptEnvironment
}

type InitializationOptions = {
  readonly compilerOptions?: ts.CompilerOptions
  readonly diagnosticDelayMs?: number
  readonly formatOptions?: ts.FormatCodeSettings
  readonly preferences?: ts.UserPreferences
}

type RequestHandler = (params: unknown, id: JsonRpcRequestId | null) => unknown

export function createTypeScriptLanguageSession(
  options: TypeScriptLanguageSessionOptions,
): TypeScriptLanguageSession {
  const loadLibraryFiles = options.loadLibraryFiles ?? loadLibraryFilesFromCdn
  let compilerOptionsOverride: ts.CompilerOptions = {}
  let diagnosticDelayMs = DEFAULT_DIAGNOSTIC_DELAY_MS
  let formatBase = defaultFormatSettings()
  let preferences = DEFAULT_PREFERENCES
  let clientCapabilities: lsp.ClientCapabilities = {}
  let workspaceFiles = new Map<string, string>()
  let servicePromise: Promise<ServiceState> | null = null
  /** Bumped by every change that can change any file's diagnostics; pull reports carry it. */
  let projectRevision = 0
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let serverRequestCount = 0
  const documents = new Map<lsp.DocumentUri, WorkerDocument>()
  const diagnosticTimers = new Map<lsp.DocumentUri, ReturnType<typeof setTimeout>>()
  const lineIndexes = new Map<string, LineIndex>()
  /**
   * Requests that have been dispatched and not yet answered, so `$/cancelRequest` can take one back
   * out again before its answer is posted.
   *
   * An id is removed when its response is posted and when it is cancelled, whichever happens first,
   * so the set holds only what is genuinely in flight.
   */
  const inFlightRequests = new Set<JsonRpcRequestId>()

  const requests = new Map<string, RequestHandler>([
    ['initialize', (params) => initializeResult(params)],
    ['shutdown', () => shutdownResult()],
    [
      'textDocument/hover',
      (params, id) => withDocument(params, id, null, (ctx) => hover(ctx, params)),
    ],
    [
      'textDocument/completion',
      (params, id) =>
        withDocument(params, id, emptyCompletionList(), (ctx) => completion(ctx, params)),
    ],
    [
      'completionItem/resolve',
      (params, id) => withService(id, (ctx) => resolveCompletionItem(ctx, params)),
    ],
    [
      'textDocument/definition',
      (params, id) => withDocument(params, id, [], (ctx) => definition(ctx, params)),
    ],
    [
      'textDocument/references',
      (params, id) => withDocument(params, id, [], (ctx) => references(ctx, params)),
    ],
    [
      'textDocument/implementation',
      (params, id) => withDocument(params, id, [], (ctx) => implementation(ctx, params)),
    ],
    [
      'textDocument/typeDefinition',
      (params, id) => withDocument(params, id, [], (ctx) => typeDefinition(ctx, params)),
    ],
    [
      'textDocument/documentHighlight',
      (params, id) => withDocument(params, id, [], (ctx) => documentHighlight(ctx, params)),
    ],
    [
      'textDocument/signatureHelp',
      (params, id) =>
        withDocument(params, id, null, (ctx) =>
          signatureHelp(ctx, params, parameterLabelOffsets()),
        ),
    ],
    [
      'textDocument/documentSymbol',
      (params, id) =>
        withDocument(params, id, [], (ctx) => documentSymbol(ctx, hierarchicalSymbols())),
    ],
    ['workspace/symbol', (params, id) => withService(id, (ctx) => workspaceSymbol(ctx, params))],
    [
      'textDocument/prepareRename',
      (params, id) => withDocument(params, id, null, (ctx) => prepareRename(ctx, params)),
    ],
    [
      'textDocument/rename',
      (params, id) => withDocument(params, id, null, (ctx) => rename(ctx, params)),
    ],
    [
      'textDocument/codeAction',
      (params, id) => withDocument(params, id, [], (ctx) => codeActions(ctx, params)),
    ],
    [
      'codeAction/resolve',
      (params, id) => withService(id, (ctx) => resolveCodeAction(ctx, params)),
    ],
    [
      'textDocument/formatting',
      (params, id) => withFormatting(params, id, (ctx) => formatting(ctx)),
    ],
    [
      'textDocument/rangeFormatting',
      (params, id) => withFormatting(params, id, (ctx) => rangeFormatting(ctx, params)),
    ],
    [
      'textDocument/onTypeFormatting',
      (params, id) => withFormatting(params, id, (ctx) => onTypeFormatting(ctx, params)),
    ],
    ['textDocument/diagnostic', (params, id) => pullDiagnostics(params, id)],
    [
      'textDocument/semanticTokens/full',
      (params, id) => withDocument(params, id, null, (ctx) => semanticTokensFull(ctx)),
    ],
    [
      'textDocument/semanticTokens/range',
      (params, id) => withDocument(params, id, null, (ctx) => semanticTokensRange(ctx, params)),
    ],
  ])

  function receive(data: unknown): void {
    const message = parseIncomingMessage(data)
    if (!message) return
    if (isRequestMessage(message)) {
      void handleRequest(message)
      return
    }

    if (isNotificationMessage(message)) handleNotification(message)
  }

  async function handleRequest(message: lsp.RequestMessage): Promise<void> {
    const id = requestId(message)
    if (id !== null) inFlightRequests.add(id)

    try {
      const handler = requests.get(message.method)
      if (!handler) throw rpcError(METHOD_NOT_FOUND, `Method not implemented: ${message.method}`)

      const result = await handler(message.params, id)
      if (!claimResponse(id)) return
      post({ jsonrpc: JSON_RPC_VERSION, id: message.id ?? null, result })
    } catch (error) {
      if (!claimResponse(id)) return
      post({
        jsonrpc: JSON_RPC_VERSION,
        id: message.id ?? null,
        error: responseErrorFromThrown(error),
      })
    }
  }

  /**
   * Whether a response for this id may still be posted.
   *
   * A cancelled request answers nothing at all. The protocol also allows a `RequestCancelled` error
   * response, but by the time `$/cancelRequest` reaches this worker the client has already rejected
   * that request locally and forgotten its id (`LspClient.abortRequest`), so a late error has nowhere
   * to land — and a cancellation that abandons real work is the point of §C8, not response
   * suppression.
   */
  function claimResponse(id: JsonRpcRequestId | null): boolean {
    if (id === null) return true
    return inFlightRequests.delete(id)
  }

  function isCancelled(id: JsonRpcRequestId | null): boolean {
    return id !== null && !inFlightRequests.has(id)
  }

  function handleNotification(message: lsp.NotificationMessage): void {
    try {
      routeNotification(message)
    } catch (error) {
      postLogMessage(errorMessage(error))
    }
  }

  function routeNotification(message: lsp.NotificationMessage): void {
    if (message.method === '$/cancelRequest') return handleCancelRequest(message.params)
    if (message.method === 'exit') return shutdownState()
    if (message.method === 'textDocument/didOpen') return handleDidOpen(message.params)
    if (message.method === 'textDocument/didChange') return handleDidChange(message.params)
    if (message.method === 'textDocument/didClose') return handleDidClose(message.params)
    if (message.method === 'editor/typescript/setWorkspaceFiles')
      return handleSetWorkspaceFiles(message.params)
  }

  function handleCancelRequest(params: unknown): void {
    if (!isRecord(params)) return

    const id = params.id
    if (typeof id !== 'number' && typeof id !== 'string') return
    inFlightRequests.delete(id)
  }

  function initializeResult(params: unknown): lsp.InitializeResult {
    const initializationOptions = readInitializationOptions(params)
    compilerOptionsOverride = initializationOptions.compilerOptions ?? {}
    diagnosticDelayMs = initializationOptions.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS
    formatBase = { ...defaultFormatSettings(), ...initializationOptions.formatOptions }
    preferences = { ...DEFAULT_PREFERENCES, ...initializationOptions.preferences }
    clientCapabilities = readClientCapabilities(params)
    invalidateService()

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TEXT_DOCUMENT_SYNC_INCREMENTAL,
        },
        diagnosticProvider: {
          interFileDependencies: true,
          workspaceDiagnostics: false,
        },
        hoverProvider: true,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: Array.from(COMPLETION_TRIGGER_CHARACTERS),
        },
        signatureHelpProvider: {
          triggerCharacters: SIGNATURE_HELP_TRIGGER_CHARACTERS,
          retriggerCharacters: SIGNATURE_HELP_RETRIGGER_CHARACTERS,
        },
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        typeDefinitionProvider: true,
        documentHighlightProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        codeActionProvider: { codeActionKinds: CODE_ACTION_KINDS, resolveProvider: true },
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        documentOnTypeFormattingProvider: {
          firstTriggerCharacter: ON_TYPE_FORMATTING_FIRST_TRIGGER,
          moreTriggerCharacter: ON_TYPE_FORMATTING_MORE_TRIGGERS,
        },
        renameProvider: { prepareProvider: true },
        semanticTokensProvider: {
          legend: SEMANTIC_TOKEN_LEGEND,
          full: true,
          range: true,
        },
      },
    }
  }

  function shutdownResult(): null {
    shutdownState()
    return null
  }

  function shutdownState(): void {
    for (const timer of diagnosticTimers.values()) clearTimeout(timer)
    diagnosticTimers.clear()
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    documents.clear()
    workspaceFiles.clear()
    invalidateService()
  }

  function handleDidOpen(params: unknown): void {
    const textDocument = textDocumentItemFromParams(params)
    if (!textDocument) return

    const fileName = documentUriToFileName(textDocument.uri)
    if (!fileName) return
    if (!isTypeScriptLspSourceFileName(fileName)) return

    const document = {
      uri: textDocument.uri,
      fileName,
      languageId: textDocument.languageId,
      version: textDocument.version,
      text: textDocument.text,
    }
    documents.set(document.uri, document)
    void syncOpenDocumentToService(document)
    documentChanged(document.uri)
  }

  function handleDidChange(params: unknown): void {
    const change = didChangeParams(params)
    if (!change) return

    const current = documents.get(change.uri)
    if (!current) return

    const document = {
      ...current,
      version: change.version,
      text: applyContentChanges(current.text, change.contentChanges),
    }
    documents.set(document.uri, document)
    void syncOpenDocumentToService(document)
    documentChanged(document.uri)
  }

  function handleDidClose(params: unknown): void {
    const uri = textDocumentUri(params)
    if (!uri) return

    const document = documents.get(uri)
    documents.delete(uri)
    clearScheduledDiagnostics(uri)
    projectRevision += 1
    if (pushesDiagnostics()) postDiagnostics(uri, document?.version ?? null, [])
    if (document) void syncClosedDocumentToService(document)
  }

  function handleSetWorkspaceFiles(params: unknown): void {
    workspaceFiles = workspaceFileMap(params)
    invalidateService()
    projectRevision += 1
    if (pushesDiagnostics()) {
      for (const uri of documents.keys()) scheduleDiagnostics(uri)
      return
    }
    scheduleDiagnosticRefresh()
  }

  function documentChanged(uri: lsp.DocumentUri): void {
    projectRevision += 1
    if (pushesDiagnostics()) {
      scheduleDiagnostics(uri)
      return
    }
    // The client pulls for the document it just changed; any other open one may have changed too.
    if (documents.size > 1) scheduleDiagnosticRefresh()
  }

  async function syncOpenDocumentToService(document: WorkerDocument): Promise<void> {
    if (!servicePromise) return

    try {
      const state = await ensureService()
      upsertEnvironmentFile(state.env, document.fileName, document.text)
    } catch (error) {
      postLogMessage(errorMessage(error))
    }
  }

  async function syncClosedDocumentToService(document: WorkerDocument): Promise<void> {
    if (!servicePromise) return

    try {
      const state = await ensureService()
      const workspaceText = workspaceFiles.get(document.fileName)
      if (workspaceText === undefined) {
        state.env.deleteFile(document.fileName)
        return
      }
      upsertEnvironmentFile(state.env, document.fileName, workspaceText)
    } catch (error) {
      postLogMessage(errorMessage(error))
    }
  }

  /** Clients that pull are never pushed to: the same diagnostics would be computed twice per edit. */
  function pushesDiagnostics(): boolean {
    return clientCapabilities.textDocument?.diagnostic === undefined
  }

  function scheduleDiagnostics(uri: lsp.DocumentUri): void {
    clearScheduledDiagnostics(uri)
    const timer = setTimeout(() => {
      diagnosticTimers.delete(uri)
      void publishDiagnosticsForUri(uri)
    }, diagnosticDelayMs)
    diagnosticTimers.set(uri, timer)
  }

  function clearScheduledDiagnostics(uri: lsp.DocumentUri): void {
    const timer = diagnosticTimers.get(uri)
    if (!timer) return

    clearTimeout(timer)
    diagnosticTimers.delete(uri)
  }

  async function publishDiagnosticsForUri(uri: lsp.DocumentUri): Promise<void> {
    const scheduledDocument = documents.get(uri)
    if (!scheduledDocument) return

    try {
      const state = await ensureService()
      const currentDocument = documents.get(uri)
      if (!isCurrentDocument(scheduledDocument, currentDocument)) return

      const diagnostics = collectDiagnostics(state.env, currentDocument.fileName)
      postDiagnostics(currentDocument.uri, currentDocument.version, diagnostics)
    } catch (error) {
      postLogMessage(errorMessage(error))
    }
  }

  function scheduleDiagnosticRefresh(): void {
    if (clientCapabilities.workspace?.diagnostics?.refreshSupport !== true) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      serverRequestCount += 1
      post({
        jsonrpc: JSON_RPC_VERSION,
        id: `typescript-lsp-${serverRequestCount}`,
        method: DIAGNOSTIC_REFRESH,
      })
    }, diagnosticDelayMs)
  }

  /**
   * Waits out the same delay a push would, so a burst of keystrokes costs one computation: each
   * keystroke's pull cancels the one before it, and a cancelled pull stops here.
   */
  async function pullDiagnostics(
    params: unknown,
    id: JsonRpcRequestId | null,
  ): Promise<lsp.DocumentDiagnosticReport> {
    await delay(diagnosticDelayMs)
    const empty: lsp.DocumentDiagnosticReport = { kind: 'full', items: [] }
    if (isCancelled(id)) return empty

    const revision = projectRevision
    return withDocument(params, id, empty, (ctx) => documentDiagnosticReport(ctx, params, revision))
  }

  /**
   * Runs a document request against the service and the document together, once both have settled —
   * or answers `empty` if the document moved out from under the request while we waited.
   *
   * `ensureService()` can suspend for a long time — the first call loads the lib set, and
   * `handleSetWorkspaceFiles` invalidates the service so that recurs — and notifications are routed
   * the moment they arrive, with nothing serialising them behind an in-flight request. So a
   * `didChange` lands freely inside that window, and a handler still holding the document it
   * captured before the await would read positions from one version against a service built from
   * another: an answer consistent with neither, which no host-side version check can reconcile.
   */
  async function withDocument<R>(
    params: unknown,
    id: JsonRpcRequestId | null,
    empty: R,
    run: (ctx: DocumentContext) => R,
  ): Promise<R> {
    const uri = textDocumentUri(params)
    const requested = uri ? documentForUri(uri) : null
    if (!requested) return empty

    const state = await ensureService()
    const current = documentForUri(requested.uri)
    if (!current || !isCurrentDocument(requested, current)) return empty
    if (isCancelled(id)) return empty

    return run(
      documentContext(state.env, current, id, formatSettingsFor(formatBase, null, current.text)),
    )
  }

  /** A formatting request also teaches the session the editor's indentation for later edits. */
  function withFormatting(
    params: unknown,
    id: JsonRpcRequestId | null,
    run: (ctx: DocumentContext) => lsp.TextEdit[],
  ): Promise<lsp.TextEdit[]> {
    formatBase = formatSettingsFor(formatBase, params, '')
    return withDocument(params, id, [], run)
  }

  async function withService<R>(
    id: JsonRpcRequestId | null,
    run: (ctx: ServiceContext) => R,
  ): Promise<R> {
    const state = await ensureService()
    return run(serviceContext(state.env, id, formatBase))
  }

  function serviceContext(
    env: VirtualTypeScriptEnvironment,
    id: JsonRpcRequestId | null,
    formatSettings: ts.FormatCodeSettings,
  ): ServiceContext {
    return {
      env,
      formatSettings,
      preferences,
      documentChanges: clientCapabilities.workspace?.workspaceEdit?.documentChanges === true,
      linesOf: (fileName) => linesOf(env, fileName),
      uriOf,
      fileNameOf: (uri) => documents.get(uri)?.fileName ?? documentUriToFileName(uri),
      versionOf: (uri) => documents.get(uri)?.version ?? null,
      cancelled: () => isCancelled(id),
    }
  }

  function documentContext(
    env: VirtualTypeScriptEnvironment,
    document: WorkerDocument,
    id: JsonRpcRequestId | null,
    formatSettings: ts.FormatCodeSettings,
  ): DocumentContext {
    return {
      ...serviceContext(env, id, formatSettings),
      document,
      lines: lineIndexFor(document.fileName, document.text),
    }
  }

  function linesOf(env: VirtualTypeScriptEnvironment, fileName: string): LineIndex | null {
    const text = textOf(env, fileName)
    if (text === null) return null
    return lineIndexFor(fileName, text)
  }

  function textOf(env: VirtualTypeScriptEnvironment, fileName: string): string | null {
    const workspaceName = workspaceFileNameForResult(workspaceFiles, fileName)
    const openDocument = documentForFileName(workspaceName)
    if (openDocument) return openDocument.text

    const workspaceText = workspaceFiles.get(workspaceName)
    if (workspaceText !== undefined) return workspaceText

    return env.getSourceFile(sourcePathToFileName(fileName))?.text ?? null
  }

  function lineIndexFor(fileName: string, text: string): LineIndex {
    const cached = lineIndexes.get(fileName)
    if (cached?.text === text) return cached

    lineIndexes.delete(fileName)
    if (lineIndexes.size >= LINE_INDEX_CACHE_LIMIT) {
      const oldest = lineIndexes.keys().next().value
      if (oldest !== undefined) lineIndexes.delete(oldest)
    }
    const index = new LineIndex(text)
    lineIndexes.set(fileName, index)
    return index
  }

  function uriOf(fileName: string): lsp.DocumentUri {
    const workspaceName = workspaceFileNameForResult(workspaceFiles, fileName)
    return documentForFileName(workspaceName)?.uri ?? fileNameToDocumentUri(workspaceName)
  }

  function documentForUri(uri: lsp.DocumentUri): WorkerDocument | null {
    const openDocument = documents.get(uri)
    if (openDocument) return openDocument

    const fileName = documentUriToFileName(uri)
    if (!fileName) return null

    const text = workspaceFiles.get(fileName)
    if (text === undefined) return null

    return { uri, fileName, languageId: 'typescript', version: 0, text }
  }

  function documentForFileName(fileName: string): WorkerDocument | null {
    for (const document of documents.values()) {
      if (document.fileName === fileName) return document
    }
    return null
  }

  function ensureService(): Promise<ServiceState> {
    if (servicePromise) return servicePromise

    servicePromise = createService().catch((error: unknown) => {
      servicePromise = null
      throw error
    })
    return servicePromise
  }

  async function createService(): Promise<ServiceState> {
    const projectConfig = readProjectConfig(workspaceFiles, (diagnostic) =>
      postLogMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    )
    const compilerOptions = resolvedCompilerOptions(projectConfig, compilerOptionsOverride)
    const libraryFiles = await loadLibraryFiles(vfsLibraryCompilerOptions(compilerOptions))
    const fsMap = projectFileMap(libraryFiles, workspaceFiles, documents.values())
    const env = createVirtualTypeScriptEnvironment(
      createSystem(fsMap),
      rootFileNames(fsMap, projectConfig, documents.values()),
      ts,
      compilerOptions,
    )
    return { env }
  }

  function invalidateService(): void {
    servicePromise = null
    lineIndexes.clear()
  }

  function parameterLabelOffsets(): boolean {
    return (
      clientCapabilities.textDocument?.signatureHelp?.signatureInformation?.parameterInformation
        ?.labelOffsetSupport === true
    )
  }

  function hierarchicalSymbols(): boolean {
    return (
      clientCapabilities.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport === true
    )
  }

  function postDiagnostics(
    uri: lsp.DocumentUri,
    version: number | null,
    diagnostics: readonly lsp.Diagnostic[],
  ): void {
    const params: PublishDiagnosticsNotificationParams =
      version === null ? { uri, diagnostics } : { uri, version, diagnostics }
    post({ jsonrpc: JSON_RPC_VERSION, method: 'textDocument/publishDiagnostics', params })
  }

  function postLogMessage(message: string): void {
    post({
      jsonrpc: JSON_RPC_VERSION,
      method: 'window/logMessage',
      params: { type: LOG_MESSAGE_ERROR, message },
    })
  }

  function post(message: unknown): void {
    options.post(message)
  }

  return { receive, dispose: shutdownState }
}

function loadLibraryFilesFromCdn(
  compilerOptions: ts.CompilerOptions,
): Promise<ReadonlyMap<string, string>> {
  return createDefaultMapFromCDN(compilerOptions, ts.version, false, ts)
}

function upsertEnvironmentFile(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
  text: string,
): void {
  if (env.getSourceFile(fileName)) {
    env.updateFile(fileName, text)
    return
  }

  env.createFile(fileName, text)
}

function isCurrentDocument(
  scheduled: WorkerDocument,
  current: WorkerDocument | undefined | null,
): current is WorkerDocument {
  if (!current) return false
  return current.uri === scheduled.uri && current.version === scheduled.version
}

export function applyContentChanges(
  text: string,
  changes: readonly lsp.TextDocumentContentChangeEvent[],
): string {
  let nextText = text
  for (const change of changes) nextText = applyContentChange(nextText, change)
  return nextText
}

function applyContentChange(text: string, change: lsp.TextDocumentContentChangeEvent): string {
  if (!('range' in change) || !change.range) return change.text

  const start = lspPositionToOffset(text, change.range.start)
  const end = lspPositionToOffset(text, change.range.end)
  return `${text.slice(0, start)}${change.text}${text.slice(end)}`
}

function workspaceFileMap(params: unknown): Map<string, string> {
  const result = new Map<string, string>()
  for (const file of filesFromParams(params)) result.set(sourcePathToFileName(file.path), file.text)
  return result
}

function filesFromParams(params: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(params)) return []
  if (!Array.isArray(params.files)) return []
  return params.files.flatMap(parseSourceFile)
}

function parseSourceFile(value: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(value)) return []
  if (typeof value.path !== 'string') return []
  if (typeof value.text !== 'string') return []
  return [{ path: value.path, text: value.text }]
}

function readInitializationOptions(params: unknown): InitializationOptions {
  if (!isRecord(params)) return {}
  const options = params.initializationOptions
  if (!isRecord(options)) return {}

  return {
    compilerOptions: isRecord(options.compilerOptions)
      ? (options.compilerOptions as ts.CompilerOptions)
      : undefined,
    diagnosticDelayMs:
      typeof options.diagnosticDelayMs === 'number' ? options.diagnosticDelayMs : undefined,
    formatOptions: isRecord(options.formatOptions)
      ? (options.formatOptions as ts.FormatCodeSettings)
      : undefined,
    preferences: isRecord(options.preferences)
      ? (options.preferences as ts.UserPreferences)
      : undefined,
  }
}

function readClientCapabilities(params: unknown): lsp.ClientCapabilities {
  if (!isRecord(params)) return {}
  return isRecord(params.capabilities) ? (params.capabilities as lsp.ClientCapabilities) : {}
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
