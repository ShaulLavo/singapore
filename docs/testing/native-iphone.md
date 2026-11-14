# Run the iPhone editor entry

The maintained entry lives in [examples/app/native-iphone](../../examples/app/native-iphone).
It imports the public editor entry and Waffle's published `0.0.129` page runner.
It changes no production API and requires no document identity or language server.

## Coverage

| Case                  | Actions and assertions                                                                                                                                        | Input source                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `simple-editor-api`   | `new Editor(element)`, `setText`, painted text, selection offsets and selected text, replacement edit and paint, undo, redo, offscreen caret reveal, disposal | Browser evaluation of public APIs                   |
| `webdriver-four-keys` | ArrowRight, Home, ArrowUp, Enter, exact caret and text effects, focused input, trusted keydown and keyup edges                                                | Waffle `HostCase.press` through the selected driver |

API setup and `dispatchCommand('undo')` are API coverage. They do not demonstrate
typing or an undo keyboard shortcut. The SDK supports only these four keys.
The entry never dispatches synthetic keyboard, input, or touch events. It does not
cover text insertion, software keyboards, composition, clipboard, touch selection,
or native selection handles. Playwright results never count as native Safari proof.
The public release's grammar consumer is a separate workload.

Each case disposes its editor and removes its host and workload listeners. Teardown
asserts that editor inputs and mounted rows were removed before removing the host.
The finish page calls Waffle `cleanupStorage`. This workload allocates no persistent
storage, service workers, or permanent route. Waffle owns its collector, browser
session, profiles, child processes, and scratch cleanup.

## Prepare from this repository

Use Bun 1.4.4 and the workspace's frozen lockfile. Rebuild the public package first.

```sh
bun install --frozen-lockfile
bun x turbo build --filter=@singapore-editor/core
bun run --cwd examples/app typecheck:iphone
```

The adapter builds `page.ts` with `Bun.build` and serves both `/page.js` and
`/page.css`. The page explicitly loads the stylesheet before reporting ready.
Waffle's generated HTML does not add stylesheet links.

## Linux WebKit control

Install the browser using this workspace's pinned Playwright executable. On Arch,
follow the [host Playwright setup](../development.md#run-checks) and the machine-fleet
host instructions for missing WebKit libraries. The command starts no user window.
Run substantial checks through the PC heavy runner.

```sh
bun /work/heavy-runner/current/run.js --host local --class browser singapore-iphone-webkit -- \
  bun run --cwd examples/app test:iphone:webkit --result /work/tmp/singapore-iphone-webkit.json
```

This runs the same adapter through public `runPageSuite` and `PlaywrightDriver`.
The JSON adds `execution: "playwright-webkit"` and `native: false`. It retains
the SDK's case observations, failures, outcomes, and cleanup results. The local
entry creates an empty, short scratch root under `/work/tmp`, then removes it
after the SDK confirms consumer shutdown. Unconfirmed cleanup fails and reports
the retained path. Keep the small result JSON as evidence, then remove it when
its consumer finishes.

## Native Safari handoff

Product shell owns native scheduling. Do not launch while SafariDriver is held,
the Mac is reserved, or another native session owns the phone. Use the existing
C4D2 FIFO and the exact device UDID supplied by its owner. An inspector helper is
unnecessary because neither case declares console or worker/request observation.

After obtaining the native slot, run from the prepared checkout on Darwin:

```sh
scratch=$(mktemp -d "$HOME/tmp/sni-XXXXXXXX")
trap 'rmdir "$scratch"' EXIT
IOS_UDID="$DEVICE_UDID" STORAGE_SCRATCH_ROOT="$scratch" \
  bun run --cwd examples/app test:iphone --result "$REPORT_DIR/singapore-iphone.json"
```

Create `$HOME/tmp` first if absent. Use an empty, physically short scratch directory
separate from `TMPDIR`, dependency caches, and results. Keep the physical path at
most 32 bytes to leave room for SDK child directories. The adapter uses an ephemeral
collector port. `nativeMain` requires Darwin and an exact UUID-shaped `IOS_UDID`.
Its result records the actual native case observations and every cleanup disposition.
Exit zero, both selected cases passing, an empty remaining-storage ledger, and
confirmed session, launcher, server, and scratch cleanup are required for acceptance.

To test public Singapore archives, copy the `native-iphone` directory into an
isolated consumer with its own package manifest. Install the public Waffle archive
and the selected public Singapore archives there. Override all Singapore workspace
dependencies consistently, including textbuffer and core. Imports resolve from
that consumer. Preserve this workload and its assertions. Do not modify shared
checkouts, use global links, or substitute a report-local smoke for this suite.

Complete and verify SafariDriver shutdown before a separate text/tap phase with a
fresh `agent-device` session. That phase belongs to Product shell and has its own
evidence. No text/tap or keyboard result is inferred from this adapter's API checks.
