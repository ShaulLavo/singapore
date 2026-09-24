# E033: Make full-document text reads an explicit boundary

- Status: Implemented
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E007](../docs/performance/e007-consumer-copies.md), [E031](../docs/performance/e031-projection.md), [E032](../docs/performance/e032-edit-batches.md), [E034](../docs/performance/e034-snapshot-indentation-folds.md)
- Inspected baseline: `a9140924d5c74b2dbf4b21239e261c7cc27b58e3`, 2026-09-23, plus the existing uncommitted working tree. This is a source inspection, not a measured performance baseline.

## Outcome

Reading editor state, delivering a plugin update, rendering, or applying an incremental edit
does not silently flatten the document. An external caller can still deliberately request
`editor.materializeFullText()` for save/export or another whole-document operation.
For example, updating Markdown replacements after a one-character edit reads capture ranges;
it does not allocate a document-sized string just to construct the provider's context.
Removing `legacyEditTextSnapshot` is part of this change, not its performance acceptance gate.

## Current code

All four prerequisites are marked Completed in [the backlog](backlog.json). E007 has a reusable
copy/retention workload; E031/E032/E034 have landed projection, batch, and fold contracts.
The working tree includes concurrent plugin-context and display changes. Before implementation,
record the exact revision and diff used for measurements; do not attribute those changes to E033.

- [TextSnapshot](../packages/editor/src/documentTextSnapshot.ts) already provides length, ranges,
  chunks, and explicit materialization. Piece-backed snapshots retain an initially supplied
  string but do not cache later materializations; `defineLazyFullTextProperty` separately does.
  That helper installs an enumerable, memoizing getter: object spread can pay the full cost.
- [Editor](../packages/editor/src/editor/Editor.ts), `applyEdit`/`renderEdit`, accepts an optional
  next snapshot and reconstructs a string through `legacyEditTextSnapshot` when it is absent.
  The earlier inventory found only test callers of public `Editor.applyEdit`; recheck
  [editor.test.ts](../packages/editor/test/editor.test.ts) at implementation time. View and Shiki tokenizer
  methods with the same name are separate APIs and must not be deleted by a name-only sweep.
- The same class's `providedInlineSpecs` and `createInjectedTextRowProviderContext` eagerly
  supply whole text; `getState`'s detached length fallback and `syncText` also read private `text`.
  [Document attachments](../packages/editor/src/editor/documentController.ts) expose a hidden
  full-text getter used by attach/render paths. E031 forwards snapshots into the display model;
  this plan removes remaining implicit attach/prepared reads and tab-size-inference reads.
- [Plugin contracts](../packages/editor/src/plugins.ts) make `textSnapshot` optional and
  `fullText` required on view snapshots/highlighter options. Inline replacement, injected row,
  and selection-range contexts carry full-document `text`; row/paste `text` is bounded payload.
- [View serialization](../packages/editor/src/editor/viewSnapshot.ts), `editorViewSnapshotToJSON`,
  reads full text; `JSON.stringify(runtimeSnapshot)` invokes it automatically. Visible-paint
  serialization already has a separate bounded representation and must retain that property.
- [React](../packages/react/src/index.tsx), `createStoreSnapshot`, installs another fullText getter;
  [Solid](../packages/solid/src/index.ts), `createLazyFullTextAccessor`, explicitly returns a cached
  string accessor. [LSP descriptors](../packages/lsp-plugin/src/documentSync.ts) reuse the getter,
  and [LSP workspace](../packages/lsp/src/workspace.ts) adds an implicit document `text` getter.
  E007 already inventories their consumer copies; this plan owns removal of the implicit API.
- [Merge conflicts](../packages/editor/src/mergeConflictPlugin.ts) retain `parsedText` and refresh
  through `materializeFullText`. [The parser/resolver](../packages/editor/src/mergeConflicts.ts)
  accepts strings; resolution constructs a complete result document even though Editor and the
  plugin consume only its replacement range. The public Editor conflict methods repeat this work.
- `syncText` materializes the old document before [prefix/suffix comparison](../packages/editor/src/editor/textEdits.ts).
  The incoming string is already supplied by the host; only the old-source read needs redesign.

## Scope

Change Editor repository packages, bundled plugins, framework adapters, examples, and tests.
Keep explicit whole-text access supported; delete old implicit properties and optional-source
fallbacks with their callers in the same implementation wave. No deprecated aliases or shims.
E007 owns find/minimap/LSP consumer algorithms, E031 lazy display inputs, E032 edit batches,
and E034 fallback folds. Coordinate their contracts before implementation; do not duplicate them.
This plan owns remaining context construction, implicit attach/prepared/render source access,
explicit capability design, merge-conflict source consumption, and cross-package gates. Preserve
the completed prerequisites' algorithms and verification; do not reopen their work by default.
Platform implementation is a paired host change, specified below. This plan revision changes no
runtime code. The eventual API removal and host migration must be validated together before
Platform adopts the Editor build. Persistence, settings behavior, and filesystem writes stay out
of the Editor implementation scope.

## Design

Proposed usage: plugins read `snapshot.textSnapshot.readRange(start, end)` and
`snapshot.lineStartsView`; a save caller uses `editor.getTextSnapshot().materializeFullText()`.
Capturing the immutable snapshot before an asynchronous save fixes which revision is serialized.
A full-sync protocol adapter explicitly materializes that same immutable source only when its
protocol requires text, never while projecting ordinary plugin state or converting positions.

Proposed types, defined beside the existing snapshot contracts:

```ts
type TextReadSnapshot = {
  readonly length: number
  readonly lineCount: number
  lineStart(lineIndex: number): number
  lineRange(lineIndex: number): TextLineRange
  lineAt(offset: number): number
  readRange(start: number, end: number): string
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void
}
type TextSnapshot = TextReadSnapshot & { materializeFullText(): string }
// Ordinary provider contexts expose the read capability; owners keep TextSnapshot.
type EditorTextContext = { readonly textSnapshot: TextReadSnapshot }
```

`TextLineRange` remains the existing type. Preserve UTF-16 offsets, zero-based line indices,
range end semantics, and current empty-document behavior. Export the read type through the
existing document/extensions entry points. Line queries stay backed by the existing index;
consumers must not rebuild a line-start array to replace methods omitted from their context.
Make the view's `lineStartsView` required wherever consumers currently fall back to `lineStarts`.

Make ordinary provider source fields required, including empty/detached documents. Migrate their
reachable snapshot/change contracts together, so a nested optional source cannot reintroduce
`fullText` fallback. Share immutable source identity; do not copy text or create parallel stores.
Project the existing object through the read type, rather than allocating per-update wrappers.
The ordinary projection must not expose the backing piece-table snapshot through a nested
`DocumentTextSnapshot`; retain storage/transport access at the owning document boundary.
Keep explicit materialization on public Editor/document snapshots. Narrow plugin types are an
accidental-cost guard, not a security sandbox: callers holding the public Editor can opt in.
An approved protocol adapter receives the full immutable source at its existing setup/sync boundary;
ordinary feature logic receives its read projection. Do not introduce a global permission registry.

Retire `defineLazyFullTextProperty`, private full-document `text` getters, and runtime snapshot
`fullText`. Replace full-view `toJSON()` with an exported `serializeEditorViewSnapshot(snapshot)`
function at the existing extensions entry point; it deliberately reads the captured snapshot's
entire range and returns `EditorViewSnapshotJSON`. Never substitute the editor's latest source.
Keep this function as one named extraction boundary in the source checker; retain
bounded `toVisibleSnapshot()`/visible JSON. JSON payload fields may still be named `fullText`:
already materialized data is not an implicit read. Object spread must never invoke serialization.
React's ordinary store exposes snapshots without `fullText`. Keep its explicitly requested
`controller.useFullText()` subscription, with any retained string owned by that subscription,
not by every store snapshot. Document its O(document length) cost and release on unmount.
Rename Solid's `fullText` accessor to `materializeFullText`, keep evaluation lazy, and keep at most
one cached source/result pair owned by the accessor, cleared on document disposal. No old alias.
Keep host-supplied `text`, inserted text, row strings, and paste payloads unchanged.

Delete the optional-next-snapshot branch of public `applyEdit`; require its immutable result
snapshot for detached projections. Attached document mutation continues through `edit`/buffer
transactions. Migrate direct tests to actual edits/snapshots; retain their token/offset assertions.
E032 owns batch semantics; this change must not add an independent editor text store.

Permitted flattening boundaries are public explicit extraction, explicit full-view serialization,
and protocol encoders requiring a complete string: LSP didOpen/full-sync/recovery, or initial/reset
Shiki transport while its existing worker protocol requires it. Incremental protocol changes,
hover/rename position conversion, viewport updates, and plugin context creation are not exceptions.
Keep E007's fallback reasons and E009's transport scope. Do not label every plugin a serializer.
Whole-document commands can scan chunks without becoming blanket materialization exceptions.

### Remaining operations and ownership

| Operation                                            | Required implementation                                                                                                                                                                           | Read and retention limit                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Inline replacements, injected rows, selection ranges | Pass the required read source. Markdown/decode read their capture ranges; selection features read their candidate ranges.                                                                         | Context construction reads zero characters. Retain offsets/results, not a document string.                                     |
| State summaries, attach/prepared/render              | Use snapshot length and line methods; pass the same immutable source through. Tab-size inference reads sampled indentation/alignment ranges with the existing 10,000-line limit and voting rules. | No flattening and no new full scan to prepare a view. Read long sampled prefixes in windows, without copying whole lines.      |
| Snippet insertion                                    | Replace `SnippetInsertion.documentText` with the read source; locate the insertion line through line queries and reuse snapshot-based indentation guessing.                                       | Preserve snippet indentation and alignment behavior; no full document string to insert a snippet.                              |
| `syncText`                                           | Change `syncTextEdit` to compare the old read source against the supplied string in bounded windows, preserving common-prefix/suffix edit semantics.                                              | Windows at most 16,384 UTF-16 units; at most two source-length passes, no concatenated old string. Equal text remains a no-op. |
| Merge-conflict discovery and navigation              | Parse the read source and retain regions plus immutable source identity. All Editor methods and the plugin use the same parser.                                                                   | One streaming scan per invalidated source; zero reads for repeat queries on that source. No `parsedText` cache.                |
| Merge-conflict resolution                            | Read the chosen side ranges and return replacement/range/selection, then apply normal edits or one E032 batch for resolve-all.                                                                    | Only selected payload strings after discovery; never build the resulting whole document.                                       |
| LSP/Shiki protocol encoding                          | Receive the full immutable source at the document sync boundary, with E007's existing recovery reasons.                                                                                           | One explicit extraction per required outbound full-text payload; no extraction on ordinary incremental updates.                |
| Explicit export/full-view JSON                       | Serialize the captured revision. Keep visible-paint JSON bounded.                                                                                                                                 | Caller owns the returned string; no hidden view/store cache.                                                                   |

Change `parseMergeConflicts` to accept `TextReadSnapshot`, and `resolveMergeConflict` to accept
that source and return the existing replacement/range/selection fields without `text`. Migrate
all repository callers and tests in the same wave. Callers with already supplied strings can use
the existing string-snapshot constructor; do not retain a string overload as a compatibility API.
`createMergeConflictDocumentText` remains an explicit transformation of host-supplied strings.

The conflict scanner handles marker prefixes and line endings across chunk/window boundaries,
CRLF, a final line without a newline, diff3 base sections, malformed markers, and long non-marker
lines. Scan text in windows of at most 16,384 UTF-16 units; retain only parser state, marker labels,
and result regions. Do not collect all lines or concatenate chunks into a document. Preserve the
existing neutral-insertion fast path where its correctness holds; after skipping a change, update
the source identity so a subsequent query cannot trigger a redundant scan. Do not introduce a
second independent conflict index for the public Editor methods. If a full invalidation scan
fails the typing gate with conflicts present, add incremental invalidation before acceptance;
renaming the allocation is not completion.

Document cost: materialization may allocate O(document length), runs synchronously, and does not
promise memoization. An existing supplied string can be reused, but callers cannot assume it.
Only the caller owns retention. Async encoders capture document/revision identity, cancel or discard
obsolete work, and release old sources on disposal; views must not acquire private full-text caches.

### Paired Platform migration

Inspected Platform `081135baf05c33c34550d5e48e3f873d49770a14` plus its working tree on 2026-09-23.
Recheck the inventory when implementing; the following are confirmed consumers, not a claim
that a text search proves there are no aliases or indirect consumers.

| Platform caller                                                                      | Required paired change                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/features/editor/state/unicode-hover-plugin.ts`                         | Remove the optional-source/fullText fallback; read the required source's two-code-unit range. Preserve supplementary-character handling.                                                                                                                                       |
| `apps/web/src/features/settings/state/diagnostics-plugin.ts`                         | Replace whole-string equality with length/chunk equality against the diagnostic source text. Preserve rejection of stale diagnostics.                                                                                                                                          |
| `apps/web/src/features/editor/utils/text-snapshot.ts`                                | Narrow helpers to the read capability they need. Reuse its equality behavior for settings by moving the shared helper to a qualifying shared module and updating all imports, following Platform's feature-boundary rule. Do not import from settings into the editor feature. |
| `apps/web/src/features/workspace/state/conflict-editor-resolution.ts`                | Pass the captured snapshot to `parseMergeConflicts` before explicit save extraction. Preserve the post-await source check and filesystem conflict behavior.                                                                                                                    |
| `apps/web/test/factories/language-server-snapshot.ts`, settings diagnostics fixtures | Remove runtime `fullText`/`toJSON`, supply required read sources and line views, and migrate any intentional serialization to the named function.                                                                                                                              |
| Search syntax and diff-token test highlighters                                       | Replace `options.fullText` with source range reads and update refresh signatures with the highlighter contract.                                                                                                                                                                |

Keep deliberate save/export materialization. Do not replace removed properties with
`materializeFullText()` throughout Platform to make typechecking pass. Validate Platform against
the candidate built exports, including React, and record the resolved package paths/versions;
passing against an installed older package is not evidence. Run the web typecheck and focused
Unicode hover, settings diagnostics, search syntax, diff-token, and conflict-resolution tests.
Drive Unicode hover, edit settings with stale diagnostics, and resolve/save a conflict once in
the candidate app. Record both repository revisions and the paired migration diff in the API note.

## Steps

1. Recheck the inspected working tree and record production call sites by operation and owner.
   Capture baseline diagnostics for edit, plugin update, explicit save, and full-sync recovery;
   distinguish supplied strings, copies, and retained copies. Reuse E007/E031/E032/E034 evidence
   and record the Platform caller inventory before changing declarations.
2. Introduce the required read contracts, migrate context producers and consumers, and delete
   implicit getter APIs in one buildable wave. Inspect generated declarations, not just source types.
3. Remove detached edit reconstruction. Convert remaining local reads in context construction,
   selection/inline suggestions, state summaries, and attach-time tab-size inference to ranges/chunks.
   Pass snapshots through attach/prepared/render entry points. Implement the sync comparison and
   shared conflict parser/resolver above, removing `parsedText` and the unused resolved `text`.
   End with matching document versions, selections, undo behavior, and plugin output.
4. Move legitimate extraction to explicit serialization calls; update framework/examples and
   API documentation and the paired Platform migration. Record each permitted operation, reason,
   source identity, and retention owner. Check both repositories against the candidate exports.
5. Add the enforcement below, compare the same baseline workload, and remove obsolete getter tests.
   Do not close this plan while an ordinary bundled consumer still relies on implicit full text.

## Verification

### Workloads and acceptance thresholds

These are acceptance requirements for implementation, not measurements from this plan revision.
Reuse [E007's runner](../examples/stress/copies.mjs) and the existing input-latency workload.
Use 65,536, 4,194,304, and 50,331,648 UTF-16-unit ASCII documents, each fragmented by 32 real
replacements. Add separate Unicode/CRLF, one-long-line, and chunk-split-marker correctness cases.
Hold viewport dimensions, visible text, captures, selection size, and plugin configuration fixed
as document size grows. Run both two-view plain documents and Markdown/scope/decode/conflict
contributions, including conflicts already present while typing. Separate open, steady-state,
full-sync recovery, explicit export, and disposal results.

| Measurement               | Pass condition                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context construction      | Zero text reads. Reading metadata, delivering unchanged snapshots, and spreading runtime/store snapshots do not flatten text.                                                                                                                                                             |
| Ordinary local operations | Zero full materializations/full-range reads. Per consumer, record requested range lengths and chunk visits; the sum must fit its declared capture/selection/viewport budget and stay constant across the fixed-content size sweep. Record the numeric budget before comparing candidates. |
| Intentional scans         | Attribute sampled indentation inference, sync comparison, conflict invalidation, and whole-document search separately. Apply the operation table's scan limits; no source-sized concatenation or retained source string. E008 retains ownership of search semantics.                      |
| Explicit extraction       | Output equals the captured revision; one full extraction per requested result or required protocol payload. Later edits cannot change the saved source.                                                                                                                                   |
| Allocation/retention      | No new document-sized string retained by views, plugin state, or ordinary framework stores. Explicit subscriber/encoder retention has the stated owner and ends on disposal.                                                                                                              |
| Typing latency            | For every size/configuration, candidate p95 must be at most control p95 + max(5% of control p95, 0.2 ms). Keep existing stricter input gates.                                                                                                                                             |
| Retained heap             | Paired post-GC live and post-disposal deltas must not exceed control by max(5% of the corresponding control delta, 1 MiB). A proven forbidden retained string fails even below this tolerance.                                                                                            |

For timing, disable diagnostic instrumentation, warm up 20 edits, and collect at least 200
measured edit/undo operations per size/configuration in each of five alternating control/candidate
pairs. Compare medians of the per-run p95 values. First repeat the control against itself; if its
variation exceeds the same timing tolerance, the run is inconclusive and must be stabilized and
repeated. Do not loosen the threshold after seeing a failure. A conflict scan is part of the
edit's timing when the edit triggers it, even though its read accounting is reported separately.

For heap, use E007's forced-GC lifecycle and the median across the same five pairs. Its existing
CDP measurement covers the main renderer, not worker heap; state that limit and separately check
worker payload counts and disposal. Calibrate control variation against the heap tolerance too.
Collect diagnostic read counters in separate runs, with operation and source revision attached.
Raw counters use UTF-16 units; heap evidence uses bytes. Keep raw results under
`/work/tmp/editor-e033/` and publish the commands, fixture configuration, revisions, comparison,
and retention evidence in the final performance note. No benchmark runs are needed to edit this plan.

### Contract and enforcement checks

- Add proposed `test/fullTextBoundary.test.ts`: real fragmented documents, two views, edit/undo,
  selection, viewport, and bundled Markdown/scope/decode contributions. Observe existing
  `textSnapshot.materializeFullText` and full-range diagnostics below wrapper call sites.
  Assert bounded reads for local operations and no flattening during plugin update delivery.
- Add compiler fixtures against built exports rejecting `.fullText`, full-document context `.text`,
  missing sources, and two-argument detached `applyEdit`; prove public materialization still compiles.
  Prove the line count and three line methods compile on the read type, and ordinary contexts cannot reach the
  backing piece-table snapshot through nested changes. Exercise object spread and JSON.stringify
  on runtime/store snapshots for zero hidden full reads; plain runtime JSON is not an export format.
  A typed plugin must not gain materialization through its ordinary nested read contexts.
- Add a symbol-aware production-source check for full-text getters, low-level materializers, and
  calls to explicit materialization outside named extraction/encoder functions. Follow imported
  aliases; do not use a method-name count or allow whole packages. Test the checker on a renamed
  wrapper and alias, and fail stale allowlist entries. Wire it into an existing verification script.
- Calibrate runtime instrumentation: explicit extraction must report the expected text length;
  `readRange(0, length)` must be observable too. Exercise real plugin entry points with a source
  that rejects flattening. Do not merely test that a new helper was called. Check read volume and
  allocation/retention evidence to catch reconstructing the string through chunk concatenation.
- From `packages/editor`, run `bun run test test/documentTextSnapshot.test.ts test/viewSnapshot.test.ts`
  and the new boundary test; run focused changed plugin tests and package `build`/`typecheck` scripts.
  Check React/Solid built consumers and explicit serialization tests, including protocol recovery.
  Test conflict discovery, repeat queries, single/all resolution, undo, and long-line/chunk boundary
  cases against the real snapshot. Preserve resolver output and selection assertions while deleting
  tests for the removed full-result string. Verify the paired Platform migration above.
  Run the measured workloads and thresholds above. Reuse browser servers; do not run broad suites.

## Risks and decisions

This is a public API break; removing hidden getters without migrating real callers is incomplete.
Required string protocols remain costly, and an entire-document selected range can legitimately
produce a document-sized payload. Distinguish such explicit operations from routine updates.
Static types cannot stop deliberate casts or arbitrary chunk concatenation; compiler checks,
runtime read evidence, and allocation measurements establish different parts of the boundary.
If a dependency still needs whole text, finish its consumer design rather than add a renamed slow
fallback. Acceptance requires correct output, zero hidden flattening on the agreed ordinary paths,
working explicit export/full-sync recovery, and no p95 typing or retained-memory regression.

## Implementation evidence, 2026-09-23

Base: Editor `7aa3e6c` (E049 committed as `f715d11` during the work, `refs/e033/baseline`), Platform
`a9a7158f`. The E033 diff is the Editor working tree against that base; Platform's paired changes are
`312f4419` (another session, consumers) plus the uncommitted follow-ups below. Raw results are in
`/work/tmp/editor-e033/`; the control was a worktree of the base, removed after the runs.

- Contracts: `TextReadSnapshot` (length, lines, `readRange`, chunks) is exported from the document,
  extensions and root entries; `TextSnapshot` adds `materializeFullText`. View snapshots carry a
  required read source and `lineStartsView`, with no `fullText` or `toJSON`;
  `serializeEditorViewSnapshot` is the named whole-view export. Inline replacement, injected-row and
  selection-range contexts carry `textSnapshot` instead of `text`. Contributions receive
  `EditorContributionChange` (the same object, typed without `snapshot`/`transaction`, text
  read-only), and their contexts gained `getDocumentSyncPoint`/`changesSinceDocumentSyncPoint` so a
  coalesced consumer can recover every edit. Syntax/highlighter sessions take a required
  `DocumentTextSnapshot` and `refresh(textSnapshot)`. `applyEdit` requires its result snapshot.
  `defineLazyFullTextProperty`, the private `text` getters and `legacyEditTextSnapshot` are gone.
- Local reads: tab-size inference reads its 10,000-line sample through 16K blocks; snippets, ghost
  text and selection expansion read their line or candidate ranges; `syncTextEdit` compares in 16K
  windows (at most two passes, tested); the input controller reads lengths from the source.
- Merge conflicts: `parseMergeConflicts(source)` scans the source's own chunks by index, touches only
  marker lines, and caches regions per source (one index for the plugin and the Editor methods).
  `carryMergeConflicts` moves regions across edits that touch no marker line (7 units per touched
  line), and the plugin feeds it every edit since its last scan. Resolution reads the chosen sides;
  the resolved-document string is gone.
- Remaining explicit whole-text reads, each a named function in `scripts/full-text-boundary-allow.json`
  with its reason: full-view serialization, Shiki's open payload, LSP didOpen/didSave and full-sync
  recovery, the live diff, edit-action and exact-occurrence commands (`commandDocumentText`; those
  helpers still take a string), React `useFullText`, Solid `materializeFullText`, save serialization.
- Enforcement: `bun run check:full-text` (symbol-aware, follows import and destructuring aliases,
  flags `readRange(0, x.length)` and `fullText` getters, fails stale or unexplained entries;
  `--self-test` covers a renamed wrapper, an alias and a stale entry) runs first in `health`. The
  architecture-health public-API baseline was already stale before E033 and was not rewritten.
  `test/types/fullTextBoundary.types.ts` compiles against `dist` in the core `typecheck`.
- `test/fullTextBoundary.test.ts`: two views over a buffer fragmented by 32 replacements, with
  Markdown, scope-lines, decode, merge-conflict and captures. At 65,536 and 1,048,576 units every
  operation read the same amount, with no full read and no conflict scan: type 902, peer undo 1,202,
  select 411, scroll/state/spread-and-stringify 0 units (budgets 2,048/2,048/1,024/1,024/0/0).
  Delivery with `materializeFullText` throwing on the source never reached it.

### Measurements

- Input latency (existing workload: ordinary 4.5K units with syntax, short-lines 12.8M, long-line
  1.0M; single and multiple views; 3 repetitions): ten alternating control/candidate pairs, the
  second five in reversed order. By the median of per-run p95 with limit
  control + max(5%, 0.2 ms), short-lines and long-line pass; 28 of 108 keys had controls that
  disagreed with each other past the limit. Five keys failed, all ordinary/single typing and undo by
  +0.2 to +0.25 ms at the timer's 0.1 ms resolution. A focused rerun of those two groups with 20
  repetitions (1,440 typing and 720 undo samples per build, three alternating pairs) gave per-run p95
  medians of 1.2 vs 1.1 ms (typing) and 1.0 vs 1.0 ms (undo): within the limit.
- Conflicts present, per-keystroke invalidation (`scan/`): control's materialize-and-parse took 2.0 ms
  at 4M and 22 ms at 48M (median); the candidate's fresh scan 0.8 and 9.5 ms; a carried edit 0.01 ms
  at both sizes. The first windowed-copy scanner was 1.7–2x slower than control and was replaced.
- Retained heap (E007 `copies.mjs --consumers`, 64K/4M/48M, five alternating pairs, main-renderer CDP
  heap after forced GC; worker heap not covered): open, live and post-disposal deltas equal control
  within 0.06 MiB at every size, zero retained objects. Diagnostic runs: opening now performs one
  whole-document materialization (Shiki open) instead of three; edits and undo read nothing in either.
- The plan's workload (`examples/stress/boundary.mjs`, see its README section): two views over a
  document fragmented by 32 replacements at 64K/4M/48M. `plain` and `contributions` (Markdown with
  fixed captures, scope-lines, decode, merge conflicts, with a conflict present and the caret typing
  inside it). Each run: 20 warm-up and 200 measured native keys, then the same for undo. The control
  was a worktree of the base running the same workload files. There were ten alternating pairs per
  configuration, the second five reversed, and reruns waited for load below 2.5: other processes
  pushed the load to 24 during the first batch. Median of per-run p95 input-to-applied, control →
  candidate:

  | Configuration | Size | Typing          | Undo             |
  | ------------- | ---- | --------------- | ---------------- |
  | plain         | 64K  | 1.15 → 1.10 ms  | 1.00 → 1.00 ms   |
  | plain         | 4M   | 0.95 → 0.90 ms  | 1.10 → 1.10 ms   |
  | plain         | 48M  | 1.05 → 0.90 ms  | 0.85 → 1.05 ms   |
  | contributions | 64K  | 2.15 → 1.90 ms  | 1.90 → 1.70 ms   |
  | contributions | 4M   | 13.00 → 1.85 ms | 13.75 → 1.60 ms  |
  | contributions | 48M  | 89.65 → 1.55 ms | 114.65 → 1.60 ms |

  No key exceeds control + max(5%, 0.2 ms). Some controls failed the self-repeat check: the
  contributions controls at 64K typing and 48M undo, and three plain undo keys. Of those, only 48M
  undo is past its limit when the first pair, which the load spike reached, is dropped. Its control
  swings between 106 and 117 ms against a candidate at 1.6 ms. The first, unstabilized batch had one
  failing key, plain 4M typing dispatch (0.9 → 1.15 ms). It passed in the gated rerun (0.95 → 0.90).
  Diagnostic runs: the candidate's typing and undo read 237,000 units with zero full reads at every
  size. The control's contributions typing and undo did 600–880 full reads and read up to 44 billion
  units at 48M. At 48M the contributions open heap went from 194 to 98 MiB, the live heap from 245 to
  149 MiB and open time from 244 to 46 ms. Post-disposal heap matched control (3.4 MiB) and nothing
  was retained. Export time was equal (6.5 ms at 48M). Full-sync recovery is not part of this
  workload; the LSP tests cover it. Raw results are in `/work/tmp/editor-e033/boundary/`.

### Tests and Platform

- Core: 2,796 tests, 4 failing (Shiki worker-cache ×3, BiDi perf probe), the same as the control.
  diff (4), typescript-lsp (5) and React (3) fail the same tests as the control; every other migrated
  package passes. Workspace `typecheck` 40/40; knip reports one issue fewer than the control.
- Platform: web typecheck clean against the linked candidate builds (`@singapore-editor/*` →
  `/work/projects/Editor/packages/*`, dist rebuilt from this tree); `bun run gates` and the
  feature-import lint pass; focused tests (search syntax, settings diagnostics, conflict resolution,
  diff tokens, semantic tokens, workspace edits) 136/136. Follow-ups to `312f4419`:
  `lib/text-snapshot-equality.ts` (chunk equality, now shared by editor, workspace and settings; the
  workspace→editor allow entry is gone), UTF-8 size counted by chunks in the semantic-token cap, and
  scenario `editor-conflict-merge`.
- Mesh release `20260923T192600Z-a9a7158f-e033-full-text-boundary`: `editor-lsp-hover` (Unicode
  confusable hover) and `editor-conflict-merge` (3/3) pass. The conflict toast closes after a `resolved` outcome. An earlier note said it stayed up, but that came from a screenshot taken before the dismissal animation, and from a timeout that was really the watcher race. The scenario now asserts that the toast closes. Settings with stale
  diagnostics were not driven in the app: the workspace settings layer is bound to the server's
  workspace root, so a disposable fixture cannot supply it; the diagnostics-plugin tests cover it.

### Review follow-ups, 2026-09-23

A review of the diff raised ten findings. Fixed:

- UTF-8 cap: counts an unpaired surrogate as the 3 bytes U+FFFD takes. It matched `TextEncoder` at
  every chunk split.
- `carryMergeConflicts` rescans once a batch touches 1,024 lines or more.
- `readLeadingWhitespace` probes 64-unit windows that grow. Ghost text stops at the line end.
- `check:full-text` catches `readRange(0, length)` through a local or destructured length, and fails
  when an `@singapore-editor/*` import does not resolve, since a missing `dist` hides references.
- Cleanup: the React store identity alias, the unreachable `rangeAroundOffset` fallbacks, and an
  orphan find comment.

Not changed:

- LSP positions past the last line: the snapshot and string converters give the same offsets (a
  direct comparison), so there was no regression.
- The merge-conflict plugin scans on its first edit when it has no parse point, once per document.
  Control materialized and parsed on every edit that was not a neutral insertion.
- `documentSessionChangeTextSnapshot` predates E033.

Redeployed as `20260923T195754Z-a9a7158f-e033-review-fixes`; `editor-conflict-merge` and
`editor-lsp-hover` pass on it.

### Second review, 2026-09-24

- Solid kept a closed or replaced document's text until the next read or controller disposal.
  `setTextSnapshot` now drops the cached pair whenever the source changes, without reading the new
  one. Tests `lets go of a replaced/closed document once its text was read` fail with the release
  removed and pass with it. The GC probe collects before it calls `deref`, because `deref` keeps its
  target alive until the current job ends.
- The plan's workload now exists and ran, as recorded above.
