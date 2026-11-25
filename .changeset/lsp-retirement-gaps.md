---
'@singapore-editor/lsp': patch
'@singapore-editor/lsp-plugin': patch
---

Close the remaining ways one workspace could run two language servers, and stop reading `file://host` as a local path.

- `LspConnection` and `LspConnectionPool` finish every state change, the retirement a replacement waits for included, before they call host code such as a `stop` hook, `close()`, a Worker's `terminate()` or a factory. Host code that disposes or acquires again re-enters a settled state. A host call that throws during disposal goes to `onError`, and the rest of the disposal still runs.
- `createTransport` receives an `AbortSignal`. A connection closed while its factory is still running waits for the factory to settle and for its transport's `gone`, and aborts the signal. A factory that ignores the signal and never settles blocks every later start for its key.
- `createWebSocketLspTransport` takes a `signal` option. Aborting it before the socket opens closes the socket and rejects with the abort reason. The built-in WebSocket factory passes the connection's signal, so a handshake that never finishes no longer holds back its replacement.
- `fileUriToPath` returns null for a URI that names only a host, such as `file://project`, so `sameFileUri('file://project', 'file:////project')` is false. `file:////project/a.ts` still maps to `//project/a.ts`.
