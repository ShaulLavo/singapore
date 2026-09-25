# E055: Edit commands read the lines they touch

- Status: In progress
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E033](../docs/performance/e033-full-text-boundary.md)
- Inspected baseline: `50a2e5baee62647b41985b1e4c6ec98dc4c72d3d`, 2026-09-25.

## Outcome

Edit actions and the exact-occurrence commands stop copying the whole document. Pressing Ctrl+D,
toggling a comment or moving a line on a 48M-unit file reads the lines around the selections, the
same way selection expansion and ghost text have since E033. Once no caller is left,
`commandDocumentText` and its allowlist entry are deleted, and `check:full-text` keeps them gone.

## Current code

- [inputSelectionController.ts](../packages/editor/src/editor/inputSelectionController.ts):
  `commandDocumentText(session)` returns `session.materializeFullText()`. Five call sites use it:
  the edit-action path (`editActionForCommand` / `documentSelectionEditForCommand`),
  `selectHighlights` / `changeAll`, move-to-next-occurrence, the whole-line half of cut
  (`deleteCaretLines`), and the occurrence selection helper behind Ctrl+D.
- [editActions.ts](../packages/editor/src/editor/editActions.ts): every action takes
  `text: string`. Line actions start with `createLineMap(text)`, which indexes the whole string.
- [occurrences.ts](../packages/editor/src/editor/occurrences.ts): `findAllExactOccurrences` and
  `findNextExactOccurrenceFromRange` run `indexOf` over the string.
- [full-text-boundary-allow.json](../scripts/full-text-boundary-allow.json) excuses
  `commandDocumentText`: "each is a user command, never typing or plugin delivery".
- `TextReadSnapshot` already offers line starts, `readRange` and chunk iteration
  ([E033](../docs/performance/e033-full-text-boundary.md)).

## Scope

`packages/editor` only. Commands keep their behaviour, undo grouping and selections exactly.
Out of scope: the other allowlisted reads (LSP payloads, Shiki open, save, the live diff).

## Design

- Line actions (delete, move, copy, join, sort lines, comment toggles, indent, case transforms)
  take a snapshot and the resolved selections. They read the covered line span plus one line on
  each side through `readRange`, and emit edits in document offsets. `createLineMap` becomes a map
  over that span.
- Word actions (delete word left/right, word part) read a bounded window around the caret, growing
  it only when the boundary search reaches its edge.
- Occurrence search scans chunks forward from the selection and wraps once, carrying a
  `query.length - 1` overlap between chunks. Select-all-occurrences scans every chunk once.
- Trim trailing whitespace is whole-document by nature; it walks chunks and never builds a string.
- Delete `commandDocumentText` and its allowlist entry in the last step.

## Steps

1. Record the current behaviour: a table test per command over fixtures with CRLF, surrogate pairs
   and multiple selections, run against today's string path.
2. Move the line actions, then the word actions, onto snapshot reads. The step 1 tests pass unchanged.
3. Move occurrence search onto chunk scans, with matches that straddle chunk boundaries.
4. Walk chunks for trim trailing whitespace.
5. Delete `commandDocumentText` and its allowlist entry; `check:full-text` fails if one comes back.

## Verification

- The step 1 table catches any change to edits, selections or undo grouping.
- A chunk-boundary test builds a fragmented piece table where each query straddles two chunks.
- Extend `test/fullTextBoundary.test.ts`: Ctrl+D, comment toggle and move line on a 1M-unit
  document read a bounded number of units with no full read.
- `bun run check:full-text`, `bun run health`, and `bench:input` before and after on the E033
  boundary workload.

## Risks and decisions

- Sort lines and join lines over a huge selection still read what is selected; that is the
  command's own input, not a hidden copy.
- Whole-word occurrence checks need one unit on each side of a match, which can sit in the
  neighbouring chunk.

## Progress 2026-09-25

- Step 1: `packages/editor/test/editCommandTable.test.ts` records every edit action, both reindent
  commands, cut, and the four occurrence commands (96 cases) through a focused editor. Fixtures
  cover a CRLF file, surrogate pairs, reversed ranges and several selections, including two carets
  on one row. Each case asserts the edits handed to the session, the resulting text and selections,
  that one undo restores the input, and that redo restores the result. The table records current
  behaviour as it is, including two carets on one row wrapping a block comment twice.
- Step 2: `editActionForCommand` takes a `TextReadSnapshot`. Line actions read through
  [lineMap.ts](../packages/editor/src/editor/lineMap.ts): each run of selected rows, plus one row
  on each side, is read once with `readRange`, and every other row or offset is answered by the
  snapshot. Copy, move and insert work out the resulting selections by applying their edits to
  those spans. Case transforms read only the selected text. Word deletes read the caret's row and
  the breaks on either side, capped at 8,192 units each way. The window grows only when a scan
  stops within 4,096 units (the grapheme search's widest window) of an edge that is not a row edge.
  The whole-line half of cut uses the same path. The step 1 table passes unchanged.
- Tests: `lineMap.node.test.ts` compares every row and offset with a string snapshot, before and
  after copy, move and insert edits, for spans that are read apart and spans that are merged.
  `lineActionChunks.node.test.ts` runs every bounded action over a piece table split every five
  units, with selections on and across each seam. It also checks word deletes on a 39K-unit row
  against scans of the whole string. `fullTextBoundary.test.ts` adds comment toggle, move line,
  delete word and whole-line cut. Before this change each did one full read, 1,050,521 units for
  comment toggle at 1M. Now none does, and at both 64K and 1M the reads are 1,987, 1,197, 1,962
  and 1,741 units.
- Measured in happy-dom on a 16M-unit document split into about 130 pieces, median of 7 dispatches,
  before → after: comment toggle 55.5 → 5.0 ms, move line down 77.2 → 5.4 ms, join lines 37.6 →
  4.5 ms, delete word left 5.8 → 1.9 ms.
- Left for E055-b: occurrence search (step 3), trim trailing whitespace (step 4, now
  `trimTrailingWhitespaceAction(text)`), and deleting `commandDocumentText` (step 5). Both reindent
  commands also still take the string. Their literal masking scans from the document start, so
  step 5 has to move reindent onto chunk reads too.
