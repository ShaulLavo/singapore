# @singapore-editor/highlighting

Worker-based Tree-sitter syntax highlighting for Singapore editors, diffs, and code snippets.

Part of [Singapore](https://singapore.shaulavo.dev/). A code editor for the browser that keeps every version.

Tree-sitter is the default highlighting engine for both editor palettes and VS Code themes via `@shaulavo/tree-sitter-scope-compat`, running in a single Tree-sitter worker with no Shiki or Oniguruma runtime. Only install [`@singapore-editor/shiki`](https://github.com/ShaulLavo/singapore/blob/main/packages/shiki/README.md) if you specifically want Shiki or TextMate grammars.

## Install

Not on npm yet. Build it from source with the [development guide](https://github.com/ShaulLavo/singapore/blob/main/docs/development.md#set-up).

## Usage

```ts
import { createHighlightingService, highlightLines } from '@singapore-editor/highlighting'

const service = createHighlightingService()
const text = 'const value = 1\n'
const result = await service.highlight(text, { language: 'typescript' })
for (const line of highlightLines(text, result.tokens)) {
  console.log(line.map((segment) => segment.text).join(''))
}
await service.dispose()
```

## API highlights

- `createHighlightingService()` creates a shared Tree-sitter service for snippets, editors, and diffs.
- `highlightLines()` splits tokens into line segments.
- `createHighlightingPlugin()` connects the service to an editor.

[Generated API reference](https://singapore.shaulavo.dev/docs/reference/api/highlighting/overview/) · [Service docs](https://github.com/ShaulLavo/singapore/blob/main/packages/highlighting/docs/service.md) · [License](https://github.com/ShaulLavo/singapore/blob/main/LICENSE)
