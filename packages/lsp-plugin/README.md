# @singapore-editor/lsp-plugin

Editor integration layer for LSP-backed Singapore language features.

This package adapts `@singapore-editor/lsp` transports to `@singapore-editor/core` plugins for diagnostics,
completion, hover, definition navigation, references, and document synchronization.

## Install

```sh
npm install @singapore-editor/core @singapore-editor/lsp @singapore-editor/lsp-plugin
```

## Usage

```ts
import {
  createLanguageServerAdapterPlugin,
  createWebSocketLspTransportFactory,
} from '@singapore-editor/lsp-plugin'

const plugin = createLanguageServerAdapterPlugin({
  name: 'typescript-lsp',
  createTransport: createWebSocketLspTransportFactory('ws://localhost:3000/lsp'),
  documentSync: {
    shouldSyncLanguageId: (languageId) => languageId === 'typescript',
  },
})
```

## Exports

- `createLanguageServerAdapterPlugin` creates the full editor integration.
- `createLanguageServerPlugin` exposes a lower-level plugin factory.
- `createWebSocketLspTransportFactory` and `createWorkerLspTransportFactory` create transport
  factories.
- Diagnostic, path, markdown tooltip, completion, and document-sync helpers are available through
  subpath exports.

## Document lifetime

The connection-only API owns its document session automatically. Dispose the editor to close it:

```ts
const plugin = createLanguageServerPlugin({
  webSocketRoute: 'ws://localhost:3001/lsp',
})
```

For tabs or split editors, create a session beside the text buffer and pass it to each view:

```ts
import {
  createLanguageServerDocument,
  createLanguageServerPlugin,
} from '@singapore-editor/lsp-plugin'

const document = createLanguageServerDocument({
  buffer,
  uri: 'file:///project/main.ts',
  languageId: 'typescript',
  lanes: [
    {
      id: 'typescript',
      features: { diagnostics: 0, completion: 0, hover: 0, navigation: 0 },
      webSocketRoute: 'ws://localhost:3001/lsp',
    },
  ],
})

const plugin = createLanguageServerPlugin({ document })
```

The session synchronizes buffer changes and receives diagnostics even with no mounted view.
Each view renders the current diagnostics on attachment. Disposing a view unsubscribes it;
it does not close the document. The host calls `document.dispose()` when the document closes.
Multiple views share the session, with independent completion, hover, and selection UI.

Use `documentId` when the editor uses an opaque identity different from the URI. Connection
options and an explicit `document` are mutually exclusive plugin inputs. Both forms use the
same synchronization and diagnostic implementation.

For shared sessions, pass `onApplyWorkspaceEdit` to `createLanguageServerDocument`.
The document uses it both to advertise workspace-edit support during initialization and to
apply edits requested by its views. It cannot be supplied on a plugin borrowing that document.
The connection-only plugin still accepts `onApplyWorkspaceEdit` directly.
