# E047: One answer to "what is under this point"

- Status: Implemented
- Kind: Implementation
- Owner: Cross-repo
- Priority: P1
- Effort: M
- Dependencies: none
- Inspected baseline: `aeba6783b978193de9d2ba0fd5874f357df68edc`, 2026-09-21, with the uncommitted
  `diffRowAtEvent` change in `packages/diff`.

## Outcome

The Editor API lands first; Platform's consumers move in Platform plan 130, which this unblocks.

A plugin or a host asks the editor which buffer row, text offset or painted marker is under a
pointer, and gets the answer the view itself would give under word wrap, folds, injected rows and in
the gutter band. Nobody reads `data-editor-virtual-row`, measures a row with
`getBoundingClientRect`, or divides a Y coordinate by a row height to find out.

This is the lesson of the 2026-09-21 diff fix applied once, at the owner. Platform's line-comment
layer read a display-row index off the DOM and used it as a buffer row; `documentModeViolations`
existed only to warn when that broke. `diffRowAtEvent` replaced it, but it still starts from the
core's row attribute and still carries its own Y hit-test.

## Current code

- [plugins.ts](../packages/editor/src/plugins.ts) exposes `textOffsetFromPoint(clientX, clientY)`
  on `EditorViewContributionContext` only. A host holding an `Editor` has no equivalent, which is
  why Platform's search results compute rows arithmetically.
- `textOffsetFromPoint` answers from the engine's caret hit-test. It has no answer in the gutter
  band, where `.editor-virtualized-gutter` is `pointer-events: none` and no text row sits, and it
  reports a neighbour's offset for a zero-width character.
- [inputSelectionController.ts](../packages/editor/src/editor/inputSelectionController.ts) chains
  two hit-testers with `??` at `textOffsetFromPoint` and again at `textPositionFromPoint`, with a
  third fallback position. They must agree on what a point means and nothing pins that.
- [virtualizedTextView.ts](../packages/editor/src/virtualization/virtualizedTextView.ts),
  `hitTestWithAuxiliaryElementsHidden`, hides auxiliary elements and re-probes up to four times,
  each a forced layout inside a mousemove.
- [editorDiffPlugin.ts](../packages/diff/src/editorDiffPlugin.ts): `bufferRowAt` resolves
  `closest('[data-editor-virtual-row]')` through `snapshot.visibleRows`; `bufferRowFromPoint` is a
  ported Y scan with its own `getBoundingClientRect`. Its class comment justifies both with core
  `file:line` citations that are already stale.
- [decode/src/rows.ts](../packages/decode/src/rows.ts) finds row elements with
  `querySelector('.editor-virtualized-row[data-editor-virtual-row="…"]')`. That is a row-handle
  problem, owned by [E050](e050-host-obligations-into-api.md), not a point query.

## Scope

Editor core, `packages/diff`, and the public `Editor` surface. Platform consumers move in Platform
plan 130. No deprecated aliases: `textOffsetFromPoint` keeps its name and gains siblings.

## Design

One geometry-backed query on the view, exposed twice (contribution context and `Editor`):

```ts
type EditorPointHit = {
  readonly bufferRow: number
  readonly displayRow: number
  readonly source: DisplayTextRowSource   // 'document' | 'injected' | …
  readonly region: 'text' | 'gutter' | 'trailing'
  readonly offset: number | null          // null outside text
}
rowAtPoint(clientX: number, clientY: number): EditorPointHit | null
```

- Rows come from the view's cached `RowGeometry`, not from the DOM and not from a fresh
  `getBoundingClientRect` per call. The scroll element's rect is read once per frame and reused.
- `region: 'gutter'` is answered, so a plugin stops needing a private Y scan for gutter clicks.
- Painted zero-width markers register their offset with the view when they mount. A
  `markerAtPoint(clientX, clientY)` returns `{ kind, offset }`, which is what Platform's unicode
  hover reads out of `data-editor-hidden-character-offset` today.
- The two chained hit-testers in `inputSelectionController` collapse into this one entry point.

## Steps

1. Add `rowAtPoint` to the view over `RowGeometry`; cover wrap, folds, injected and block rows.
2. Expose it on `EditorViewContributionContext` and on `Editor`.
3. Re-implement `textOffsetFromPoint` and `textPositionFromPoint` on top of it; delete the `??`
   chains and measure whether `hitTestWithAuxiliaryElementsHidden` is still reachable.
4. Add `markerAtPoint` fed by the hidden-character layer.
5. `packages/diff`: `rowHitAt` becomes `rowAtPoint` plus `getRows()[bufferRow]`. Delete
   `bufferRowAt`, `bufferRowFromPoint` and the stale citations in the class comment.

## Verification

- A view test per projection kind: wrap on, a fold above the target, an injected row above the
  target, the gutter band. Each asserts `bufferRow` against the document line actually painted.
- `packages/diff` tests pass unchanged, including `names the diff row and pane under a pointer
event`; add a wrapped-row case, which the display-index shortcut could not have passed.
- A mousemove trace over a diff with expandable rows shows no forced layout from the hit-test.
- Platform scenario `git-diff-line-comment` passes against the rebuilt package.

## Risks and decisions

- D1: `rowAtPoint` reads geometry that is one frame old during a scroll. Accept it, or fold the
  pending scroll first as the virtualizer does. Recommendation: fold first; a stale row is the bug
  this plan exists to remove.
- D2: whether `Editor.rowAtPoint` is public API or stays plugin-only with hosts writing a two-line
  plugin. Recommendation: public. Search results are a host surface with no plugin of their own.

## Implementation evidence, 2026-09-21

- `Editor` and contribution contexts expose `rowAtPoint`, `markerAtPoint`, and
  `textOffsetFromPoint`. Point queries and selection positions share `locatePoint`; selection
  dragging keeps its outside-viewport clamping and bidi affinity handling.
- Viewport bounds are cached for one animation frame. Queries read current scroll coordinates.
  Simple-text queries reuse the viewport scale instead of measuring each row again.
- The hidden-character layer registers the markers it paints, including the 2px painted width
  of an invisible character. Clearing or recycling a row clears that registration.
- Diff row lookup uses `rowAtPoint`; its DOM attribute lookup and private Y scan are deleted.
- The current projection has document and injected text rows only, no separate block-row kind.
  The browser tests cover a folded block and the document row below it.
- The native auxiliary-element retry remains reachable through bidi caret probing. Keeping it
  preserves the browser-oracle tests; ordinary LTR queries do not enter that path.

Verification:

- 173 focused DOM tests and 134 browser tests pass, including the seven new point-query cases.
  The burst case proves one viewport read and no repeated row-bound reads for 100 queries.
- The wrapped diff-row regression passes. The diff suite's gutter-width expectation and three
  snapshot-restoration failures also reproduce on unmodified `7a37f10` in a separate worktree.
- Core and diff typechecks pass. The workspace typecheck reports an existing possibly-undefined
  value at `packages/editor/src/editor/indentationGuess.ts:83` through tree-sitter-languages.
- Platform `git-diff-line-comment` passes against rebuilt packages. Screenshot and before/after
  traces: `/work/tmp/fregat-evidence/20260921T193947Z-trace-git-diff-line-comment/`.
  Its five mousemove dispatches contain no Layout events. Whole-scenario timing includes startup
  and is not evidence of an overall speedup.
- The full diff suite finishes with 96 passing tests and the same four baseline failures.
- All Editor packages build, formatting checks pass, and Platform gates pass.
- Deployed on 2026-09-22 as `20260922T030243Z-4590463f-e047-point-queries` after the
  model-picker references were corrected in the Platform checkout. Production typecheck, build,
  and live check pass. Live `git-diff-line-comment` and `chat-model-picker` scenarios pass;
  screenshots were inspected in `/work/tmp/fregat-evidence/20260922T030305Z-scenario-git-diff-line-comment/`
  and `/work/tmp/fregat-evidence/20260922T030306Z-scenario-chat-model-picker/`.
