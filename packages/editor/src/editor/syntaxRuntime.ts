// Imports nothing: the modules that install into it (document analysis, the syntax controller) and
// the editor that reads it sit on opposite sides of the import graph, and this is where they meet
// without either importing the other. Typed accessors live in `syntaxPipeline.ts`.

// On the global object rather than in this module, so that a page which ends up with two copies of
// the package (a provider resolved through another path) still finds what a provider installed.
const RUNTIME_KEY = Symbol.for('@singapore-editor/core/syntax-runtime')

export type EditorSyntaxRuntimeSlot = 'analysis' | 'controller'

type RuntimeHolder = { [RUNTIME_KEY]?: Partial<Record<EditorSyntaxRuntimeSlot, unknown>> }

export function installEditorSyntaxRuntime(slot: EditorSyntaxRuntimeSlot, value: unknown): void {
  const holder = globalThis as RuntimeHolder
  const runtime = (holder[RUNTIME_KEY] ??= {})
  runtime[slot] ??= value
}

export function installedEditorSyntaxRuntime(slot: EditorSyntaxRuntimeSlot): unknown {
  return (globalThis as RuntimeHolder)[RUNTIME_KEY]?.[slot]
}
