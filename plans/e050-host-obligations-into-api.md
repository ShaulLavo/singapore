# E050: Things every host must remember become things the API does

- Status: Proposed
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

## Scope

API design across `packages/editor` and the bundled plugins. Each section below ships on its own;
this document is the inventory and the contract, not one change.

## Design

| Secret today                                   | API that replaces it                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `setTokens` after every `setText`              | `setText(text, { tokens })`, or a split between "replace text" and "reset presentation"                  |
| Diff option traps                              | a `createDiffEditorOptions()` preset exported by `packages/diff`; `readonly` suppresses edit bindings    |
| CSS variables for typography                   | `fontSize`, `fontFamily`, `lineHeight` options; the resolved row pitch on the view snapshot              |
| `!important` theming                           | theme keys for diff palette, caret, selection, inactive selection, popup surface                         |
| Listener order plus `stopImmediatePropagation` | a pointer participant that can claim a press before selection handling; rows a plugin can mark non-caret |
| Capture-phase `keydown`                        | plugin-contributed keymap context keys with a defined priority                                           |
| `MutationObserver` on `style`                  | `onDidChangeReservedOverlayWidth(side)` that is not dropped when re-entrant                              |
| Raw `scroll` listener                          | `onDidScroll` fired after the virtualizer's fold, and a two-axis scroll setter                           |
| `pointer-events: auto`                         | an `interactive` flag on a gutter cell contribution                                                      |
| Row elements by selector                       | a row presentation handle that survives recycling, or a reveal mode owned by the view                    |
| `TOKENS_WAIT_MS`                               | the initial-highlight terminal status exposed to contributions                                           |

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
