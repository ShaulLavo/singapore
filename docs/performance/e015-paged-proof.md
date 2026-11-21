# Paged UTF-8 browser proof

The browser proof exercises the read-only viewer in Chromium with a deterministic UTF-8
source containing emoji, combining marks, CJK, and CRLF. It generates ranges on demand
without a resident fixture file.

## Reproduce

```sh
bun run stress:build
bun run --cwd examples/stress bench:paged --sizes 629145600 --modes demand,indexed --output /tmp/paged-windows.json
bun run --cwd examples/stress bench:paged --sizes 10485760 --modes traverse --output /tmp/paged-traverse.json
```

- **Demand.** Open without a byte length, line count, or index. The source returns a short first
  response and never signals EOF. Verify the initial rows, observe idle request counts, and scroll
  two rows plus seven pixels. The next read reports a byte length. The first visible byte and
  its pixel offset stay fixed as the view makes room for the next rows. Scroll up by one row
  across the window boundary and verify the same pixel offset after prepending. Copy a selected range
  across two lines with Chromium's clipboard, then close while a user-requested range is pending.
  The virtual source rejects reads outside the allowed region.
- **Indexed.** Use the line control to jump to 90% of a file with one supplied checkpoint. The
  fixture forbids reads before that checkpoint once the jump starts.
- **Traverse.** Explicitly request each continuation through EOF. This separate mode measures a
  full traversal and checks every fragment against the generator.
- **Resident and streamed.** Optional comparison modes construct the editable buffer from one
  decoded string or from successively decoded chunks.

The report records time to first DOM content, scroll, copy, and jump times, and traversal time.
It includes source calls, requested and delivered bytes, cache hits, cancellation, peak cached
bytes, checkpoint retention, and CDP samples of main-renderer JavaScript heap. Timings include
browser automation. They do not measure compositor paint or network throughput.

## Demand and traversal measurements

Chromium 156.0.8078.4 on the PC heavy runner, November 21, 2026. The measured commit was
`0babd97af374d89600edcbca9cb6d1d32c2692bc`.

| Operation                                           | Source calls | Requested bytes | Delivered bytes | Cache hits | Peak raw cache |     Retained checkpoints |
| --------------------------------------------------- | -----------: | --------------: | --------------: | ---------: | -------------: | -----------------------: |
| Open unknown 600 MiB source, then idle              |            1 |          65,536 |             675 |          0 |          675 B |                        1 |
| Open, scroll both ways, copy, and revisit the start |            2 |         131,072 |          66,211 |          2 |       66,211 B |                        1 |
| Open and jump to 90% using an index                 |            2 |         131,072 |         131,072 |          0 |        128 KiB | 1 discovered, 1 supplied |
| Traverse 10 MiB explicitly, including open          |          160 |      10,485,760 |      10,485,750 |      3,271 |          8 MiB |                       40 |

The unknown source showed its first content in 8.9 ms. Downward and upward rebases took 59.8
and 34.8 ms, respectively, and kept a seven-pixel offset. Clipboard copy took 7.4 ms with no
additional reads. Closing cancelled one pending read and left zero in-flight reads and cached
bytes. The indexed jump took 26.7 ms and used one range beginning at byte 566,231,025. The
separate full traversal took 340.4 ms. Sampled JavaScript heap peaks were 3.2 MiB for demand,
1.8 MiB for the indexed jump, and 9.3 MiB for traversal.

## Historical baseline

The September 28 E015 run measured bounded residency while the viewer still indexed the whole
source on startup. Its 300 and 600 MiB inputs fetched about twice the source size over indexing
plus a full sweep. Paged backing storage was about 8.16 MiB. Those results establish the old
residency envelope. The demand proof above measures the new request behavior. The
[historical results](e015-results/) retain the original samples.

| Historical input | Construction or index | Steady JS heap | Backing storage | Sampled JS peak |
| ---------------- | --------------------: | -------------: | --------------: | --------------: |
| Resident 50 MiB  |                446 ms |       76.8 MiB |         8.1 MiB |       196.8 MiB |
| Streamed 50 MiB  |                217 ms |       77.6 MiB |        0.16 MiB |        82.5 MiB |
| Resident 200 MiB |              1,776 ms |      304.8 MiB |        32.1 MiB |       784.8 MiB |
| Streamed 200 MiB |                832 ms |      307.1 MiB |        0.16 MiB |       318.9 MiB |
| Paged 300 MiB    |              2,104 ms |       2.26 MiB |        8.16 MiB |        7.10 MiB |
| Paged 600 MiB    |              4,292 ms |       2.30 MiB |        8.16 MiB |        9.95 MiB |
