# E037: Remove avoidable per-edit allocations from the textbuffer

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: none
- Inspected baseline: `69dfef7425539165ec05a457bd6f0516fb6607fa`, 2026-09-16.

## Outcome

Every edit in `@singapore-editor/textbuffer` stops paying for work that has nothing to do with
persistence, anchors or tombstones: string parsing of buffer ids, string hashing for node
priorities, a range read to inspect two code units, and a batch pipeline run for a single edit.
The [attribution report](../packages/textbuffer/bench/ATTRIBUTION.md) measured 38.30 MiB of sampled
JS-heap allocation per 1,500 random insertions against 3.46 MiB for the control, with the
surrogate probe alone at 53.6% of sampled self-allocation in sequential typing. After this plan,
the same fixtures show those sources gone from the allocation profile, and the structural counters
that prove it are a CI gate rather than an artifact.

## Current code

- [`buffers.ts`](../packages/textbuffer/src/buffers.ts): `PieceBufferId` is a branded string
  `buffer:N`. `bufferSequence` runs `startsWith`, `slice` and `Number` on every `get`, and every
  `createPiece` reaches it through `countBufferLineBreaks`. `sharesIndexedPrefix` calls
  `startsWith` on the tail chunk after `extendTail` concatenated a cons string onto it.
- [`priority.ts`](../packages/textbuffer/src/priority.ts): `priorityForPiece` converts four numbers
  with `toString(36)` and mixes the id string. It runs for every node created in both trees.
- [`reads.ts`](../packages/textbuffer/src/reads.ts): `splitsSurrogatePair` reads a two-unit window
  through `readPieceTableTextRange`, which allocates a chunk array, slices and joins.
  [`edits.ts`](../packages/textbuffer/src/edits.ts) calls it twice per edit through
  `snapBatchEditRanges`, which also runs `toSorted`, two boundary maps, a map and the overlap merge
  for a single insert or delete. [`anchors.ts`](../packages/textbuffer/src/anchors.ts) calls it once
  per `anchorAt`.
- [`reverseIndex.ts`](../packages/textbuffer/src/reverseIndex.ts): a split pushes a remove and an
  add at the same `(buffer, start)` key; `insertReverseIndexNode` already replaces in place on an
  equal key, so the remove pays a second path copy for nothing.
- [`bench/probes.mjs`](../packages/textbuffer/bench/probes.mjs) counts these events exactly in a
  disposable build; [`bench/profile.mjs`](../packages/textbuffer/bench/profile.mjs) reports them.
  Nothing gates on them yet.
- Drift to recheck: [E006](e006-tombstone-reclamation.md) may change how buffer ids are reused,
  and the buffer-id comment in [`pieceTableTypes.ts`](../packages/textbuffer/src/pieceTableTypes.ts)
  says undo rolls the sequence back, so an id alone does not identify text.

## Scope

Deliver, in this order, one commit each with counters before and after:

1. Counter budgets in the benchmark: a committed per-workload ceiling for each structural counter,
   checked by `bench:check` on the smoke and standard profiles.
2. Numeric buffer ids.
3. Numeric priority hashing.
4. A non-allocating code-unit probe for surrogate checks.
5. A single-edit path around `snapBatchEditRanges`.
6. Remove-then-add pairing in `applyReverseIndexChanges`.
7. A probe on `sharesIndexedPrefix` and, if it confirms a per-keystroke flatten, an index keyed
   on the chunk's stable prefix rather than string equality.

Explicit limits: no change to chunking, the buffer store's shape, balancing, tombstones, anchor
semantics or LF policy. Those are [E038](e038-append-only-buffer-store.md),
[E039](e039-reverse-index-cost.md) and [E040](e040-balanced-persistent-tree.md). Transient batch
edits are out of scope unless step 6 leaves `eight-cursor-batches` as the worst counter per edit.

## Design

Buffer ids become a branded `number`. The store indexes pages by sequence directly. Serialized
forms that carry ids, and any host sidecar keyed on them, change in the same pass. Priorities hash
the numeric fields with `imul` mixing and the avalanche step already in `priority.ts`; the seed
and the index-kind discriminator stay, so tree shape remains deterministic for a given seed, but
the shapes themselves change and every golden test that pinned a shape is regenerated.

The probe is an iterative descent that returns the piece containing `offset - 1` and reads both
code units from that piece's buffer string, crossing into the next visible piece only when the
offset sits exactly on a piece boundary. It returns a boolean and allocates nothing. Edits with a
single range skip sorting and boundary counting: snap start and end directly, then apply.

Counter budgets are exact, deterministic numbers per workload, so they can fail CI where timing
cannot. Each budget is the current count rounded up by a small margin, and every step of this
plan lowers the relevant budgets in its own commit.

## Steps

1. Add budgets to the benchmark and record the baseline counts in the committed file.
   Evidence: `bench:check` fails when a budget is lowered below the measured count.
2. Numeric ids. Evidence: `bufferSequence` no longer exists, package tests and adapter tests pass,
   the counter pass shows unchanged tree and reverse-index copy counts.
3. Numeric priorities. Evidence: heap profile of `random-insertions` no longer lists
   `priorityForPiece`; tree height replay across seeds stays within the current band.
4. Probe. Evidence: `collectTextInRange` leaves the top allocators of `sequential-typing`;
   `boundary.test.ts` and the surrogate cases in `pieceTable.test.ts` pass unchanged.
5. Single-edit path. Evidence: the edit-preparation CPU category drops on `random-insertions`;
   the fuzz suite passes with the same seeds.
6. Reverse-index pairing. Evidence: `cloneReverseIndexNode.calls` on `random-insertions` falls by
   roughly a third; the invariant validator reports both trees in agreement.
7. Prefix probe and, if confirmed, the fix. Evidence: the probe count per keystroke and the
   `sequential-typing` allocation figure before and after.
8. Final clean timing run on the standard profile, three seeds, retained beside the baseline run.

## Verification

Existing entry points: `bun run verify`, `bun run bench:check`, `bun run bench:profile:check`,
`bun run bench -- --profile standard`, `bun run bench:profile -- --profile standard`, and
`bun run bench:height` from `packages/textbuffer`. The fuzz tests in
[`pieceTable.test.ts`](../packages/textbuffer/src/pieceTable.test.ts) and
[`boundary.test.ts`](../packages/textbuffer/src/boundary.test.ts) already replay seeded random edits
against a string oracle; extend the seed set rather than writing a new harness.

New tests and the failure each catches: a probe test on every boundary class (document ends, piece
boundary, tombstone between the halves, pair split across chunks) catches a probe that reads the
wrong neighbour; a single-edit test that compares the fast path with the batch path on the same
edit catches snapping drift; a reverse-index test that splits a piece and checks one entry per key
catches a pairing that drops an add; a budget test catches a regression that the timings hide.

Acceptance: all budgets lowered and green; `random-insertions` sampled allocation per replay under
half the baseline on the same runner; no timing lane slower than baseline beyond run variation.

## Risks and decisions

Numeric ids change the serialized snapshot and every consumer that keyed on the string; find them
with the built-export check before starting. Changing the priority hash changes tree shapes, which
can move the height replay in either direction; a seed sweep decides whether the new hash is kept
or reseeded. The single-edit path duplicates snapping logic, so the equivalence test is mandatory,
and if it cannot be kept simple the fast path is dropped in favour of making the batch path cheap.
Stop if any step regresses an anchor or history lane; the counters say which step.
