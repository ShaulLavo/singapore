# E048: The minimap maps display rows to document lines, not the other way round

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: none
- Inspected baseline: `aeba6783b978193de9d2ba0fd5874f357df68edc`, 2026-09-21.

## Outcome

With word wrap on, a fold collapsed or injected rows present, the minimap draws the part of the
document that is on screen, the slider covers exactly that part, and a click on the minimap lands
where the slider then sits. Today all three hold only when a display row is a document line.

## Current code

- [plugins.ts](../packages/editor/src/plugins.ts) documents `EditorViewportSnapshot.scrollRow` as a
  "continuous display-row coordinate at scrollTop, including the gap following each row".
- [minimap/src/layout.ts](../packages/minimap/src/layout.ts), `proportionalStartLine`:
  `visibleStart = Math.max(1, viewport.scrollRow + 1)` is returned as `startLineNumber`, which
  [renderer.ts](../packages/minimap/src/renderer.ts) uses to index `document.lineStarts`. A display
  row is being used as a document line. Verified in source 2026-09-21.
- Same file, `visibleLineCount()` returns `clientHeight / rowHeight`, a count of display rows, and
  both slider-height formulas combine it with `realLineCount` and the minimap `lineHeight`, which
  are document-line quantities.
- [minimap/src/plugin.ts](../packages/minimap/src/plugin.ts), `rowFromPointer`: the click ratio is
  mapped onto `lineCount` and passed to `revealLine`, while the slider is positioned from
  `scrollTop / scrollHeight`. Verified in source 2026-09-21.
- [workerClient.ts](../packages/minimap/src/workerClient.ts) and `renderer.ts` keep a second copy of
  the line index in the worker, with `editsExplainTransition()` and an O(lines)
  `lineStartSummaryPatchRange()` fallback checking the copy still matches. `scope-lines` reads
  `snapshot.lineStartsView` directly.

## Scope

`packages/minimap` only. The worker's line-index mirror is in scope for a decision, not
necessarily for deletion.

## Design

The minimap is a picture of the document, so its raster stays in document-line space. What changes
is the two conversions at its edges:

- In: the first and last visible document lines come from `snapshot.visibleRows`, filtered to
  `source === 'document'` and the first wrap segment, not from `scrollRow`.
- Out: a pointer ratio becomes a document line through the same mapping the slider uses, so the
  slider and the click agree by construction. One function owns the mapping; `layout.ts` and
  `plugin.ts` both call it.

## Steps

1. Add `visibleDocumentLineRange(snapshot)` and use it for `startLineNumber` and slider height.
2. Replace `rowFromPointer` with the inverse of the slider mapping.
3. Reconcile `computedSliderRatio` (pixel space) and `startLineNumber` (line space) in
   `containedFrameLayout` and `proportionalFrameLayout` so one derives from the other.
4. Decide the worker mirror (D1).

## Verification

- Layout tests with wrap on and with a fold collapsed: the slider's line range equals the visible
  document lines.
- A pointer test: clicking the slider's centre does not move the viewport.
- The stress example with wrap on, by eye and with a screenshot in the report.

## Risks and decisions

- D1: the worker's `lineStarts` mirror. It exists because the worker cannot read the snapshot. Keep
  it with its self-check, or transfer `lineStartsView` on change. Recommendation: measure the
  transfer cost first; a verified mirror is acceptable, an unverified one is not.
