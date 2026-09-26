import type { EditorCommandId } from './editor/commands'
import type { Editor } from './editor/Editor'
import { EditorDisposableStore } from './editor/disposables'
import type {
  EditorCommandHandler,
  EditorDisposable,
  EditorInternalViewContributionContext,
  EditorPlugin,
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionInput,
  EditorViewContributionUpdateKind,
  EditorViewportSnapshot,
  EditorViewSnapshot,
  EditorVisibleRowSnapshot,
} from './plugins'
import type { EditorTheme } from './theme'
import type { EditorTokenStore } from './syntax/tokenStore'
import type { TextReadSnapshot } from './documentTextSnapshot'
import type { TextEdit } from './tokens'

/**
 * A value the editor publishes, read from a view snapshot. `kinds` are the update kinds that can
 * change it: a scope watching it is updated for those and nothing else.
 */
export type EditorInput<T> = {
  readonly id: string
  readonly kinds: readonly EditorViewContributionInput[]
  read(snapshot: EditorViewSnapshot): T
  // A method, so an input of a narrower value still counts as an input of `unknown` among sources.
  equals?(left: T, right: T): boolean
  /** Set on a derived input: recomputed only when one of these changed. */
  readonly sources?: readonly EditorInput<unknown>[]
  /** Set on scope state: changes arrive from `set`, outside any view pass. */
  readonly subscribe?: (listener: () => void) => EditorDisposable
}

export const selectionInput: EditorInput<readonly EditorResolvedSelection[]> = {
  id: 'selection',
  kinds: ['selection', 'content'],
  read: (snapshot) => snapshot.selections,
  equals: sameSelections,
}

export const textInput: EditorInput<TextReadSnapshot> = {
  id: 'text',
  kinds: ['content'],
  read: (snapshot) => snapshot.textSnapshot,
}

export const visibleRowsInput: EditorInput<readonly EditorVisibleRowSnapshot[]> = {
  id: 'visibleRows',
  kinds: ['content', 'tokens', 'viewport', 'layout'],
  read: (snapshot) => snapshot.visibleRows,
}

export const viewportInput: EditorInput<EditorViewportSnapshot> = {
  id: 'viewport',
  kinds: ['viewport', 'layout'],
  read: (snapshot) => snapshot.viewport,
}

export const tokensInput: EditorInput<EditorTokenStore> = {
  id: 'tokens',
  kinds: ['tokens'],
  read: (snapshot) => snapshot.tokens,
}

export const themeInput: EditorInput<EditorTheme | null> = {
  id: 'theme',
  kinds: ['tokens'],
  read: (snapshot) => snapshot.theme ?? null,
}

/** The open document's id. It changes only with a document, which reaches every scope. */
export const documentInput: EditorInput<string | null> = {
  id: 'document',
  kinds: [],
  read: (snapshot) => snapshot.documentId,
}

/** A value computed from other inputs, recomputed when one of them changes and quiet while `equals` holds. */
export function derive<const Sources extends readonly EditorInput<unknown>[], T>(
  sources: Sources,
  compute: (...values: { [Index in keyof Sources]: InputValue<Sources[Index]> }) => T,
  equals?: (left: T, right: T) => boolean,
): EditorInput<T> {
  const kinds = new Set<EditorViewContributionInput>()
  for (const source of sources) for (const kind of source.kinds) kinds.add(kind)
  return {
    id: `derive(${sources.map((source) => source.id).join(',')})`,
    kinds: [...kinds],
    read: (snapshot) =>
      compute(...(sources.map((source) => source.read(snapshot)) as InputValues<Sources>)),
    equals,
    sources,
  }
}

type InputValue<Input> = Input extends EditorInput<infer T> ? T : never
type InputValues<Sources extends readonly EditorInput<unknown>[]> = {
  [Index in keyof Sources]: InputValue<Sources[Index]>
}

export type EditorViewState<T> = {
  get(): T
  set(value: T): void
  readonly input: EditorInput<T>
}

/**
 * Everything one plugin does in one editor view. What it registers here is owned by the scope and
 * released with the view or the plugin.
 */
export type EditorViewScope = {
  /** The live editor. Unstable: calling setPlugins, dispose or openDocument from a listener is unsupported. */
  readonly editor: Editor
  /** The view's DOM, geometry and highlight surface, for what the scope does not wrap. */
  readonly view: EditorViewContributionContext
  read<T>(input: EditorInput<T>): T
  /** Calls `listener` now and whenever the value changes; returns what stops it. */
  watch<T>(
    input: EditorInput<T>,
    listener: (value: T, snapshot: EditorViewSnapshot) => void,
  ): EditorDisposable
  state<T>(initial: T): EditorViewState<T>
  handle(command: EditorCommandId, run: EditorCommandHandler): void
  getSelections(): readonly EditorResolvedSelection[]
  applyEdits(edits: readonly TextEdit[], selection?: EditorSelectionRange): void
  onDispose(cleanup: () => void): void
  own(disposable: EditorDisposable): void
}

export type EditorPluginDefinition = {
  /** Identity for dedup and the namespace a plugin's commands will live under. */
  readonly name: string
  /** Once per editor view the plugin is installed in. */
  view?(scope: EditorViewScope): void
}

/** The one way to author a plugin; experimental. It lowers onto `EditorPlugin`. */
export function createPlugin(definition: EditorPluginDefinition): EditorPlugin {
  return {
    name: definition.name,
    activate(context) {
      const view = definition.view
      if (!view) return
      return context.registerViewContribution({
        createContribution: (viewContext) =>
          createScopeContribution(viewContext as EditorInternalViewContributionContext, view),
      })
    },
  }
}

type Watcher = {
  readonly input: EditorInput<unknown>
  readonly listener: (value: unknown, snapshot: EditorViewSnapshot) => void
  sources: readonly unknown[] | null
  value: { readonly current: unknown } | null
}

function createScopeContribution(
  context: EditorInternalViewContributionContext,
  setup: (scope: EditorViewScope) => void,
): EditorViewContribution {
  const owned = new EditorDisposableStore()
  const watchers = new Set<Watcher>()
  let settingUp = true

  const deliver = (watcher: Watcher, snapshot: EditorViewSnapshot, force: boolean) => {
    const sources = watcher.input.sources?.map((source) => source.read(snapshot)) ?? null
    if (!force && sources && watcher.sources && sameValues(watcher.input, sources, watcher.sources))
      return
    watcher.sources = sources
    const next = watcher.input.read(snapshot)
    const previous = watcher.value
    if (!force && previous && sameValue(watcher.input, previous.current, next)) return
    watcher.value = { current: next }
    watcher.listener(next, snapshot)
  }

  const scope: EditorViewScope = {
    editor: context.unstableEditor as Editor,
    view: context,
    read: (input) => input.read(context.getSnapshot()),
    watch: (input, listener) => {
      const watcher: Watcher = {
        input: input as EditorInput<unknown>,
        listener: listener as Watcher['listener'],
        sources: null,
        value: null,
      }
      const local = input.subscribe?.(() => deliver(watcher, context.getSnapshot(), false))
      watchers.add(watcher)
      if (!settingUp) context.refreshInputs()
      deliver(watcher, context.getSnapshot(), true)
      const registration = owned.add({
        dispose: () => {
          local?.dispose()
          watchers.delete(watcher)
          owned.delete(registration)
        },
      })
      return registration
    },
    state: (initial) => createState(initial),
    handle: (command, run) => void owned.add(context.registerCommand(command, run)),
    getSelections: () => context.getSelections(),
    applyEdits: (edits, selection) =>
      context.applyEdits(edits, 'editor.plugin.applyEdits', selection),
    onDispose: (cleanup) => void owned.add({ dispose: cleanup }),
    own: (disposable) => void owned.add(disposable),
  }

  try {
    setup(scope)
  } catch (error) {
    owned.dispose()
    throw error
  } finally {
    settingUp = false
  }

  return {
    get inputs() {
      const kinds = new Set<EditorViewContributionInput>()
      for (const watcher of watchers) for (const kind of watcher.input.kinds) kinds.add(kind)
      return [...kinds]
    },
    update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind) {
      const every = kind === 'document' || kind === 'clear'
      for (const watcher of [...watchers]) {
        // State changes arrive from `set`, never from a view pass.
        if (watcher.input.subscribe) continue
        if (!every && !watcher.input.kinds.includes(kind)) continue
        deliver(watcher, snapshot, false)
      }
    },
    dispose: () => owned.dispose(),
  }
}

function createState<T>(initial: T): EditorViewState<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (value) => {
      if (Object.is(value, current)) return
      current = value
      for (const listener of [...listeners]) listener()
    },
    input: {
      id: 'state',
      kinds: [],
      read: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return { dispose: () => void listeners.delete(listener) }
      },
    },
  }
}

function sameValue(input: EditorInput<unknown>, left: unknown, right: unknown): boolean {
  return input.equals ? input.equals(left, right) : Object.is(left, right)
}

function sameValues(
  input: EditorInput<unknown>,
  next: readonly unknown[],
  previous: readonly unknown[],
): boolean {
  const sources = input.sources ?? []
  return next.every((value, index) => sameValue(sources[index]!, value, previous[index]))
}

function sameSelections(
  left: readonly EditorResolvedSelection[],
  right: readonly EditorResolvedSelection[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((selection, index) => {
    const other = right[index]!
    return (
      selection.anchorOffset === other.anchorOffset &&
      selection.headOffset === other.headOffset &&
      selection.affinity === other.affinity
    )
  })
}
