# E049: A miss is an error, not a default

- Status: Implemented
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E033](e033-explicit-full-text-boundary.md)
- Inspected baseline: `aeba6783b978193de9d2ba0fd5874f357df68edc`, 2026-09-21.

## Outcome

E033 owns deleting `legacyEditTextSnapshot` and making `textSnapshot` required; this plan does not
repeat it.

When the core cannot do what it was asked, the caller finds out: a type error at build time, a
thrown structured error, or a `null` it must handle. Today several paths answer with a quiet
default, and the symptom shows up somewhere else as a stale highlight, an ignored call or a
decoration on the wrong row.

## Current code

Verified in source 2026-09-21 unless marked otherwise.

- [Editor.ts](../packages/editor/src/editor/Editor.ts) lines 1058, 1086, 1116 and 3020:
  `if (editorBufferSession(this.session)) return`. `setContent`, `applyEdit`, `setDocument` and one
  more public entry point do nothing on a buffer-session editor. No throw, no log, no result.
- [displayProjection.ts](../packages/editor/src/virtualization/displayProjection.ts),
  `bufferRowForRow`: `getRowMetrics(clamp(index, rowCount - 1))?.bufferRow ?? 0`. An unmapped
  display row becomes buffer row 0, and that feeds row decorations, gutter contributions and fold
  markers.
- [plugins.ts](../packages/editor/src/plugins.ts): `onDidType?`, `log?`, `announce?`,
  `getReservedOverlayWidth?`, `trackRanges?`, `trackPoint?`, `setRangeHighlight?`,
  `clearRangeHighlight?` and `highlightPrefix?` are optional "so a hand-written context keeps
  compiling". The one real implementation provides all of them, so every call site writes
  `foo?.()` and a missing member is a skipped feature. `stickyScroll.ts` falls back to the literal
  prefix `'editor'`, which reintroduces the cross-editor highlight collision the unique prefix
  exists to prevent. (Not individually verified.)
- [viewContributions.ts](../packages/editor/src/editor/viewContributions.ts),
  `queueReentrantUpdate`: any nested update whose kind is not `'layout'` is dropped without a log.
  (Not verified.)
- A deprecated positional `setSelection(…, revealOffset)` overload is declared five times across
  `plugins.ts`, `Editor.ts`, `selectionReveal.ts` and `packages/solid`. (Not verified.)
- `packages/editor/src/internal.ts` (deleted by this plan) is a `@deprecated` "Phase 1 bridge" that
  re-exports the internal view, scheduler and plugin context. `public/secondaryViews.ts` exports
  the internal `VirtualizedTextView` class as `EditorSecondaryTextView`, and sticky scroll writes
  `lineView.scrollElement.style.height` because there is no `setHeight`. (Not verified.)

## Scope

`packages/editor`, the bundled plugins that call the optional members, and `packages/solid`. No
compatibility shims: the project is greenfield, so an overload or an optional member is deleted
with its callers in one pass.

## Design

- Buffer-session entry points either work or throw a structured error naming the operation and the
  session kind. Which, per method, is D1.
- `bufferRowForRow` returns `number | null`. The clamp survives only in scroll math, where a clamp
  is the right semantics; decoration and gutter lookups handle the miss.
- Context members become required. Test doubles come from one
  `createTestViewContributionContext()` in the test helpers, so a new member is added in one place.
- Re-entrant updates of every kind are queued and drained after the current pass, or a write during
  `update()` throws in development. D2.

## Steps

1. Required context members plus the test-context factory; delete every `?.()` on them.
2. `bufferRowForRow` to nullable; fix callers.
3. Buffer-session entry points per D1.
4. Re-entrant update policy per D2.
5. Delete the `setSelection` overload and `selectionReveal`'s union resolution.
6. Inventory `internal.ts` consumers; promote what is public, delete the rest, give secondary views
   a typed interface with `setHeight`.

## Verification

- Typecheck is the gate for steps 1, 2 and 5: removing a member from the factory must fail to
  compile, and no `?.(` remains on a context member.
- A test per buffer-session entry point asserting the chosen behaviour.
- A contribution test that mutates a range highlight inside `update()` and sees the follow-up
  notification arrive.

## Risks and decisions

- D1: for each of the four buffer-session no-ops, route through the session or throw.
  Recommendation: `applyEdit` and `setContent` route through; `setDocument` throws.
- D2: queue all re-entrant kinds, or forbid writes during `update()`. Recommendation: queue. A
  decoration provider that sets a highlight from `update()` is a legitimate shape.

## Implementation evidence, 2026-09-23

E033 is still open. This plan did not need it: E033 alone owns `legacyEditTextSnapshot`.

- Steps 1 and 2: every optional member on the view, document, capability, edit and plugin
  contexts is required, and every `?.(` on them is gone. The typecheck found two real gaps:
  the edit and feature contexts never implemented `registerProvider`, and the feature context
  never implemented `startSnippetSession`. Test doubles come from four factories in
  `src/testContexts.ts`, exported from `@singapore-editor/core/testing`. `defaultHighlightPrefix`
  (lsp-plugin, typescript-lsp) is deleted with every `highlightPrefix ??` fallback. Also deleted:
  find's no-tracker path, markdown's and tree-sitter's "unsupported host" warnings, and
  diagnostics' missing-highlight guards.
- Step 2: `bufferRowForRow` returns `number | null`. Decoration lookup treats a miss as no
  decoration. A mounted row the projection cannot place throws `EDITOR_ROW_UNMAPPED`; with that
  throw in place the full editor suite never reached it.
- Step 3 (D1 as recommended): `setContent` and `applyEdit` go through the session in one
  operation, so the change is undoable and every view renders it. `setDocument` throws
  `EDITOR_SET_DOCUMENT_ON_BUFFER_SESSION`. The routed calls apply the same gate as `edit()`,
  but loudly: a leased buffer throws `EDITOR_BUFFER_LEASED`, and a read-only or provisional
  editor throws `EDITOR_NOT_EDITABLE`. On a buffer session, `applyEdit` adopts the caller's
  tokens inside the edit's own operation, before its change listeners run, so a listener that
  opens another document never receives them. It ignores its optional `textSnapshot`, because
  the session makes one.
- Step 4 (D2, queue): every re-entrant kind is queued with its change and delivered after the
  pass, in order. A layout requested during a layout pass still coalesces, so
  `requestViewUpdate()` from `update()` cannot loop. Each queued update records the update
  whose pass asked for it. The cap is on the depth of that chain (32), not on the queue, so a
  one-off burst of any size is delivered in full. When a chain passes the cap, every
  contribution that asked more than once along it is part of the cycle. Each one is reported
  through `onFailure` with `EDITOR_VIEW_UPDATE_LOOP` and removed, and so are its queued updates.
  A contribution that only reacted once stays, and the other contributions keep receiving
  updates. A loop with no contribution to blame still throws. The test suites exercise re-entrant paths that were previously
  dropped: viewport during document or viewport, selection during document, and content during
  content. The typing, find, completion, hover, fast-scroll and split-view scenarios never
  re-enter, so the hot path gains no extra pass. That was checked with a temporary probe and a
  control probe that did fire.
- Step 5: the positional `setSelection(…, revealOffset)` overload is deleted from core, both
  context types, Solid and React, together with `EditorSelectionRevealOptions`,
  `EditorSelectionRevealTarget` and `normalizeEditorSetSelectionOptions`. Platform's one caller
  was passing the caret as the reveal target, which is already the default.
- Step 6: `internal.ts` and its export are deleted. Its consumers moved as follows:
  - `core/document`: selection helpers, `documentSessionChangeTextSnapshot`,
    `defineLazyFullTextProperty`
  - `core/extensions`: snippet parsing
  - `core/rendering`: `scheduleFrame`
  - `core/debug`: `forEachBufferSpan`
  - `core/testing`: `reclaimPieceTableText` and the concrete text view that tests narrow to

  The secondary text view is now the `EditorSecondaryTextView` interface from
  `createEditorSecondaryTextView`: read-only, out of the tab order, with `setHeight`. Sticky
  scroll no longer writes `scrollElement.style.height`.

Verification:

- Typecheck is clean in every package and at the repo root, except the known
  `indentationGuess.ts:83` and `typescript-lsp/test/markdownTooltip.test.ts:21`. Platform
  web, server, tui and client-core also typecheck.
- New tests: one per buffer-session entry point, the re-entrant delivery order, the loop stop,
  nullable `bufferRowForRow`, and the secondary view factory. `public-api.test.ts` pins that a
  positional reveal offset no longer compiles.
- Editor suite: 2772 pass, 4 fail. The failures are the same as before the change: three in
  `workerClient-cache`, one in `bidiPerfProbe`. Other suites fail only where HEAD fails
  in a clean worktree: diff 4, react 3, typescript-lsp 5. Every other package passes.
- Format check and lint pass. knip reports no new findings in changed files.
