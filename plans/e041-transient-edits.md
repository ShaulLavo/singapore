# E041: Measure whether in-place edits between retained snapshots close the small-edit gap

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E037](../docs/performance/e037-textbuffer-edit-allocations.md), [E038](../docs/performance/e038-append-only-buffer-store.md)
- Inspected baseline: `b6a265a786b08c61318a3e02b666f17cb7ef50fc`, 2026-09-16.

## Outcome

A measured answer to one question: how much of the remaining small-edit gap against the mutable
control is persistence itself, and how much of that can be removed by mutating nodes in place
whenever no retained snapshot can observe the change. After E038 a random insertion costs about
3.7 µs against 0.75 µs for `microsoft/vscode-textbuffer`, and a random replacement 8.3 µs against
0.9 µs. Cloning the roughly 70 tree nodes per insertion is on the order of a microsecond at V8's
allocation speed; the rest is summary recomputation, priority hashing, the second tree and fixed
per-edit work. This plan builds the transient on a branch, measures it at two retention
granularities, and ends in a go/no-go that reorders or rewrites E039 and E040.

## Current code

- [`tree.ts`](../packages/textbuffer/src/tree.ts): `cloneNode` copies a ten-field node and
  `updateNode` recomputes six subtree summaries on it. `merge`, `splitByVisibleOffset`,
  `replacePieceEndingAt`, `markTreeInvisible` and `normalizePieceOrders` clone every node on
  the path they touch. Nothing records which snapshot a node belongs to.
- [`reverseIndex.ts`](../packages/textbuffer/src/reverseIndex.ts): the same pattern on the second
  tree, with rotations that clone two nodes each. On `random-insertions` it clones more nodes per
  edit than the sequence tree (budgets: 56,958 against 48,350 for 1,500 edits).
- [`buffers.ts`](../packages/textbuffer/src/buffers.ts): after E038 the store already behaves as a
  transient. A log is appended in place by the one view whose extent matches it and forked by
  anyone else. That is the same ownership test this plan proposes for tree nodes.
- [`history.ts`](../packages/editor/src/history.ts) pins a snapshot per undo entry, up to 200.
  [`documentSession.ts`](../packages/editor/src/documentSession.ts) additionally keeps
  `cleanSnapshot`, keeps `snapshotBefore` on every transaction receipt for barrier reversal, and
  computes each change with `diffPieceTableSnapshots(before, after)`. The tree-sitter session
  and the text snapshot hold the snapshot they were built from. So today the previous root is
  observable after every transaction, not only at undo boundaries.
- [`bench/fixtures.mjs`](../packages/textbuffer/bench/fixtures.mjs): the edit lanes never retain
  a root except `persistent-history` (64 roots over 1,500 edits) and `branch-edits`. The batch
  lane applies eight inserts per transaction.
- E037's CPU attribution for `random-insertions`: piece tree 40.9%, reverse index 20.6%, edit
  preparation and boundary policy 19.7%, buffer store and line index 14.9%. E038 removed most of
  the last bucket.

## Scope

Three measurements and one decision:

1. An epoch-owned sequence tree: nodes carry the epoch that created them, an edit mutates nodes of
   the current epoch in place and clones older ones, and retaining a snapshot advances the epoch.
2. The same on the reverse index, so both trees are transient together.
3. The fixed per-edit overhead isolated from persistence: what `random-insertions` costs with
   both trees in place and nothing retained, against the control.

Limits: this is a branch and a report. No API change ships, no editor call site changes, and
anchors, tombstones and the log keep their semantics. Adoption, if any, is a follow-up
implementation plan with its own audit of snapshot holders.

## Design

Ownership by epoch. `PieceTreeNode` and `PieceTableReverseIndexNode` gain an integer `epoch`.
`PieceTableBuffers` gains `epoch`, shared by every snapshot of a lineage the way the log is. An
edit reads the epoch from the buffers it is given; `cloneNode(node)` becomes
`own(node, epoch)`, which returns `node` itself when `node.epoch === epoch` and a clone stamped
with `epoch` otherwise. `updateNode` is unchanged. Nothing else in the algorithms changes.

`retain(snapshot)` advances the lineage epoch and returns the snapshot. After it, the next edit
clones its path once, exactly as today, and every edit after that on the same snapshot chain
mutates in place until the next retain. A snapshot that is edited twice without a retain between
the edits is the branch case; the second edit would mutate nodes the first already owns. The
transient therefore makes that a contract: an edited snapshot is consumed unless retained. The
research prototype detects violations by stamping a `consumed` flag on the snapshot object in
`createSnapshot` and throwing on a second edit; the measurement lanes never hit it, and the
editor audit in step 5 lists where production would.

The two granularities are the whole question. Retaining per undo entry is what makes persistence
free on a typing run, but today's session retains per transaction through receipts and the
change diff, and per keystroke is the same as never. Step 4 measures both and the decision
depends on which one the editor can actually adopt.

## Steps

1. Prototype on a branch: `epoch` on nodes and buffers, `own` in place of `cloneNode` in both
   trees, `retain` in `snapshot.ts`, the consumed check. Every existing test passes unchanged when
   every edit retains first, which is the compatibility mode the branch defaults to. Evidence:
   `bun run verify` green in that mode.
2. Retention modes in the bench adapter: `always` (today), `transaction` (retain before every
   `edit` and `batch` call), `history` (retain only where the `persistent-history` lane retains,
   and never on the other lanes). Evidence: the three modes select through one option and the
   validation in `worker.mjs` passes in all three, including `branch-edits`, which retains before
   every branch by construction.
3. Counters: `tree.own.inPlace` and `tree.own.cloned`, and the same for the reverse index, so the
   probed build shows what fraction of touched nodes were mutated. Evidence: on `random-insertions`
   in `history` mode the cloned count is near zero; in `transaction` mode it equals today's clone
   count; in `always` mode both trees behave as on main.
4. Timing: `random-insertions`, `random-replacements`, `eight-cursor-batches`, `mixed-edit-churn`,
   `sequential-typing`, `typing-with-lookups`, `persistent-history` and `branch-edits`, standard
   profile, three seeds, all three modes, beside the control. Evidence: one table. The reading
   that matters is `history` mode against the control, and `transaction` mode against `always`,
   which is what the batch lane gains without any editor change.
5. Editor audit, on paper: list every holder of a previous snapshot in `documentSession.ts`,
   `history.ts`, the tree-sitter session and the text snapshot, and for each say whether it needs
   the old root after the next edit begins or only until a computation finishes. Evidence: a table
   with a proposed retain point per holder, and the change-diff and receipt cases called out,
   since they are what forces per-transaction retention today.
6. Decision. Go if `history` mode puts the insert lane within 2x of the control and the audit
   finds a per-undo-entry retain point the session can honour. Partial go if only `transaction`
   mode is safe: adopt in-place mutation inside a batch and keep per-transaction cloning.
   No-go if `history` mode stays above 3x: persistence is not the cost, and the time goes to the
   fixed overhead measured in step 3, which E037's successors should take instead. Record the
   decision and the losing numbers in `docs/performance/`.

## Verification

Entry points: `bun run verify`, `bun run bench:check`, `bun run bench` with the retention option,
`bun run bench:profile --modes counters,cpu`. The `retainedText` checks in `worker.mjs` and the
`persistent-history` and `branch-edits` lanes are the correctness gates for retention: a root
retained before an in-place edit must still read its own text afterwards.

New tests and what they catch: an edit on a retained snapshot followed by an edit on the result
catches an `own` that mutates a node the retained root still reaches; two edits on one
unretained snapshot catches a missing consumed check; a retain in the middle of a batch catches
an epoch read once per batch instead of per edit; the reverse-index invariant validator after an
in-place rotation catches a rotation that assumed fresh nodes.

Acceptance is the decision itself, with its evidence table, not a speed-up. A go decision must
name the retain points; a no-go must name where the remaining time goes.

## Risks and decisions

The consumed contract is the whole risk. Every consumer of `PieceTableSnapshot` today holds an
immutable value; under transients an unretained snapshot becomes invalid after the next edit,
which is a use-after-free class of bug in a language that cannot enforce it. The prototype's
consumed flag catches double edits, not stale reads, so the audit in step 5 is what makes a go
decision honest. If the audit shows the session cannot give up per-transaction retention without
redesigning receipts and the change diff, the partial go is the answer and the batch lane is the
only lane that improves.

The epoch field costs eight bytes per node on both trees. The `own` check is one integer compare
per touched node, which is below the noise of `updateNode`. Rotations in the reverse index clone
two nodes and are the one place in-place mutation can alias: the prototype must own both before
rewiring either.

If E040 lands first, its join-based tree changes which functions clone, and the prototype should
be rebased on it rather than measured against the treap. If E039 reaches its option 3, the
reverse index disappears and step 2 of this plan applies to one tree only.
