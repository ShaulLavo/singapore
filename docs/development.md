# Develop Singapore

Singapore is a standalone Bun workspace. The repository owns the packages,
examples, documentation site and release tooling.

## Set up

You need [Bun](https://bun.sh/) 1.4.4 and Node.js 26 or newer. The parser and
browser tests also need a current browser supported by the selected Playwright
projects.

```sh
bun install --frozen-lockfile
bun run build
```

Packages import one another through their built `dist/` directories. Rebuild
after changing a package that another package consumes.

## Run the demo app

```sh
bun run --cwd examples/app dev
```

Vite prints the address. The app shows a file tree beside the editor and
exercises the package integrations.

## Run checks

Use package scripts. Do not use `bun test`, which skips the configured Vitest
environments.

```sh
bun run --cwd packages/textbuffer test
bun run --cwd packages/editor test
bun run format:check
bun run typecheck
bun run lint
bun run health
```

The editor and several packages have browser projects. Install the browsers
needed by the package you are checking with its pinned Playwright executable,
for example:

```sh
bun --cwd packages/editor x playwright install chromium firefox webkit
```

The documentation site has its own checks:

```sh
bun run --cwd site docs:check
bun run --cwd site build
bun run --cwd site test:browser
```

## Release package tarballs

A Singapore release contains all 23 package tarballs from one verified build. It
is distributed as a draft GitHub Release, not as npm artifacts. The manifest
records the exact source commit, tag, package versions, release URLs and
checksums; `SHA256SUMS` covers every tarball.

Install the workspace's Chromium before qualification:

```sh
cd packages/tree-sitter
./node_modules/.bin/playwright install --with-deps chromium chromium-headless-shell
cd ../..
```

Run the complete local qualification without publishing:

```sh
bun run release:tarballs -- --out release
bun run release:tarballs:validate -- --out release
```

The build command compiles every package once, packs the complete package set,
installs those tarballs with their external peer dependencies in a fresh Bun
consumer, checks the installed grammar `NOTICE` and `notices/` inventory against
the source files, imports every package entry point, then builds a Vite browser consumer of the
packed highlighting, language catalog and metadata entry points. Headless Chromium
loads every lazy catalog grammar and the simple JavaScript, JSX, TypeScript and
TSX variants in a worker, initializes their WASM, parses samples and compiles and
executes their queries. The consumer has its own dependencies outside the producer
workspace and is removed, along with its server and browser, after qualification.
The command then writes and validates `release-manifest.json` and `SHA256SUMS`.
The validator checks the exact package directories, names, versions, source commit,
`singapore-<full-commit>` tag and all checksums.

To rerun browser qualification on existing tarballs without rebuilding them, use
`bun run release:tarballs -- --qualify-only --out release`. Validation still requires
the current commit, tag, package versions and checksums to match. A validation-only
run checks artifact identity and integrity; it does not run browser qualification.

Published artifacts are immutable. For a packaging replacement, bump the patch
version of each changed public package and any package whose runtime dependency
pin changes. Keep the complete 23-package manifest and use a new commit tag.

To create the draft release through GitHub Actions, push the tag for the commit
that was verified locally:

```sh
commit=$(git rev-parse HEAD)
git tag "singapore-$commit"
git push origin "singapore-$commit"
```

Consumers should install the package tarballs they use from one release and
include each tarball needed by its internal dependencies. Keep the release
manifest beside the dependency configuration. To install the complete set from
a downloaded manifest:

```sh
jq -r '.packages[].releaseUrl' release-manifest.json | xargs bun add
```

Verify downloaded tarballs before use with `sha256sum -c SHA256SUMS`.

## Repository layout

- `packages/<name>` contains one public package.
- `examples/app` is the demo application.
- `site` contains the documentation site and generated API reference.
- `scripts` contains workspace checks and package release tooling.
- `docs` contains architecture, design and performance records.
