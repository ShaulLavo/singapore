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

## Release packages

Package manifests use the `@singapore-editor/` scope and publish-ready
metadata. Build and inspect the complete release set without publishing:

```sh
bun run publish:packages:dry-run
```

Publishing requires npm credentials for the scope owner:

```sh
bun run publish:packages
```

The script skips versions already visible in the npm registry. Packages marked
`Not on npm yet.` in their README remain source-only until they are intentionally
included in a release.

## Repository layout

- `packages/<name>` contains one public package.
- `examples/app` is the demo application.
- `site` contains the documentation site and generated API reference.
- `scripts` contains workspace checks and package release tooling.
- `docs` contains architecture, design and performance records.
