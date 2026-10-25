# Site deployment

Singapore owns the public site at [singapore.shaulavo.dev](https://singapore.shaulavo.dev/).
The Worker serves the documentation site at `/` and the example application at `/demo/`.
The exact Custom Domain and Static Assets settings live in
[`wrangler.singapore.jsonc`](../wrangler.singapore.jsonc).

## Build locally

Use Bun 1.4.4 and Node.js 26 or newer:

```sh
bun install --frozen-lockfile
bun x --cwd site playwright install chromium
bash scripts/product-sites/build.sh dist
```

The output directory must not exist before the build. Remove only the generated `dist/`
directory before a new local build. The browser install uses the exact Playwright version
declared by `site/package.json` and provides Chromium for the build-time capture. The build
runs the selected workspace package builds, then builds the docs with `/` and the demo with
`/demo/`.

## Dry-run and deploy

Wrangler is invoked at the pinned version used by the existing production configuration:

```sh
bunx --bun wrangler@4.149.0 deploy --config wrangler.singapore.jsonc --dry-run
bunx --bun wrangler@4.149.0 whoami
bunx --bun wrangler@4.149.0 deploy --config wrangler.singapore.jsonc
```

A production deploy requires an authenticated Wrangler session or a protected
`CLOUDFLARE_API_TOKEN` environment variable. The selected account must own `shaulavo.dev`
and permit Workers deployment and Custom Domain changes. Do not put credentials in files,
arguments or logs.

## Verify and roll back

Run the local configuration checks before the dry-run:

```sh
python3 -m unittest discover -s scripts/product-sites -p 'test_*.py'
```

Inspect the Worker before changing it:

```sh
bunx --bun wrangler@4.149.0 deployments list --config wrangler.singapore.jsonc
bunx --bun wrangler@4.149.0 versions list --config wrangler.singapore.jsonc
```

Roll back only to a version confirmed to belong to `product-sites-singapore`:

```sh
bunx --bun wrangler@4.149.0 rollback VERSION_ID --config wrangler.singapore.jsonc
```

The Worker has no database or state bindings. A rollback restores a previous Worker version
and its Static Assets. The first deployment has no prior version to restore.
