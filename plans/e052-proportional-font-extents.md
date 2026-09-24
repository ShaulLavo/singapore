# E052: Wrap and horizontal extent from measured advances when the font is not monospace

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P3
- Effort: L
- Dependencies: [E036](../docs/display/e036-monaco-geometry-comparison.md)
- Inspected baseline: `40d841583659d2889fc03f61979e607f56df4c86`, 2026-09-24.

## Outcome

A proportional editor font lays out like a monospace one does today. Soft wrap breaks where the
text actually reaches the viewport edge. Long rows keep their left spacer under the text they
stand in for. The horizontal scroll width fits the widest line.

For example, in Noto Sans at 13px, `iiiiiiii` is about a third as wide as `WWWWWWWW`, yet today
both count as eight columns. A line of `i` wraps far short of the edge, a line of `W`
overflows it, and scrolling into the middle of a 2,000-character line jumps sideways by the
difference.

E036 made clicks and carets correct for proportional fonts: `view.monospace` demotes rows to DOM
geometry. Everything the view estimates from `characterWidth` before any row is measured is
still column arithmetic. Monospace fonts must not pay anything for this work.

## Current code

- **Wrap** is column counts end to end.
  - `horizontalViewportColumns` ([rows](../packages/editor/src/virtualization/virtualizedTextViewRows.ts))
    turns the viewport width into `ceil(width / characterWidth)`. `refreshWrapWidth` in
    [virtualizedTextView.ts](../packages/editor/src/virtualization/virtualizedTextView.ts) passes
    that to the projection as `wrapColumn`.
  - [displayProjectionWrap.ts](../packages/editor/src/virtualization/displayProjectionWrap.ts)
    scans whole-document spans in 256-line blocks and counts cells (tabs expand to stops).
  - [displayProjectionText.ts](../packages/editor/src/virtualization/displayProjectionText.ts)
    summarizes one line as `uniform` (`k × width`) or `indexed` (explicit row ends, only when the
    line has tabs). `wrapRange` and `wrapSegmentForColumn` read both shapes.
- **Long rows:** rows over `MAX_SINGLE_NODE_ROW_LENGTH` (512) render a window of chunks. The
  left spacer is `estimatedDisplayCellForColumn(window.start) × characterWidth`, both in the
  plain path and in the inline-run path (`virtualizedTextViewRows.ts`).
- **Horizontal extent:** `applyContentWidth` multiplies `maxVisualColumnsSeen` by
  `characterWidth`. The columns come from `estimatedDisplayRowColumns`.
- **The monospace verdict:** `measureTextMetrics` in
  [browserMetrics.ts](../packages/editor/src/virtualization/browserMetrics.ts) sets it, and it is
  re-read whenever the rendered face changes.
- **Control:** VS Code's `wrappingStrategy: 'advanced'`
  (`references/vscode/src/vs/editor/browser/view/domLineBreaksComputer.ts`, under Platform)
  renders lines into a hidden container at the wrap width and reads the breaks back from the DOM.
  It is exact, but it needs layout per line.

Drift to check again: whether wrap gained word-boundary breaking, and whether the projection
summaries still carry only `uniform` and `indexed` shapes.

## Scope

- **Deliverables:**
  - A per-face advance table.
  - A pixel-width wrap path taken only when `monospace` is false.
  - Pixel prefixes for the long-row spacer and the content width on the same condition.
  - Measurements against real layout.
- **Limits:**
  - No word-boundary wrapping. Breaks stay at code units, as today.
  - No change to monospace behavior or cost.
  - No kerning or ligature shaping beyond what the error budget below allows.
- **Platform:** nothing. `editor.fontFamily` already reaches the editor, and demotion is automatic.

## Design

The decision that needs evidence is whether a cached advance table is accurate enough, or whether
only DOM line breaking (VS Code's approach) is.

- **Advance table (proposed `glyphAdvances.ts`):** an `OffscreenCanvas` 2D context set to the
  computed font shorthand of the scroll element. It is keyed like the metrics cache, and cleared
  by the same face observer. `advance(codePoint)` fills a `Float32Array` for BMP code points
  lazily and a `Map` above that. Tabs keep tab stops, measured in space advances.
- **Wrap:** when `monospace` is false, the projection is configured with
  `wrapWidthPx` and the table instead of `wrapColumn`. Lines use a new summary shape `measured`
  that holds explicit row ends, like `indexed`. Breaks are placed where the running advance would
  exceed the width minus a safety margin (proposed 0.5 px per 100 glyphs, tuned in step 1). The
  margin makes the error one-sided: a line may wrap a glyph early, never overflow.
- **Spacer and extent:** a pixel prefix sums advances up to `window.start`. That is O(window
  start) per mount, so keep a per-row prefix cache keyed by text version and face. The content
  width uses the same per-row sum in place of `maxVisualColumnsSeen × characterWidth`.
- **Ownership:** the view owns the table and its lifetime, and the projection only reads it. No
  DOM access enters the projection.

## Steps

1. **Accuracy gate.** Using `examples/stress/geometry.mjs --font-check`, compare table-summed
   widths with `Range` widths for 2,000 real lines (Platform sources, Markdown, CJK) in Noto Sans,
   Liberation Sans and a CJK face. Evidence: the error distribution in px per line length, and the
   margin that keeps overflow at zero.
2. **Cost gate.** Wrap the 500,000-line fixture with the table and with the column path, and
   record build time and memory. Evidence: both numbers. If the table path is more than 3× the
   column path, prototype DOM line breaking for mounted rows only before going further.
3. **Wrap path.** Add the `measured` summary and the configuration switch. Evidence: projection
   unit tests and the browser tests below.
4. **Spacer and extent.** Evidence: browser tests below, and `bench:virtualization` unchanged for
   monospace.
5. **Monospace control.** Run the E002 input-latency gate and the first-paint matrix with a
   monospace font, before and after. Evidence: no regression beyond the gates' tolerance.

## Verification

- **Wrap:** a browser test that fails when a proportional wrapped row's DOM width exceeds the
  viewport (overflow), or falls short of it by more than one glyph advance (early wrap).
- **Spacer:** a browser test that scrolls to the middle of a 2,000-character proportional line
  and fails when the glyph under a fixed x differs from the one before scrolling (spacer drift).
- **Extent:** a browser test that fails when `scrollWidth` does not reach the end of the widest
  proportional line, or leaves more than one advance of slack.
- **Face changes:** a test that swaps a monospace face for a proportional one and back on a
  mounted editor. It fails if wrap, spacer or extent keep the old face's numbers.
- **Existing suites:** `bun run test` in `packages/editor`. The proportional-font, projection and
  geometry suites must stay green with monospace fonts.

## Risks and decisions

- **Canvas and CSS disagree:** font-feature settings, `letter-spacing` and synthetic styles may
  shape text differently from `measureText`. Step 1's margin must absorb this. If it cannot
  without visible early wraps, use DOM line breaking.
- **Kerning:** pair kerning makes widths context dependent. Summing single glyphs is
  approximate, and the margin exists for that.
- **Late fonts:** a web font arriving late must rebuild the table and the projection together.
  The E036 face observer already signals it; wire both to the same signal.
- **Stop condition:** if step 1 shows no margin under 2 px per line prevents overflow, record a
  no-go for the table and leave proportional wrap on DOM measurement of mounted rows only.
