---
'@singapore-editor/lsp': patch
'@singapore-editor/lsp-plugin': patch
'@singapore-editor/typescript-lsp': patch
---

Prevent duplicate language servers during startup and teardown, and stop treating `file://host` URIs as local paths.

- `LspConnection` and `LspConnectionPool` finish state updates and record retirement before calling host code such as `stop`, `close()`, `terminate()`, `createTransport`, or a status callback. Re-entrant `dispose()` or `acquire()` calls see settled state. If a host call throws during disposal, `LspConnection` reports it to `onError` and runs the remaining cleanup. If `onError` itself throws, every remaining disposal still runs and the first such error is rethrown afterwards.
- A pooled connection that gives up leaves the pool before its `error` status is reported, so a borrower that retries from `onStatusChange` gets a new connection.
- `createTransport` now receives an `AbortSignal` that aborts if the connection closes while the factory is still running. Because the factory may already own a server process, the next start for that key waits for the factory to settle and for any returned transport's `gone` promise. A factory that ignores the signal and never settles blocks later starts for its key.
- `createWebSocketLspTransport` now takes a `signal` option. Aborting it before the socket opens, including while the socket is being constructed, closes the socket and rejects with the abort reason, or with the error `close()` threw. The built-in WebSocket factory passes the connection's signal, so a stalled handshake no longer blocks a replacement. The plugins' `webSocketTransportOptions` are typed as `LspWebSocketFactoryOptions`, which has no `signal`.
- `fileUriToPath` returns `null` for host-only URIs such as `file://project`, so `sameFileUri('file://project', 'file:////project')` is `false`. `file:////project/a.ts` still maps to `//project/a.ts`.
