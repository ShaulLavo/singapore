---
'@singapore-editor/lsp': patch
'@singapore-editor/lsp-plugin': patch
---

Connect language server processes over their standard streams. `createStdioLspTransport` frames LSP messages for a host that holds the process, with limits on message size and pending input. `createLanguageServerAdapterPlugin` accepts `reconnect`, so a server process that exits is started again. File URIs are escaped the way Node language servers escape them, diagnostics and definitions match a document however the server escaped its URI, and `pathToFileUri`, `fileUriToPath` and `sameFileUri` map POSIX paths exactly.
