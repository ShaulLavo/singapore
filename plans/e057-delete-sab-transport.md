# E057: Delete the SAB text transport

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: S
- Dependencies: None
- Inspected baseline: `c23cd306c22c107741a4c27ee5afc39b8b99ad59`, 2026-09-25.

Decided 2026-09-25: owner — delete the SAB transport now, ahead of Platform
[Plan 099](../../platform/plans/099-document-contributions.md). After the transport fixes it runs at
the same speed as the string path and never got faster; the
[2026-09-12 measurements](../docs/performance/sab-transport-2026-09-12.md) predate those fixes.

## Outcome

Tree-sitter source chunks travel to the worker as strings only. The `shared-utf16` payload, its
encoder and decoder, and the capability check that chooses it are gone. Parsing, chunk retention
and incremental edits behave as they do on the string path today, which is already the path every
host without cross-origin isolation takes.

For example, a 50k-line document opened on a cross-origin-isolated page sends the same string chunks
a non-isolated page sends, and a 20-character tail edit still sends one small chunk.

## Current code

- [source.ts](../packages/tree-sitter/src/treeSitter/source.ts): `TreeSitterSourceChunkPayload` has a
  `shared-utf16` arm. `createTreeSitterSourceDescriptor` takes `useSharedBuffers`, defaulting to
  `supportsSharedTreeSitterSource()` (SAB present and `crossOriginIsolated`). `createChunkPayload`,
  `createSharedUtf16Buffer`, `resolveChunkPayload`'s shared branch, `readUtf16Text`,
  `readUtf16TextExact` and the endianness check serve only that arm.
- Tests pass `useSharedBuffers` in
  [source-sharedChunks.test.ts](../packages/tree-sitter/test/source-sharedChunks.test.ts) and
  [source-reclamation.test.ts](../packages/tree-sitter/test/source-reclamation.test.ts).
- The transport benchmarks under `packages/tree-sitter/bench/` (`transport-browser.ts`,
  `transport-build.ts`, `transport-fanout.ts`, `transport-run.mjs`, `transport-summary.mjs`) exist to
  compare the two arms.
- The atomic cancellation flag in
  [workerClient.ts](../packages/tree-sitter/src/treeSitter/workerClient.ts) and the worker also use a
  `SharedArrayBuffer`. It is not text transport and stays.

Drift to check again: other packages that import the descriptor option. Platform passed no
`useSharedBuffers` on 2026-09-25.

## Scope

- Delete the `shared-utf16` arm, the `useSharedBuffers` option, the capability check and the
  helpers that only it uses.
- Keep string chunks, chunk identity, chunk retention and the atomic cancellation flag.
- Delete or rewrite the shared-arm tests against strings; keep their UTF-16, surrogate, chunk
  identity and retention coverage.
- Delete the transport comparison benchmarks, or keep one as a string-only benchmark if a caller
  needs it. The 2026-09-12 report keeps its numbers as history.
- Platform: remove any option it passes, in the same change. No Platform setting exists for this.

## Design

No new design: the string path is the design. The only decision is what to do with the benchmark
files, and the default is to delete them with the arm they measure.

## Steps

1. Grep Editor and Platform for `useSharedBuffers`, `shared-utf16` and `createSharedUtf16Buffer`.
   Evidence: the caller list.
2. Delete the arm and its helpers; move the kept test cases to strings. Evidence: `bun run test`
   in `packages/tree-sitter` passes.
3. Run `bun run test:browser` and `bun run bench:syntax` in `packages/tree-sitter`. Evidence: worker
   messaging passes, and syntax timings match the string arm of the last run.
4. Build the package and typecheck Platform against it.

## Verification

- `source-sharedChunks.test.ts` cases ported to strings catch a chunk split inside a surrogate
  pair and a stale chunk reused after reclamation.
- `test:browser` catches a worker that still expects a shared payload.
- A grep for `shared-utf16` and `useSharedBuffers` returns nothing in either repository.

## Risks and decisions

- If `bench:syntax` shows the string path slower on an isolated page, stop and report the numbers
  to the owner before deleting.
- Platform Plan 099 unit 2 also lists this deletion; when this plan lands, unit 2 has no SAB work
  left.
