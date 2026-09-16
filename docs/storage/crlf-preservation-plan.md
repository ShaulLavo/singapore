# CRLF preservation and anchor retention

- Status: Accepted direction; implementation deferred.
- Recorded: 2026-09-16.
- Owner: Textbuffer and Editor; persistence integration belongs to the host.
- Inspected baseline: `46c349229f56de838c9c4c0e987a39363240a44e` on PR #16.
- Scope of this change: Documentation only. The current LF-normalizing behavior is unchanged.

## Outcome

Adopt the CRLF responsibility split described in Cameron DaCamara's
[Text Editor Data Structures, CRLF section](https://cdacamar.github.io/data%20structures/algorithms/benchmarking/text%20editors/c++/editor-data-structures/#crlf):
preserve the carriage return and line feed in storage, allow them to occupy different pieces,
and handle paired caret movement and interactive deletion in the editor rather than tree balancing.
This adopts the boundary, not his red-black tree, encoding, or complete implementation.

For an LF/CRLF document, default reads and saves should retain its existing line endings:

```text
ingest:       "a\r\nb\nc"
stored text:  "a\r\nb\nc"
default save: "a\r\nb\nc"
```

Mixed LF/CRLF files must no longer be rewritten to one preferred ending merely by opening
and saving. A preferred ending can still determine what Enter inserts; it is not a description
of every existing newline. This is preservation of decoded text, not a promise to preserve
arbitrary original file bytes or encodings.

## Current code

- [lineEndings.ts](../../packages/textbuffer/src/lineEndings.ts) normalizes CRLF, lone CR,
  and U+2028/U+2029 to LF; document ingestion also separates a leading BOM.
- [snapshot.ts](../../packages/textbuffer/src/snapshot.ts) invokes ingestion unless
  `normalized: true` is supplied. That bypass is not a supported editor-wide CRLF mode.
- [edits.ts](../../packages/textbuffer/src/edits.ts) does not normalize incoming text;
  [documentSession.ts](../../packages/editor/src/documentSession.ts) currently does.
- [documentText.ts](../../packages/textbuffer/src/documentText.ts) re-expands every LF on
  CRLF export. Keeping this exporter after admitting raw CRLF would produce `\r\r\n`.
- [buffers.ts](../../packages/textbuffer/src/buffers.ts) counts LF for line indexes and
  avoids chunk boundaries after CR. The CR-specific chunk restriction should not be needed
  under the proposed contract; surrogate-boundary rules are a separate concern.
- [documentTextSnapshot.ts](../../packages/editor/src/documentTextSnapshot.ts) connects
  storage positions to editor reads. Rendering and other consumers currently assume LF-only text.

## Scope

Change storage ingestion/export and editor integration together, in a follow-up to extraction.
Keep persistent treap balancing, reverse indexes, tombstones, and existing anchor bias semantics.
Do not add an alternative tree, an extra per-document CRLF index, or automatic tombstone collection.
Do not merge this behavioral change just because the standalone package tests pass.

## Design

### Storage owns exact positions, not interactive CRLF atomicity

Preserve LF and CRLF as supplied through document loading and raw edit APIs. Storage length and
edit offsets remain UTF-16 code-unit counts: `"a\r\nb"` has length four, not three.
A CRLF pair is two stored code units and one LF-delimited line break.

Keep the existing LF-counting subtree/index model for LF/CRLF input. Do not require the two
characters to share a piece, chunk, or tree node. Do not add CRLF repair to split/merge.
Raw offset/point conversion describes the stored text, not a painted caret column.
An offset between CR and LF can exist at the storage layer; interactive caret rules belong above it.
Raw programmatic edits may intentionally create or split a pair. Do not silently widen every edit.
Existing surrogate-safe editing and anchor behavior are not being redesigned here.

### Editor owns line presentation and interactive boundaries

Introduce or adapt shared editor-level helpers, with proposed names chosen during implementation,
for logical line ends and previous/next interactive edit boundaries. Reuse them across keyboard,
mouse selection, hit testing, commands, clipboard, IME, and accessibility instead of scattered checks.

A displayed line excludes a CR only when it immediately precedes that line's terminating LF.
End lands before the pair, ordinary arrow movement skips the pair, and interactive Backspace/Delete
removes the pair together. A final unpaired CR must not be discarded by a blanket trim.
An explicit programmatic raw-range edit is distinct from an interactive delete command.

Look at adjacent characters in the snapshot's **visible text**, not adjacent physical nodes.
`[CR][invisible piece][LF]` is an adjacent CRLF in the live document. A pair split across two
visible pieces has the same behavior as a pair stored together. Use bounded reads or the walker;
no full-document scan on each caret move. Do not rewrite anchor identity to enforce caret policy.

Enter uses the document's preferred ending. Pasted LF/CRLF text is preserved by default;
any paste conversion must be an explicit host/editor policy, not an implicit tree operation.
Audit multi-cursor edits, reported changes, undo inverses, and selection endpoints against the
actual inserted code-unit count. Two views of one snapshot must agree on storage coordinates.

### Export and migration must change at the same boundary

Default export emits stored LF/CRLF text without expanding it again, retaining the existing
explicit BOM policy. A requested whole-document EOL conversion is a separate operation that
recognizes existing pairs. Never implement it as blindly prefixing every LF with CR.
Define whether an explicit conversion updates document state or only exported output, and test
that choice. Merely changing the preferred ending must not rewrite existing text.

Audit raw offsets versus display columns in LSP, Tree-sitter, find/replace, diff, workers,
serialization, clean-state tracking, and save paths. Keep snapshot/version identity attached to
positions crossing asynchronous boundaries. Do not interpret normalized offsets or persisted
anchors as raw-CRLF offsets without a migration/version decision. Previously normalized mixed
endings cannot be recovered from a single saved line-ending preference.

BOM handling, lone-CR line semantics, and U+2028/U+2029 rendering require explicit decisions.
Removing all of `normalizeDocumentText` would change those too. Separate their policies rather
than silently broadening this migration or dropping existing rendering safeguards. The storage
line-index proposal above covers LF and CRLF, not a newly promised lone-CR line mode.

### Tombstones remain part of the anchor contract

[Anchor semantics](../positions/anchors.md) require deletion to change liveness, not identity.
[anchors.ts](../../packages/textbuffer/src/anchors.ts) resolves a buffer-relative identity through
a snapshot's reverse index and visible-prefix calculations, including invisible pieces.
[Deletion](../../packages/textbuffer/src/edits.ts) retains those pieces with `markTreeInvisible`.

Keep tombstones and the matching reverse-index entries. They preserve the ordered location of
removed spans so an existing anchor can resolve in the **current** snapshot with deleted liveness
and its left/right bias. Keeping an old root preserves the old text, but does not by itself supply
that deleted-position mapping in a newer root. Persistence and anchor retention solve different jobs.

This requirement is specific to the current anchor design, not a claim that all possible anchor
systems require tree tombstones. Removing them would require an equivalent deleted-position mapping
or a reviewed anchor-lifetime/remapping design. That is not CRLF work or extraction cleanup.
Dropping an undo entry alone does not prove a tombstone is unreferenced: consumers can retain anchors.
[E006](../../plans/e006-tombstone-reclamation.md) remains the separate reclamation investigation.
It must prove preservation of supported anchors and retained snapshots before removing any records.

## Steps

1. Inventory LF-only assumptions and specify raw offsets, logical line ends, preferred EOL,
   exact export, and explicit conversion. Record BOM/unusual-terminator decisions before coding.
2. Add failing storage tests for LF/CRLF preservation and cross-piece pairs, using a string oracle.
   Change ingestion/export as a coordinated boundary; retain the existing snapshot/anchor contract.
3. Implement shared editor CRLF boundary helpers and migrate all affected input, view, and adapter
   consumers. Keep changes and undo receipts in raw coordinates. Produce real-browser evidence.
4. Validate host save/clean-state behavior and persisted-position compatibility. Record any host
   integration still outstanding rather than treating an Editor demo as the persistence integration.
5. Update API contracts and LF-only documentation, then compare the same edit/read workloads
   before and after. Do not claim that moving CRLF policy automatically improves performance.

## Verification and acceptance

- Uniform LF, uniform CRLF, mixed LF/CRLF, empty documents, trailing newline, and BOM fixtures:
  catch unintended normalization, lost metadata, or `\r\r\n` on default save.
- Cross-piece/chunk pairs, separately inserted CR then LF, insertion inside a pair, deletion of
  one half by a raw edit, and deletion that makes previously separated CR/LF adjacent:
  catch assumptions about piece boundaries and stale line/position metadata.
- Pair adjacency across tombstones; anchors before, between, after, and inside deleted spans;
  replacement bias, delete-all, undo/redo, and retained snapshot branches:
  catch identity loss, incorrect liveness, and physical-versus-visible adjacency mistakes.
- Real-browser arrows, Home/End, Delete/Backspace, mouse selection, paste, multi-cursor, IME,
  hit testing, accessibility, and two views: catch carets inside pairs or stray CR in painted rows.
- LSP/parser/worker position round-trips, find/replace, diff, dirty tracking, and host saves:
  catch raw/normalized coordinate mixing and accidental whole-file newline conversion.
- Add the standalone cases to the textbuffer suite; adapt existing
  [line-ending tests](../../packages/editor/test/pieceTable-lineEndings.test.ts) and retain
  editor integration coverage. Run `bun run --cwd packages/textbuffer verify`, workspace
  typecheck/tests, and real-browser projects through the repository's package scripts.

Accept only when existing LF behavior remains correct, LF/CRLF text survives default round trips,
visible line/caret behavior is correct regardless of piece layout, and retained anchors/snapshots
keep their semantics. Record a baseline and any performance regression; do not relax gates to ship.
No runtime changes, tests, benchmarks, or CRLF migration have been performed by this document.
