# E006: Reclaim deleted text without breaking retained document states

- Status: In progress
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E001](../examples/stress/README.md), [E005](../docs/storage/piece-tree-inspection.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Execution update, 2026-09-23

[Automatic text reclamation](../docs/storage/e006-text-reclamation.md) now releases unused
portions of append chunks and original text across current and retained history snapshots.
Sparse physical spans preserve logical coordinates, snapshot identity, prepared transactions,
leases, receipts, dirty state and revision. Rendering measurements borrow bounded movable
pages and detach them during reclamation; worker source IDs follow physical owners, including divergent branches.

Large-paste survivors detach during incremental maintenance, preserving synchronous paste
latency. Mounted two-view checks measure actual heap release under mixed edits, small surviving
fragments, fixed-size paragraph replacement and original-text deletion. Retained readers keep
their text until released. The implementation reference records results and reproduction commands.
The follow-up passes all 30 mounted samples against string-category bytes and retained code
units. Total heap is observational because compiled code dominated its small growth denominator.
At 500 cycles, survivors/mixed/paragraph release 48.01%/26.57%/31.50% of string growth. The old
failed total-heap runs remain recorded. Repeated maintenance reuses untouched sparse spans and
tail owners, and small inverse edits copy at most 1,024 units. Fresh mixed/survivor snapshots
find zero sliced-string parents behind undo payloads, down from 782–847 KB. Position metadata
remains the separate unfinished milestone, so E006 stays in progress.

## Outcome

A long insert-and-delete session can return close to its live-document memory footprint.
Undo, retained snapshots, selections, and deleted-anchor bias keep their existing meaning.
For example, repeatedly replacing one paragraph does not leave the active tree proportional
to every paragraph ever inserted after obsolete history and external readers release their states.

## Current code

- [Storage](../packages/textbuffer/src/buffers.ts) uses append-only logs and 16 Ki-unit append
  chunks. Original text is one unrestricted chunk. Several insertion IDs can share a chunk.
- [The collector](../packages/textbuffer/src/reclamation.ts) groups snapshots by actual log
  identity and protects text across visible pieces in every retained root. Numeric insertion IDs
  alone cannot distinguish divergent branches.
- [Buffer maintenance](../packages/editor/src/textStorageMaintenance.ts) schedules incremental
  quiet-time collection. [Document sessions](../packages/editor/src/documentSession.ts) enumerate
  history, save baselines, current wrappers and transaction endpoints. Snapshot identity is part
  of lease and receipt validity; storage publication must preserve it.
- [Measurements](../packages/editor/src/documentTextSnapshot.ts) and
  [worker source descriptors](../packages/tree-sitter/src/treeSitter/source.ts) are storage readers.
  Their cached source strings and IDs must follow the physical text representation.
- Tombstones, reverse-index entries and insertion-ID mappings still grow with edit history.
  Deleted anchors depend on those position records even after their characters are released.

## Scope

The current implementation milestone reclaims partial append chunks and original text, while
preserving logical coordinates, snapshot identity, undo, transaction validity and external readers.
It includes every storage reader, line indexes, rendering measurements and worker descriptors.
It does not claim bounded total memory: position-metadata reclamation is the subsequent milestone.
No shared-memory redesign, new settings, scheduler rewrite or history truncation is required.

## Design

Keep logical piece and anchor coordinates unchanged. Collect the union of protected visible
ranges per physical log, then retain independently copied source spans for that union. Readers
resolve a physical source once per span; walker character reads stay direct string accesses.
Original-only documents are eligible, but clean baselines and retained history still protect
original text they display. Writable append tails remain dense. When a pass retires text,
it also detaches borrowed dense append survivors, including the tail: a 64-unit substring
must not keep a multi-megabyte paste allocation alive. Already detached closed chunks are reused.

Copy in bounded batches, preserving UTF-16 code units including isolated surrogates. Retain
logical newline offsets and their ordinal positions, but remove their references to old strings.
Publication across a shared group stays atomic after incremental preparation.

Rendering indexes borrow bounded page handles without copying on cold acquisition or first
classification. A document-family registry detaches retired backing during maintenance, including
unread readers from abandoned logs; leaves keep handles rather than raw strings. Internally cached measurements are weakly owned by their storage
generation. Externally returned ranges remain readable. Worker source IDs identify physical
content: unchanged ID and length must imply unchanged text, including divergent branches.

This selects sparse retained spans over paging all input text. Eager pages would add ingestion
cost and per-page metadata to every document. The selected design adopts bounded measurement
blocks from that alternative without imposing them on ordinary storage and walker reads.

## Steps

1. Capture current same-browser mounted heap and input measurements before changes.
2. Implement sparse retained spans for closed append chunks; migrate all readers and indexes.
   Verify anchors, branches, Unicode, line mapping, cancellation and retained snapshots.
3. Extend the representation to original-only text with bounded copying. Verify legitimate
   clean/history/external pins, then release those owners and measure reclamation.
4. Migrate measurement caches and worker descriptors in the same buildable change. Prove idle
   warmed views do not pin old whole strings and workers cannot reuse stale same-length data.
5. Run mounted mixed/survivor and fixed-live-size paragraph churn workloads, retained undo,
   prepared transactions and paired current-browser input measurements. Record peak memory,
   maintenance pauses and actual post-GC release, not just logical retired-unit counts.
6. Bound small undo-payload backing and measure input impact. Gate text reclamation on string
   categories and retained code units; keep total heap observational. This follow-up is implemented.
   Do not assume the remaining heap is position metadata.
7. Keep E006 open for position metadata. Establish either a compact equivalent position
   representation or an explicit lifetime contract before removing any tombstone or reverse entry.

## Verification

Run the textbuffer package tests through `bun run test`; the focused collector suite is
`src/reclamation.test.ts`. Core maintenance and measurement tests run with
`bun run --cwd packages/editor test --project node test/storageMaintenance.node.test.ts src/textMeasurements.test.ts`.
Run Tree-sitter source and real-worker tests and the linked Platform WorkspaceEdit tests.

`bun run --cwd examples/stress bench:reclamation-live` measures two mounted views. Surviving-text
and mixed workloads must release real heap, not merely finish successfully. Original text tests
must warm measurement caches, preserve a pinned reader, then release all eligible owners.
A fixed-live-size workload separates avoidable retention from legitimate document growth.

Compare input before and after using the same browser and fixture configuration. Existing
Chromium 148 controls cannot certify a Chromium 153 candidate. Record failures and baseline
noise honestly; do not silently relax a performance gate to pass a candidate.

The metadata milestone additionally needs piece/index growth bounds and deleted-anchor
comparison against an unreclaimed control. E005 tree invariants alone cannot detect the known
anchor regression from deleting invisible pieces.

## Risks and decisions

- A substring may keep its parent's allocation; detached copies require actual heap evidence.
- Original chunks are unbounded; one original survivor cannot become one unbounded copy task.
- Exact snapshot identity remains unchanged. Physical storage is replaceable; logical revision
  and dirty state are not maintenance events.
- External readers legitimately pin old logs. Missing from undo history does not mean unused.
- Newline ordinals and position metadata remain for the next milestone; text release alone is
  not a proof that total storage plateaus with edit count.
