# Tree height

This pass replays edits and measures the trees at checkpoints. Timing and profiling runs keep using their existing commands.

It measures the Singapore sequence tree, Singapore reverse index, and pinned VS Code red-black tree. Each checkpoint records height, mean node depth, p95 node depth, stored pieces, visible pieces, tombstones, and visible text length.

## Run

From `packages/textbuffer`, after the workspace dependencies are installed:

```sh
bun run build
node bench/prepare.mjs
node --test bench/tree-shape.test.mjs
node bench/tree-shape.mjs --profile standard
python -m pip install matplotlib==3.10.8
python bench/plot-tree-shape.py bench/results/tree-shape/tree-shape.json
```

Use `--profile smoke` for a small run. To change the edit trace, tree priorities, or checkpoint frequency:

```sh
node bench/tree-shape.mjs --seed 7 --priority-seeds 0,1,2,3,4 --every 10 --stress-edits 10000
```

`--seed` controls the existing benchmark fixtures. `--priority-seeds` changes Singapore's tree priorities while keeping the edits identical. The four stress traces have fixed edit sequences. `--stress-edits` controls their length. The VS Code control runs once per trace.

## Read the plots

- **Height over edits:** how the deepest path changes during a session.
- **Height versus stored pieces:** how height grows as the tree gets more pieces. The dashed `log2(P + 1)` line gives a scale reference.
- **Relative height:** `height / log2(P + 1)`, using each tree's own piece count.
- **Mean and p95 depth:** the distribution of node depths in each tree.
- **Pieces over edits:** total pieces and tombstones alongside the control's piece count.

Height counts real nodes on the path. An empty tree has height 0; a root alone has height 1. The upstream NIL sentinel is excluded. Mean and p95 give every stored node equal weight. The JSON also includes mean depth among visible pieces. These describe tree shape; edit timings are recorded by the comparison harness.

Lines show the median across the selected priority seeds. Bars show the minimum and maximum. The height-versus-pieces plot includes every checkpoint from every selected seed.

## Workloads and checks

The pass reuses the six editing fixtures: sequential typing, random insertions, random replacements, eight-cursor batches, mixed churn, and large paste/delete. It adds four stress traces: prepending, insertion at one fixed offset, alternating ends, and repeated replacement at one location. Replacement stress keeps three visible characters while building deletion history.

Checkpoints include the initial state, powers of two, every `--every` operations, and the final state. A batch counts as one operation. Text is checked against a string oracle at every checkpoint. Singapore's two indexes must have matching piece and tombstone counts. Final states pass the existing invariant validator, and retained snapshots are checked for unchanged text.

The collector walks iteratively so it can measure long chains. Cycles and repeated children fail explicitly. A failed replay records its seed, last completed operation, error, and earlier checkpoints; the command exits with an error. Plots label partial runs.

Results go to `bench/results/tree-shape/`: raw JSON, a Markdown summary, and PNG/SVG plots. The JSON records the source revision, source/build/harness hashes, upstream pin, fixture hashes, seeds, and runtime. The new CI job uploads this directory.

Tombstones count toward P in both Singapore trees. The control can retain fewer pieces after the same edits. Use the piece-count plots and per-tree relative height together when reading height differences. Results describe the tested traces, seeds, and checkpoint spacing. Set `--every 1` to measure after every operation.
