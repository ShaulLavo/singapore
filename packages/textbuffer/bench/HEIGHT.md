# Tree height

Replay edits and sample the Singapore sequence tree, Singapore reverse index, and pinned VS Code
red-black tree. This runs separately from the timing and profiling workers.

From `packages/textbuffer`, after installing workspace dependencies:

```sh
bun run build
node --test bench/height.test.mjs
node bench/height.mjs --profile standard
python3 -m pip install matplotlib==3.10.8
python3 bench/plot-height.py bench/results/height-standard/height.json
```

Open `bench/results/height-standard/index.html` for the plots. The directory also contains raw JSON,
CSV, a Markdown summary, the generated edit traces, and source/build hashes.

## Runs

The default run uses edit-trace seeds `20260916,7` and Singapore priority seeds `0,1,7,42`.
Every priority seed replays the same edits. VS Code runs once per trace.

The six shared edit workloads come from `fixtures.mjs`: typing, random insertions, random replacements,
eight-cursor batches, mixed churn, and large paste/delete. Five additional traces exercise prepending,
a fixed middle position, alternating ends, repeated insert/delete at one position, and a shrinking
document. Those stress traces use 5,000 edits each.

```sh
node bench/height.mjs --profile smoke
node bench/height.mjs --stress-edits 50000 --every 500 --priority-seeds 0,1,2,3,7,42
node bench/height.mjs --workloads fixed-middle,hotspot-churn --trace-seeds 7
node bench/height.mjs --engines singapore --out bench/results/height-singapore
```

The control uses the existing pinned-source preparation and adapter. The Singapore-only command uses
the local build. Each run checks visible text at checkpoints and tree invariants at the end. A failed
run records its error and last checkpoint. Interrupted reports keep `complete: false`.

## Measurements

Height counts levels: an empty tree has height 0 and a root-only tree has height 1. Node depths start
at 0. Stored-piece counts include tombstones; the VS Code NIL sentinel is excluded.

Each sample records height, mean depth, p95 depth, a depth histogram, visible pieces, tombstones,
stored and visible text lengths, and visible-piece/text-weighted mean depths. Mean depths describe
node positions. A complete edit or anchor lookup can perform several tree searches.

`height / log2(P + 1)` puts height beside a growth reference, where `P` is that tree's stored-piece
count. The minimum possible height is `ceil(log2(P + 1))`. Tree sizes can differ between engines
because coalescing and deletion retain different pieces.

Samples are taken at the start, finish, powers of two, and every `--every` operations. Use `--every 1`
for short traces that need every intermediate height. Peaks between checkpoints may be missed.

## Plots

Each workload and trace seed gets five plots: height over edits, height over stored pieces,
height divided by `log2(P + 1)`, mean node depth, and piece/tombstone counts over edits.

Lines show the median across priority seeds. Whiskers show the sampled minimum and maximum.
The piece-count scatter shows all sampled seeds. Raw samples retain each seed and histogram.
Height and piece-count plots help separate tree shape from retained history. Timing results remain
in the existing benchmark reports.

The plotter rejects interrupted reports by default. Use `--allow-partial` to render one with a visible
partial-result label. Failures are included in the report heading.
