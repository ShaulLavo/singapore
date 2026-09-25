import type { EditorDisposable } from '@singapore-editor/core/extensions'
import { createEditorCapabilityToken } from '@singapore-editor/core/extensions'
import type {
  LspClient,
  LspServerRequestHandler,
  LspWebSocketTransportOptions,
  LspWorkerLike,
} from '@singapore-editor/lsp'
import {
  createLanguageServerAdapterPlugin,
  createWebSocketLspTransportFactory,
  createWorkerLspTransportFactory,
  type LanguageServerConnectionContext,
  type LspConnectionTransportFactory,
} from '@singapore-editor/lsp-plugin'
import type { LanguageServerCompletionEditFeature } from '@singapore-editor/lsp-plugin/completion'

import { isTypeScriptLspSourceFileName } from './paths'
import {
  DELETE_WORKSPACE_FILES,
  LIBRARY_FILES_REQUEST,
  SET_WORKSPACE_FILES,
  UPSERT_WORKSPACE_FILES,
} from './worker/customMethods'
import type {
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
} from './types'

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 15000
const TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID = 'editor.typescript-lsp.completion-edit'
const TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE =
  createEditorCapabilityToken<LanguageServerCompletionEditFeature>(
    TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID,
  )

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: string | null
  readonly compilerOptions: TypeScriptLspPluginOptions['compilerOptions']
  readonly diagnosticDelayMs: number
  readonly libraryFiles: TypeScriptLspPluginOptions['libraryFiles']
  readonly timeoutMs: number
  readonly capabilities: TypeScriptLspPluginOptions['capabilities']
  readonly clientInfo: TypeScriptLspPluginOptions['clientInfo']
  readonly semanticTokens: TypeScriptLspPluginOptions['semanticTokens']
  readonly onConnectionCreated: TypeScriptLspPluginOptions['onConnectionCreated']
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange: TypeScriptLspPluginOptions['onStatusChange']
  readonly onDiagnostics: TypeScriptLspPluginOptions['onDiagnostics']
  readonly onOpenDefinition: TypeScriptLspPluginOptions['onOpenDefinition']
  readonly onOpenReferences: TypeScriptLspPluginOptions['onOpenReferences']
  readonly onApplyWorkspaceEdit: TypeScriptLspPluginOptions['onApplyWorkspaceEdit']
  readonly onRequestError: TypeScriptLspPluginOptions['onRequestError']
  readonly onError: TypeScriptLspPluginOptions['onError']
}

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  const resolved = resolveOptions(options)
  const workspaceFiles = new TypeScriptWorkspaceFiles()
  const plugin = createLanguageServerAdapterPlugin({
    name: 'editor.typescript-lsp',
    rootUri: resolved.rootUri,
    initializationOptions: typeScriptInitializationOptions(resolved),
    serverRequestHandlers: libraryRequestHandlers(resolved.libraryFiles),
    timeoutMs: resolved.timeoutMs,
    capabilities: resolved.capabilities,
    clientInfo: resolved.clientInfo,
    semanticTokens: resolved.semanticTokens,
    createTransport: typeScriptTransportFactory(resolved),
    documentSync: {
      shouldSyncLanguageId: isTypeScriptLspLanguage,
      shouldSyncUri: isTypeScriptLspSourceFileName,
    },
    diagnostics: {
      minimapSourceId: 'editor.typescript-lsp.diagnostics',
      highlightNameNamespace: 'typescript-lsp',
      markerTimingNamePrefix: 'typescriptLsp.marker',
    },
    completion: {
      editFeature: TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE,
      acceptTimingName: 'typescriptLsp.completion.accept',
      widgetClassNamespace: 'typescript-lsp',
      // The worker sends TypeScript's own per-item sets, so the sets this turns on are the ones the
      // language service vouches for rather than a guess made in the editor.
      acceptOnCommitCharacter: true,
    },
    hoverDefinition: {
      linkHighlightNameNamespace: 'typescript-lsp',
      tooltipClassNamespace: 'typescript-lsp',
      navigationTimingNamePrefix: 'typescriptLsp',
    },
    onConnectionCreated: (context) =>
      registerTypeScriptConnection(context, workspaceFiles, resolved),
    onConnected: (context) => workspaceFiles.syncClient(context.client),
    onStatusChange: resolved.onStatusChange,
    onDiagnostics: resolved.onDiagnostics,
    onOpenDefinition: resolved.onOpenDefinition,
    onOpenReferences: resolved.onOpenReferences,
    onApplyWorkspaceEdit: resolved.onApplyWorkspaceEdit,
    onRequestError: (_serverId, method, error) => resolved.onRequestError?.(method, error),
    onError: resolved.onError,
  })

  return {
    ...plugin,
    setWorkspaceFiles: (files) => workspaceFiles.setWorkspaceFiles(files),
    upsertWorkspaceFiles: (files) => workspaceFiles.upsertWorkspaceFiles(files),
    deleteWorkspaceFiles: (paths) => workspaceFiles.deleteWorkspaceFiles(paths),
    clearWorkspaceFiles: () => workspaceFiles.setWorkspaceFiles([]),
  }
}

/**
 * The host's files, kept here so a worker that reconnects starts from all of them; a connected
 * worker is told only what changed.
 */
class TypeScriptWorkspaceFiles {
  private readonly clients = new Map<LspClient, (error: unknown) => void>()
  private readonly files = new Map<string, string>()

  public setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    this.files.clear()
    for (const file of files) this.files.set(file.path, file.text)
    this.syncClients()
  }

  public upsertWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    const changed = files.filter((file) => this.files.get(file.path) !== file.text)
    if (changed.length === 0) return
    for (const file of changed) this.files.set(file.path, file.text)
    this.notifyClients(UPSERT_WORKSPACE_FILES, {
      files: changed.map((file) => ({ path: file.path, text: file.text })),
    })
  }

  public deleteWorkspaceFiles(paths: readonly string[]): void {
    const removed = paths.filter((path) => this.files.delete(path))
    if (removed.length === 0) return
    this.notifyClients(DELETE_WORKSPACE_FILES, { paths: removed })
  }

  public registerClient(
    client: LspClient,
    onError: ((error: unknown) => void) | undefined,
  ): EditorDisposable {
    this.clients.set(client, onError ?? ignoreConnectionError)
    return {
      dispose: () => {
        this.clients.delete(client)
      },
    }
  }

  public syncClient(client: LspClient): void {
    const onError = this.clients.get(client)
    if (!onError) return
    if (!client.initialized) return

    this.notify(client, onError, SET_WORKSPACE_FILES, {
      files: Array.from(this.files, ([path, text]) => ({ path, text })),
    })
  }

  private syncClients(): void {
    for (const client of this.clients.keys()) this.syncClient(client)
  }

  private notifyClients(method: string, params: unknown): void {
    for (const [client, onError] of this.clients) {
      if (client.initialized) this.notify(client, onError, method, params)
    }
  }

  private notify(
    client: LspClient,
    onError: (error: unknown) => void,
    method: string,
    params: unknown,
  ): void {
    void client.notify(method, params).catch((error: unknown) => onError(error))
  }
}

// The host's callback runs alongside the workspace-file registration rather than instead of it: the
// handle it is being given is the only way to reach the `LspClient`, and taking the workspace sync
// away as the price of holding it would be a trade nobody asked for.
function registerTypeScriptConnection(
  context: LanguageServerConnectionContext,
  workspaceFiles: TypeScriptWorkspaceFiles,
  options: TypeScriptLspResolvedOptions,
): EditorDisposable {
  const registration = workspaceFiles.registerClient(context.client, options.onError)
  const hostRegistration = options.onConnectionCreated?.(context) ?? null

  return {
    dispose: () => {
      hostRegistration?.dispose()
      registration.dispose()
    },
  }
}

function typeScriptTransportFactory(
  options: TypeScriptLspResolvedOptions,
): LspConnectionTransportFactory {
  if (options.webSocketRoute) {
    return createWebSocketLspTransportFactory(
      options.webSocketRoute,
      options.webSocketTransportOptions,
    )
  }
  if (options.workerFactory) return createWorkerLspTransportFactory(options.workerFactory)

  return missingWorkerTransportFactory
}

function missingWorkerTransportFactory(): never {
  throw new Error('TypeScript LSP worker factory was not configured')
}

function typeScriptInitializationOptions(options: TypeScriptLspResolvedOptions): unknown {
  return {
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs,
    libraryFiles: librarySource(options.libraryFiles),
  }
}

function librarySource(libraryFiles: TypeScriptLspPluginOptions['libraryFiles']): string {
  if (typeof libraryFiles === 'function') return 'host'
  return libraryFiles ?? 'bundled'
}

/** A host loader answers the worker's request for library files by name. */
function libraryRequestHandlers(
  libraryFiles: TypeScriptLspPluginOptions['libraryFiles'],
): Readonly<Record<string, LspServerRequestHandler<LspClient>>> {
  if (typeof libraryFiles !== 'function') return {}
  return {
    [LIBRARY_FILES_REQUEST]: async (_client, params) => ({
      files: await libraryFiles(libraryNames(params)),
    }),
  }
}

function libraryNames(params: unknown): readonly string[] {
  if (typeof params !== 'object' || params === null || !('names' in params)) return []
  const names = params.names
  return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []
}

function resolveOptions(options: TypeScriptLspPluginOptions): TypeScriptLspResolvedOptions {
  return {
    rootUri: options.rootUri ?? 'file:///',
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
    libraryFiles: options.libraryFiles,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
    semanticTokens: options.semanticTokens,
    onConnectionCreated: options.onConnectionCreated,
    workerFactory: options.workerFactory,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    onRequestError: options.onRequestError,
    onError: options.onError,
  }
}

function isTypeScriptLspLanguage(languageId: string): boolean {
  return (
    languageId === 'javascript' ||
    languageId === 'javascriptreact' ||
    languageId === 'typescript' ||
    languageId === 'typescriptreact'
  )
}

function ignoreConnectionError(): void {
  return undefined
}
