# Singapore Textbuffer

Persistent, treap-backed text storage extracted from Singapore. This package owns text,
edits, line/offset mapping, persistent snapshots, stable anchors, and snapshot diffing.
It does not own rendering, display measurements, selections, or undo grouping.

## Development

`bun install`, then `bun run verify`. The test suite runs in Node, without a DOM.
The TypeScript configuration deliberately excludes DOM and Node ambient types from production source.
There are no runtime dependencies. The build uses only this package's TypeScript dependency.

## API

```ts
import {
  createPieceTableSnapshot,
  insertIntoPieceTable,
  materializePieceTableFullText,
} from '@singapore-editor/textbuffer'

const before = createPieceTableSnapshot('hello')
const after = insertIntoPieceTable(before, 5, ' world')
materializePieceTableFullText(before) // 'hello'
materializePieceTableFullText(after) // 'hello world'
```

The existing functional API is retained. Offsets use UTF-16 code units; ingestion normalizes
line endings, and edits retain the existing surrogate-boundary repair behavior. Extraction
changes ownership, not tree balancing, tombstones, reverse indexes, or anchor semantics.

`/debug` exposes opt-in inspection. `/diagnostics` exposes a lazy, realm-wide diagnostic sink,
disabled by default. `/internal/*` is a transitional, unstable integration surface for Singapore;
new consumers should use the main entry point. Hosts may key WeakMap sidecars by
`snapshot.buffers.identity`, which identifies a document lineage, not an individual version.
Buffer IDs may be reused by divergent versions; a sidecar must also validate the exact text.

## Moving into a repository

This directory is self-contained: copy it without `node_modules` or `dist`, run `bun install`,
and commit the resulting standalone lockfile. No repository has been created or package published
by this source extraction. No license grant is introduced; settle licensing before publication.
Singapore should eventually consume a released version from the new repository, not a copied implementation.

## Comparing against VS Code

Pin both revisions and use one deterministic edit trace, one runtime, and one correctness oracle.
Report load, edits, line/range reads, position lookup, long-session memory, and retained snapshots
separately. Align line-ending and UTF-16 edit semantics before timing. Persistence and stable-anchor
workloads are additional capabilities, not automatically equivalent to a mutable buffer's read snapshot.
No performance claim or benchmark result is implied by this extraction.
