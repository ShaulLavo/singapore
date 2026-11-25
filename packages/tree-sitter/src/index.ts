export { createTreeSitterInputEdits } from './treeSitter/edits'
export {
  createTreeSitterSliceHighlighter,
  TreeSitterSliceHighlighter,
  type TreeSitterHighlightedSlice,
  type TreeSitterHighlightSlice,
  type TreeSitterSliceHighlighterOptions,
  type TreeSitterSliceHighlightLimits,
  type TreeSitterSliceHighlightResult,
} from './sliceHighlighting'
export {
  createTreeSitterReviewSyntax,
  type TreeSitterReviewSyntax,
  type TreeSitterReviewRead,
  type TreeSitterReviewUnit,
} from './mergeReview'
export {
  TreeSitterLanguageRegistry,
  createTreeSitterLanguageRegistry,
  isTreeSitterLanguageId,
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageContribution,
  type TreeSitterLanguageAssets,
  type TreeSitterLanguageContribution,
  type TreeSitterLanguageDescriptor,
  type TreeSitterLanguageDisposable,
  type TreeSitterLanguageId,
  type TreeSitterLanguageRegistrationOptions,
  type TreeSitterLanguageResolver,
} from './treeSitter/registry'
export type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterError,
  TreeSitterInjectionInfo,
  TreeSitterParseResult,
  TreeSitterMergeUnit,
  TreeSitterMergeUnitResult,
  TreeSitterProjectedMergeUnitsResult,
  TreeSitterSyntaxRange,
  TreeSitterPoint,
  TreeSitterWorkerRetentionSnapshot,
} from './treeSitter/types'
export {
  canUseTreeSitterWorker,
  createTreeSitterWorkerOwner,
  TreeSitterWorkerOwner,
  type TreeSitterWorkerCacheSnapshot,
  type TreeSitterWorkerLifecycleState,
  type TreeSitterWorkerOwnerSnapshot,
  type TreeSitterMergeUnitPayload,
  type TreeSitterProjectedMergeUnitsPayload,
} from './treeSitter/workerClient'
export {
  expandTreeSitterSelection,
  selectTreeSitterToken,
  shrinkTreeSitterSelection,
  type TreeSitterSelectionCommandOptions,
  type TreeSitterSelectionCommandResult,
  type TreeSitterSelectionExpansionState,
} from './structuralSelection'
import type { EditorSyntaxProvider } from '@singapore-editor/core/syntax'
import { defineStructuralOperation } from '@singapore-editor/core/internal/document-worker'
import type {
  EditorDisposable,
  EditorPlugin,
  EditorPluginContext,
} from '@singapore-editor/core/extensions'
import type {
  TreeSitterLanguageAssets,
  TreeSitterLanguageContribution,
  TreeSitterLanguageDescriptor,
  TreeSitterLanguageDisposable,
  TreeSitterLanguageId,
  TreeSitterLanguageRegistrationOptions,
  TreeSitterLanguageResolver,
} from './treeSitter/registry'
import { TreeSitterLanguageRegistry, resolveTreeSitterLanguageClosure } from './treeSitter/registry'
import { TreeSitterSyntaxSession } from './session'
import { treeSitterSelectionRanges } from './structuralSelection'
import {
  createTreeSitterWorkerOwner,
  treeSitterBackendForOwner,
  type TreeSitterBackend,
  type TreeSitterWorkerOwner,
} from './treeSitter/workerClient'

export type TreeSitterSyntaxProviderOptions = {
  readonly workerOwner?: TreeSitterWorkerOwner
  /**
   * Languages to compile ahead of their first document, read each time a document's first parse
   * answers, so the host's set can change (a workspace switch) and paint is never delayed. Each is
   * compiled once with its injection closure; unknown ids and load failures are skipped.
   */
  readonly warmLanguages?: () => readonly TreeSitterLanguageId[]
}

export type TreeSitterSyntaxProvider = EditorSyntaxProvider &
  TreeSitterLanguageResolver & {
    registerLanguage(
      contribution: TreeSitterLanguageContribution,
      options?: TreeSitterLanguageRegistrationOptions,
    ): TreeSitterLanguageDisposable
  }

export type TreeSitterLanguagePluginOptions = TreeSitterLanguageRegistrationOptions & {
  readonly name?: string
}

export type TreeSitterSyntaxPluginOptions = {
  readonly name?: string
}

type TreeSitterProviderRegistration = {
  readonly owner: TreeSitterWorkerOwner
  readonly provider: TreeSitterSyntaxProvider
  readonly contextReferences: WeakMap<EditorPluginContext, TreeSitterContextReference>
  readonly languageReferences: Map<string, TreeSitterLanguageReference>
  readonly loaderIdentityIds: WeakMap<() => Promise<TreeSitterLanguageAssets>, number>
  nextLoaderIdentityId: number
  activeContexts: number
  pendingActivations: number
  idleDisposeTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

type TreeSitterContextReference = {
  contributions: readonly EditorDisposable[]
  references: number
}

type TreeSitterLanguageReference = {
  disposable: TreeSitterLanguageDisposable
  references: number
}

const DEFAULT_TREE_SITTER_PROVIDER_KEY = Symbol.for(
  '@singapore-editor/tree-sitter/default-provider',
)

/**
 * Keeps the shared default Tree-sitter worker warm across brief SPA route transitions, then
 * terminates the worker and releases its WASM heap once no mounted editors retain it.
 */
const DEFAULT_PROVIDER_IDLE_GRACE_MS = 5_000

export const createTreeSitterSyntaxProvider = (
  options: TreeSitterSyntaxProviderOptions = {},
): TreeSitterSyntaxProvider => {
  const registry = new TreeSitterLanguageRegistry()
  const owner = options.workerOwner ?? createTreeSitterWorkerOwner()
  const backend = treeSitterBackendForOwner(owner)
  let warmedKey: string | null = null
  const warm = () => {
    const languageIds = options.warmLanguages?.() ?? []
    const key = languageIds.join('\n')
    if (languageIds.length === 0 || key === warmedKey) return
    warmedKey = key
    void warmTreeSitterLanguages(registry, backend, languageIds)
  }

  return {
    operation: defineStructuralOperation((sessionOptions) => {
      if (!sessionOptions.languageId) return null
      return new TreeSitterSyntaxSession({
        ...sessionOptions,
        // The worker knows grammars by id. A fence name such as `ts` reaches here from a hover.
        languageId:
          registry.resolveLanguageAlias(sessionOptions.languageId) ?? sessionOptions.languageId,
        languageResolver: registry,
        backend,
        onFirstParse: warm,
      })
    }),
    registerLanguage: (contribution, registrationOptions) => {
      const registration = registry.registerLanguage(contribution, registrationOptions)
      warmedKey = null
      return {
        dispose: () => {
          registration.dispose()
          warmedKey = null
        },
      }
    },
    resolveTreeSitterLanguage: (languageId) => registry.resolveTreeSitterLanguage(languageId),
  }
}

const warmTreeSitterLanguages = async (
  resolver: TreeSitterLanguageResolver,
  backend: TreeSitterBackend,
  languageIds: readonly TreeSitterLanguageId[],
): Promise<void> => {
  if (!backend.warmLanguages) return

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
  // Best effort: a worker that cannot start fails the first document too, which reports it.
  await backend.warmLanguages([...descriptors.values()]).catch(() => undefined)
}

export const createTreeSitterLanguagePlugin = (
  contributions: readonly TreeSitterLanguageContribution[],
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin => ({
  name: options.name ?? 'tree-sitter-languages',
  activate(context) {
    const registration = defaultProviderRegistration()
    const disposables: EditorDisposable[] = []
    try {
      disposables.push(retainSyntaxProvider(context, registration))
      for (const contribution of contributions) {
        disposables.push(retainLanguage(registration, contribution))
      }
      return disposables
    } catch (error) {
      for (const disposable of disposables.toReversed()) disposable.dispose()
      scheduleIdleDisposeIfUnused(registration)
      throw error
    }
  },
})

/**
 * Immediately disposes the idle default Tree-sitter provider (and terminates its worker) if no
 * active editors or language registrations currently retain it. Useful for deterministic teardown
 * in tests or route-exit cleanup.
 */
export const flushDefaultTreeSitterProvider = (): Promise<void> => {
  const state = globalThis as Record<PropertyKey, unknown>
  const registration = state[DEFAULT_TREE_SITTER_PROVIDER_KEY] as
    | TreeSitterProviderRegistration
    | undefined
  if (!registration) return Promise.resolve()
  return disposeDefaultProviderRegistration(registration)
}

/** Registers an already-configured provider with an editor without constructing another backend. */
export const createTreeSitterSyntaxPlugin = (
  provider: TreeSitterSyntaxProvider,
  options: TreeSitterSyntaxPluginOptions = {},
): EditorPlugin => ({
  name: options.name ?? 'tree-sitter-syntax',
  activate: (context) => contributeToEditor(context, provider),
})

const defaultProviderRegistration = (): TreeSitterProviderRegistration => {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[DEFAULT_TREE_SITTER_PROVIDER_KEY] as
    | TreeSitterProviderRegistration
    | undefined
  if (existing && !existing.disposed) return existing

  const owner = createTreeSitterWorkerOwner()
  const registration: TreeSitterProviderRegistration = {
    owner,
    provider: createTreeSitterSyntaxProvider({ workerOwner: owner }),
    contextReferences: new WeakMap<EditorPluginContext, TreeSitterContextReference>(),
    languageReferences: new Map<string, TreeSitterLanguageReference>(),
    loaderIdentityIds: new WeakMap<() => Promise<TreeSitterLanguageAssets>, number>(),
    nextLoaderIdentityId: 0,
    activeContexts: 0,
    pendingActivations: 0,
    idleDisposeTimer: null,
    disposed: false,
  }
  state[DEFAULT_TREE_SITTER_PROVIDER_KEY] = registration
  return registration
}

const retainSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): EditorDisposable => {
  const existing = registration.contextReferences.get(context)
  if (existing) {
    cancelIdleDispose(registration)
    existing.references += 1
  } else {
    registration.pendingActivations += 1
    try {
      const contributions = contributeToEditor(context, registration.provider)
      cancelIdleDispose(registration)
      registration.contextReferences.set(context, {
        contributions,
        references: 1,
      })
      registration.activeContexts += 1
    } finally {
      registration.pendingActivations -= 1
    }
  }

  let released = false
  return {
    dispose: () => {
      if (released) return
      released = true
      releaseSyntaxProvider(context, registration)
    },
  }
}

const contributeToEditor = (
  context: EditorPluginContext,
  provider: TreeSitterSyntaxProvider,
): readonly EditorDisposable[] => {
  const syntaxRegistration = context.registerSyntaxProvider(provider)
  try {
    const selectionRegistration = context.registerSelectionRangeProvider((selection) =>
      treeSitterSelectionRanges(selection.folds),
    )
    return [syntaxRegistration, selectionRegistration]
  } catch (error) {
    syntaxRegistration.dispose()
    throw error
  }
}

const retainLanguage = (
  registration: TreeSitterProviderRegistration,
  contribution: TreeSitterLanguageContribution,
): EditorDisposable => {
  const key = languageRegistrationKey(registration, contribution)
  const existing = registration.languageReferences.get(key)
  if (existing) {
    cancelIdleDispose(registration)
    existing.references += 1
  } else {
    registration.pendingActivations += 1
    try {
      const disposable = registration.provider.registerLanguage(contribution, { replace: true })
      cancelIdleDispose(registration)
      registration.languageReferences.set(key, {
        disposable,
        references: 1,
      })
    } finally {
      registration.pendingActivations -= 1
    }
  }

  let released = false
  return {
    dispose: () => {
      if (released) return
      released = true
      releaseLanguage(registration, key)
    },
  }
}

const releaseSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): void => {
  const reference = registration.contextReferences.get(context)
  if (!reference) return

  reference.references -= 1
  if (reference.references > 0) return

  for (const contribution of reference.contributions.toReversed()) contribution.dispose()
  registration.contextReferences.delete(context)
  registration.activeContexts = Math.max(0, registration.activeContexts - 1)
  scheduleIdleDisposeIfUnused(registration)
}

const releaseLanguage = (registration: TreeSitterProviderRegistration, key: string): void => {
  const reference = registration.languageReferences.get(key)
  if (!reference) return

  reference.references -= 1
  if (reference.references > 0) return

  reference.disposable.dispose()
  registration.languageReferences.delete(key)
  scheduleIdleDisposeIfUnused(registration)
}

const cancelIdleDispose = (registration: TreeSitterProviderRegistration): void => {
  if (registration.idleDisposeTimer === null) return

  clearTimeout(registration.idleDisposeTimer)
  registration.idleDisposeTimer = null
}

const isRegistrationInUse = (registration: TreeSitterProviderRegistration): boolean =>
  registration.activeContexts > 0 ||
  registration.languageReferences.size > 0 ||
  registration.pendingActivations > 0

const scheduleIdleDisposeIfUnused = (registration: TreeSitterProviderRegistration): void => {
  if (registration.disposed) return
  if (isRegistrationInUse(registration)) return
  if (registration.idleDisposeTimer !== null) return

  const timer = setTimeout(() => {
    void disposeDefaultProviderRegistration(registration)
  }, DEFAULT_PROVIDER_IDLE_GRACE_MS)
  unrefTimer(timer)
  registration.idleDisposeTimer = timer
}

const unrefTimer = (timer: unknown): void => {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof (timer as { readonly unref?: unknown }).unref === 'function'
  ) {
    ;(timer as { unref(): void }).unref()
  }
}

const disposeDefaultProviderRegistration = (
  registration: TreeSitterProviderRegistration,
): Promise<void> => {
  if (isRegistrationInUse(registration)) {
    return Promise.resolve()
  }
  cancelIdleDispose(registration)
  if (registration.disposed) return Promise.resolve()

  registration.disposed = true
  const state = globalThis as Record<PropertyKey, unknown>
  if (state[DEFAULT_TREE_SITTER_PROVIDER_KEY] === registration) {
    delete state[DEFAULT_TREE_SITTER_PROVIDER_KEY]
  }
  return registration.owner.dispose()
}

const languageRegistrationKey = (
  registration: TreeSitterProviderRegistration,
  contribution: TreeSitterLanguageContribution,
): string =>
  JSON.stringify({
    aliases: sortedItems(contribution.aliases),
    assets: inlineAssetSignature(contribution),
    extensions: sortedItems(contribution.extensions),
    filenames: sortedItems(contribution.filenames),
    id: contribution.id,
    injectionDependencies: sortedItems(contribution.injectionDependencies),
    loader: lazyLoaderSignature(registration, contribution),
  })

const lazyLoaderSignature = (
  registration: TreeSitterProviderRegistration,
  contribution: TreeSitterLanguageContribution,
):
  | { readonly kind: 'cacheKey'; readonly key: string }
  | { readonly kind: 'fn'; readonly id: number }
  | null => {
  if (!('load' in contribution) || !contribution.load) return null

  if (contribution.cacheKey !== undefined) {
    return { kind: 'cacheKey', key: contribution.cacheKey }
  }

  let id = registration.loaderIdentityIds.get(contribution.load)
  if (id === undefined) {
    id = ++registration.nextLoaderIdentityId
    registration.loaderIdentityIds.set(contribution.load, id)
  }
  return { kind: 'fn', id }
}

const inlineAssetSignature = (
  contribution: TreeSitterLanguageContribution,
): TreeSitterLanguageAssets | null => {
  if ('load' in contribution) return null

  return {
    foldQuerySource: contribution.foldQuerySource,
    highlightQuerySource: contribution.highlightQuerySource,
    injectionQuerySource: contribution.injectionQuerySource,
    mergeUnitQuerySource: contribution.mergeUnitQuerySource,
    wasmUrl: contribution.wasmUrl,
    extraWasmUrls: contribution.extraWasmUrls,
  }
}

const sortedItems = (items: readonly string[] | undefined): readonly string[] =>
  (items ?? []).toSorted()
