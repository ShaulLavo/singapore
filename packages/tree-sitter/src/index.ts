export { createTreeSitterInputEdits } from './treeSitter/edits'
export {
  createTreeSitterHighlighterPlugin,
  createTreeSitterHighlighterProvider,
  treeSitterHighlightLanguageForDocument,
  type ResolvedTreeSitterHighlightLanguage,
  type TreeSitterHighlightLanguageMap,
  type TreeSitterHighlighterPluginOptions,
  type TreeSitterHighlighterProviderOptions,
  type TreeSitterThemeRegistrationResolver,
} from './highlighter'
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
  DEFAULT_TREE_SITTER_MAX_TOKENIZATION_LINE_LENGTH,
  canUseTreeSitterWorker,
  createTreeSitterWorkerOwner,
  TreeSitterWorkerOwner,
  type TreeSitterWorkerCacheSnapshot,
  type TreeSitterWorkerLifecycleState,
  type TreeSitterWorkerOwnerOptions,
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
  TreeSitterLanguageContribution,
  TreeSitterLanguageDescriptor,
  TreeSitterLanguageDisposable,
  TreeSitterLanguageId,
  TreeSitterLanguageRegistrationOptions,
  TreeSitterLanguageResolver,
} from './treeSitter/registry'
import {
  cancelDefaultIdleDispose,
  flushDefaultTreeSitterProvider,
  getDefaultTreeSitterRegistration,
  languageRegistrationKey,
  scheduleDefaultIdleDisposeIfUnused,
  type DefaultTreeSitterRegistration,
} from './defaultProvider'
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

type TreeSitterProviderRegistration = DefaultTreeSitterRegistration<TreeSitterSyntaxProvider> & {
  readonly provider: TreeSitterSyntaxProvider
}

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
      scheduleDefaultIdleDisposeIfUnused(registration)
      throw error
    }
  },
})

/**
 * Immediately disposes the idle default Tree-sitter provider (and terminates its worker) if no
 * active editors, highlighters, or language registrations currently retain it. Useful for
 * deterministic teardown in tests or route-exit cleanup.
 */
export { flushDefaultTreeSitterProvider }

/** Registers an already-configured provider with an editor without constructing another backend. */
export const createTreeSitterSyntaxPlugin = (
  provider: TreeSitterSyntaxProvider,
  options: TreeSitterSyntaxPluginOptions = {},
): EditorPlugin => ({
  name: options.name ?? 'tree-sitter-syntax',
  activate: (context) => contributeToEditor(context, provider),
})

const defaultProviderRegistration = (): TreeSitterProviderRegistration =>
  getDefaultTreeSitterRegistration((owner) =>
    createTreeSitterSyntaxProvider({ workerOwner: owner }),
  ) as TreeSitterProviderRegistration

const retainSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): EditorDisposable => {
  const existing = registration.contextReferences.get(context)
  if (existing) {
    cancelDefaultIdleDispose(registration)
    existing.references += 1
  } else {
    registration.pendingActivations += 1
    try {
      const contributions = contributeToEditor(context, registration.provider)
      cancelDefaultIdleDispose(registration)
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
    cancelDefaultIdleDispose(registration)
    existing.references += 1
  } else {
    registration.pendingActivations += 1
    try {
      const disposable = registration.provider.registerLanguage(contribution, { replace: true })
      cancelDefaultIdleDispose(registration)
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

const disposeContributionsInReverse = (
  contributions: readonly { readonly dispose: () => void }[],
): { readonly hasError: boolean; readonly firstError: unknown } => {
  let firstError: unknown
  let hasError = false
  for (const contribution of contributions.toReversed()) {
    try {
      contribution.dispose()
    } catch (error) {
      if (hasError) continue
      firstError = error
      hasError = true
    }
  }
  return { hasError, firstError }
}

const releaseSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): void => {
  const reference = registration.contextReferences.get(context)
  if (!reference) return

  reference.references -= 1
  if (reference.references > 0) return

  registration.contextReferences.delete(context)
  registration.activeContexts = Math.max(0, registration.activeContexts - 1)
  let outcome: { readonly hasError: boolean; readonly firstError: unknown }
  try {
    outcome = disposeContributionsInReverse(reference.contributions)
  } finally {
    scheduleDefaultIdleDisposeIfUnused(registration)
  }
  if (outcome.hasError) throw outcome.firstError
}

const releaseLanguage = (registration: TreeSitterProviderRegistration, key: string): void => {
  const reference = registration.languageReferences.get(key)
  if (!reference) return

  reference.references -= 1
  if (reference.references > 0) return

  registration.languageReferences.delete(key)
  try {
    reference.disposable.dispose()
  } finally {
    scheduleDefaultIdleDisposeIfUnused(registration)
  }
}
