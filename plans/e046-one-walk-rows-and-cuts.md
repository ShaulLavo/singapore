# E046: Find a row in one walk, check surrogates inside the edit, and search line breaks within the piece

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E039](../docs/performance/e039-reverse-index-cost.md), [E045](../docs/performance/e045-one-pass-edits.md)
- Inspected baseline: `7cafb67f0d441fe50cbdb19d59da9375422a438f`, 2026-09-17.

## Outcome

The textbuffer's largest remaining ratios against the pinned control are reads, and its largest
remaining avoidable edit cost is work done around the edit rather than by it. The
[README table](../packages/textbuffer/README.md#current-results) for the baseline has
`position-to-offset` at 2.64x, line reads at 2.51x to 2.57x and `random-replacements` at 2.31x in
the bench's default regime, and 3.29x, 2.88x to 3.38x and 1.87x with 8 warmups. A 40-replay CPU
profile of the baseline attributes them to three causes this plan removes:

- A row lookup walks the tree once per end of the row. `pointToOffset` walks twice, a line read
  three times. `findOffsetAfterLineBreak` is 41% of `position-to-offset` and 24% of
  `lines-random-after-churn` as self time.
- Every delete is preceded by two read descents that check its ends for a cut surrogate pair.
  `splitsSurrogatePair` is 10% of `random-replacements` and 11% of `mixed-edit-churn`.
- Every line-break count and every line-break lookup binary-searches the whole chunk's line
  index, 10,000 entries for the fixture's original text. `firstLineBreakAtOrAfter` is 18% of
  `position-to-offset`, 14% of line reads, 12% of replacements and 10% of churn.

After this plan a row's two ends come from one walk, an edit of a document that holds no
surrogates performs no surrogate descent at all, and a line-break search covers only the breaks
of the piece it concerns. Example: `pointToOffset(snapshot, { row: 4000, column: 12 })` descends
once, reads both of row 4000's bounds from the piece it lands in when the row sits inside one
piece, and indexes the line table directly instead of searching it.

## Current code

- [`positions.ts`](../packages/textbuffer/src/positions.ts): `findOffsetAfterLineBreak` descends
  by `subtreeLineBreaks` to the piece holding the N-th break, then calls
  `findBufferLineBreakOffset`. `lineStartOffset` is one such descent. `pointToOffset` calls
  `lineStartOffset` and the private `lineEndOffset`, a second full descent for row + 1, only to
  clamp the column. `offsetToPoint` already finds row and line start in one descent.
- There is no line-content call. The bench adapter's `line(row)` in
  [`adapters.mjs`](../packages/textbuffer/bench/adapters.mjs) and the editor both compose
  `lineStartOffset(row)`, `lineStartOffset(row + 1)` and `readPieceTableTextRange`: three
  descents. In the editor, `DocumentTextSnapshot.lineStart` in
  [`documentTextSnapshot.ts`](../packages/editor/src/documentTextSnapshot.ts) and `lineEnd` in
  [`displayProjectionText.ts`](../packages/editor/src/virtualization/displayProjectionText.ts)
  are called as a pair by
  [`displayProjection.ts`](../packages/editor/src/virtualization/displayProjection.ts) and by
  seven other modules under `packages/editor/src`.
- [`edits.ts`](../packages/textbuffer/src/edits.ts): `snapEditRange` and `snapBatchEditRanges`
  call `splitsSurrogatePair` in [`reads.ts`](../packages/textbuffer/src/reads.ts) once per end
  of every non-empty range. Since E045 a caller that pre-snaps pays once, not twice, but the
  editor's `documentSession.applyEdits` still pays the two descents inside
  `snapBatchEditRanges` for every edit. The insert path already checks at its landing (E043).
- [`buffers.ts`](../packages/textbuffer/src/buffers.ts): `countBufferLineBreaks` runs
  `firstLineBreakAtOrAfter` twice over the chunk's whole `PieceBufferLineIndex`, and
  `findBufferLineBreakOffset` runs it once. Chunk strings only grow at their end and
  `growTailLineIndex` extends the tail's index on every append, so the index position of a break
  never changes once scanned. A `Piece` records `lineBreaks` but not where its breaks sit in
  that index. E045 added a shortcut for pieces with no breaks; pieces with breaks still search.
- `normalizeDocumentText` in [`lineEndings.ts`](../packages/textbuffer/src/lineEndings.ts)
  already scans ingested text once for line endings and unusual terminators, and
  `PieceTableBuffers` already records what it found.

## Scope

Three changes inside `packages/textbuffer`, each measured on its own, plus the editor adopting
the new row call where it fetches both ends of a row.

1. `lineRange(snapshot, row)` returning the row's start and end from one descent, `pointToOffset`
   built on it, and `readPieceTableLine(snapshot, row)` exported from the package.
2. A `containsSurrogates` flag on `PieceTableBuffers` that lets every snap skip its descents, and
   the single-edit delete checking its two ends inside `hideVisibleRange` when the flag is set.
3. `firstLineBreak` on `Piece`: the index, in its chunk's line index, of the first break at or
   after the piece's start.

Limits: no cache of the last line read. The control has one and it would help the sequential
lane, but a cache on an immutable snapshot is shared mutable state and the editor already caches
rows above this layer; record the lane's remaining gap instead. No change to snapping policy,
batch sibling rules or the ranges `snapBatchEditRanges` reports. No tombstone reclamation, which
stays with [E006](e006-tombstone-reclamation.md). No Platform work.

## Design

**Row bounds.** The descent for break N lands in the piece that holds it. Break N + 1 is in the
same piece whenever the piece holds more than N's ordinal, which with change 3 is one array
read. Otherwise it is the first break after the landing: in the landing's right subtree, else at
the nearest ancestor the descent turned left at, or that ancestor's right subtree, found by
following `subtreeLineBreaks > 0` downward. The insert probe's `leftTurns` in
[`tree.ts`](../packages/textbuffer/src/tree.ts) is the same successor walk and is the model.
The result is an out-parameter pair, as `findRowAtOffset` already does with `lineStart`, so the
lookup allocates nothing. `readPieceTableLine` slices the landing piece directly when the row
lies inside it and falls back to `collectTextInRange` otherwise.

**Surrogates.** Most source text holds no surrogate code unit, and then no offset can cut a
pair. The flag is set when ingested or appended text contains one and is never cleared: deleting
the text leaves a tombstone whose units a later undo can restore. Ingestion finds it in the pass
`normalizeDocumentText` already makes, or one `RegExp` test when the caller passes
`normalized: true`; an append tests only the appended text. When the flag is set, the batch path
keeps its up-front snap, because sibling edits decide each other's snapping. The single-edit
delete folds the check into `hideVisibleRange`, which visits both ends: a cut inside a piece
reads two units of one chunk, a cut at a piece boundary needs the visible unit on the other
side, which is the successor and predecessor walk above. A cut pair is reported the way the
insert probe reports `retry`, and the edit runs again on the widened range; it is rare enough
that the second descent does not matter.

**Line breaks.** `firstLineBreak` is known without a search wherever a piece is made. The
original piece has 0. The right part of a cut has the left part's value plus the left part's
count, which the cut computes anyway. An appended piece has the tail index's `count` before its
text is scanned, which `growTailLineIndex` holds. With it, a count inside a piece searches only
`[firstLineBreak, firstLineBreak + lineBreaks)`, and the offset of the piece's K-th break is
`offsets[firstLineBreak + K - 1]`. The decision that needs evidence is memory: one more number
on every piece, against the 8% to 18% it removes from six lanes.

## Steps

1. Baseline. Rerun the standard profile on three seeds in both regimes and the CPU profile of
   `position-to-offset`, `lines-random-after-churn`, `random-replacements` and
   `mixed-edit-churn` at 40 replays. Evidence: the figures in Outcome reproduce within run
   variation, or the plan's premises are corrected before any code.
2. `firstLineBreak`. Add the field, set it at the three creation sites, use it in
   `countBufferLineBreaks`' callers and `findOffsetAfterPieceLineBreak`, and teach
   [`inspection.ts`](../packages/textbuffer/src/inspection.ts) to check it against the index.
   Evidence: `firstLineBreakAtOrAfter` gone from the read lanes' profile; retained heap of the
   churn lanes before and after.
3. `lineRange`, `pointToOffset` on it, `readPieceTableLine`, and the bench adapter's `line`
   through it. Evidence: descents per conversion and per line read from the structural counters,
   and the three read lanes re-timed.
4. `containsSurrogates`. Evidence: `splitsSurrogatePair.calls` is 0 on a new ASCII-only edit
   lane; the load lanes are not slower beyond run variation.
5. The folded check for single-edit deletes. Evidence: `splitsSurrogatePair.calls` on
   `random-replacements` and `mixed-edit-churn`, whose fixtures are surrogate-rich, and both
   lanes re-timed.
6. Editor adoption: `DocumentTextSnapshot.lineRange(row)` and the call sites that fetch both
   ends of one row switched to it. Evidence: `bun run bench:virtualization` and
   `bun run bench:walker` in `packages/editor`, before and after.
7. Report in `docs/performance/`, README table regenerated with each regime against its own
   control, counter budgets lowered in the same commit.

Steps 2 to 5 each stand alone. Stop after any of them whose lane does not move beyond run
variation, record the measurement, and drop that change rather than keep unused machinery.

## Verification

Entry points: `bun run verify`, `bun run bench:check`, `bun run bench`, `bun run bench:profile`
and `bun run bench:height` from `packages/textbuffer`; `bun run test`,
`bun run bench:virtualization` and `bun run bench:walker` from `packages/editor`.

New tests and what each catches:

- `lineRange` against a string model after every edit of the existing position fuzz, including
  the first row, the last row with and without a trailing newline, empty rows, and a row whose
  two breaks sit in different pieces with tombstones between them. Catches a successor walk that
  stops at a tombstone or skips a piece.
- `pointToOffset` and `readPieceTableLine` against the same model. Catches a clamp that drifts
  from the current one.
- `firstLineBreak` validated by the inspector on every fuzzed snapshot, plus a branch test: two
  branches appending to one log, then a cut in each. Catches an index position taken from the
  wrong branch's view of the tail chunk.
- The editor's surrogate sweep in `pieceTable-edits.test.ts` run with the flag both forced on and
  derived. A document with no surrogates that gains one by insert, then loses it by delete, then
  regains it by undo. Catches a flag that is cleared or never set on append.
- The single-edit delete against `snapBatchEditRanges` for every range of a surrogate-rich
  document, as `edits.test.ts` does today. Catches a folded check that widens differently.

Acceptance: every correctness test green; `position-to-offset`, both line-read lanes,
`random-replacements` and `mixed-edit-churn` faster than the baseline beyond run variation in
both regimes; no other lane slower beyond run variation; retained heap per piece reported.

## Risks and decisions

`firstLineBreak` must survive order normalization, coalescing, which extends a piece without
moving its start, and the fork of a shared tail chunk. It must not be read for a piece whose
chunk index has not been scanned that far; the inspector check is the net. If the field costs
more retained memory than the lanes justify, the fallback is a bounded search from a hint held
on the descent, which removes the cost from row lookups but not from cuts.

The surrogate flag is monotonic by design. A document that once held an emoji pays the descents
for the rest of its history; clearing the flag would need proof that no tombstone and no retained
snapshot holds a surrogate, which is reclamation's problem, not this plan's.

The folded delete check duplicates a policy that lives in `snapEditToCodePoints`. Keep one
function deciding whether a cut orphans a half and call it from both places, as the insert probe
does with `insertSplitsPair`, or the two paths will drift.

`lineRange` changes no public behaviour, but `readPieceTableLine` is new public API and needs
the built-export check. Stop and keep the three-descent line read if step 3 does not move the
line lanes: that would mean the range read, not the row lookup, is their cost.
