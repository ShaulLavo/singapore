---
'@singapore-editor/lsp-plugin': patch
---

Close the remaining ways one workspace could run two language servers, and stop reading `file://host` as a local path.

- A connection closed while its async `createTransport` was still running now waits for that transport: it closes the transport when it arrives, and the next start for the same pool key waits for its `gone`.
- A `stop` hook that acquires the same pool key again gets a connection that waits for the old server, instead of starting a second one beside it.
- `fileUriToPath` returns null for a URI that names only a host, such as `file://project`, so `sameFileUri('file://project', 'file:////project')` is false. `file:////project/a.ts` still maps to `//project/a.ts`.
