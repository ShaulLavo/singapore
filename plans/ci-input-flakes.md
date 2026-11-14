# WebKit native typing event flake

Status: Approved. Diagnose when next changing this test or its native keyboard command. Keep the current assertion blocking.

## Observed failure

On November 8, 2026, the `scroll-webkit` project failed `packages/editor/test/initialViewport.browser.test.ts:108`, test `keeps a 10 MiB document windowed while typing in a block host`.

There were **19/20 native beforeinput events in the 10 MiB fixture** while typing at the end. Expected length was 10485780; application and snapshot lengths were both 10485779. The input was a focused textarea and `document.hasFocus()` was true when diagnostics were collected. This suggests one browser input event did not arrive, but it does not establish why or which event was lost.

- [CI run 42459236799](https://github.com/ShaulLavo/singapore/actions/runs/42459236799)
- [Core test job 128664849331](https://github.com/ShaulLavo/singapore/actions/runs/42459236799/job/128664849331)
- Tested source: `02a3445bd` on PR 111. The only changes were CI and its publisher, not editor input behavior.

The core task finished in 3 minutes 7 seconds. An earlier attempt hung for two hours with Turbo buffering all test output, [job 128639549890](https://github.com/ShaulLavo/singapore/actions/runs/42450816127/job/128639549890). The same stalled test has not been established for that attempt. CI now streams verbose output and limits the core job to 20 minutes.

## Bounded reproduction

The unchanged test passed **10 isolated local WebKit runs**, 60 tests in total, on Linux with Vitest 5.0.2. This does not rule out suite-level interference or a hosted-runner-only failure.

After the normal dependency and Playwright setup, build the test imports:

```sh
bun run build -- --filter=@singapore-editor/core --filter=@singapore-editor/diff --filter=@singapore-editor/gutters --filter=@singapore-editor/tree-sitter-languages
cd packages/editor
for attempt in $(seq 1 10); do
  node node_modules/vitest/vitest.mjs run test/initialViewport.browser.test.ts --project=scroll-webkit --reporter=verbose
done
```

Next, capture native event counts after each `proofKeyPress` and focus state before dispatch. Compare isolated runs with the full core browser project. Do not add retries, replace native typing with synthetic edits, or lower the 20-character assertion without identifying the cause.

## November 14 bounded diagnosis

The same failure recurred on main at `d80fa319b30936215ab802071a3dccb5f43dcb6c` in
[CI run 42460742300](https://github.com/ShaulLavo/singapore/actions/runs/42460742300),
[core job 128669441140](https://github.com/ShaulLavo/singapore/actions/runs/42460742300/job/128669441140).
The failing 10 MiB case was typing at the end. It recorded 19 native `beforeinput`
events, expected length 10485780, and application and snapshot lengths 10485779.
The textarea and document were focused when the final diagnostic was collected.
That observation does not establish their focus before every key.

The full raw job log was retrieved with the command below. `gh run view --log`
returned a truncated log ending before the failure. This run has no uploaded
artifacts, so its failure screenshot and a browser trace are unavailable.

```sh
gh api --allow-escape-sequences repos/ShaulLavo/singapore/actions/jobs/128669441140/logs
```

The PC ran these package-script commands at the same main commit. Setup used
`bun install --frozen-lockfile` and the filtered build from the reproduction above.
Every test ran through `/work/heavy-runner/current/run.js` with `--host local`.
The browser cache was `/work/cache/ms-playwright`. Temporary directories were
task-owned, and the outer process deadlines were 360 seconds for the focused and
WebKit runs and 480 seconds for the full package. Test deadlines and assertions
were unchanged.

```sh
bun run --cwd packages/editor test test/hiddenInputSelection.browser.test.ts test/initialViewport.browser.test.ts test/selectionCopy.browser.test.ts test/gutterPointerEvents.browser.test.ts --project=scroll-firefox --project=scroll-webkit --reporter=verbose
bun run --cwd packages/editor test --project=scroll-webkit --reporter=verbose
bun run --cwd packages/editor test --reporter=verbose
```

- Focused audit passed 78 tests across eight file instances, with two existing
  Chromium-only IME skips, in 12.37 seconds.
- Diagnosis attempt 1 passed the whole `scroll-webkit` project, 215 tests across
  28 files, with one existing IME skip, in 29.87 seconds.
- Diagnosis attempt 2 passed the whole core package, 4781 tests across 337 files,
  with three existing skipped tests and one skipped file, in 126.91 seconds.
  Only this attempt added temporary per-key length, focus, and native-event
  diagnostics to the existing viewport test. Those diagnostics changed no input
  behavior or assertion and were removed after the run.

Source review covered `handleBeforeInput`, `beforeInputText`, hidden-input window
and selection synchronization, `handleKeyDown`, and `VirtualizedTextView.focusInput`.
Typed text commits synchronously when its `beforeinput` arrives. The fallback
deliberately leaves textarea keystrokes to native input, and the test awaits each
of its 20 Playwright key presses. No source defect explaining the absent native
insertion was established. Final focus and event totals cannot identify which
key was lost or why.

Stop local reproduction after these two broader attempts. The historical failure
remains unresolved. No production fix, retry, extra wait, skip, or weaker assertion
was added. Require normal green CI on the final independently reviewed coverage
PR before release. A local pass is not evidence that this failure was fixed.
