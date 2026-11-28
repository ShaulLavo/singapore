# The shared service

One `HighlightingService` per page can serve every editor, diff, and snippet. It owns grammar loading, VS Code theme registration through `@shaulavo/tree-sitter-scope-compat`, and the lifetime of its single Tree-sitter worker. It does not load Shiki or Oniguruma. Callers bring VS Code theme data and, optionally, the languages they expect to open.

## Creating one

```ts
import { createHighlightingService, createHighlightingPlugin } from '@singapore-editor/highlighting'

const highlighting = createHighlightingService({
  // Imported VS Code theme data, by the id a `vscode` selection names.
  resolveTheme: (id) => loadTheme(id),
  // Languages to prepare after first paint. Null prepares the default grammar set.
  preloadLanguages: () => workspaceLanguages,
})
```

Other options: `treeSitterBackend` replaces the default Tree-sitter worker, and `maxTokenizationLineLength` is read on every VS Code theme document open and snippet.

## Editors

```ts
const syntax = createHighlightingPlugin({
  service: highlighting,
  theme: { current: () => ({ format: 'vscode', id: 'dracula' }), subscribe },
})
```

`theme` is either a fixed selection (`{ format: 'editor' }` or `{ format: 'vscode', id }`) or a source with `current()` and an optional `subscribe(listener)` that returns an unsubscribe. Left out, documents use the editor's own palette.

A plugin given a `service` borrows it and never disposes it. Without one, each activation owns a service of its own.

Under an imported VS Code theme, `@shaulavo/tree-sitter-scope-compat` resolves TextMate scopes directly from Tree-sitter parses on the same worker and caches resolved scopes so theme switches recolor without reparsing. Switching back to the editor palette removes only the colors.

If you specifically need Shiki or TextMate grammars instead of Tree-sitter, use the separate optional `@singapore-editor/shiki` package directly.

## Diffs and prepared documents

`service.documentBackend(theme)` returns the backend `@singapore-editor/diff` accepts, `{ kind: 'highlighter' }` or `{ kind: 'tree-sitter' }`, for that theme. `prepareDiff(file, theme)` parses a diff ahead of its view and `showDiff(view, file, side, theme)` picks up the kept result.

## Snippets

```ts
const result = await highlighting.highlight(sample, {
  language: 'typescript',
  theme: { format: 'vscode', definition: registration },
  signal,
})
```

- Needs no DOM, editor, or document.
- Tokens are UTF-16 offsets into exactly the submitted text, and frozen.
- `themeRevision` follows the theme's content, so two themes with the same name and different colors get different revisions.
- With no `theme`, snippets paint with `github-dark`. `{ format: 'editor', definition }` takes an editor palette.
- An unknown language answers `language: 'text'` with no tokens.
- Aborting rejects that caller with an `AbortError`. The shared worker keeps serving everyone else.
- With no worker available the call rejects with a `HighlightingError` of code `unavailable`. It never tokenizes on the main thread.

`highlightLines(text, tokens)` turns a result into lines of styled segments for renderers that draw spans.

## Disposal

Whoever created the service disposes it. `await highlighting.dispose()` stops the Tree-sitter worker and rejects work still in flight. Calling it twice is safe.
