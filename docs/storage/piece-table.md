# Storage Engine: Treap-Backed Piece Table

## Status: Implemented and Proven

The editor's storage engine is a treap-backed piece table with persistent immutable snapshots via structural sharing. Each mutation returns a new snapshot; previous snapshots remain valid and unmodified.

**Implementation:** `packages/textbuffer/src/`
**Types:** `packages/textbuffer/src/pieceTableTypes.ts`
**Operations:** `packages/textbuffer/src/pieceTable.ts`

## Locked Decisions

- Treap-backed piece table as the storage engine
- Persistent (immutable-snapshot) data model for undo
- Opaque buffer identity with append-only chunk storage
- Buffer chunk storage is exposed as `ReadonlyMap` at the type boundary; no debug-only accessor layer for now
- UTF-16 code units as the native encoding
- Line-ending normalization to `\n` on load
- Phase 2 deletion keeps invisible pieces in the treap rather than physically removing them

## Capabilities

| Capability | Complexity | Notes |
|---|---|---|
| Insert text at offset | O(log n) | Split treap at offset, merge with new node |
| Delete text range | O(log n) | Current implementation physically removes pieces; Phase 2 changes this to mark pieces invisible |
| Read text range | O(log n + k) | Tree walk collecting piece slices |
| Snapshot isolation | O(1) | Structural sharing; old roots remain valid |
| Document length | O(1) | Currently cached in `subtreeLength`; Phase 2 switches user-facing length to `subtreeVisibleLength` |
| Piece count | O(1) | Cached in `subtreePieces` aggregate |

## The Piece

The editor has one fundamental text-slice record: the **piece**. There is no second slice abstraction. A piece is a descriptor (`buffer`, `start`, `length`) pointing into one of the buffers via a `PieceBufferId`.

A piece's `(buffer, start)` pair serves as its insertion identity — no separate `insertionId` field is needed. The anchor model (see [Anchors](../positions/anchors.md)) builds on this identity without introducing new record types.

## Aggregate Maintenance Pattern (Locked)

All subtree aggregates (`subtreeLength`, `subtreePieces`, and future additions like `subtreeLineBreaks`, `subtreeVisibleLength`) are computed in a single function pattern. `createNode` delegates to aggregate computation; every site that reassigns children recomputes aggregates on the result. There is no separate update that mutates individual fields — partial aggregate updates are structurally impossible. Adding a new aggregate means adding it to the aggregate function and the `PieceTreeNode` type.

## Enrichment Roadmap

**Phase 1 — Line breaks:**
- Piece gains `lineBreaks` field (newline count in its buffer slice)
- Treap node gains `subtreeLineBreaks` aggregate
- Enables O(log n) offset-to-row/column conversion

**Phase 2 — Anchor resolution:**
- Treap node gains `subtreeVisibleLength` aggregate, maintained in the shared aggregate function
- Piece gains `visible: boolean`
- Delete marks pieces invisible instead of removing them
- `subtreeVisibleLength` sums only visible pieces and becomes the user-facing document length aggregate

**Future — Collaboration:**
- The Phase 2 visibility model is reused rather than redesigned
- Reverse index keys remain extensible to replica-scoped buffer identity

## Phase 1 Prerequisites

### Opaque BufferId

**Status: complete.** `PieceBufferId` is an opaque branded string.

Phase 2 must continue treating buffer identity as opaque. No string-literal comparisons should be introduced.

### Chunked Append Buffer

**Status: complete.** Inserted text is stored in immutable chunks, each with its own `PieceBufferId`.

Pieces reference chunk identity plus local range. Appending inserted text is O(1) amortized over bounded chunks.

**Alternatives rejected:**
- Single string: O(n) per insertion. Unacceptable.
- Rope: Unnecessary — the piece table already provides the tree structure.
