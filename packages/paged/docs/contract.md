# Paged viewer contract

`PagedDocument` is a read-only view of one replayable UTF-8 byte source. Construction and
`initialize()` perform no I/O. The first `view.first(count)` works with only a source ID, a
revision, and a range reader. The source can leave its size unknown for the whole session.

## Source and revision

`readBytes(start, end, signal)` takes safe integer offsets and a positive half-open range. Bytes
start at `start`. A short response with `eof: false` must deliver at least one byte. The next
response starts at the end of those bytes if the current operation needs more. The viewer uses the
actual cached interval and may replay any evicted interval.

`eof: true` says there are no bytes after that response. A nonempty terminal read or an empty one
at a confirmed boundary can establish the exact length. An empty probe beyond the end supplies
only an upper bound unless `byteLength` is also present. Contradictory lengths, overlong responses,
and reads without progress produce a `PagedSourceError`. A later read can retry after an operation
fails.

Every response belongs to the opening revision. Receiving another revision or
`PagedSourceInvalidatedError` makes the document stale, aborts its reads, and invalidates every
cursor, selection, and index. The optional `document.validate()` explicitly asks a source that
implements `validate` for its current revision. A cache hit does not call it.

## Windows and selections

| Operation                 | Position or prerequisite                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| `first(count)`            | Byte zero                                                                      |
| `next(cursor, count)`     | The previous window's `next`                                                   |
| `previous(cursor, count)` | The next window's `previous`                                                   |
| `seekByte(offset, count)` | A byte position. The viewer moves forward to the next UTF-8 boundary if needed |
| `seekLine(line, count)`   | A zero-based line with discovered or supplied mapping                          |
| `end(count)`              | Known byte length                                                              |
| `copy(start, end)`        | Located fragments and local UTF-16 columns                                     |
| `copyRange(start, end)`   | A half-open global UTF-16 range with discovered or supplied mapping            |

A cursor belongs to its original document instance. Its public `byteOffset` is a source position.
Pass the cursor object back to the same view or another view of that document to resume. A budget
stop can return no fragments with a continuation. Each operation runs on demand. The viewer does
not schedule the continuation.

Each fragment has `text`, `start`, `end`, `lineBreak`, and continuation flags. The byte interval
includes the LF only when `lineBreak` is `'\n'`. Joining `text + lineBreak` across fragments
reproduces the decoded text. A giant logical line can span windows. A fragment can end in a
continuation until a later read establishes EOF or sees the next LF.

Use `sourceId`, `revision`, `start.byteOffset`, and `end.byteOffset` to identify a fragment's byte
interval across renders. Include `lineBreak` when passing fragment text to a parser. Highlight
spans and selection columns count UTF-16 units in the fragment. A selection can reach one column
past the text to include an owned LF. Global line and UTF-16 offsets are optional and exact when
present.

Decoding preserves the UTF-8 BOM and CRLF. It counts LF as the row boundary. Malformed UTF-8 uses
replacement characters with positions in the original byte stream. The viewer rejects UTF-16 BOMs
when it reads the start. Empty files and trailing LF each have an empty logical row. Fragment
boundaries preserve valid surrogate pairs. [Encoding Standard](https://encoding.spec.whatwg.org/#utf-8-decoder)

## Trusted indexes and totals

Pass independent exact totals through `totals` or a revision-bound `index`. A line count alone
cannot locate a line. An index has a `sourceId`, `revision`, `PAGED_POSITION_POLICY`, and half-open
coverage intervals for each mapped coordinate. It supplies a small ordered checkpoint table or an
abortable locator. Each checkpoint is at byte zero or immediately after LF and can declare an
exact UTF-16 offset. Use a locator when the table is too large to retain on the client.

Opening validates the index's shape and identity without reading file contents. A supplied
checkpoint allows a jump without loading the prefix. Skipping from a sparse checkpoint still costs
a bounded read per operation. A `next` cursor resumes the skip at the last decoded position.
Reading a region that contradicts the index or totals raises an error without reindexing. A missing
mapping returns `{ kind: 'unavailable', reason: 'no-mapping' }`.

`stats.state` describes the document lifetime. `stats.totals` contains only exact information.
`stats.coverage` describes the mapped prefix. Totals may change during demand reads. Keep the same
first-visible cursor and pixel offset when updating the host's status or navigation controls.

## Local and HTTP adapters

Use `blobRangeSource(blob, { id, revision })` for a browser `File` or `Blob`. The adapter reads
bounded slices. The host is responsible for stable identity and the snapshot's lifetime.

`httpRangeSource(url, { id, etag })` sends `Range` and `If-Match` using a pinned strong ETag.
Alternatively, give it `{ id, revision, immutable: true }` for a versioned immutable URL.
`openHttpRangeSource(url, { id, signal })` establishes a strong ETag with one bounded opening read
and reuses its bytes. Use the final range URL. Open the source before associating a trusted index with it.

The HTTP adapter validates single-range `206` responses and reads at most the declared range.
A `206` with total `*` can make short progress without revealing the file size. A valid `416` gives
the exact length if its bounds and identity agree. An ignored range cancels the body. A `200` is
accepted only for a verified empty representation with an explicit zero Content-Length. A
`412` or changed ETag makes the source stale.

Use identity encoding and expose `ETag`, `Content-Range`, and `Content-Encoding` for cross-origin
requests. Configure the server to allow `If-Match` preflight. The browser supplies its own range
encoding header. Model metrics count requested and delivered payload bytes. Browser buffers and
network-level transfers can differ from those counters.
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests) ·
[Fetch Standard](https://fetch.spec.whatwg.org/)

## Work and lifetime

The defaults allow two views, two in-flight reads, 64 KiB pages, and an 8 MiB cache. An operation
reserves up to 1 MiB of input and 32 source calls, and returns up to 128 fragments and 512 Ki
UTF-16 units. Cache hits and restart bytes use the work budget. Copies that exceed their budget
return a limit result. The model retains at most 4,096 discovered checkpoints and bounds the
inline index separately. A caller owns returned windows and determines how many remain live.

A new request supersedes pending work on its view. Shared reads continue while another consumer
needs them. Dispose the view when the host closes it and dispose the document when the source is
no longer in use. The host owns geometry, scrollbars, selection presentation, and accessibility.

[Browser proof and measurements](../../../docs/performance/e015-paged-proof.md)
