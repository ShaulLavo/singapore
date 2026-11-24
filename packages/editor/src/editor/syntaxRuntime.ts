// Imports nothing: the syntax controller that installs itself here and the editor and plugin host
// that read it sit on opposite sides of the import graph, and this is where they meet without either
// importing the other. Typed accessors live in `syntaxPipeline.ts`.
//
// A module variable rather than anything global, so each copy of the package only ever sees the
// controller its own helpers installed: a provider and an editor from one copy are never paired with
// the analysis of another.

let installedController: unknown = null

export function installEditorSyntaxRuntime(controller: unknown): void {
  installedController ??= controller
}

export function installedEditorSyntaxRuntime(): unknown {
  return installedController
}

/**
 * Refuses a syntax or highlighter provider whose operation was built without the helpers that bring
 * the syntax controller, instead of letting the editor show it as plain text.
 */
export function requireEditorSyntaxRuntime(): void {
  if (installedController) return
  throw new TypeError(
    'Syntax and highlighter providers must be built with createEditorStructuralOperation or ' +
      'createEditorHighlighterOperation from @singapore-editor/core/editor, or defineStructuralOperation ' +
      'or defineHighlighterOperation from @singapore-editor/core/internal/document-worker',
  )
}
