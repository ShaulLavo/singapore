# Remove range colors the view has left

Status: Approved. Follow-up to PR 141, scheduled after it merges.

## Problem

In range mode the syntax controller paints the tokens of each range answer into one token store. It removes the tokens of answers it drops only while that store is made of range answers alone (`rangeTokenOwner` in `packages/editor/src/editor/syntaxController.ts`). That stops holding after:

- any edit, because the editor adopts the tokens it moved through the edit;
- a newer analysis replacing the painted answers, which is every large file since PR 141, where the complete parse replaces the early preview;
- tokens installed by a host.

From then on no token is removed until the document changes. Colors stay for every range the view has shown, so token memory grows with the distance scrolled, up to the whole file. PR 141 kept this behavior and only fixed the request loop.

## Design that was tried

Commits `c0763eba2` and `3f500a2c9` on PR 141's branch (before the reduced version that merged) tracked which ranges of the painted store range answers wrote, as a list on the controller:

- a range answer adds its range;
- an edit moves the ranges with the text, and the editor hands the projected store to a separate `setProjectedTokens`;
- tokens installed from elsewhere empty the list;
- the frame trim removes a range once no kept answer covers it and none of it is shown, and never touches tokens outside the list.

Two independent reviews found no request loop and no wrong removal of host tokens. They found the cases below. The first review's cases were fixed in `3f500a2c9`; the second review's are open.

## Open findings from the second review

1. **Prepared whole-document results.** `applyPreparedStructuralResult` applies every prepared result as an answer to one frame. With a provider that cannot answer ranges, typing one character, jumping away and returning before the next parse finished left the first frame uncolored. Apply whole-document results through the full-result path, for ready and pending transfers. The pending case (the preparation finishes after transfer and distant colors are dropped) also fails on main today.
2. **Cost of keeping long tokens.** A token can reach past the range it was written for. To keep one painted while its far end is shown, the trim kept one character of the removed range per token. With 512 nested tokens that start at different places and end together, one viewport move took about 620 ms: the trim rebuilt 131,328 markers for 512 positions each frame. Two markers per removed range (its first and last character) cover every such token; whatever replaces this must be bounded per frame.
3. **Stale colors with fallback folds.** Start on `[0, 20)`, edit, move to `[10, 30)` while the new parse's first answer is pending, and return before it arrives. `[0, 10)` keeps stale colors, because the refill after an answer is gated on syntax folds (`usesFallbackFolds` in `publishSyntaxResult`). Main does the same today. Schedule the refill from missing coverage instead.

## Known limit of tracking ranges

Ranges cannot tell a token from host tokens that overlap it on both sides. An edit that replaces a whole listed range from inside a longer token leaves that token unlisted, and the trim never removes it. Main keeps the same token, since it removes nothing after an edit. Removing the limit means recording each token's origin in `EditorTokenStore` and carrying it through `projectTokensThroughEdit`.

## What to decide first

Choose between the range list above and a per-token origin in the store. The range list is small but has the limit above and needed special handling for tokens longer than their range. A per-token origin is exact through edits, but it changes the store, the projection and the merge of range answers, and needs its own benchmark round.

## Evidence

- Probes from the two reviews, runnable from `packages/editor` with the Vitest `node` project after copying them into `packages/editor/test/`:
  - `/work/reports/perf-20261121/singapore-20261123/pr141/review-round-2/pr141SecondReview.node.test.ts`
  - `/work/reports/perf-20261121/singapore-20261123/pr141/ownership/syntaxRangeOwnershipReview.node.test.ts`
- On main and on PR 141 as merged, four of the probes fail, all for behavior described here: the pending whole-document preparation, the fallback-fold refill, and the two that expect tokens to be removed after an edit.
- Tests written for the tried design, in `3f500a2c9`: `packages/editor/test/syntaxRangeTokens.node.test.ts`, `packages/editor/test/syntaxEditedTokens.test.ts`, and the removal cases in `packages/editor/test/syntaxRangeRetention.node.test.ts`.
- Benchmark for any version: `/work/reports/perf-20261121/scripts/singapore-user-bench.ts --runs 5 --only open,interact`. The tried design left scroll and typing latency unchanged.
