# E050: Things every host must remember become things the API does

- Status: In progress
- Kind: Design
- Owner: Cross-repo
- Priority: P2
- Effort: L
- Dependencies: [E047](e047-point-and-row-queries.md)
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
  `cursorLineHighlight` because `undefined` means the default.
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
  interactive.

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
| `pointer-events: auto`      | Holds   | The merge-conflict lens punches through the same way (`style.css:494`).                                                                                                                                                                                                                                                                                                                         |
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
row-height audit is deleted (Platform plan 130, D3). `editor.tabSize` remains unwired: the editor
detects each document's width and has no setter for the fallback it detects against.

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

Not covered: the arrow keys still move the caret onto a separator (the "rows a plugin can mark
non-caret" half of this row), and the fold gutter and merge-conflict buttons still stop propagation
on their own elements, which is ordinary DOM ownership rather than an ordering trick. Platform's
line-comment action observes presses on the pane host, so a Ctrl+click in a diff also offers
"Ask the agent about these lines".

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

## Scope

API design across `packages/editor` and the bundled plugins. Each section below ships on its own;
this document is the inventory and the contract, not one change.

## Design

| Secret today                                   | API that replaces it                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `setTokens` after every `setText`              | done: `setText(text, { tokens })`                                                                     |
| Diff option traps                              | a `createDiffEditorOptions()` preset exported by `packages/diff`; `readonly` suppresses edit bindings |
| CSS variables for typography                   | done: `fontSize`, `fontFamily` options beside `lineHeight`; pitch was already `snapshot.metrics`      |
| `!important` theming                           | theme keys for diff palette, caret, selection, inactive selection, popup surface                      |
| Listener order plus `stopImmediatePropagation` | done: `registerPressParticipant`; rows a plugin can mark non-caret remain                             |
| Capture-phase `keydown`                        | done: `registerKeymapContextKey`, a `suggest` pack first in priority                                  |
| `MutationObserver` on `style`                  | `onDidChangeReservedOverlayWidth(side)` that is not dropped when re-entrant                           |
| Raw `scroll` listener                          | `onDidScroll` fired after the virtualizer's fold, and a two-axis scroll setter                        |
| `pointer-events: auto`                         | an `interactive` flag on a gutter cell contribution                                                   |
| Row elements by selector                       | a row presentation handle that survives recycling, or a reveal mode owned by the view                 |
| `TOKENS_WAIT_MS`                               | the initial-highlight terminal status exposed to contributions                                        |

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
