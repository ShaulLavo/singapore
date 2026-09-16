# E040: Replace treap balancing with a join-based balanced tree

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E037](e037-textbuffer-edit-allocations.md)
- Inspected baseline: `69dfef7425539165ec05a457bd6f0516fb6607fa`, 2026-09-16.

## Outcome

The sequence tree keeps split and merge as its only structural operations, keeps persistence and
structural sharing, and gains a height bound instead of an expected height. The
[height replay](../packages/textbuffer/bench/HEIGHT.md) measured height 25 against 14 for the
control at 2,996 pieces; path copies scale with height, so that is roughly 40% more nodes cloned
per edit. After this plan the tree's height stays within a proven constant of `log2(P + 1)` on
every replayed trace, every existing correctness test passes unchanged in meaning, and the
choice of balancing scheme is backed by the same fixtures on several seeds and document sizes.

## Current code

- [`tree.ts`](../packages/textbuffer/src/tree.ts): a persistent treap. `merge` and
  `splitByVisibleOffset` are the structural operations; `createNode` computes six subtree
  summaries; `cloneNode` copies a node for path copying. Ten other functions descend or rebuild
  the tree and read `left`, `right` and the summaries, but only `merge`, the split and
  `normalizePieceOrders` depend on `priority`.
- [`priority.ts`](../packages/textbuffer/src/priority.ts) derives priorities from piece fields and
  a `prioritySeed` that is a public option of `createPieceTableSnapshot`. The height replay
  sweeps that seed. [`inspection.ts`](../packages/textbuffer/src/inspection.ts) validates the heap
  order.
- [`walker.ts`](../packages/textbuffer/src/walker.ts), [`positions.ts`](../packages/textbuffer/src/positions.ts)
  and [`anchors.ts`](../packages/textbuffer/src/anchors.ts) descend by summaries only.
- [`reverseIndex.ts`](../packages/textbuffer/src/reverseIndex.ts) is a second treap with its own
  keyed insert and rotations; [E039](e039-reverse-index-cost.md) decides its future, so this plan
  changes only the sequence tree unless E039 has chosen to keep a keyed tree, in which case the
  same balance is applied there in a final step.
- [E011](e011-packed-piece-tree.md) evaluates a typed-array layout of the same tree. A join-based
  API is layout-independent, so E011 remains valid after this plan.
- History: [`docs/positions/anchors.md`](../docs/positions/anchors.md) records why a Fenwick tree
  was rejected for the piece tree, namely no structural-sharing seam. The Fenwick index from
  commit `f5fe4ae` lives in the display layer's line-start index, not in the buffer. A flat
  prefix-sum structure is not a candidate here for the same reason.

## Scope

Implement the sequence tree on the join-based framework of Blelloch, Ferizovic and Sun, where
`split` and `merge` are derived from a single `join(left, key, right)` that restores balance.
Candidates: weight-balanced (Adams parameters) and AVL. Red-black through join is a third if the
first two disagree. Priorities and `prioritySeed` are removed in the same pass, along with the
heap check in the inspector, replaced by the chosen scheme's invariant. Public option removal is a
breaking change and is done without a compatibility shim.

Limits: node layout stays an object; no typed arrays here. No change to pieces, orders, tombstone
semantics, chunking or the reverse index's design. A wide tree with fanout 16 to 32 is not in
scope; if this plan's result is not enough, that becomes its own research entry beside E011.

## Design

`join` takes two trees and a middle node and returns a balanced tree in `O(|h1 - h2|)` node
copies; `split` walks one path and joins the pieces back, `merge` is `join2`. The existing split
by visible offset keeps its contract, including the mid-piece split that creates two pieces and
records reverse-index changes, and `merge` keeps its signature, so every caller in `edits.ts` is
unchanged. Weight balance stores a subtree size, which already exists as `subtreePieces`; AVL
stores a height. Both give height within `1.45 log2(P + 2)` or better. Weight balance is the
first candidate because it needs no new field and its rebalance decisions read summaries the tree
already maintains.

Determinism stays: the same edits on the same input produce the same tree, now without a seed.
Tests that pin a shape through a seed are rewritten to assert the invariant and the summaries.

## Steps

1. Freeze the contract: a differential fuzz that runs the current treap and the candidate on the
   same seeded edit streams, comparing full text, every line lookup, every retained snapshot's
   text, anchor resolutions for a fixed anchor set after every edit, and the invariant validator.
   Evidence: it runs green against the treap alone at several seeds and document sizes.
2. Implement `join` and derive split and merge for weight balance; keep the treap in the tree
   until step 4 so the fuzz can run both. Evidence: the differential fuzz is green.
3. Height replay on both, all default traces and stress traces, plus 50,000-edit prepend and
   hotspot traces. Evidence: the candidate's `height / log2(P + 1)` stays under its proven bound
   on every checkpoint; the treap's numbers are retained as the control.
4. Remove priorities, `prioritySeed`, the heap check and the seed sweep from the height driver.
   Evidence: build, package smoke, and the E005 inspector fixtures pass.
5. Timing, profiling and counters: standard profile, three seeds, plus a 1,000,000-line document
   for the load and typing lanes. Evidence: `cloneNode.calls` per edit falls in proportion to the
   height drop; no read lane is slower beyond run variation.
6. If weight balance regresses any lane, repeat 2 through 5 with AVL and record both.
7. If E039 kept a keyed tree, apply the same `join` to it and rerun the anchor lanes.
8. Update the README's tree section, which currently explains the treap choice.

## Verification

Entry points: `bun run verify`, `bun run bench:check`, `bun run bench:height`, `bun run bench`,
`bun run bench:profile` from `packages/textbuffer`; `bun run bench:piece-table`,
`bun run bench:walker` and `bun run bench:anchors` from `packages/editor` as editor-level
controls; the [E001 stress fixtures](../examples/stress/README.md) for end-to-end typing.

New tests and what they catch: the differential fuzz catches any divergence in text, positions,
history or anchors; a join test on adversarial shapes (chains, one-sided weights, repeated
mid-piece splits) catches a rebalance that violates the invariant; a persistence test that edits
an older snapshot after the tree rebalanced catches a join that mutates a shared node; a
normalization test catches order relabeling that assumed heap order. The invariant validator
learns the balance rule so the inspector fails on a bad tree rather than a test noticing later.

Acceptance: height within bound on every checkpoint of every trace, differential fuzz green on
all seeds and sizes, edit-lane copy counts and timings improved on the random lanes, no read or
anchor lane regressed, and the README updated.

## Risks and decisions

`join` implementations are short but subtle; the differential fuzz is the safety net and it must
exist before any balancing code. Removing `prioritySeed` touches the public API, the bench driver
and any host that passed it; find them with the export check. Weight-balanced parameters must be
the proven pair, not tuned by hand. A mid-piece split allocates two nodes and joins twice; if the
counters show join dominating, the alternative is an in-place split that reuses the copied node.
Stop and keep the treap if step 5 shows no copy-count improvement on the random lanes; that
result would mean depth was not the cost and the wide-tree question moves to E011.
