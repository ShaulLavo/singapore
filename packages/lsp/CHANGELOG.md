# @singapore-editor/lsp

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
