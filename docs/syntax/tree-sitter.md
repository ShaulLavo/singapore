# Tree-sitter Syntax System

## Decision

Tree-sitter is the first-party structural syntax engine, delivered through the optional `@singapore-editor/tree-sitter` runtime plugin. Core editing remains plain when no syntax provider is registered. Shiki remains available as an optional highlighter package for hosts that prefer it.

Tree-sitter provides a single structural model for:

- syntax highlighting through highlight queries
- folds
- structural selection expand/shrink
- bracket and tag matching
- indentation
- language injections
- outline-style symbol extraction
- future semantic decorations and code-intelligence hooks

## Runtime requirements

Tree-sitter and the same-memory Markdown extension require `WebAssembly.Memory.prototype.toResizableBuffer()`. The supported floors are Chromium 144, Firefox 145, Safari 26.2, Node 26.0.0, and Bun 1.2.22. Repository development uses the pinned Bun version and Node 26 on `PATH`; Vitest and grammar generation run in Node.

## Core Invariant

The piece table remains the canonical document model. A Tree-sitter parse is a derived projection over one `PieceTableSnapshot`.

Selections are stored as anchors, not Tree-sitter nodes. Tree-sitter can create, expand, shrink, and classify selections, but the resulting ranges must cross the API boundary as anchor-backed ranges.

This preserves correctness when:

- parsing is stale
- syntax is temporarily invalid
- no grammar exists for the file
- edits arrive faster than worker parsing
- undo/redo switches snapshots
- multi-cursor selections cross syntax boundaries

## Worker Ownership

Tree-sitter is owned by the optional runtime package and runs behind a syntax backend. The default backend is a local browser worker. Parser creation, grammar loading, parsing, incremental reparsing, query execution, injected-language parsing, and syntax-tree traversal all run off the main thread.

The main thread may render syntax results, but it must not synchronously parse or query during typing. It should only consume compact, snapshot-tagged worker outputs:

- highlight decorations
- fold ranges
- structural-selection ranges
- indentation hints
- bracket/tag match ranges
- outline or symbol summaries

Each parse result is tied to a document snapshot/version. Consumers must be able to reject syntax results whose base snapshot is older than the visible document state.

### Long requests

A page without cross-origin isolation has no shared memory, so it cannot interrupt a running worker. The worker therefore never runs long without returning to its message loop:

- A range query against a parsed document runs in slices of about 8,192 units and yields between slices once 8 ms have passed. A request queued behind it (a newly opened document, rows just scrolled into view) waits for one slice. The answer is the same as one query over the whole range: a node that crosses a slice boundary is reported by the slice that contains its start, and brackets and errors come from one walk over the whole range that pauses and resumes. A query whose document was closed or edited meanwhile stops at its next slice. If its snapshot was replaced by another parse of the same text, it starts over on the replacement.
- A slice never ends inside a token. A boundary that falls in one moves to the token's end, so a token longer than many slices (a minified line's string, a huge identifier) is matched, and its predicates are read, once and not once per slice.
- Folds are listed in one order however the range was sliced: by lines, then by offsets, then by node type and language.
- A close is announced to the worker at once, ahead of the session's unfinished requests, and the close itself follows when they have settled. Without shared memory the announcement is the only way a running query learns its document is gone.
- A closed document is forgotten at once, and its trees are freed after the first 20 ms in which no request arrived, a few milliseconds at a time. The document opened in its place is queued right behind the close, and its first colors need a handful of short requests: they run before the release, and what follows them runs between its steps. The wait counts request arrivals, with a bound of 100 rounds.

The session numbers its range requests. Each caller is answered with the range it asked for, and `getResult()` keeps the answer to the request made last, whichever reply arrives last.

## Incremental Parse Pipeline

1. Worker receives an edit batch against snapshot `S`.
2. Piece table produces snapshot `S+1`.
3. The syntax system translates the edit batch into Tree-sitter input edits.
4. Tree-sitter incrementally reparses against `S+1`.
5. Queries run for invalidated or visible ranges first.
6. Query results are emitted as syntax decorations or structural ranges tagged with their base snapshot.

### Range requests while scrolling

The shown rows always come from one answer for the visible range: its tokens, brackets, folds, copy colors and readiness. The editor asks for the visible range again whenever the last such answer no longer covers it.

Beside it, the editor asks for a look-ahead window: up to 750,000 characters in the scroll direction and 50,000 behind. That request is optional and separate. It asks only for the window's uncached text, and asks again on a side only once less than half of that side is cached next to the viewport. At most one look-ahead request is on the way at a time. Its answer only paints provisional token colors until the visible answer lands. The view keeps the newest look-ahead answer on each side of the shown rows.

A range query every caller has left is never sent to the worker. One already running stays joinable for 150 ms for a caller asking for the same range again; after that, or as soon as another range is asked for, it is cancelled. A look-ahead on the way that falls outside the look-ahead window for either scroll direction is cancelled before the new viewport is asked for; turning around keeps it. A caller's query is never cancelled because another caller's query started. Cancelling stops the worker mid-query where shared cancellation flags are available (a cross-origin-isolated page), and otherwise drops the query before it is sent, or re-sent once the complete analysis lands.

Open implementation details:

- exact Tree-sitter input adapter for piece-table reads
- websocket backend protocol beyond the local worker backend
- parser package loading policy for third-party language plugins
- query asset format beyond raw highlight/fold/injection query strings
- cancellation or superseding behavior for stale parses

The current parsed snapshot retention, source chunk accounting, and worker restart policy are
recorded in [Worker Topology](../architecture/worker-topology.md#tree-sitter-syntax-worker).

## Highlighting

Tree-sitter highlight queries are the long-term source of syntax highlighting.

Highlight output should be represented as dense decorations with offsets or line-scoped ranges. It must not allocate an anchor per token. The renderer may continue using the CSS Highlight API, but the source of ranges should be Tree-sitter query output.

### Range answers

A range-mode editor asks for the text it shows, one range at a time, and keeps the answers in `EditorSyntaxController`. The frame trim keeps every answer that is the newest one for some shown text, whoever painted the tokens (range answers, a separate highlighter, or a host). The view asks again for shown text without an answer, so dropping one of these would make it ask on every frame.

Answers carried through an edit only stand in for the new parse. Its first answer replaces them, and what they covered is asked for again when it is shown.

The trim removes tokens only while the painted store is made of range answers alone. After an edit, a newer analysis, or tokens installed by a host, it removes none.

### Read-only slices

`createTreeSitterSliceHighlighter` uses the same worker, root grammar, highlight query, and token styles. It accepts a plain string and returns UTF-16 spans relative to that string. A caller can include adjacent text it already holds and choose which spans to paint. Pass the input verbatim, including CRLF and any real line breaks at fragment boundaries. The slice highlighter has no source reader or document session.

Set `startsAtSourceStart` and `endsAtSourceEnd` from the actual source boundaries. Analysis starts with the root grammar's initial state. An answer that starts at the source origin has `known-start` quality. Any other answer is `provisional` and can color tokens inside a continued comment, template, or TSX construct differently from a resident editor. The reported end flag distinguishes a partial suffix from source EOF. Grammar recovery near either cut can still affect the colors. The slice uses root-language captures, including those around embedded constructs. It does not parse injected languages.

Configure one highlighter per viewport and language or query generation. Each highlighter retains successful results for one source revision, keyed by location, both boundary flags, and the exact submitted text. `lookup` returns a retained result synchronously. `highlight` chooses the current slice and supersedes older unfinished requests. Passing a new source or revision clears the cache. Token styles refer to the editor palette through CSS variables, so a theme can change the displayed color without a new parse.

`prewarm` loads the grammar and query without any text. The slice path uses the patterns that fit its [predicate limits](../limitations.md#tree-sitter-slice-highlighting). It skips a pattern if any of its predicates fall outside those limits. The shipped JavaScript, TypeScript, TSX, Python, Rust, Java, PHP, Svelte and SQL queries have usable slice patterns. Some captures may be absent, such as SQL's distinction between numeric and string literals. If no usable patterns remain, a grammar is missing or analysis exceeds a limit, callers can keep displaying the original text. A slice answer describes only its submitted span. It never schedules a complete parse.

The [paged TypeScript example](../../examples/stress/paged-code.html) colors the loaded fragments and the overscan rows they already include. It submits their exact text, caps the analysis input at 8,192 UTF-16 units, and paints clipped token ranges on the visible fragments. Go to byte works before the source size is known. A cold jump can display plain text while new colors are pending. A failed jump leaves the mounted text eligible for its original colors.

Run the Chromium proof from the repository root after building the example dependencies. It reports request-to-color timing, worker phases, source bytes requested, cache hits, and retained token buffers.

```sh
bun run stress:build
bun run --cwd examples/stress bench:paged --modes highlighted --output paged-syntax.json
```

## Structural Selection

Structural selection is syntax-driven and anchor-backed.

Examples:

- select smallest named node at cursor
- expand to containing expression/block/function/class
- shrink through the previous expansion stack
- select sibling node or list item
- select Tree-sitter leaf/token range

The selection model stores `SelectionSet<Anchor>`. Tree-sitter nodes are transient helpers for
computing the next selection range.

Structural-selection commands normalize the set before sending ranges to the backend, then derive
both request order and source metadata from that same normalized sequence. Returned ranges retain
the source selection's id, direction, and affinity. The result is normalized honestly rather than
being marked normalized by construction; when backend ranges converge, expansion stacks are rebound
to the surviving selection ids and their tops are aligned with the normalized ranges. A result-count
mismatch is stale rather than a partially paired response.

## Folds

Fold ranges should be derived from Tree-sitter queries where a grammar is available. Manual folds and fallback indentation folds can coexist, but syntax folds are the primary path.

Fold ranges should cross into the display transform layer as anchor-backed ranges so FoldMap remains snapshot-aware.

## Injections

Language injections are part of the syntax system, not a separate tokenizer path.

Injected parse trees must retain parent snapshot identity and produce highlights/decorations in buffer coordinates so rendering and selection stay unified.

## Acceptance Criteria

| Deliverable               | Acceptance Criteria                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Worker-owned runtime      | Parser creation, parsing, query execution, tree traversal, and injections all run off the main thread |
| Language registry         | Loads parser + queries from registered language plugins by explicit language id inside workers        |
| Piece-table input adapter | Tree-sitter can read document text without flattening whole files on every parse                      |
| Incremental edit bridge   | Batched edits update the previous parse tree correctly                                                |
| Parse snapshots           | Parse results are tagged with document snapshot/version and stale results are rejected                |
| Highlight queries         | Tree-sitter query captures produce editor decorations compatible with CSS Highlight rendering         |
| Structural selection      | Expand/shrink/select-token produce anchor-backed selections                                           |
| Fold queries              | Syntax folds feed FoldMap as anchor-backed ranges                                                     |
| Injection support         | Embedded languages produce correct ranges in parent buffer coordinates                                |
| Benchmarks                | 10K, 50K, 100K-line parse/update/query timings and memory                                             |
| Fallback behavior         | Unknown language or failed parse leaves plain editing, selections, and rendering functional           |
