# E039: Make reverse-index maintenance cheaper than the edit it follows

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: L
- Dependencies: [E037](e037-textbuffer-edit-allocations.md), [E038](e038-append-only-buffer-store.md)
- Inspected baseline: `69dfef7425539165ec05a457bd6f0516fb6607fa`, 2026-09-16.

## Outcome

Anchors keep resolving through tombstones with the same bias rules, and the index that makes that
possible stops costing more per edit than the sequence tree. The
[attribution report](../packages/textbuffer/bench/ATTRIBUTION.md) measured 91,651 reverse-index
node copies against 50,845 sequence-tree copies for 1,500 random insertions, and 187,587 against
105,907 for replacements. After this plan the reverse-index copy count per edit is at or below
the sequence tree's, the anchor-resolution lane is no slower, and the decision between the three
candidate designs is recorded with measurements.

## Current code

- [`reverseIndex.ts`](../packages/textbuffer/src/reverseIndex.ts): a second persistent treap keyed
  by `(buffer, start)`, with keyed insert, copy-on-write rotations and merge-on-delete. Every
  sequence-tree change is mirrored as a list of remove and add records.
- [`anchors.ts`](../packages/textbuffer/src/anchors.ts): resolution finds the entry covering the
  anchor's buffer offset, then locates that entry's order in the sequence tree. Deleted anchors
  walk to the reverse predecessor or successor. `resolveAnchorLinear` is the reference.
- [`snapshot.ts`](../packages/textbuffer/src/snapshot.ts): order normalization rebuilds the whole
  index with `buildReverseIndex`.
- [`edits.ts`](../packages/textbuffer/src/edits.ts): after E037, a split contributes one replace
  and one add; an insert contributes one add per new piece; a delete contributes one replace per
  tombstoned piece.
- After E038, pieces from many document positions share one chunk, so the per-chunk keyspace is
  large and ordered by buffer offset, not by document position.
- The anchor lane in [`bench/fixtures.mjs`](../packages/textbuffer/bench/fixtures.mjs) resolves
  128 anchors 3,000 times after churn. There is no lane that resolves many anchors after each edit.

## Scope

Measure a ceiling, add the missing workload, then choose and implement one of:

1. Per-buffer ordered structure inside a persistent map keyed by chunk, so a change touches one
   small tree plus a shallow map path.
2. Deferred maintenance: the snapshot carries the change list, and the index is brought up to
   date on the first anchor resolution that needs it, applying the accumulated changes in one
   sorted pass, with a cap that forces application when the list grows past a bound.
3. Derivation from the sequence tree: for each chunk the pieces' buffer offsets are found by a
   descent using an added per-node summary, so no second tree exists.

Limits: anchor semantics, bias and deleted-anchor edge rules are fixed by the existing tests and
the linear resolver. Tombstone reclamation stays with [E006](e006-tombstone-reclamation.md).

## Design

The ceiling comes first. The disposable probed build stubs `applyReverseIndexChanges` to identity
and the profile run records the timing and allocation delta per lane. That number bounds what any
design can win on edits; the anchor lane bounds what it may cost on reads.

Option 1 keeps the algorithm and shrinks the path. With E038's chunk filling, a chunk holds up to
16,384 code units of inserts, typically tens of pieces, so a per-chunk tree is shallow and the
outer map path is a few nodes. Option 2 changes when work happens, not how much, and helps only
if edits outnumber resolutions between them; decorations resolve every frame, so the cap and the
one-pass application are what make it viable. Option 3 removes the structure but adds a summary
to every sequence node and a second descent per resolution; it is the cleanest and the least
certain, so it is prototyped only if options 1 and 2 both miss the acceptance bar.

Whatever wins, the linear resolver stays as the oracle and the invariant validator in
[`inspection.ts`](../packages/textbuffer/src/inspection.ts) keeps checking that the index and the
sequence tree agree entry for entry.

## Steps

1. Ablation ceiling per lane. Evidence: a table of edit-lane savings with the index disabled.
2. Add an anchor-density lane: 500 live anchors, resolved all after each of 300 edits, with the
   string oracle checking each resolution. Evidence: the lane runs on the clean and probed builds.
3. Implement option 1 behind the same `applyReverseIndexChanges` and lookup functions.
   Evidence: reverse-index copies per edit on `random-insertions` and `random-replacements`, the
   anchor-density lane time, and the invariant validator.
4. If option 1 misses the bar, implement option 2 with a cap of 64 pending changes and the same
   evidence, plus a test that an anchor resolved between edits sees the pending changes applied.
5. If both miss, prototype option 3 on a branch and record the measurement as the decision.
6. Record the decision, the losing measurements and the retained design in the README's reverse
   index section.

## Verification

Entry points: `bun run verify`, the anchor tests in
[`pieceTable.test.ts`](../packages/textbuffer/src/pieceTable.test.ts), `bun run bench:profile` for
the counters, `bun run bench` for the anchor lanes, and `bun run bench:anchors` in
`packages/editor` as the editor-level control.

New tests and what they catch: an anchor-after-every-edit fuzz against the linear resolver catches
a stale or partially applied index; a deleted-anchor test across a normalization rebuild catches
an index that lost tombstone entries; for option 2, a test that resolves from an older snapshot
after a newer one forced application catches shared pending state between branches.

Acceptance: reverse-index copies per edit at or below sequence-tree copies on both random lanes,
anchor-density lane not slower than baseline beyond run variation, invariant validator green on
every fixture, and the decision written down.

## Risks and decisions

Option 2 introduces laziness into a structure that is otherwise pure; pending state must live on
the snapshot, never on shared buffers, or branches will observe each other's changes. Option 3
changes every sequence-tree node, which collides with [E040](e040-balanced-persistent-tree.md) if
both are in flight; sequence E040 first if option 3 is reached. Stop if the ceiling in step 1 is
under a fifth of edit time, and record that the reverse index is not the problem.
