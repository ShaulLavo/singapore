import type { EditorDisposable, EditorPluginContext } from '@singapore-editor/core/extensions'
import type {
  TreeSitterLanguageAssets,
  TreeSitterLanguageContribution,
  TreeSitterLanguageDisposable,
} from './treeSitter/registry'
import { createTreeSitterWorkerOwner, type TreeSitterWorkerOwner } from './treeSitter/workerClient'

export type DefaultTreeSitterContextReference = {
  contributions: readonly EditorDisposable[]
  references: number
}

export type DefaultTreeSitterLanguageReference = {
  disposable: TreeSitterLanguageDisposable
  references: number
}

export type DefaultTreeSitterRegistration<TProvider> = {
  readonly owner: TreeSitterWorkerOwner
  provider: TProvider | null
  readonly contextReferences: WeakMap<EditorPluginContext, DefaultTreeSitterContextReference>
  readonly languageReferences: Map<string, DefaultTreeSitterLanguageReference>
  readonly loaderIdentityIds: WeakMap<() => Promise<TreeSitterLanguageAssets>, number>
  nextLoaderIdentityId: number
  activeContexts: number
  activeHighlighters: number
  pendingActivations: number
  idleDisposeTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

export const DEFAULT_TREE_SITTER_PROVIDER_KEY = Symbol.for(
  '@singapore-editor/tree-sitter/default-provider',
)

/**
 * Keeps the shared default Tree-sitter worker warm across brief SPA route transitions, then
 * terminates the worker and releases its WASM heap once no mounted editors or highlighters retain it.
 */
const DEFAULT_PROVIDER_IDLE_GRACE_MS = 5_000

export const getDefaultTreeSitterRegistration = <TProvider>(
  createProvider?: (owner: TreeSitterWorkerOwner) => TProvider,
): DefaultTreeSitterRegistration<TProvider> => {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[DEFAULT_TREE_SITTER_PROVIDER_KEY] as
    | DefaultTreeSitterRegistration<TProvider>
    | undefined
  if (existing && !existing.disposed) {
    if (existing.provider === null && createProvider) {
      existing.provider = createProvider(existing.owner)
    }
    return existing
  }

  const owner = createTreeSitterWorkerOwner()
  const registration: DefaultTreeSitterRegistration<TProvider> = {
    owner,
    provider: createProvider ? createProvider(owner) : null,
    contextReferences: new WeakMap<EditorPluginContext, DefaultTreeSitterContextReference>(),
    languageReferences: new Map<string, DefaultTreeSitterLanguageReference>(),
    loaderIdentityIds: new WeakMap<() => Promise<TreeSitterLanguageAssets>, number>(),
    nextLoaderIdentityId: 0,
    activeContexts: 0,
    activeHighlighters: 0,
    pendingActivations: 0,
    idleDisposeTimer: null,
    disposed: false,
  }
  state[DEFAULT_TREE_SITTER_PROVIDER_KEY] = registration
  return registration
}

export type DefaultTreeSitterOwnerLease = {
  readonly owner: TreeSitterWorkerOwner
  readonly release: () => void
}

export const retainDefaultTreeSitterOwner = (): DefaultTreeSitterOwnerLease => {
  const registration = getDefaultTreeSitterRegistration()
  cancelDefaultIdleDispose(registration)
  registration.activeHighlighters += 1
  let released = false
  return {
    owner: registration.owner,
    release: () => {
      if (released) return
      released = true
      registration.activeHighlighters = Math.max(0, registration.activeHighlighters - 1)
      scheduleDefaultIdleDisposeIfUnused(registration)
    },
  }
}

export const cancelDefaultIdleDispose = (
  registration: DefaultTreeSitterRegistration<unknown>,
): void => {
  if (registration.idleDisposeTimer === null) return

  clearTimeout(registration.idleDisposeTimer)
  registration.idleDisposeTimer = null
}

export const isDefaultRegistrationInUse = (
  registration: DefaultTreeSitterRegistration<unknown>,
): boolean =>
  registration.activeContexts > 0 ||
  registration.activeHighlighters > 0 ||
  registration.languageReferences.size > 0 ||
  registration.pendingActivations > 0

export const scheduleDefaultIdleDisposeIfUnused = (
  registration: DefaultTreeSitterRegistration<unknown>,
): void => {
  if (registration.disposed) return
  if (isDefaultRegistrationInUse(registration)) return
  if (registration.idleDisposeTimer !== null) return

  const timer = setTimeout(() => {
    void disposeDefaultRegistration(registration)
  }, DEFAULT_PROVIDER_IDLE_GRACE_MS)
  unrefTimer(timer)
  registration.idleDisposeTimer = timer
}

export const disposeDefaultRegistration = (
  registration: DefaultTreeSitterRegistration<unknown>,
): Promise<void> => {
  if (isDefaultRegistrationInUse(registration)) {
    return Promise.resolve()
  }
  cancelDefaultIdleDispose(registration)
  if (registration.disposed) return Promise.resolve()

  registration.disposed = true
  const state = globalThis as Record<PropertyKey, unknown>
  if (state[DEFAULT_TREE_SITTER_PROVIDER_KEY] === registration) {
    delete state[DEFAULT_TREE_SITTER_PROVIDER_KEY]
  }
  return registration.owner.dispose()
}

export const flushDefaultTreeSitterProvider = (): Promise<void> => {
  const state = globalThis as Record<PropertyKey, unknown>
  const registration = state[DEFAULT_TREE_SITTER_PROVIDER_KEY] as
    | DefaultTreeSitterRegistration<unknown>
    | undefined
  if (!registration) return Promise.resolve()
  return disposeDefaultRegistration(registration)
}

export const languageRegistrationKey = (
  registration: DefaultTreeSitterRegistration<unknown>,
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
  registration: DefaultTreeSitterRegistration<unknown>,
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
