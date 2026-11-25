---
'@singapore-editor/lsp': patch
'@singapore-editor/lsp-plugin': patch
---

Prevent duplicate language servers during startup and teardown, and stop treating `file://host` URIs as local paths.

- `LspConnection` and `LspConnectionPool` finish state updates and record retirement before calling host code such as `stop`, `close()`, `terminate()`, or `createTransport`. Re-entrant `dispose()` or `acquire()` calls see settled state. If a host call throws during disposal, `LspConnection` reports it to `onError` and runs the remaining cleanup.
- `createTransport` now receives an `AbortSignal` that aborts if the connection closes while the factory is still running. Because the factory may already own a server process, the next start for that key waits for the factory to settle and for any returned transport's `gone` promise. A factory that ignores the signal and never settles blocks later starts for its key.
- `createWebSocketLspTransport` now takes a `signal` option. Aborting it before the socket opens closes the socket and rejects with the abort reason. The built-in WebSocket factory passes the connection's signal, so a stalled handshake no longer blocks a replacement.
- `fileUriToPath` returns `null` for host-only URIs such as `file://project`, so `sameFileUri('file://project', 'file:////project')` is `false`. `file:////project/a.ts` still maps to `//project/a.ts`.
