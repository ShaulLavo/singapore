# Language servers

Connect a language server for diagnostics, completion, hover and the features it supports. Syntax highlighting is a separate plugin.

## 1. Connect a WebSocket server

You need a server endpoint that carries LSP JSON-RPC messages. The example assumes your application hosts that endpoint at the shown local URL.

```sh
npm install @singapore-editor/core @singapore-editor/lsp @singapore-editor/lsp-plugin
```

```ts
import { Editor } from '@singapore-editor/core/editor'
import { createLanguageServerPlugin } from '@singapore-editor/lsp-plugin'

const editor = new Editor(document.querySelector<HTMLElement>('#editor')!, {
  plugins: [
    createLanguageServerPlugin({
      webSocketRoute: 'ws://localhost:3001/lsp',
      rootUri: 'file:///project',
    }),
  ],
})
editor.openDocument({
  documentId: '/project/main.ts',
  text: 'const value: number = "one"\n',
  languageId: 'typescript',
})
```

The document id maps to `file:///project/main.ts`. Use a secure WebSocket endpoint when serving the application over HTTPS.

## 2. Handle host actions

Use `onOpenDefinition` and `onOpenReferences` to open files in your application. Use `onApplyWorkspaceEdit` for edits spanning files. The server's capabilities determine which features are available. The plugin can expose diagnostics, completion, hover, signature help, definition, references, rename, code actions, formatting and document highlights.

## 3. Run TypeScript in a worker

`@singapore-editor/typescript-lsp` runs the TypeScript language service in the browser and supplies its standard-library declarations. Pass the other virtual files so imports resolve.

```ts
import { Editor } from '@singapore-editor/core/editor'
import { createTypeScriptLspPlugin } from '@singapore-editor/typescript-lsp'

const typescript = createTypeScriptLspPlugin()
typescript.setWorkspaceFiles([{ path: '/src/math.ts', text: 'export const answer = 42\n' }])
const editor = new Editor(document.querySelector<HTMLElement>('#editor')!, {
  plugins: [typescript],
})
editor.openDocument({
  documentId: '/src/main.ts',
  text: "import { answer } from './math'\nconsole.log(answer)\n",
  languageId: 'typescript',
})
```

`upsertWorkspaceFiles` and `deleteWorkspaceFiles` update that file set. Types for external imports must be available to the worker's project.

## 4. Connect a server process over its standard streams

A server that speaks LSP on stdin and stdout needs a host that holds the process. `createStdioLspTransport` adds and removes the `Content-Length` framing and gives you three things to wire to that process.

```ts
import { createStdioLspTransport } from '@singapore-editor/lsp'
import { createLanguageServerAdapterPlugin, pathToFileUri } from '@singapore-editor/lsp-plugin'

type ServerProcess = { kill(): void; exited: Promise<Error> }
declare function startServer(
  stdin: ReadableStream<Uint8Array>,
  onStdout: (bytes: Uint8Array) => void,
): ServerProcess

function connectServer() {
  const stdio = createStdioLspTransport({ stop: () => server.kill() })
  const server = startServer(stdio.stdin, stdio.stdout)
  void server.exited.then(stdio.exited)
  return stdio.transport
}

const plugin = createLanguageServerAdapterPlugin({
  name: 'typescript',
  rootUri: pathToFileUri('/project'),
  createTransport: connectServer,
  reconnect: { delaysMs: [250, 1000, 4000] },
  documentSync: {
    uriForDocument: (snapshot) => (snapshot.documentId ? pathToFileUri(snapshot.documentId) : null),
  },
})
```

`startServer` is yours. It pipes `stdin` into the process and calls `onStdout` with each chunk the process writes.

- Always call `exited` once the process and everything it started are gone, with the reason it ended, even after the connection was closed. The connection learns of a failed or exited server then, and it waits for that call before it starts a replacement, so two servers never run side by side. The new server receives `initialize` and every open document.
- `stop` is called at most once: when the connection is disposed, when the server writes bytes that are not a frame, sends a message over `maxMessageBytes`, stops reading its stdin until `maxPendingStdinBytes` are waiting, or closes its stdin. It may return a promise. A throw or rejection is reported as the reason for the loss.
- Keep handing over stdout until the process is gone. Output written after the server closed its stdin is still delivered, and a server that exits on its own partway through a message is reported as an `LspFramingError` whose `cause` is your reason.
- Keep the server's stderr away from `stdout`. A stray log line there is a protocol failure, reported as an `LspFramingError` that quotes it.

`pathToFileUri` and `fileUriToPath` map absolute POSIX paths to `file:` URIs exactly, for a host whose document ids are paths in the file tree the server reads. Nothing is normalized: `..` stays in the path for the file tree to resolve. Open a definition in another file from `onOpenDefinition` with `fileUriToPath(target.uri)`.

## If it doesn't work

### Completion and hover are absent

Check the connection status and server capabilities. Inspect worker or WebSocket failures. Confirm that the document language and URI match what the server expects.

### Imports are unresolved in the TypeScript worker

Add the referenced virtual files and declarations, using consistent paths. The worker sees the open document and files you supply.

Continue with the TypeScript playground and the generated `lsp`, `lsp-plugin` and `typescript-lsp` reference groups.
