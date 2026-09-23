# Automatic text reclamation

Implemented 2026-09-23 against `6656eb7113040f7489a15f4c6e2293e511a55edd` plus the
E006 working changes. Reclamation now runs automatically in editor buffers. The original
storage-only prototype is also available through the internal textbuffer API, backed by
the same collector. It frees whole dead chunks only, so ordinary typing, where survivors land in
every chunk, frees nothing yet. Full E006 remains open for that reason and because position
metadata still grows.

## Live behavior

A buffer schedules maintenance after 128 Ki UTF-16 units have been deleted. Events that release
retained snapshots without deleting text also schedule it: a save baseline change, clearing
history, a receipt lifecycle change, and committing a transaction that was prepared on a log
maintenance has since replaced. Undo, redo, history jumps and logical-only synchronization
release nothing and do not schedule it.
Work waits for a 300 ms quiet interval, with a 2 s scheduling deadline during continued
activity. The collector yields between bounded batches; the scheduler targets 2 ms and
at most 32 collector steps per task. These are cooperative limits, not a hard real-time
promise: GC and browser scheduling can still delay a task.

An edit cancels the pending traversal and schedules a fresh one. The last change-listener
detachment cancels maintenance, which covers editor disposal and document replacement.
A view attaching resumes work that was already due. Headless buffers can also maintain storage
after edits.
No host opt-in or application setting is required.

Maintenance covers the buffer's current state, retained history and transaction endpoints,
clean snapshot, cached text wrapper, and installed transaction barriers. Snapshots are grouped
by their actual append log, not anchor lineage: divergent branches can reuse numeric buffer
IDs for different strings. A group whose log has no closed append chunk is skipped before
marking, so a small current log does not hide a large retained one. Visible pieces across each
group protect their chunks. One fork serves all snapshots in a group, preserving each
snapshot's original extent and writable tail.

Only wholly dead closed append chunks lose text. Original text, each retained snapshot's
tail and any partly live chunk remain. Writable tails own independent newline indexes in both
ordinary forks and reclaimed logs, even when their existing text is fully scanned. Retired chunks keep their coordinate lengths and
lose their line indexes, which also own text. Tree nodes, reverse indexes, buffer IDs,
anchor bias and selections remain unchanged.

Publication replaces physical storage inside the existing snapshot object. Its identity,
root, logical revision and text do not change, but `snapshot.buffers` does: nothing may key a
cache on it, as the type's comment says. Prepared transactions, mutation leases,
receipts, save baselines and view caches therefore keep their existing identity contracts.
Each prepared group publishes synchronously without yielding between snapshots, so cancellation
cannot leave history split across copied logs. Preparation remains incremental. The publication
step scales with the number of retained snapshots, so unusually large custom history limits
can exceed the soft slice target. External snapshots outside the buffer's retained set keep
their old logs until their owners release them.

The [measurement cache](../../packages/editor/src/documentTextSourceCache.ts) follows text
chunk ownership through a weak key. Retained chunks share that owner across forks; a reclaimed
chunk drops it. The previous lineage-wide cache could keep every measured deleted string
alive even after the storage collector ran. The mounted-editor experiment exposed that
retention, which storage-only tests could not see.

[`getStorageMaintenanceStats()`](../../packages/editor/src/textStorageMaintenance.ts) reports
completed and cancelled runs, retired chunks/code units, snapshots republished and the largest
observed slice. Reclamation also emits one performance diagnostic per completion or failure,
carrying that run's largest slice.
Code-unit counts describe retired storage, not physical bytes freed while external readers
still retain old logs.

## Worker source chunks

The tree-sitter worker caches the source chunks each parse request sends. It used to evict them
only when the document closed, so it kept every chunk it had ever parsed. Now it keeps only the
chunks named by the last descriptor it received. The client ledger in
[`sourceChunkRetention.ts`](../../packages/tree-sitter/src/treeSitter/sourceChunkRetention.ts)
forgets the same chunks when it builds that descriptor. It also records a response only if the
response belongs to the newest descriptor, because an older response can name chunks a newer
request has already dropped. The worker resolves a request's source when the message arrives, so
it drops chunks in the order the client built descriptors.
[`source-eviction.test.ts`](../../packages/tree-sitter/test/source-eviction.test.ts) replays
churn and undo-like revisits with overlapping, reordered responses. Without the newest-descriptor
check it fails with a missing chunk.

## Browser evidence

The [live harness](../../examples/stress/reclamation-live.mjs) bundles the built editor,
mounts two views sharing one buffer, and runs 500 or 1,000 insert/delete cycles of three
workloads. It retains the default 200 undo states and makes no explicit reclamation call:

- aligned: 16 Ki inserts, each deleted whole. One insert fills one chunk, the collector's best case.
- survivors: 1 Ki inserts that each keep 64 units.
- mixed: 1 Ki inserts, three of every four deleted whole.

CDP forces GC before and after automatic maintenance in the same page. Every sample checks
unchanged revision and dirty state, every retained undo/redo, trusted typing and visible peer
text, replacement/disposal cancellation, and the absence of browser errors. Aligned samples must
also release at least 10% of the measured heap growth.

Measurements are in [live-chromium.json](../../examples/stress/results/reclamation/live-chromium.json).
Median heap growth after GC, three samples each:

| Workload  | Cycles | Before maintenance | After maintenance | Reduction | Deleted units retired |
| --------- | -----: | -----------------: | ----------------: | --------: | --------------------: |
| aligned   |    500 |       17,467,488 B |       5,447,284 B |     68.8% |                   80% |
| aligned   |  1,000 |       33,044,140 B |       5,870,716 B |     82.2% |                   90% |
| survivors |    500 |        4,653,744 B |       4,762,728 B |      none |                    0% |
| survivors |  1,000 |        5,632,200 B |       5,792,340 B |      none |                    0% |
| mixed     |    500 |        4,045,040 B |       4,158,780 B |      none |                    0% |
| mixed     |  1,000 |        5,013,392 B |       5,117,720 B |      none |                    0% |

Only the aligned workload frees anything. A 16 Ki chunk holds sixteen 1 Ki inserts, and in the
other two workloads at least one of them survives, so no chunk dies. Ordinary typing behaves
like these two, which makes partly live chunks the next E006 step, not a refinement. The small
growth after maintenance in those rows is measurement noise; nothing was retired.

The largest observed maintenance slice was 0.3 ms. Heap deltas include live views and history;
they do not include worker heaps or process RSS. These slice timings are observations on this
workload, not a guarantee for all document sizes.

The earlier explicit-call prototype measurements remain as historical evidence:

- [Bun paired storage controls](../../examples/stress/results/reclamation/text-candidate.json):
  approximately 89% lower post-release heap at 5,000 and 10,000 small churn cycles.
- [Chromium storage controls](../../examples/stress/results/reclamation/chromium.json):
  approximately 81–84% lower post-release heap, without mounted editors.
- [Initial investigation](e006-reclamation-investigation.md): ownership inventory and
  counterexamples showing why deleting position records changes anchor behavior.

Reproduce from the repository root:

```sh
bun run --cwd packages/textbuffer build
bun run --cwd packages/editor build
bun run --cwd examples/stress bench:reclamation-live > examples/stress/results/reclamation/live-chromium.json
bun run --cwd packages/editor test --project node test/storageMaintenance.node.test.ts src/textMeasurements.test.ts
bun run --cwd packages/textbuffer test
bun run --cwd packages/tree-sitter test
bun run --cwd packages/tree-sitter test:browser
```

## Correctness and checks

[Textbuffer tests](../../packages/textbuffer/src/reclamation.test.ts) cover both deleted-anchor
biases, old readers, line-index release, partial chunks, idempotence, later appends and forks,
divergent branches with equal IDs, transient ownership and cancellation at publication.
Regression tests exercise edits to both the retained and reclaimed tail in either order,
atomic publication of 40 snapshots, and batches of at most 256 entries when discarding
4,096 line indexes. All four regression cases failed before the fixes and pass afterward.
Three seeded 400-edit/checkouts compare text, anchors, positions and invariants with an
unreclaimed control.

[Live buffer tests](../../packages/editor/test/storageMaintenance.node.test.ts) cover actual
publication while a prepared transaction and lease exist, commit and receipt reversal, full
retained undo/redo, shared history storage, unchanged snapshot/wrapper identity, dirty state,
revision, no spurious change events, interrupted traversal and last-view detachment/reattachment.
They also cover a second run after a prepared commit lands on the unreclaimed log, a run after
clearing history, a small current log beside a large retained one, and the lease rule that makes
in-place publication necessary. The prepared-commit and clear-history cases fail with their
triggers removed. Measurement tests preserve original-text cache reuse across forks and
reclamation while old measured ranges remain valid.

The broad core run passed 2,755 tests and failed four. Three are the existing Shiki worker-cache
failures, which reproduce on unchanged HEAD. The fourth is the BiDi performance probe's
click/drag ratio. It fails the same way with the pre-E006 measurement cache restored, and the
probe deletes nothing, so maintenance never runs during it; it was not checked on a clean HEAD
checkout. Tree-sitter passes 84 unit tests and 55 real-worker browser tests. Textbuffer passes
118 tests. Platform's WorkspaceEdit service/event suites pass against the linked build (54 tests).

The [input workload](../../examples/stress/results/reclamation/input-summary.json) validated all
108 samples (three repetitions). It covers typing, repeat, composition, paste and undo across ordinary,
short-line and long-line fixtures with one and multiple views. Its artifact is a fresh
candidate observation, not a newly calibrated E002 regression-gate pass: the stored controls
use Chromium 148, while this environment uses Chromium 153.

## Remaining E006 work

- Partly live chunks and original text need separate logical anchor coordinates and physical
  text slices before their unused portions can be released. One live character can retain
  its entire chunk; substring backing stores can retain more than visible string lengths.
  The survivors and mixed workloads above show this is the case that matters for typing.
- Tombstones, reverse-index slots and chunk/ID mappings still grow with editing. Reclaiming
  them needs a compact equivalent position representation or a stronger anchor-lifetime
  contract. Automatic text reclamation does not establish a bound on all editor memory.
- External readers legitimately retain old logs until released. The collector preserves their
  text rather than inferring that a missing undo entry means no reader exists.
