# AGENTS.md

Instructions for AI coding agents working in the repository (Singapore). The [README](README.md) maps the packages, and [ARCHITECTURE.md](ARCHITECTURE.md) explains the design. Read [docs/development.md](docs/development.md) for setup.

## Plans

The standalone repository owns its source and release history. Keep plans and decision records in the repository's existing documentation directories; do not add a product roadmap just for an implementation task.

## The simple API comes first

Every feature works on an editor that was only given text: `new Editor(element)` and `setText(text)`, or a plugin built from plain options. Documents (an `openDocument` id, a shared `DocumentSession`, a `LanguageServerDocument`) add identity and sharing: persistence, one buffer or one protocol state behind several views. They are supported, and no feature may require one.

- When a feature needs something a document usually supplies, such as a language server's URI, take it as a plain option on the simple path and let a document fill it in when there is one.
- A new capability must not add required setup to the one-line use. If it cannot work without a document, the design is wrong, not the caller.
- Test the simple path. A feature covered only through documents has not proven it works without one.

## Read before you change

- Storage, anchors, or positions: [piece table](docs/storage/piece-table.md), [anchors](docs/positions/anchors.md), and ADRs [001](docs/adr/001-persistent-avl-piece-table.md) and [002](docs/adr/002-anchors-into-immutable-buffers.md). Deleted text stays in the tree as tombstones, because deleted anchors need it.
- Rows, geometry, or paint: [browser layout and virtualizer](docs/display/browser-virtualization.md) and [ADR 004](docs/adr/004-browser-layout-and-css-highlights.md). Add a [browser quirks](docs/display/browser-quirks.md) entry for every browser workaround you put in the code.
- Workers: [worker topology](docs/architecture/worker-topology.md) and [ADR 003](docs/adr/003-document-on-main-thread.md). Each worker has one owner object. Do not add package-level worker singletons.
- Syntax: [tree-sitter](docs/syntax/tree-sitter.md). Selections are anchors, never syntax nodes.
- Plugin hooks: [extension hooks](docs/architecture/extension-hooks.md).
- A limit or ceiling: update [known limits](docs/limitations.md) when you change one.

## Conventions

- Call the text-slice record a Piece. Other editors say "fragment".
- Combine arrays with `concat` and use fresh array results directly, following the repository's array construction rules. Keep copies needed for ownership, iterable or typed-array conversion, tuple typing, or sparse-array behavior. A performance exception needs measurements.
- Link files inside the repository with relative paths. Link external projects with absolute HTTPS URLs.
- Package READMEs follow the local install and API template. A package that `npm view` does not find says `Not on npm yet.` in its Install section.

## Generated files

- `docs/commands.md`: run `bun run commands:reference`.
- `docs/architecture/phase-0/*.json`: run `bun run health:write` only for an intended architecture change.
- `site/src/content/docs/docs/reference/api/`: TypeDoc output, gitignored.

## Build and test

Turborepo with Bun. Run tests through package scripts with `bun run test`. Do not use `bun test`; it bypasses the configured Vitest environments.

Before you commit, run the narrowest package test, then from the repository:

1. `bun run format:check`. `bun run format` formats the whole workspace, so it touches unrelated files when formatting has drifted. Keep those incidental changes.
2. `bun run typecheck` and `bun run lint`.
3. `bun run health` for any architecture-sensitive change.
4. Run the repository checks from its root; there is no parent monorepo required for standalone verification.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->

- On Arch Linux, use the host Playwright setup instructions after any `playwright install` that downloads WebKit, before Firefox or WebKit verification.
