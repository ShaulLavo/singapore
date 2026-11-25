# @singapore-editor/lsp

## 0.2.13

### Patch Changes

- a0f2b60: Prevent duplicate language servers during startup and teardown, and stop treating `file://host` URIs as local paths.

  - `LspConnection` and `LspConnectionPool` finish state updates and record retirement before calling host code such as `stop`, `close()`, `terminate()`, `createTransport`, or a status callback. Re-entrant `dispose()` or `acquire()` calls see settled state. If a host call throws during disposal, `LspConnection` reports it to `onError` and runs the remaining cleanup. If `onError` itself throws, every remaining disposal still runs and the first such error is rethrown afterwards.
  - A pooled connection that gives up leaves the pool before its `error` status is reported, so a borrower that retries from `onStatusChange` gets a new connection.
  - `createTransport` now receives an `AbortSignal` that aborts if the connection closes while the factory is still running. Because the factory may already own a server process, the next start for that key waits for the factory to settle and for any returned transport's `gone` promise. A factory that ignores the signal and never settles blocks later starts for its key.
  - `createWebSocketLspTransport` now takes a `signal` option. Aborting it before the socket opens, including while the socket is being constructed, closes the socket and rejects with the abort reason, or with the error `close()` threw. The built-in WebSocket factory passes the connection's signal, so a stalled handshake no longer blocks a replacement. The plugins' `webSocketTransportOptions` are typed as `LspWebSocketFactoryOptions`, which has no `signal`.
  - `fileUriToPath` returns `null` for host-only URIs such as `file://project`, so `sameFileUri('file://project', 'file:////project')` is `false`. `file:////project/a.ts` still maps to `//project/a.ts`.

## 0.2.12

### Patch Changes

- 6a3cf24: Connect language server processes over their standard streams.

  - `createStdioLspTransport` frames LSP messages for a host that holds the process, with limits on message size and pending input. The host must call `exited` once the process and everything it started are gone, also after the connection was closed.
  - `LspManagedTransport` gains an optional `gone` promise that settles when the server behind a transport is gone. `LspConnection` and `LspConnectionPool` wait for it before they start a replacement, so one workspace never has two servers running. `LspConnection.connect()` is now a no-op while the connection is connected or already starting.
  - The `stop` hook may be async. A throw is reported as the reason for the loss. A rejection is reported only if it has settled by the time `exited` reports the loss; a later one is observed and dropped.
  - `createLanguageServerAdapterPlugin` accepts `reconnect`, so a server process that exits is started again.
  - File URIs are escaped the way Node language servers escape them, diagnostics and definitions match a document however the server escaped its URI, and `pathToFileUri`, `fileUriToPath` and `sameFileUri` map POSIX paths exactly, without resolving `..` or collapsing slashes.

## 0.2.11

### Patch Changes

- Omit sourcemap `sourcesContent` in published builds.

## 0.2.10

### Patch Changes

- Keep deferred replies, queued notifications and send-error cleanup within their originating connection. Prevent old frames from reaching renewed transport subscriptions.

## 0.2.9

No changes in this release.

## 0.2.8

No changes in this release.

## 0.2.7

No changes in this release.

## 0.2.6

### Patch Changes

- 5670c3d: Synchronize language-server documents through their retained document contribution owner. Preserve scoped protocol versions, connection epochs, source-before-query ordering, URI transitions and final-peer retirement.

  Retire documents locally when their managed transport is already closing, preserving physical failures for source updates.

## 0.2.5

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.
