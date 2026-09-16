# Textbuffer extraction

The storage implementation lives in `packages/textbuffer`, which can build and test outside this workspace.
The former `packages/editor/src/pieceTable` modules are compatibility re-exports, not a second implementation.
The editor depends on `@singapore-editor/textbuffer` via `workspace:*` during this review stage.

Display measurement indexes now live in an editor-owned WeakMap keyed by the persistent document lineage.
Exact-text checks preserve correctness when undo branches reuse buffer IDs. Storage diagnostics call an
optional package-level sink; the editor adapts them to its existing diagnostic events.

The original piece-table unit test moved with the implementation. New tests cover package imports,
absence of outward dependencies, lazy diagnostics, lineage identity, and deterministic edit equivalence.
The existing editor measurement test still verifies reuse across edits, views, undo, and divergent branches.

Run `bun install`, `bun run format`, `bun run format:check`, `bun run typecheck`, and `bun run test`.
Validate the package independently with `bun run --cwd packages/textbuffer verify`.
Do not merge or publish until the recorded checks pass. Creating the separate GitHub repository,
choosing a license, and publishing the initial version are separate operations.
