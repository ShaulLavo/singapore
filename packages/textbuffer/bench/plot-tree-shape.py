"""Plot tree-shape.json. Requires matplotlib; uses its default color cycle."""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LABELS = {"sequence": "Singapore sequence", "reverse": "Singapore reverse index", "red-black": "VS Code red-black"}

def grouped(rows, tree):
    result = defaultdict(list)
    for row in rows:
        if row["tree"] == tree:
            result[row["operation"]].append(row)
    return sorted(result.items())

def series(ax, groups, field, label):
    points = []
    for operation, samples in groups:
        values = [row[field] for row in samples if row[field] is not None]
        if values:
            points.append((operation, median(values), min(values), max(values)))
    if not points:
        return
    x, y, low, high = zip(*points)
    ax.errorbar(x, y, yerr=[[mid - value for mid, value in zip(y, low)], [value - mid for mid, value in zip(y, high)]], label=label, linewidth=1.5, elinewidth=0.6, capsize=0)

def new_figure(title, xlabel, ylabel):
    fig = plt.figure(figsize=(10, 6))
    ax = fig.add_subplot(111)
    ax.set_title(title, loc="left", fontsize=14, pad=14)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.grid(True, alpha=0.2)
    ax.set_ylim(bottom=0)
    return fig, ax

def save(fig, ax, destination, name, caption):
    ax.legend(fontsize=9)
    fig.text(0.09, 0.015, caption, fontsize=8)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(destination / f"{name}.png", dpi=160)
    fig.savefig(destination / f"{name}.svg")
    plt.close(fig)

def plot_report(source, destination):
    report = json.loads(source.read_text(encoding="utf-8"))
    if report.get("schemaVersion") != 1 or not report.get("rows"):
        raise ValueError("Expected tree-shape schema 1 with measured rows")
    failures = [run for run in report["runs"] if run["status"] != "passed"]
    destination.mkdir(parents=True, exist_ok=True)
    index = ["# Tree-shape plots", "", f"Revision: `{report['provenance']['commit']}`.", f"Fixture seed: {report['fixtureSeed']}. Priority seeds: {report['prioritySeeds']}.", "", "Height counts real nodes: root = 1, empty = 0. P includes tombstones.", "Lines show medians; bars show min/max across the selected priority seeds.", "The control has one replay per trace. Depth statistics count tree nodes.", ""]
    if failures:
        index += [f"**PARTIAL DATA: {len(failures)} runs failed. See report.md.**", ""]
    for fixture in report["fixtures"]:
        name = fixture["name"]
        rows = [row for row in report["rows"] if row["workload"] == name]
        if not rows:
            continue
        title = name.replace("-", " ").capitalize()
        suffix = " [PARTIAL]" if any(r["workload"] == name for r in failures) else ""
        caption = "Median and min/max across priority seeds. " + report["provenance"]["commit"][:12]
        for field, ylabel, filename in [("height", "Tree height (nodes on longest path)", "height"), ("heightOverLog2", "Height / log2(P + 1)", "relative-height"), ("meanDepth", "Mean node depth", "mean-depth"), ("p95Depth", "p95 node depth (nearest rank)", "p95-depth")]:
            fig, ax = new_figure(title + suffix, "Completed edit operations", ylabel)
            for tree, label in LABELS.items():
                series(ax, grouped(rows, tree), field, label)
            save(fig, ax, destination, name + "-" + filename, caption)
        fig, ax = new_figure(title + suffix, "Stored pieces P (including tombstones)", "Tree height")
        for tree, label in LABELS.items():
            selected = [row for row in rows if row["tree"] == tree and row["nodes"] > 0]
            ax.scatter([r["nodes"] for r in selected], [r["height"] for r in selected], label=label, s=10, alpha=0.45)
        maximum = max(row["nodes"] for row in rows)
        if maximum:
            xs = sorted(set([1, maximum] + [2 ** i for i in range(int(math.log2(maximum)) + 1)]))
            ax.plot(xs, [math.log2(x + 1) for x in xs], linestyle="--", label="log2(P + 1) guide")
            ax.set_xscale("log", base=2)
        save(fig, ax, destination, name + "-height-vs-pieces", "Each point is one tree at one checkpoint. " + report["provenance"]["commit"][:12])
        fig, ax = new_figure(title + suffix, "Completed edit operations", "Pieces")
        series(ax, grouped(rows, "sequence"), "nodes", "Singapore stored pieces")
        series(ax, grouped(rows, "sequence"), "tombstones", "Singapore tombstones")
        series(ax, grouped(rows, "red-black"), "nodes", "VS Code stored pieces")
        save(fig, ax, destination, name + "-pieces", caption)
        index += [f"## {title}", ""]
        for kind in ["height", "height-vs-pieces", "relative-height", "mean-depth", "p95-depth", "pieces"]:
            index += [f"![{title}: {kind}]({name}-{kind}.png)", ""]
    (destination / "README.md").write_text("\n".join(index), encoding="utf-8")
    print(f"Plots written to {destination}; failed runs: {len(failures)}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    plot_report(args.source, args.out or args.source.parent / "plots")
