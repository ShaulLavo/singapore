# E054: The TypeScript worker answers everything the server path answers

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: L
- Dependencies: none
- Inspected baseline: `ed5b2e20b9cdd3492ab33ae4e9676a133817b79d` (2026-09-25)

## Outcome

`@singapore-editor/typescript-lsp` runs a TypeScript language service in a Web Worker. Platform
never uses it: every language feature goes through the server's LSP proxy to a real language
server. The worker should be able to stand in for that path for TypeScript and JavaScript, so a
host with no server gets the same features Platform gets from the server.

Example: in the Editor demo, with no server, Rename, Go to Symbol, signature help, quick fixes,
Format Document and pull diagnostics all work on a TypeScript file, and they behave the same as
Platform's editor over the proxy.

## Current code

The worker (`packages/typescript-lsp/src/typescriptLsp.worker.ts`, 1,455 lines) answers
`initialize`, `shutdown`, `textDocument/hover`, `completion` (no resolve), `definition`,
`references`, `implementation`, `typeDefinition` and `semanticTokens/full|range`. It handles
`didOpen`/`didChange`/`didClose`, `$/cancelRequest`, and a custom `editor/typescript/setWorkspaceFiles`
that replaces the whole file set. Anything else gets `METHOD_NOT_FOUND`.

What the Editor's LSP client asks a server for (`packages/lsp-plugin`, `packages/lsp`), and the worker's
answer:

| Method                                              | Worker                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| hover, definition, references, implementation, typeDefinition | yes                                                       |
| completion                                          | yes; `completionItem/resolve` no                                    |
| semanticTokens full / range                         | yes; delta no (the client accepts full)                             |
| `textDocument/diagnostic` (pull)                    | **advertised but not handled.** `diagnosticProvider` is in the initialize result, so `pullDiagnostics.ts` asks on every sync and gets `METHOD_NOT_FOUND`; diagnostics still arrive by push |
| signatureHelp, documentHighlight                    | no                                                                  |
| rename, prepareRename                               | no                                                                  |
| codeAction, `codeAction/resolve`                    | no                                                                  |
| formatting, onTypeFormatting                        | no                                                                  |
| documentSymbol, `workspace/symbol`                  | no (Platform's outline and symbol search use documentSymbol)        |
| didSave                                             | not needed; the worker holds the text                               |

What the server path provides beyond methods (Platform `apps/server/src/lsp/proxy-session.ts`):

- **Project files from disk.** Unopened files, `tsconfig` with `extends`, and real
  `node_modules` types. The worker only knows what the host pushes through `setWorkspaceFiles`,
  and it loads the standard library from a CDN (`createDefaultMapFromCDN`).
- **External edits.** Watched-file notifications (`workspace/didChangeWatchedFiles`) when files
  change on disk. The worker can only replace its whole file set.
- **Exit reporting.** A dead backend sends Platform's `LSP_SERVER_EXITED` notification with its exit
  code. A crashed worker leaves `TypeScriptLspWorkerOwner` in `crashed`
  (`docs/architecture/worker-topology.md`), and nothing tells the client.
- **Sharing.** One backend serves every tab and view. In one tab, `LspConnectionPool` already
  shares a worker connection across views; sharing across tabs is not a goal here.

Drift to check again: how much of `tsconfig` `extends` and project references `readProjectConfig`
(line 1152) resolves, and whether completion items already carry enough detail that resolve is
only about documentation.

## Scope

- The method rows above, answered by the worker from the TypeScript language service.
- A host file-provider contract: incremental upsert and delete, and a way to answer the reads the
  language service asks for, replacing push-everything-up-front.
- Standard library and package types from the host, with the CDN as an explicit opt-in.
- Crash → `exited` status and a server-exited notification, the same thing the client gets from
  the server path.
- Out of scope, by owner decision on 2026-09-25 (TypeScript only for now): other language servers (oxlint, ESLint, Biome, Python and so on), cross-tab sharing
  through a SharedWorker, and Platform's integration. Adopting the worker in Platform (a setting to
  choose the backend, a file provider over Platform's fs routes) is a Platform plan written after
  Step 4.

## Design

Each new method is a thin mapping from the language service, matching what `tsserver`-based
servers return: `getSignatureHelpItems`, `getDocumentHighlights`, `getRenameInfo` +
`findRenameLocations` → `WorkspaceEdit`, `getCodeFixesAtPosition` + `getApplicableRefactors` →
code actions resolved through `getEditsForRefactor`, `getFormattingEditsForDocument` /
`getFormattingEditsAfterKeystroke`, `getNavigationTree` → `DocumentSymbol[]`,
`getNavigateToItems` → `workspace/symbol`, `getCompletionEntryDetails` → resolve, and
`getSemanticDiagnostics` + `getSyntacticDiagnostics` → a pull report with a `resultId`.

The decision that needs evidence is **file access**. The language service reads files
synchronously, but a host's files are behind async I/O. There are two options:

- **Preload:** the host pushes the project's source and `.d.ts` files, and later sends deltas.
  Simple; its cost is startup time and memory, which scale with the project.
- **Synchronous pull:** the worker blocks on `Atomics.wait` over a `SharedArrayBuffer` while the
  host reads. It only loads what the program touches, but it needs cross-origin isolation.

Measure both on a mid-size repo (Platform's `apps/web`) before choosing (Step 4).

## Steps

1. **Parity harness.** A test drives one scripted session (open, edit, every row above) against
   the worker and records each method's result as supported or not supported. It should catch a
   capability that is advertised but not handled. Evidence: the table above, produced by the
   harness.
2. **Stop the pull-diagnostics error.** Implement `textDocument/diagnostic` with a `resultId`, or
   stop advertising it until then. Evidence: no `onRequestError` from pull during an edit session.
3. **Methods.** Add the missing rows in the order Platform uses them: documentSymbol,
   signatureHelp, rename/prepareRename, codeAction + resolve, formatting, documentHighlight,
   completion resolve, `workspace/symbol`. Each gets a worker test that uses the lsp-plugin feature
   the way the demo does.
4. **File provider (research, then build).** Measure preload against synchronous pull. Evidence:
   time until the first diagnostics appear, worker memory, and the first request after a burst of
   external edits, for both. Then build the winner with incremental upsert and delete.
5. **Library and types.** Host-supplied lib and package types; CDN only when the host opts in.
6. **Lifecycle.** A worker crash sends the same exited notification and status the server path
   produces.

## Verification

- `packages/typescript-lsp` tests: the harness from Step 1, and one test per new method that checks
  the result's shape against the LSP types and a position mapping in a multi-line file.
- A real-browser demo scenario: rename across two files, a quick fix, Format Document, and the
  outline, with no server running.
- Gate: the harness reports every row supported, and pull diagnostics raise no request errors.

## Risks and decisions

- If synchronous pull needs cross-origin isolation that a host cannot provide, preload is the only
  option, and the file provider must make deltas cheap.
- Refactor code actions can be slow on large files. Resolve lazily and honour `$/cancelRequest`.
- Formatting must use the editor's indentation settings, not TypeScript's defaults. The host passes
  them as formatting options.
- Stop condition: if the Step 4 measurements show neither option can reach first diagnostics in a
  usable time on `apps/web`, record that and limit this plan to single-package projects.
