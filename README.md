# Singapore

Singapore is a modular code editor for the browser. Every edit creates a new
version of persistent text, while optional packages add syntax highlighting,
language services, search, diffs, framework adapters and more.

## Install

```sh
npm install @singapore-editor/core vite
```

```ts
import { Editor } from '@singapore-editor/core/editor'
import '@singapore-editor/core/style.css'

const editor = new Editor(document.querySelector<HTMLElement>('#editor')!)
editor.setText('const greeting = "Hello, Singapore"\n')
```

Use the package you need from the [`packages/`](packages/) directory. The
[documentation site](https://singapore.shaulavo.dev/docs/start-here/introduction/)
has the quick start, guides and generated API reference.

## Develop

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run test
```

See [docs/development.md](docs/development.md) for browser tests, the demo,
package checks and the release tarball verification.

## Links

- [Documentation](https://singapore.shaulavo.dev/)
- [Issues and discussions](https://github.com/ShaulLavo/singapore/issues)
- [License](LICENSE)
