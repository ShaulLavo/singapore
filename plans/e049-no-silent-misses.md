# E049: A miss is an error, not a default

- Status: Proposed
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
- [internal.ts](../packages/editor/src/internal.ts) is a `@deprecated` "Phase 1 bridge" that
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
