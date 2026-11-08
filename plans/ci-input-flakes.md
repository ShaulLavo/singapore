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
