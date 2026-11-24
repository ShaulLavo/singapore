# Browser Layout + 2D Virtualizer

The editor uses browser layout carefully instead of owning a parallel text layout engine. The
renderer virtualizes what it asks the browser to lay out, then uses native DOM ranges,
CSS Highlight API, selection APIs, and measured browser boxes for geometry.

## Direction

- Browser layout is the source of visual truth.
- CSS Highlight API remains the selection and syntax paint path until a better paint path exists.
- Virtualization owns visibility, mounting, and scroll-space management, not glyph measurement.
- Geometry queries should be local to mounted DOM. Avoid full-document `Range` walks.
- The implementation uses a custom 2D virtualizer inspired by an earlier prototype.

## Architecture

### Scroll Space

An editor with `height: 'container'` takes its host's height and owns its scroll container.
With `height: 'content'`, the editor sets its height from the document and lets the page or a
scrolling ancestor move it. Set `maxHeight` in CSS pixels to switch to internal scrolling when
the document exceeds that height. `setHeight(height, maxHeight?)` changes both settings.

Inside it:

- a spacer establishes total document height
- mounted rows are absolutely positioned by virtual row start
- each mounted row lets the browser lay out its text normally
- horizontal scrolling is native

In content-height mode, the visible row window comes from the editor's intersection with its
clipping ancestors and the visual viewport. The virtualizer keeps at least one viewport of extra
rows on each side. It updates the window during the scroll event and stops listening for scroll
when the editor leaves the screen. Plugin snapshots report the visible window in editor
coordinates in both modes. Browser find-in-page and print cover only mounted rows.

`captureSnapshot({ scope: 'document' })` uses the same row renderer to capture missing rows in
small batches. The live editor keeps its current mounted rows and scroll position. Saving and
restoring paint needs `createPaintSnapshotPlugin()` from `@singapore-editor/core/editor`; without
it, capture returns nothing and an offered snapshot is ignored.

`scrollMode` and `setScrollMode` are deprecated for one release. In an editor, legacy `content`
maps to `height: 'content'`, and both `virtualized` and `static` map to `height: 'container'`.
Explicit `height` wins when both options are present. A secondary view can use `scroll: false` to
show all of its rows without scrolling. Legacy `scrollMode: 'static'` on a secondary view still
selects that layout.

### Vertical Virtualization

Text rows normally use fixed heights:

- `totalHeight = lineCount * rowHeight`
- `visibleStart = floor(scrollTop / rowHeight)`
- `visibleEnd = ceil((scrollTop + viewportHeight) / rowHeight)`
- render visible rows plus overscan

The retained row-size index supports variable-height projections when a live producer supplies
them:

- maintain measured row heights
- store prefix sums / Fenwick tree for row -> y and y -> row
- update only rows whose measured height changes

After an edit, each mounted row is compared with its display row: source, text, offsets, inline
row, chunk window, row decoration and fold marker. A row where all of them match stays as it is.
A row below the edit whose text is unchanged but whose source offsets moved by a uniform shift
keeps its DOM, and only its chunk offsets move. Every other row is rebuilt. The view's text
revision is not part of the comparison, so one key rebuilds the edited row, not every mounted row.
Inline-mapped and widget rows are always rebuilt when their offsets move, because their runs come
from the inline map that the edit rebuilt.

### Horizontal Virtualization

Do not build a full x-position model.

Use browser layout and mounted DOM:

- no-wrap mode mounts ordinary visible rows directly
- long-line mode splits a logical line into horizontal text chunks when geometry permits
- chunks are mounted only around the horizontal viewport plus overscan
- chunk boundaries are chosen conservatively by UTF-16 offsets, not by measured glyphs
- browser layout determines actual glyph positions inside mounted chunks

### Geometry Queries

Geometry comes from mounted DOM:

- selection/caret: DOM `Range.getClientRects()`
- hit testing: `caretPositionFromPoint` / `caretRangeFromPoint`
- row bounds: virtualizer row positions plus measured DOM row height
- token/decorations: intersect token offsets with mounted rows/chunks, then paint through CSS Highlight API or mounted spans

If a query targets an unmounted region, scroll/mount it first or return a stale-safe miss.

### BiDi Geometry and Caret Affinity

The browser remains the layout oracle for BiDi text. The row classifier uses generated Unicode
17.0.0 `R`/`AL` BiDi-class ranges from the pinned `DerivedBidiClass.txt` source, plus explicit BiDi
controls. This gate keeps ASCII and non-RTL rows off the measured run path without pretending to
implement the Unicode BiDi algorithm in editor code.

For mounted RTL rows, collapsed DOM ranges expose one or two painted x positions at each grapheme
boundary. The virtualizer derives half-open logical runs ordered visual-left to visual-right from
those measurements. A selection's `before`/`after` affinity chooses which legitimate caret belongs
to its head; the chosen position is primary and the other boundary position may be painted as the
secondary caret. Selection ranges use the browser's visual rectangle list rather than spanning
disjoint runs with one logical box.

Run and boundary geometry is cached by row identity and retired on text, inline projection, width,
font metrics, and row recycling changes. A drag anchor records both text and display-projection
revisions, because revealing inline source can change the BiDi mapping without editing the buffer.

Hit testing asks `caretPositionFromPoint` or `caretRangeFromPoint` first and ignores editor overlay
descendants. If those APIs are absent or unusable, measured geometry supplies the fallback. Its
display-local index is mapped through the inline projection with `nearest` bias and clamped to the
row's source span, so inline insertions and replacements cannot shift an RTL hit into the wrong
buffer offset.

`rtlMoveVisually` governs character-step Left/Right and Shift+Left/Right. It defaults on for macOS
and Linux and off for Windows. Word and subword commands remain in logical document order; Home and
End remain logical. Unmounted rows and rows that refuse BiDi measurement retain the deterministic
logical fallback.

Vertical arrows and page movement are independent of `rtlMoveVisually`. `SelectionGoal.horizontal`
stores the affinity-selected row-local CSS pixel x and reuses it across rows; `lineEnd` retains a
separate logical aim. Eligibility for a cold target row uses the cheap measurement-refusal
predicate, so deciding whether vertical geometry is available does not derive every BiDi run or
sweep the row with DOM ranges.

Long RTL rows are not horizontally windowed across a BiDi run. Rows above the safe geometry ceiling
use an endpoint-only fallback, keeping work bounded while preserving deterministic edge behavior.

## Inspired By vibe2

Useful patterns from that prototype:

- `createFixedRowVirtualizer.ts`: small fixed-row math, scroll listener, `ResizeObserver`, overscan, stable `VirtualItem` records
- `createTextEditorLayout.ts`: browser-measured char/line metrics, fixed-row virtualizer, visible range, content width from visible scans
- `TextFileEditorInner.tsx`: one scroll element, spacer height, absolute overlay layers, visible row rendering
- `useSelectionRects.ts`: selection work is limited to virtual rows

These ideas are implemented in framework-free TypeScript.

## Implemented Baseline

1. A framework-free fixed-row virtualizer owns the viewport math.
2. Native browser selection and CSS Highlight APIs provide geometry and paint.
3. Only visible line DOM nodes plus overscan are mounted.
4. Real-browser suites cover scrolling, hit testing, selection, syntax highlights, typing, BiDi
   boundaries, visual movement, and fallback geometry.

## Acceptance Criteria

- No independent text layout engine. Implemented for fixed-height rows and long-line chunks.
- No full-document DOM for large files in the virtualized path. Implemented and benchmarked at 100K lines.
- Browser selection/caret hit testing remains authoritative. Mounted-row validation runs in browser tests.
- CSS Highlight selection behavior matches the pre-virtualized editor. Covered over mounted rows and chunks.
- Fold controls are syntax-driven and collapsed regions render placeholders while FoldMap supplies visible rows.
- 10K, 50K, and 100K-line files scroll without mounting offscreen rows. 100K-line benchmark covered.
- Long lines do not force full horizontal paint work once horizontal chunking is enabled. 50K-character benchmark covered.
