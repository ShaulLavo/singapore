# @singapore-editor/shiki

Optional Shiki and TextMate syntax highlighter for Singapore.

Tree-sitter is the default highlighting engine in `@singapore-editor/tree-sitter` and `@singapore-editor/highlighting`. It renders both built-in editor palettes and VS Code themes natively through `@shaulavo/tree-sitter-scope-compat`, without Oniguruma or TextMate bundles. There is almost no reason to install `@singapore-editor/shiki` unless you specifically want Shiki or TextMate grammars. Callers that do not install or import this package pay zero runtime or bundle cost.

## Install

Not on npm yet. Build it from source with the [development guide](https://github.com/ShaulLavo/singapore/blob/main/docs/development.md#set-up).

## Usage

```ts
import { Editor } from '@singapore-editor/core/editor'
import {
  createShikiHighlighterPlugin,
  editorThemeToShikiTheme,
  loadShikiGrammar,
} from '@singapore-editor/shiki'

const host = document.createElement('div')
host.style.height = '400px'
document.body.append(host)

const editor = new Editor(host, {
  plugins: [
    createShikiHighlighterPlugin({
      theme: 'dark',
      resolveLanguage: (lang) => loadShikiGrammar(lang),
      resolveTheme: async () => editorThemeToShikiTheme({ type: 'dark' }, { name: 'dark' }),
    }),
  ],
})
editor.setText('const value = 1\n', { languageId: 'typescript' })
```

## API

- `createShikiHighlighterPlugin()`, `createShikiHighlighterProvider()`, `createShikiWorkerOwner()`
- `shikiHighlightingGrammar()`, `loadShikiGrammar()`

[Generated API reference](https://singapore.shaulavo.dev/docs/reference/api/shiki/overview/) · [License](https://github.com/ShaulLavo/singapore/blob/main/LICENSE)
