# E053: Diagnostic tags paint in each token's own colour, in every engine

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: none
- Inspected baseline: `206bc32eca5fd02a2d4573952312367c96500192`, 2026-09-24, with the uncommitted
  Deprecated strike layer in `packages/lsp-plugin` (see Current code).

## Outcome

Unused code fades the way it does in VS Code, and deprecated code is struck through. In both, each
token keeps its own hue, and that holds in Chromium, Firefox and WebKit. A faded `import` is dim
keyword colour, and a struck `substr` stays method colour with a line in the same colour.
Diagnostic washes stop erasing syntax colour in WebKit.

For example, TypeScript reports `const unused = 1` as 6133 with `tags: [1]` on `unused`. That name
paints at 67% on dark themes and 47% on light ones, with no hint wash. `'x'.substr(1)` is 6385 with
`tags: [2]` on `substr`.

The desktop app renders with CEF (Chromium) on every platform
(`platform/apps/desktop/electrobun.config.ts`). Firefox and WebKit matter for the mesh, and every
iPhone browser is WebKit.

## Current code

- **Tags.** [capabilities.ts](../packages/lsp/src/capabilities.ts) declares Unnecessary and
  Deprecated for push and pull diagnostics; TypeScript 7 sends pull tags only since that landed.
  [diagnostics.ts](../packages/lsp-plugin/src/diagnostics.ts) adds a `deprecated` layer, painted
  by [diagnosticsPresenter.ts](../packages/lsp-plugin/src/diagnosticsPresenter.ts) as a colourless
  `line-through` range highlight at priority 0. Tag 1 is read nowhere.
- **Syntax tokens** paint in `appendTokenSegmentsForChunk` → `addTokenSegmentsForRow` →
  `ensureTokenGroup` in
  [virtualizedTextViewHighlights.ts](../packages/editor/src/virtualization/virtualizedTextViewHighlights.ts).
  There is one shared `Highlight` per `styleKey`
  ([sharedTokenHighlights.ts](../packages/editor/src/virtualization/sharedTokenHighlights.ts)) at
  priority 0. `tokenRowSignature` (in `virtualizedTextViewHelpers.ts`) gates row rebuilds.
- **Everything else** goes through `setRangeHighlight` in the same file (`priority = zIndex`).
  Colour producers: syntax 0, bracket colours 1
  ([bracketColors.ts](../packages/scope-lines/src/bracketColors.ts)), semantic 2
  (`SEMANTIC_TOKEN_Z_INDEX`, [semanticTokenLayer.ts](../packages/editor/src/semanticTokenLayer.ts)),
  error 3 ([plugin.styles.ts](../packages/lsp-plugin/src/plugin.styles.ts)), and find
  ([findController.ts](../packages/find/src/findController.ts)). Washes and occurrence highlights
  set no colour and sit at 0.
  [highlightPriority.test.ts](../packages/lsp-plugin/test/highlightPriority.test.ts) pins the order.
- **Untokenized text** is `color: var(--editor-foreground)` ([style.css](../packages/editor/src/style.css)).
- **Tests run in Chromium only.** The `browser` project in
  [vitest.config.ts](../packages/editor/vitest.config.ts) has `instances: [{ browser: 'chromium' }]`,
  and [ci.yml](../.github/workflows/ci.yml) installs only Chromium.
- **Control.** VS Code's `squiggly-inline-unnecessary` class gets `opacity` from the alpha of
  `editorUnnecessaryCode.opacity` (`#000a` / `#0007`), and deprecated code gets `line-through`.
  Both work on real spans, which highlights cannot copy.

**Engine probe, 2026-09-24.** Red token text, with a second highlight over half of it. Measured
pixels in Chromium 153, Firefox 155 and WebKitGTK 2.52.6:

| Upper highlight                                  | Chromium              | Firefox                  | WebKit                  |
| ------------------------------------------------ | --------------------- | ------------------------ | ----------------------- |
| `line-through`, priority 1                       | red text, red line    | red text, **white** line | **white** text and line |
| `line-through`, priority 0 (tie)                 | red, red line         | **white** text           | **white** text          |
| `line-through`, priority −1                      | red text, white line  | red text, white line     | **no line**             |
| wash, priority ≥ 0                               | red                   | red                      | **white** text          |
| wash, priority −1                                | red                   | red                      | red                     |
| `color: currentColor`                            | red (the layer below) | white (the element)      | white (the element)     |
| `color-mix(currentColor 50%, transparent)`       | **invisible**         | grey                     | grey                    |
| `color-mix(<literal or var()> 50%, transparent)` | dim red               | dim red                  | dim red                 |

Only an explicit colour paints the same everywhere. No single colourless layer strikes correctly in
all three engines, and a wash must sit below the tokens for WebKit.

## Scope

- An overlay mask in the view, with faded and decorated twins for token and range-highlight colours.
- Colourless range highlights moved below the token priority.
- `unnecessary` and `deprecated` tag layers rebuilt on the overlay mask.
- Firefox and WebKit added to the highlight browser tests and to CI.
- Not in scope: a high-contrast border variant, and a Platform `showUnused` setting (Platform's).

## Design

- **Overlay API (proposed).** `VirtualizedTextHighlightStyle.overlay?: { dim?: number;
textDecoration?: string }`. An overlay group is never registered as a CSS highlight. The view
  merges overlay groups into one sorted mask; `dim` takes the strongest value and decorations join.
  An overlay combined with any other style field is rejected.
- **Twins.** Inside the mask, each colour producer paints a twin that sets the same colour,
  `color-mix`ed by `dim`, together with the overlay's decoration. That happens in
  `appendTokenSegmentsForChunk` for tokens, and in `renderRangeHighlight` for groups with a
  `color`. Twins keep the original's priority, so the winner per character is unchanged in every
  engine. Because the twin sets a colour, its decoration's `currentColor` is the token's colour.
  The mask's row intersection joins `tokenRowSignature`.
- **Base.** One mask group at priority −1 carries the faded foreground and the decoration for
  untokenized text.
- **Colourless band.** `setRangeHighlight` maps a style without `color` to `zIndex − 100`, below
  every colour producer. Relative order among washes is kept.
- **lsp-plugin.** `unnecessary` becomes `{ overlay: { dim } }` and `deprecated` becomes
  `{ overlay: { textDecoration: 'line-through' } }`. A hint tagged Unnecessary drops its wash.
  Find opts out of dimming (`dimmable: false`, proposed).

## Steps

1. **Engine matrix first.** Add `firefox` and `webkit` browser instances for a new
   `highlightPaint.browser.test.ts`, which pins the probe table above with pixel reads. Add both
   to the CI install. Evidence: the table's current rows pass or fail as recorded, in every engine.
2. **Colourless band.** Evidence: the wash rows turn red in WebKit.
3. **Overlay mask and base group.** Evidence: a unit test of the pure split; untokenized text fades.
4. **Token and range twins.** Evidence: the strike and fade rows are identical in all three
   engines, and the priority test shows each twin at its original's priority.
5. **lsp-plugin layers.** Evidence: `diagnostics.test.ts` for tag 1, tag 2, and both together.
6. **Cost and app.** `bench:tokens` and `bench:virtualization` with an empty mask and with a mask
   over a tenth of the viewport; an empty mask must be free. Platform scenarios
   `editor-lsp-deprecated` and `editor-lsp-unnecessary` pass under `--engine chromium` and
   `--engine firefox`.

## Verification

- `bun run test` in `packages/editor` and `packages/lsp-plugin`; the paint test runs in all three
  engines in CI.
- Each new test names the failure it catches:
  - a colourless layer at or above the tokens, which erases colour in WebKit;
  - a twin at the wrong priority;
  - a decoration without a colour, which Firefox and WebKit draw white;
  - a mask edge across a surrogate pair;
  - a stale row signature after the mask moves.
- Acceptance: the paint test is green in all three engines, and the Platform scenarios' screenshots
  show `substr` struck in method colour and `unused` faded in its own hue.

## Risks and decisions

- **Local WebKit.** Playwright's WebKit build does not start on Arch (libicu74, libxml2 and libflite
  are missing), so step 1 is proven in CI. A local WebKitGTK harness reproduced the table on
  2026-09-24; keep it out of the repo unless CI cannot run WebKit.
- **Alpha source.** Decided 2026-09-25 by the owner: use a registered theme colour's alpha, as in VS Code.
- **Firefox painting.** In the real app a hint wash was not visible in Firefox where Chromium drew
  it (2026-09-24). This may be the intermittent painting noted in `virtualizedTextViewHelpers.ts`.
  Step 1 should include a wash row that runs through the real view, not only a bare page.
- **Stop condition.** If Chromium makes `currentColor` inside `color-mix()` resolve like the other
  engines, the fade still needs twins, because Firefox and WebKit resolve it to the element's
  colour, not the token's. Re-run the probe before step 4 anyway.
