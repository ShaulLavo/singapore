# E050: Things every host must remember become things the API does

- Status: In progress
- Kind: Design
- Owner: Cross-repo
- Priority: P2
- Effort: L
- Dependencies: [E047](../docs/display/e047-point-queries.md)
- Inspected baseline: `aeba6783b978193de9d2ba0fd5874f357df68edc`, 2026-09-21.

## Outcome

This is a design inventory; each row then ships as its own implementation change, and Platform
removes its half in Platform plan 130. Platform plan 111 (editor decorations) owns the wider
decoration surface.

A host that mounts an editor, or a plugin that adds behaviour, cannot get it subtly wrong by
forgetting a step, registering a listener in the wrong order, or overriding a private class. Each
item below is a secret a caller currently has to know. None was individually re-verified after the
audit except where stated; step 1 of this plan is to confirm each against source.

## Current code

Content and presentation:

- `Editor.setContent` clears tokens, manual folds and syntax folds
  ([Editor.ts](../packages/editor/src/editor/Editor.ts) around line 1072); only `renderDocument`
  restores tokens. Every host calling `setText` must call `setTokens` straight after. Platform's
  `diff-pane.tsx` does it in a five-step order the editor does not enforce, and
  `scope-lines/stickyScroll.ts` repeats the same dance for secondary views. `packages/diff`'s README
  lists it as a host obligation.
- The diff README lists further traps: `languageId: null`, an explicit `tabSize` (or
  `adoptDocumentTabSize` re-guesses on every `setText`), `keymap: { defaultBindings: false }`
  because `editability: 'readonly'` does not suppress the keymap, and explicit `false`s for
  `cursorLineHighlight` because `undefined` means the default. Resolved by row 2 below.
- The editor has no `fontSize` or `fontFamily` option. Platform writes `--editor-font-size`,
  `--editor-row-height` and `--editor-tab-size` on `:root` while the editor writes the same
  variables itself, and Platform runs a row-height audit to notice when the two disagree.
- The theme surface covers syntax tokens only. Platform themes the diff palette, caret, inactive
  selection and popups with `!important` overrides on `.editor-virtualized-*` classes, and wins by
  stylesheet order.

Events and ordering:

- [editorDiffPlugin.ts](../packages/diff/src/editorDiffPlugin.ts) keeps the caret off separator
  rows by registering its `mousedown` before the editor's own and calling
  `stopImmediatePropagation`. Platform's definition-click plugin does the same in the capture phase.
- `lsp-plugin`'s completion and signature-help controllers each capture `keydown` on the scroll
  element to beat the keymap, and race each other for Escape. `EditorKeymapContext` is a closed set
  that a plugin cannot extend, while the core hardcodes `findVisible` for a plugin in another
  package.
- [find/src/plugin.ts](../packages/find/src/plugin.ts) observes the scroll element's inline `style`
  with a `MutationObserver` because the overlay-reservation notification is dropped when raised
  during layout.
- Platform's diff scroll bridge listens to the raw `scroll` event and depends on the virtualizer
  having registered its listener first, because `getScrollPosition()` is stale within the event and
  the `update` hook is throttled.
- [foldGutter.css](../packages/gutters/src/foldGutter.css) sets `pointer-events: auto` to punch
  through the core's `pointer-events: none` gutter; no gutter contribution can declare a cell
  interactive. Resolved by row 9 below.

Handles:

- [decode/src/rows.ts](../packages/decode/src/rows.ts) animates row elements it found by selector.
  The core recycles those elements, so a scroll during a reveal can leave an unrelated line
  half-clipped. `decode` also waits on a `TOKENS_WAIT_MS` timer because contributions get no
  "initial highlight settled" signal.

## Step 1 result, 2026-09-24

Every row was re-checked at Editor `c9fb653`. All eleven describe a real workaround; five need their
wording corrected, and three already have part of the proposed API.

| Row                         | Verdict | Correction                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setTokens` after `setText` | Holds   | The clearing is in private `renderContent`, reached as `setText` → `resetOwnedDocument` → `renderContent`; `setContent` on a buffer session is now an undoable edit. `setText` also resets language, tab size, decorations, folds, selection and undo; only scroll carries over. Sticky scroll's `lineView` is a secondary view whose `setText` keeps its tokens, so it is not this obligation. |
| Diff option traps           | Partly  | `languageId: null`, `tabSize` and `cursorLineHighlight` hold. `readonly` already blocks every mutating binding (`editor/keymap.ts:34`, `keymap/presets.ts:705`); only find, navigation and fold bindings get through. Platform passes `keymap: { enabled: false }`, not `defaultBindings: false`.                                                                                               |
| Typography variables        | Partly  | `lineHeight` and `setLineHeight` exist; `fontSize` and `fontFamily` do not. The editor writes `--editor-row-height` and `--editor-tab-size` on its own element, which wins over Platform's `:root` values; it never writes `--editor-font-size` and hardcodes `13px`.                                                                                                                           |
| `!important` theming        | Partly  | `EditorTheme` has `caretColor` and an open `colors` map (`hover.background` exists). Missing: the diff palette, selection colour (a literal in `style.css:297`) and inactive selection.                                                                                                                                                                                                         |
| Pointer order               | Holds   | The core mousedown already returns on `defaultPrevented` (`inputSelectionController.ts:1873`), so `stopImmediatePropagation` only silences other plugins. Plugins added after construction register after the core, so "first" is not guaranteed. Same shape in `lsp-plugin/definitionLinkController.ts`, merge-conflict lenses and the fold gutter button.                                     |
| Capture-phase `keydown`     | Holds   | Signature help is lazy-loaded, so it always registers after completion: Escape closes completion first and needs a second press; with only signature help open, Escape also runs the keymap's Escape bindings.                                                                                                                                                                                  |
| Style `MutationObserver`    | Holds   | Three drop paths: re-entrant layout (`viewContributions.ts:224`), `committingPresentation`, and provisional paint.                                                                                                                                                                                                                                                                              |
| Raw `scroll` listener       | Partly  | Plugins already have `updateViewport` after the fold and unthrottled (`plugins.ts:634`); hosts have no `onDidScroll`, and the contribution context has only `setScrollTop`.                                                                                                                                                                                                                     |
| `pointer-events: auto`      | Holds   | The merge-conflict lens punches through the same way (`style.css:494`). Row 9: no core `none` covers the lens, so it needed none.                                                                                                                                                                                                                                                               |
| Rows by selector            | Holds   | Programmatic scroll does not cancel a reveal.                                                                                                                                                                                                                                                                                                                                                   |
| `TOKENS_WAIT_MS`            | Partly  | `EditorViewSnapshot.initialHighlightStatus` already reaches contributions on every change; `'plain'` means both "not started" and "settled", which is the real gap.                                                                                                                                                                                                                             |

## Row 1, 2026-09-24: tokens travel with the text

`EditorSetTextOptions.tokens` (and so `openDocument`) paints the given tokens with the text.
`renderContent` swaps text and tokens inside one atomic render: before, the view published a
`viewport` update showing the new text under the outgoing document's tokens, then an empty store,
then the host's. `syncText` with `tokens` renders the edit and the host's tokens in one atomic
render too: the buffer publishes the edit inside `applyEdits`, so the tokens cannot ride the change.
`test/setTextTokens.test.ts` fails if any contribution update during `setText` sees other tokens.
The diff README, plugin contract and tests pass tokens with the text; Platform's `diff-pane.tsx`
does the same (scenario `git-diff-expand-tokens`). The host's `setPresentationReady` bracket stays:
it also covers restoring selection and scroll, which `setText` drops.

## Typography row, 2026-09-25: the editor owns its font

`EditorOptions.fontSize` (pixels) and `fontFamily` (a CSS `font-family` list), with `setFontSize`
and `setFontFamily` and entries in the option registry, so both bindings apply them live (D2). The
view writes them as `--editor-font-size` and `--editor-font-family` on its own element, before the
first measurement at construction and followed by a re-measure in the same call afterwards;
`undefined` removes the variable and hands the font back to the stylesheet, whose defaults stay
`13px` and `monospace`. The editor's hover, completion and rename popups already copied those two
variables, which nothing wrote, so they now take the editor's face. `lineHeight` stays its own
option: a larger face does not stretch rows. The resolved pitch was already on the snapshot as
`metrics`. Sticky scroll's secondary view mirrors `metrics` whole through
`setTextMetrics` (was `setLineHeight`), since a new size moves every column it draws.
`test/typography.browser.test.ts` fails with the in-call re-measure removed (character width stays
at the old face until the resize observer fires); binding samples cover both options.

Platform passes all three from its settings and stopped writing `--editor-font-size`,
`--editor-row-height` and `--editor-tab-size` on `:root`. Those never reached the editor anyway:
it writes the row height and tab size on its own element, so `editor.lineHeight` had no effect
(scenario `editor-typography` fails on the old build at a 34px setting, rows stay 24px). The
row-height audit is deleted (Platform plan 130, D3).

Tab size followed: `tabSize` is now the configured width (the columns a tab spans, and the fallback
the indentation guess uses), `detectIndentation` (default on) replaces "a named `tabSize` switches
the guess off", and `setTabSize` changes both live. The view used to lay tabs out at its
constructor width forever; it now re-projects, so wrap points, hit tests and the caret follow
(`typography.browser.test.ts` fails with only the CSS variable updated). The diff recipe and the
stress examples pass `detectIndentation: false`. Platform feeds `editor.tabSize` to every editor
and to prepared documents, whose `configuredTabSize` must match the editor's to be claimed.

## Row 5, 2026-09-24: a press a plugin claims

`EditorViewContributionContext.registerPressParticipant(participant)` registers a function the
editor asks, in registration order, before it turns a mouse press into a caret or a selection and
before it focuses. The first to return true claims the press: the editor prevents its default and
stops. A participant that throws is logged as `editor.contribution.press_failed` and the press goes
on. Registration order against the editor's own listener no longer matters, so a plugin added after
construction claims presses too. The diff separator, LSP Ctrl/Cmd+click and Platform's diff
Ctrl/Cmd+click use it; none calls `stopImmediatePropagation` or listens in the capture phase any
more. `test/pressParticipants.test.ts`; Platform scenario `editor-press-participants` fails with
the hook disabled (a double-click selects `lines` of the separator label).

The fold gutter and merge-conflict buttons still stop propagation on their own elements, which is
ordinary DOM ownership rather than an ordering trick. Platform's line-comment action observes
presses on the pane host, so a Ctrl+click in a diff also offers "Ask the agent about these lines".

Rows a plugin marks non-caret, 2026-09-25: `registerNonCaretRows(isNonCaret)` takes a predicate
over buffer rows. A caret move whose target lands on such a row steps onward in the move's
direction, keeping a vertical move's goal column and entering a row from its near edge on a
horizontal one, and turns back when nothing lies that way (Ctrl+Home onto a leading separator).
Extending moves step the same way, so the head never rests on one. The diff plugin marks its
separator rows. Tests: `navigationTargets.test.ts`, diff `diffPlugin.test.ts` (fails with the
predicate returning false); Platform scenario `editor-press-participants` presses Down and Right at
the last row above a trailing separator and fails without the predicate (the caret lands on
`Show 9 unmodified lines`).

## Row 6, 2026-09-24: keys a plugin contributes

`EditorKeymapContext` is open: `registerKeymapContextKey(key, read)` on the view contribution
context adds a key read at match time, an unregistered key reads false, and a condition is any key
or `!key`. The editor's own four keys cannot be shadowed. The core no longer builds `findVisible`;
the find plugin registers it, and `EditorFindFeature.isVisible` is gone: a find provider registers
the key. A test holds every condition in the shipped presets to a known key. Completion and signature help register `suggestWidgetVisible`,
`parameterHintsVisible` and `parameterHintsMultipleSignatures`, and their keys are commands with
VS Code's ids (`editor.action.triggerSuggest`, `selectNextSuggestion`, `acceptSelectedSuggestion`,
`hideSuggestWidget`, `closeParameterHints`, `showNextParameterHint`, …) bound in a `suggest` pack
that is last in the layer order, so it outranks caret movement, inline suggestions and find. The
defined priority is that order: one Escape closes the list, the next the hint, and only then does
Escape reach find or secondary cursors. Before, signature help's capture listener closed the hint
without claiming the key, so the same Escape also cleared secondary cursors. Every LSP command,
rename and format included, now goes to the views of the editor that dispatched it rather than to
every editor sharing the plugin object, and the widget commands are ordinary entries in
`commands`, so `commands: []` still lets a second LSP plugin share an editor. Only commit
characters keep a keydown listener, in the bubble phase: any character can commit, so it cannot be
a binding. Ctrl+Space is Ctrl on every platform (it used to accept Cmd too); Shift+Enter and
Shift+Tab accept, as before, while Ctrl+Enter stays insert-line-after. A host without the editor's
keymap binds the commands itself (lsp-plugin README, Keys).
`test/keymapContextKeys.test.ts`, lsp `test/widgetKeys.test.ts` (fails with the hint's Escape
unclaimed); Platform registers the ten commands, scenario `editor-widget-keys`.

## Row 2, 2026-09-25: the diff options are a preset

`createDiffEditorOptions()` in `packages/diff` returns what a diff's editor needs: a static
read-only document, `detectIndentation: false`, every part of `cursorLineHighlight` off, and a
keymap of the navigation, selection and find packs. A host spreads it and adds its own plugins,
typography and theme. The README's list of four load-bearing options is gone. Its recipe, every diff
test and Platform's `diff-pane.tsx` build the editor from the preset and push
`setText(text, { tokens })`. `languageId: null` was never needed, because `setText` without a
language leaves the document without one.

The keymap was decided from source. `readonly` already refuses every mutating binding: each one
carries the `writable` condition (`withEditorConditions` in `keymap/presets.ts`), so the preset
strips nothing for safety. Of the keys left, folding does harm. A buffer with no language gets
indentation fallback folds, so Ctrl+K Ctrl+0 folds the interleaved rows (a deletion and its addition
vanish behind `...`) and would misalign a split. The preset keeps navigation, selection and find
and leaves folding out. Platform keeps `keymap: { enabled: false }`, as every hosted editor does,
because its app keymap drives them. The arrow keys can rest the caret on a separator row, where a
collapsed-caret copy takes the label: row 5's non-caret rows remain. Platform's app keymap already
moved the caret there.

`test/editorOptions.test.ts` fails with `detectIndentation` removed (the width follows each push's
guess), with `cursorLineHighlight` removed (the caret's row is painted), with the default keymap or
the folding pack added (the fold chord folds the projection), with the navigation, selection or find
pack removed, and with `editability` or `documentMode` changed (with both, a host keymap's
Backspace edits the buffer). The README shows how to extend the preset's `keymap` and
`cursorLineHighlight`, since a field an override leaves out takes the editor default. Platform
deletes `diff-options.ts`. Scenarios `git-diff-expand-tokens`, `git-diff-line-comment`,
`git-diff-inline-tint` and `editor-title-diff-toggle` pass.

A host that brings its own keymap could still fold a diff: Platform turns the editor's keymap off
and dispatches `editor.foldAll` to the focused editor, so with a diff focused Ctrl+K Ctrl+0 hid a
deletion and its addition behind `...`. The core now has a `folding` option (VS Code's
`editor.folding`, on by default). Off, the editor takes no syntax, indentation, contributed or
hand-drawn regions, so every fold command returns false and the gutter shows no chevron. The
preset sets it off, and its keymap is one frozen object, so a React host that spreads the preset
in render does not re-apply the keymap. `foldCommands.test.ts` pins each gate, the preset test
dispatches the fold commands the way Platform does, and Platform's `git-diff-fold` scenario presses
the chord on a focused diff. Editor `6b5b04d`, `0b5b431` and the review-fix commit carry the change.

## Row 11, 2026-09-25: the settled highlight is the signal

`EditorInitialHighlightStatus` gains `idle`, the status before any document and after
`clearDocument`. `plain` now only means "settled with no highlighter", so every value except `idle`
and `loading` is settled; `EditorInitialPaintEvent`'s `status` excludes both. `decode` hides the
rows on open and starts when the snapshot's status settles, on whichever update carries it.
`TOKENS_WAIT_MS` and its timer are gone, and so is the decode entry in the timer baseline. Input
during the wait now cancels too (the listeners used to attach only once the reveal began). A
document that opens before its highlighter provider registers settles as `plain` and reveals
uncoloured; Platform registers Shiki with the critical plugins, so its editors are not affected.
The wait has no ceiling: a highlight request that never settles keeps the rows hidden until input
(keydown, pointerdown or wheel). Accepted because decode is opt-in (`editor.decode.mode` is `off` by
default in Platform) and the retry ladder now ends every failed refresh. If hangs show up, the fix
is a request budget in the controller that fails into the ladder; the scheduler's budget timeout
cancels without reaching `fail` today.

Platform plan 071's retry lands with it, so `error` is settled only once the retries are spent. A
refresh that fails (the document-open path)
retries after 100 ms on the same session, then reloads the highlighter session and retries after
400 ms, and then settles as `error`. The backoff goes through the controller's existing
`LatestAsyncRequest`, so no new timer. Each attempt still logs `editor.syntax.highlight_request_failed`
at `warn` (now with `failedRefreshes`); exhaustion logs one `editor.syntax.highlight_retries_exhausted`
at `warn` with `attempts` and the final error, replacing `highlight_cleared_after_error`. The
document-version and configuration checks already guard every attempt, and an edit replaces a
pending retry. A retry that paints logs one `editor.syntax.highlight_recovered` at `info` with
`attempts`. A success, a new document, a provider reload, a highlighter theme change and the edit
path's session reload reset the count, so an edit that fails after the ladder ran out gets a fresh
one. The edit path still reloads the session and does not count. If the provider declines the
reloaded session, the ladder ends there with the terminal event. The shared Platform logs for
2026-09-20 to 2026-09-25 hold no `highlight_request_failed` or `highlight_cleared_after_error`
event, so the retry hides no live failure.

`packages/editor/test/syntax.test.ts` "highlight refresh retry" (the bound of three attempts and
two sessions, recovery and its event, a superseded retry, the edit path, a fresh ladder for an edit
after exhaustion, a declined reload session, and the reset) and
`packages/decode/test/plugin.test.ts` (no reveal after 60 s of fake time while `loading`, a start on
`error` and `plain`, input during the wait) fail without the change.

## Row 9, 2026-09-25: a gutter cell that takes presses

`EditorGutterContribution.interactive` marks a contribution whose cell handles presses. The core
tags that cell `data-editor-gutter-interactive` and owns the one rule that gives it
`pointer-events: auto`; the rest of the gutter stays `none`, so a press there reaches the text as
before. A press an interactive cell does not claim bubbles to the editor, which places the caret from
the point, as it did for the empty fold cell. The fold gutter sets the flag, and `foldGutter.css`
lost its `pointer-events: auto` and the hidden button's `none` (`visibility: hidden` already takes
it out of hit testing).

The merge-conflict lens is not a gutter cell: its view contribution mounts a zero-height layer in
`contentElement`, which no core `none` covers. The layer's `none` and the lens's `auto` cancelled
each other, so both are deleted. The minimap's `pointer-events: auto` stays: it undoes the
minimap's own autohide `none` on a sibling of the editor, not a core rule. Platform has no
punch-through on editor gutter or lens selectors (`apps/web`, `packages/ui` `globals.css`).

`test/gutterPointerEvents.browser.test.ts` clicks through Playwright at each element's centre: an
interactive probe cell gets the press and the caret stays, an inert probe cell and a line number
move the caret to their row, an empty fold cell moves the caret, the chevron folds and unfolds, and
a lens action resolves its conflict. With the core rule removed the probe and chevron cases fail;
on the old source only the probe case fails. Platform scenario `editor-split-folds` clicks the
chevron through Playwright's hit check.

Review: the gutter row's `display: flex` beat the UA `[hidden]` rule, so a retired row stayed in
layout where the host has no `[hidden]` reset, and now its whole fold cell took presses. The core
hides `.editor-virtualized-gutter-row[hidden]`; the browser test asserts a row retired by a fold has
no box.

## Row 7, 2026-09-25: a reservation change is an event

`EditorViewContributionContext.onDidChangeReservedOverlayWidth(listener)` is called with the side
after the width reserved on it changes. The viewport raises it where the padding is written, so it
covers all three drop paths step 1 found: a claim staked inside a layout pass (whose re-entrant
`layout` notification is still dropped by design), a claim deferred behind a provisional paint and
applied when the paint commits, and the saved paint's own widths. A change made by a listener
queues behind the one being delivered; a listener that throws is logged as
`editor.contribution.reserved_width_failed`. The find widget moved from its `MutationObserver` on
the scroll element's `style` to the event. Tests: `editor.test.ts` (a claim made during layout
reaches the listener while the contribution before it sees no second layout),
`provisionalPaint.test.ts` (fails when only the editor's own `reserveOverlayWidth` announces, since
the commit path writes the viewport directly), find `plugin.test.ts`. Platform scenario
`editor-find` asserts the widget clears the minimap.

## Row 8, 2026-09-25: a host hears the scroll it is looking at

`Editor.onDidScroll(listener)` is called with `{ top, left }` after the position changes, from a
gesture, a programmatic move or a clamp. It is raised from the virtualizer's scroll handler, which
runs after the fold, so the position is current and nothing throttles it. `applyScrollPosition`
now hands the view both axes before it writes the element: the element's `scrollTop` setter is the
virtualizer's, and on its own it published a vertical-only move with the old `scrollLeft`, which a
mirror would copy. The contribution context's vertical-only `setScrollTop` became
`setScrollPosition({ top?, left? })`. Platform deleted `diff-scroll-bridge.ts` (a raw `scroll`
listener plus a frame of delay) and subscribes; because the mirrored pane reports its move from
inside `setScrollPosition`, `use-diff-panes.ts` recognises that report by a flag set around the
write instead of matching positions. Tests: `editor.test.ts` (one report per new position, none
after dispose; failed with a `{ top: 300, left: 0 }` intermediate before the reorder), Platform
`use-diff-panes.test.tsx` (the double now reports synchronously) and the real-wheel browser test
`diff-split-scroll`.

## Scope

API design across `packages/editor` and the bundled plugins. Each section below ships on its own;
this document is the inventory and the contract, not one change.

## Design

| Secret today                                   | API that replaces it                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `setTokens` after every `setText`              | done: `setText(text, { tokens })`                                                                                           |
| Diff option traps                              | done: `createDiffEditorOptions()` preset in `packages/diff` with `folding: false`; `readonly` already refused edit bindings |
| CSS variables for typography                   | done: `fontSize`, `fontFamily` options beside `lineHeight`; pitch was already `snapshot.metrics`                            |
| `!important` theming                           | theme keys for diff palette, caret, selection, inactive selection, popup surface                                            |
| Listener order plus `stopImmediatePropagation` | done: `registerPressParticipant`, and `registerNonCaretRows` for the arrow keys                                             |
| Capture-phase `keydown`                        | done: `registerKeymapContextKey`, a `suggest` pack first in priority                                                        |
| `MutationObserver` on `style`                  | done: `onDidChangeReservedOverlayWidth(side)`, raised by the viewport on every change                                       |
| Raw `scroll` listener                          | done: `Editor.onDidScroll` after the fold; the context's `setScrollPosition` takes both axes                                |
| `pointer-events: auto`                         | done: `interactive` on a gutter contribution; the merge-conflict lens needed no flag                                        |
| Row elements by selector                       | a row presentation handle that survives recycling, or a reveal mode owned by the view                                       |
| `TOKENS_WAIT_MS`                               | done: `idle` before a document, so every status but `idle` and `loading` is settled                                         |

## Steps

1. Confirm each row against source and record file and line; drop any that do not hold.
2. Order by blast radius. Recommended first three: `setText` with tokens, the pointer participant,
   plugin keymap context keys. Each removes a workaround in more than one package.
3. One change per row: add the API, move every caller, delete the workaround and its comment.

## Verification

Per row, a test that fails on the old obligation: for example a diff expansion toggle that stays
coloured without the host calling `setTokens`, and Escape closing the completion list regardless of
controller registration order.

## Risks and decisions

- D1: whether the diff plugin should own its document text through a contribution, which would
  remove the host round-trip entirely. It needs a document-mutation capability for plugins, which
  is a larger decision than this plan; recorded here so it is not rediscovered.
- D2: typography options change how Platform applies appearance live. The "no remount" property
  Platform relies on must survive, so options have to be settable after construction.

## Theme row, 2026-09-25

Selection, inactive selection and popup background are public EditorTheme fields. The diff palette
uses registered `diff.*` colours, inherited by its rows; row-local literals and forced editor
background overrides are gone. Diff base colors use `backgroundColor`, `foregroundColor` and
`gutterBackgroundColor`; the diff README maps the removed CSS hooks to these fields. Palette
defaults distinguish dark and light themes. Hover, completion and rename copy the popup colour
into their portalled elements. `themeColors.browser.test.ts` constructs the plugin and checks
default palette, overrides, live base-color updates and selection paint. The production consumer
bundle test executes registration after minification; removing the factory registration fails
both tests. Split `getStackedRows()` caches its projection until the file or expansion changes,
with private and shared expansion stores covered by toggle regressions.

## Row presentation decision, 2026-09-25

The owner chose short-lived row presentation handles invalidated before DOM recycling, with decode
reveals cancelled on scrolling and viewport changes. Decode continues to own the animation.
