# E038: Append inserted text without copying the buffer store

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E037](../docs/performance/e037-textbuffer-edit-allocations.md)
- Inspected baseline: `69dfef7425539165ec05a457bd6f0516fb6607fa`, 2026-09-16.

## Outcome

Inserting text costs the text itself, not a copy of the chunk store. The
[attribution report](../packages/textbuffer/bench/ATTRIBUTION.md) counted 640,302 copied array
slots for 1,500 random insertions, about 427 per edit, because each non-coalesced insert opens a
new chunk and every append copies the page array and the tail page. After this plan a run of
typing, a paste, or a multi-cursor batch on a linear history appends in constant time, a random
insertion no longer creates a chunk of its own, and branching from an older snapshot still sees
exactly the text it saw before.

## Current code

- [`buffers.ts`](../packages/textbuffer/src/buffers.ts): `PieceBufferChunkStore` holds pages of
  1,024 string slots. `append` copies the page list and the tail page; `extendTail` copies both
  and concatenates onto the last string. `appendChunksToBuffers` always mints a new chunk per
  insert, splitting only at 16,384 code units, so a 1-character insert becomes a 1-character chunk.
- [`edits.ts`](../packages/textbuffer/src/edits.ts): `tryCoalesceInsert` extends the newest chunk
  only when the insertion point is the end of the piece that ends that chunk. Every other insert
  goes through `appendChunksToBuffers`.
- Line indexes in `buffers.ts` are cached per chunk on the buffers record and retained per chunk
  store in a `WeakMap`; `sharesIndexedPrefix` tolerates a grown chunk string.
- [`pieceTableTypes.ts`](../packages/textbuffer/src/pieceTableTypes.ts) records that a buffer id is
  a sequence number and undo rolls the sequence back, so two branches can mint the same id with
  different text. That is the case any shared store must detect.
- The README's [storage section](../packages/textbuffer/README.md#copy-on-write-buffers) documents
  the current paged store; update it with the result.
- Drift to recheck: [E006](e006-tombstone-reclamation.md) wants to drop chunks no protected root
  references. An append-only log must leave room for a generation swap.

## Scope

Two deliverables, measured separately:

1. Fill before you open: an insert appends to the newest chunk while it has capacity, regardless
   of where the piece lands in the document, and opens a new chunk only when full. The piece
   references the chunk and offset it landed at.
2. A shared append-only log with per-snapshot extent: the store is one growable array of chunk
   strings shared by every snapshot in a lineage, each snapshot records the `size` and tail
   length it can see, and an append that finds the log already longer than its extent copies on
   that branch only.

Limits: chunk strings stay immutable in what a snapshot can see; tombstones, anchors, the reverse
index and balancing are untouched. Reclaiming chunks stays with E006.

## Design

Deliverable 1 changes the piece factory, not the store. A piece created for an insert of `n`
code units at document offset `d` becomes `(newestChunk, tailLength, n)` when
`tailLength + n <= BUFFER_CHUNK_SIZE`, and `tryCoalesceInsert` becomes a special case of it where
the previous piece is extended instead of a new one created. Chunk boundaries still keep surrogate
pairs and CR/LF together. Because several unrelated document positions now share a chunk, the
reverse index keyspace per chunk grows; that interaction is why
[E039](e039-reverse-index-cost.md) depends on this plan.

Deliverable 2 replaces `PieceBufferChunkStore` with a log: `chunks: string[]` owned by the
lineage, plus `extent: { count, tailLength }` on the snapshot's buffers record. A read of
sequence `s` is valid only when `s < extent.count`, and a read of the tail only up to
`tailLength`. Appending compares the log against the extent: equal means linear history, append
in place and publish a new extent; longer means another branch already appended, so copy the
visible prefix into a fresh log for this branch. Undo re-minting an id is exactly the longer
case and is caught by the same check. Line indexes key on the log identity and the chunk
sequence, and remain valid because a chunk string never changes below a snapshot's tail length.

## Steps

1. Ablation ceiling: stub `append` and `extendTail` copying in the disposable probed build and
   record the timing and allocation delta on `random-insertions`, `sequential-typing`,
   `eight-cursor-batches` and `large-paste-delete`. Evidence: a table of ceilings per lane.
2. Deliverable 1 behind the existing API. Evidence: chunk count after `random-insertions` drops
   from about 1,500 to a handful; copied-slot counter falls accordingly; all tests pass.
3. Property test for branch isolation: from one snapshot, apply two different insert sequences
   and assert each branch's full text, line lookups and retained-snapshot texts. Evidence: the
   test fails against a deliberately broken shared tail.
4. Deliverable 2. Evidence: copied-slot counter reaches zero on every linear lane; the branch
   test and the `persistent-history` lane pass; a branch-heavy fixture shows one copy per branch.
5. Update the README storage section and the inspector's buffer checks in
   [`inspection.ts`](../packages/textbuffer/src/inspection.ts) to validate extents.
6. Clean timing run, three seeds, standard profile, beside the E037 result.

## Verification

Entry points: `bun run verify`, `bun run bench:check`, `bun run bench:profile`, and the
`persistent-history` and `anchor-resolution-after-churn` lanes in `bun run bench`. The
`retainedText` checks in [`bench/worker.mjs`](../packages/textbuffer/bench/worker.mjs) already
verify every retained root's text after the workload; keep them and add a branching fixture.

New tests and what they catch: branch isolation catches a shared tail leaking a sibling's text;
an undo-reminted-id test catches a stale line index served for a reused sequence; a chunk-fill
test with a pair straddling the boundary catches a split surrogate; an extent test that reads
`size` from an older snapshot after a newer append catches an off-by-one in visibility.

Acceptance: copied-slot counter zero on linear lanes, chunk count bounded by text volume rather
than edit count, no anchor or history lane regressed, and the branch fixture's copies equal its
branch count.

## Risks and decisions

Sharing a mutable log across snapshots is the one place this package gives up pure immutability;
the extent check is what makes it safe and it must be the only path that appends. If the branch
detection cannot be made airtight, stop at deliverable 1 plus a persistent vector for the pages,
which keeps the copies logarithmic and needs no shared state. Filling chunks changes which
inserts coalesce and therefore piece counts in the height replay; record that before and after.
E006's reclamation will need a generation swap of the log; leave the log identity opaque so that
swap does not become a second copy path.
