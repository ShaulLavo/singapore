# E053: Unnecessary code fades in the colour it already has

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: none
- Inspected baseline: `206bc32eca5fd02a2d4573952312367c96500192`, 2026-09-24, with the uncommitted
  Deprecated strike layer in `packages/lsp-plugin` (see Current code).

## Outcome

An unused import, local or parameter fades the way it does in VS Code. Each token keeps its own
hue at reduced strength: a faded `import` is dim keyword colour, and its module string is dim string
colour. Nothing is recoloured grey and nothing is underlined.

For example, TypeScript reports `const unused = 1` as code 6133 with `tags: [1]` (Unnecessary) on
`unused`. Today that name gets the quiet hint wash and keeps full colour. After this plan it paints
at 67% on dark themes and 47% on light ones, and the hint wash is gone.

## Current code

- **Where the tag arrives.** `defaultClientCapabilities` in
  [capabilities.ts](../packages/lsp/src/capabilities.ts) declares Unnecessary and Deprecated for
  both push and pull diagnostics. TypeScript 7 sends tags on pulls only since the pull
  `tagSupport` was added on 2026-09-24. [diagnostics.ts](../packages/lsp-plugin/src/diagnostics.ts)
  groups diagnostics by severity plus a `deprecated` layer, which
  [diagnosticsPresenter.ts](../packages/lsp-plugin/src/diagnosticsPresenter.ts) paints as
  `line-through`. Tag 1 is read nowhere.
- **Syntax tokens** paint in `appendTokenSegmentsForChunk` → `addTokenSegmentsForRow` →
  `ensureTokenGroup` in
  [virtualizedTextViewHighlights.ts](../packages/editor/src/virtualization/virtualizedTextViewHighlights.ts).
  They use one shared `Highlight` per `styleKey` per document
  ([sharedTokenHighlights.ts](../packages/editor/src/virtualization/sharedTokenHighlights.ts)),
  at priority 0. Row signatures (`tokenRowSignature`) decide whether a mounted row is rebuilt.
- **Every other colour** goes through `setRangeHighlight` in the same file: one group per name,
  `highlight.priority = style.zIndex`, and a rule from `rangeHighlightRule` (colour, background and
  decoration only). Colour producers, in priority order: syntax tokens 0, bracket colours 1
  ([bracketColors.ts](../packages/scope-lines/src/bracketColors.ts)), semantic tokens 2
  (`SEMANTIC_TOKEN_Z_INDEX` in [semanticTokenLayer.ts](../packages/editor/src/semanticTokenLayer.ts)),
  error diagnostics 3 ([plugin.styles.ts](../packages/lsp-plugin/src/plugin.styles.ts)), and find
  ([findController.ts](../packages/find/src/findController.ts)).
  [highlightPriority.test.ts](../packages/lsp-plugin/test/highlightPriority.test.ts) pins the order.
- **Untokenized text** takes `color: var(--editor-foreground)` from the row
  ([style.css](../packages/editor/src/style.css)).
- **Control.** VS Code's `markerDecorationsService.ts` gives Unnecessary the inline class
  `squiggly-inline-unnecessary`. `codeEditorWidget.ts` sets `opacity` on it from the alpha of
  `editorUnnecessaryCode.opacity` (`#000a` dark, `#0007` light). High-contrast themes use
  `editorUnnecessaryCode.border` instead. (Paths are under Platform's `references/vscode`.)

**Why this is not one rule.** `::highlight()` does not accept `opacity`. A fade therefore has to be
a `color`, and a colour on a higher highlight replaces the token colour. A probe in Chrome 153
(2026-09-24) found that bare `currentColor` in a highlight does resolve to the layer below.
Inside `color-mix()` or relative colour syntax it resolves to transparent, and the text vanishes.
A literal or `var()` colour inside `color-mix()` fades correctly.

## Scope

- A dim mask in the view, plus faded twins for token and range-highlight colours.
- An `unnecessary` layer in `lsp-plugin`.
- Browser tests, and one Platform scenario as verification.
- Not in scope: a high-contrast border variant, since the editor has no high-contrast mode to
  select it. Also not in scope: a Platform `showUnused` setting, which Platform owns.
- Platform needs only a rebuild and relink.

## Design

- **Mask API (proposed).** `VirtualizedTextHighlightStyle.dim?: number` (0–1). A group whose
  style has `dim` is not registered as a CSS highlight; the view unions every dim group into one
  sorted, disjoint offset mask. `dim` combined with any other field is illegal and is rejected at
  `setRangeHighlight`. Plugins keep the existing named-group lifecycle (set, clear, dispose).
- **Token twins.** `appendTokenSegmentsForChunk` splits each segment at mask edges. Dimmed parts
  use `{ ...style, color: color-mix(in srgb, <color> <dim>, transparent) }` under their own
  `styleKey`, shared across editors like any token style, at the original's priority 0. The
  mask's intersection with a row joins that row's token signature, so a mask change rebuilds only
  the rows it touches.
- **Range-highlight twins.** A group with a `color` renders its masked parts into a twin group,
  `<name>-dim`, at the same priority. A group without a colour is untouched. Every twin keeps its
  original's priority, so the producer that wins a character today still wins it, only faded.
  Find opts out (`dimmable: false`, proposed): a match must stay legible inside unused code.
- **Base colour.** One mask group at priority −1 carries
  `color-mix(in srgb, var(--editor-foreground) <dim>, transparent)` for untokenized text.
- **lsp-plugin.** `diagnosticHighlightGroups` adds `unnecessary`, painted with
  `{ dim: UNNECESSARY_DIM }`. A hint tagged Unnecessary leaves the hint wash, because the fade is
  the mark (VS Code likewise drops its hint mark). It keeps its minimap marker and its hover.

## Steps

1. **Mask.** Add `dim`, union the mask, and add the base group. Evidence: a unit test of the pure
   split (mask × segments → plain and dimmed parts), and a browser test that untokenized text
   inside the mask paints at the faded foreground.
2. **Token twins.** Evidence: a browser test where a red token half-covered by the mask produces
   a twin group that holds exactly the covered offsets, with a `color-mix` rule over the token's
   colour. Also a pixel read showing the covered half at the expected channel values.
3. **Range twins.** Twins for semantic, bracket and error groups, and the find opt-out.
   Evidence: `highlightPriority.test.ts` extended so each twin's priority equals its original's.
   A semantic colour must still beat its syntax colour inside the mask.
4. **lsp-plugin layer** and the dropped hint wash. Evidence: `diagnostics.test.ts` cases for tag
   1, and tags 1 and 2 together (both layers).
5. **Cost.** `bench:tokens` and `bench:virtualization` before and after with an empty mask, then
   with a mask over a tenth of the viewport. An empty mask must be free. Platform scenario
   `editor-lsp-unnecessary` types an unused `const`, then checks the twin groups and a screenshot.

## Verification

- `bun run test` in `packages/editor` and `packages/lsp-plugin` (Vitest, browser project included).
- Each new test names the failure it catches:
  - a mask edge that splits a surrogate pair or a chunk boundary;
  - a twin at the wrong priority, so a faded syntax colour beats a semantic colour;
  - a mask left behind after `clearRangeHighlight`;
  - a stale row signature that keeps full colour after the mask moved.
- Acceptance: the Platform scenario passes. The screenshot shows a faded `unused` in its own hue,
  and the benchmarks show no change with an empty mask.

## Risks and decisions

- **Alpha source.** Either a plain number option on the plugin (simple, but themes cannot reach
  it), or a registered colour whose alpha is read, as VS Code does (themeable, but needs a numeric
  read of a colour id). Decide before step 4.
- **Backgrounds.** VS Code's `opacity` also fades washes and find backgrounds. This plan leaves
  them alone. Revisit only if screenshots look wrong.
- **Twin count.** One twin per distinct colour inside the mask. That is bounded by the styles
  already in view, but check it against the live highlight-group count.
- **Stop condition.** If Chrome starts resolving `currentColor` inside `color-mix()` in highlights
  to the layer below, one mask highlight replaces steps 2 and 3. Re-run the probe before starting.
- **Firefox.** It paints registered highlights intermittently (`virtualizedTextViewHelpers.ts`).
  Twins add groups, not a new mechanism, so they inherit that risk rather than add to it.
