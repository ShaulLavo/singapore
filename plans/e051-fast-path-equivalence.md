# E051: Every fast path is pinned to the slow path it stands in for

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: none
- Inspected baseline: `aeba6783b978193de9d2ba0fd5874f357df68edc`, 2026-09-21.

## Outcome

Where the core has two implementations of one question, a test proves they agree, or one of them is
deleted. A divergence here produces a wrong screen with no error anywhere, which is the most
expensive kind of bug this codebase can have.

Items below come from the 2026-09-21 audit and were not individually re-verified; step 1 confirms
them.

## Current code

- [virtualizedTextViewLayout.ts](../packages/editor/src/virtualization/virtualizedTextViewLayout.ts):
  `sameLineEditPatch` and `multiLineEditPatch` are incremental row-layout paths. They bail to a full
  re-layout when `hasModelRowProjections` sees a fold map, word wrap, an inline map or injected
  rows. That gate is a hand-kept list of features the fast path does not understand, so a fifth
  projection kind added without touching it yields a wrong layout. No test references
  `sameLineEditPatch`, `multiLineEditPatch` or `hasModelRowProjections`.
- [virtualizedTextViewRows.ts](../packages/editor/src/virtualization/virtualizedTextViewRows.ts):
  `bufferRowForDisplayRow` prefers the display row's own `bufferRow` and falls back to the
  projection, while `rowDecorationForVirtualRow` goes straight to the projection. Row identity uses
  one converter and decoration lookup the other.
- The same file's `createSplitTextChunkParts` is safe only for "simple" text; the caller gates on
  `isSimpleRowText` and the function does not.
- `mouseSelection.ts` and `fixedRowVirtualizer.ts` hold byte-identical `requestAnimationFrame`
  shims, each casting a timer handle to `number` through `unknown`.
- [scope-lines/src/index.ts](../packages/scope-lines/src/index.ts), `scheduleContentUpdate`, renders
  on the next frame in a browser and synchronously where `requestAnimationFrame` is missing. Only
  the deferred path re-checks `geometryCommitted` and requests a view update, so the path tests
  take differs from the one production takes.
- `syntaxController.ts` uses one-shot `skipNextStructuralRefresh` and `skipNextHighlighterRefresh`
  latches, consumed by whichever refresh arrives next.

## Scope

`packages/editor` and `packages/scope-lines`. Test additions are the bulk of the work.

## Design

- The projection declares `supportsIncrementalRowPatch`; the layout asks it. The list of features
  lives with the features.
- A property test drives random edits over documents with each projection kind enabled and asserts
  the patched row set equals a full re-layout. This is the single highest-value item in the audit.
- One display-row to buffer-row converter, used by reconciliation and by decoration lookup.
- `createSplitTextChunkParts` checks its own precondition.
- One `scheduleFrame` helper with a real handle type. Scope lines always defers through the
  contribution scheduler, and tests flush it.
- The syntax latches become a comparison against the prepared session's document version.

## Steps

1. Confirm each item against source.
2. Write the equivalence property test first, against the current gate. Any failure it finds is a
   live bug and is fixed before the refactor.
3. Invert the gate, then merge the converters.
4. Frame helper, scope-lines scheduling, syntax latches.

## Verification

The property test runs in CI with a fixed seed set plus one random seed that it prints on failure.
Existing layout and input-latency gates do not regress.

## Risks and decisions

- D1: the property test's running time. Bound the document size and edit count so it stays under a
  few seconds; breadth comes from seeds, not from size.
