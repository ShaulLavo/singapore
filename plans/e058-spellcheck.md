# E058: Spellcheck for text the editor paints itself

- Status: Proposed
- Kind: Implementation
- Owner: Cross-repo
- Priority: P2
- Effort: L
- Dependencies: None
- Inspected baseline: `74e76bef2af674ad80b3c13024fa47f692e2bb7c`, 2026-09-26 (Platform `97bfbf2ba`).

Research done 2026-09-26. The measurements, licence audit and survey are in
[spellcheck-research.md](../docs/editing/spellcheck-research.md). Decided 2026-09-26: owner. The
chat composer keeps Lexical until this lands, so this plan gates Platform
[Plan 171](../../platform/plans/171-composer-on-our-editor.md) phase 3. Only permissive licences
may be used, with as few dependencies as possible.

## Outcome

A misspelled word gets a wavy underline in the editor and in the chat composer. Right-clicking it
offers suggestions and "Add to dictionary". Words the user adds stop being marked everywhere.

For example, a user types "the list settles befor the cursor" in the composer and "befor" is
underlined. They right-click it, the menu opens with "before" first, and one click replaces the
word as a single undo step. In a Markdown file, prose is checked. Code spans, fences, URLs, paths
and link targets are not. In a TypeScript file, nothing is checked unless the user turns on
comments and strings.

## Current code

- **No native path.** The Editor paints text outside its input element. The EditContext host and
  the textarea both set `spellcheck = false`
  ([virtualizedTextViewHelpers.ts](../packages/editor/src/virtualization/virtualizedTextViewHelpers.ts)).
  The EditContext explainer states that native spellcheck is unreachable under EditContext, and the
  web platform has no API that reports misspellings. A hidden mirror is rejected in the findings.
- **Squiggles already paint.** LSP errors draw `underline wavy` through
  `setRangeHighlight(name, ranges, style)` ([plugin.styles.ts](../packages/lsp-plugin/src/plugin.styles.ts),
  [diagnosticsPresenter.ts](../packages/lsp-plugin/src/diagnosticsPresenter.ts) `renderHighlights`),
  and colours are registered ids (`registerEditorColor`).
- **The contribution context has the rest.** Contributions have `trackRanges`,
  `getDocumentSyncPoint` / `changesSinceDocumentSyncPoint`, `textOffsetFromPoint` (E047),
  `getRangeClientRect` and `getSelections` ([plugins.ts](../packages/editor/src/plugins.ts)
  `EditorViewContributionContext`). Workers follow the minimap pattern
  (`new Worker(new URL('./minimap.worker.ts', import.meta.url))`).
- **Captures are tied to replacement providers.** They reach only inline replacement providers.
  `needsSyntaxCaptures` is true only while such a provider is registered
  (`Editor.ts:578-579`, `syntaxController.ts:522-528`), and captures are requested for the
  highlighted range (`syntaxMode: 'range'`). The packed token store holds colours, not capture
  names.
- **Menus.** Platform's editor right-click menu is `editor.text`
  (`apps/web/src/features/editor/components/frame.tsx`, `utils/text-menu.ts`). Its model already
  allows local `action` items (`keymap/menus/utils/model.ts` `MenuActionItem`). A right-click does
  not move the caret, so suggestions must come from the pointer offset.

## Scope

Editor:

- A new `@singapore-editor/spellcheck` package (proposed name): a worker that owns the dictionary,
  a word tokenizer with skip rules, and a view contribution that paints issues.
- A feature token (`EDITOR_SPELLCHECK_FEATURE`, proposed) with `issueAt(offset)`,
  `suggestions(offset)`, `replace(offset, word)` and `setAcceptedWords(words)`.
- Capture demand that is not tied to inline replacement providers.
- A demo in `examples/app`.

Platform:

- Settings keys, the dictionary words as a settings mutation, the `editor.text` menu section, a
  keyboard command, composer registration and a scenario.

Out of scope:

- Grammar.
- Languages other than English.
- Autocorrect as you type.
- A problems count for the whole file.

## Design

- **Engine.** `cspell-trie-lib` (MIT, no transitive dependencies, 34 KB gzip tree-shaken) decodes a
  SCOWL-derived trie in the worker. Measured:
  - load: 68 ms and 4 MB heap
  - 79k words checked: 17–21 ms
  - suggestions: 4.8 ms median, 7.9 ms p95, 12.5 ms max
  - quality: 72.8% top-1 and 89.3% top-5

  nspell had a 97 ms maximum and 81.3% top-5. typo-js took 430 ms per suggestion. Harper is an
  8 MB wasm using 284 MB. SymSpell used 105 MB. A home-grown `Set` engine had an 84 ms p95. The
  choice between the dependency and our own code is owner question 1.
- **Dictionaries are vendored data, not packages.** en_US is cspell's `en_US.trie.gz` (298 KB,
  SCOWL size 70). en_GB is built from SCOWL's hunspell pair with `hunspell-reader` and
  `cspell-trie-lib` (123k words, 153 KB gzip). `scripts/build-dictionaries.ts` (proposed) is run by
  hand, and its output is committed with `THIRD_PARTY_NOTICES` (SCOWL, Ispell BSD, WordNet, cspell
  MIT). The worker fetches the file through a Vite `?url` asset and inflates it with the native
  `DecompressionStream`, so first load gains no bytes. `@cspell/dict-software-terms` (MIT, 3,247
  words) is vendored the same way; it halves false positives on engineering prose (343 → 182
  distinct words).
- **What is checked.** Words are Latin-alphabet runs of two or more letters, including apostrophes.
  Skipped:
  - acronyms, and words containing digits or `_`
  - camelCase in prose
  - any word containing a letter outside the dictionary's alphabet, so Hebrew text is never marked
  - URLs, email addresses, paths, and ranges covered by an inline replacement (composer chips,
    hidden Markdown fences)

  Which ranges are prose comes from syntax:
  - No language, or plain text: all of it.
  - Markdown: everything except `text.literal`, `text.uri`, `text.reference` and fences.
  - Code, only when the setting allows it: `comment*` and `string*` captures, splitting camelCase
    and snake_case as cSpell does.

  A per-language `*-spell.scm` query with `@spell` / `@nospell` (Neovim's model) replaces the
  capture-name rules wherever the colour names are wrong.
- **What runs when.** The contribution checks the mounted rows plus one screen above and below. A
  60-line viewport tokenizes in 0.2 ms. Only words missing from a per-document verdict cache go to
  the worker. Before painting, the reply is mapped from its sync point to the current text with
  `changesSinceDocumentSyncPoint`, and a range an edit touched is dropped. The word under a caret is
  not marked until the caret leaves it, as Chromium and cSpell do. Whole-file checking is not
  needed, since marks only matter on screen. For reference, a whole 10k-line file costs about
  50 ms in the worker.
- **Painting.** `setRangeHighlight('spelling', ranges, { textDecoration: 'underline wavy <spellcheck.misspelled>' })`,
  with a registered colour and a `zIndex` below the LSP error. When Plan 111's decoration range set
  lands, this becomes a `mark` source with no behaviour change.
- **One engine per page.** The host creates one spellchecker service (worker plus dictionary) and
  hands it to every editor's contribution. There is no module singleton and no active-editor lookup.
  Disposal ends the worker when the last editor goes.
- **Words the user adds.** They are Platform settings: `spellcheck.words`, a
  `record<string, boolean>` with `merge: 'record'` and scope `window`. It only suppresses marks, so
  `window` is allowed, with the cross-scope indicator. User and workspace entries merge, and `false`
  un-accepts a word. "Add to dictionary" writes user scope and "Add to workspace dictionary" writes
  window scope, each as a settings mutation. The Editor receives the merged list through
  `setAcceptedWords`, and suggestions consider those words too.

## Steps

1. **Engine package (Editor, M).** Package, vendored dictionaries and notices, worker protocol
   (`check(words) → misspelled`, `suggest(word, n)`), tokenizer and skip rules.
   - Evidence: node tests on the tokenizer; a bench script that reproduces the findings table on the
     same corpora.
2. **View contribution (Editor, M).** Viewport window, verdict cache, sync-point mapping, caret-word
   hold-back, capture demand decoupled from replacement providers, prose ranges per language,
   feature token, demo.
   - Evidence: a Chromium, Firefox and WebKit paint test (as E053 did) and a typing test showing no
     mark on the word in progress.
3. **Platform wiring (Platform, M).**
   - Settings keys:
     - `editor.spellcheck`: `'off' | 'prose' | 'proseAndCode'`, default `'prose'`
     - `chat.spellcheck`: boolean, default on
     - `spellcheck.language`
     - `spellcheck.words`
   - Registered in the same pass that wires them, with the reference regenerated.
   - `editor.text` gets a spelling section at the pointer: up to five suggestions, Add to
     dictionary, Add to workspace dictionary. A command "Spelling suggestions" opens the same
     section at the caret.
   - Evidence: an `editor-spellcheck` scenario (type, look, right-click, pick, add a word, reload)
     and `look` screenshots.
4. **Composer (Platform, inside Plan 171 phase 3, S).** Register the contribution in the composer
   host. Chips are skipped as replacements.
   - Evidence: a `chat-composer-editing` scenario step with a misspelled word.
5. **Ranking (Editor, S, optional).** Rank SCOWL-60 words first among near-ties (75.8% top-1, no
   frequency data needed). Accept the document's own identifiers in comment checking, as harper-ls
   does.
   - Evidence: the bench before and after.

## Verification

- **Tokenizer tests.** Catch a path, URL, inline code or chip range being marked, and a Hebrew word
  being marked.
- **Mapping test.** Catch a reply painted at stale offsets after an edit arrives mid-flight.
- **Caret test.** Catch the word being typed flashing a mark on every keystroke.
- **Paint test in three engines.** Catch a colourless or missing wavy line (the E053 class of bug).
- **Platform scenario.** Catch the menu acting on the caret instead of the pointer, and an added
  word not persisting across reload.
- **Input budget.** The E002 input-latency gate must not regress with spellcheck on, because the
  main-thread work per keystroke is the tokenization of changed visible rows.

## Risks and decisions

- **Owner question 1: engine code.**
  - (a) Depend on `cspell-trie-lib`: one MIT package, no transitive dependencies, maintained.
  - (b) Write our own trie and weighted edit-distance suggester, about 400–600 lines.
  - (c) nspell: 4 KB, reads hunspell files, unmaintained since 2021.

  **Recommendation:** (a). It has the best bounded suggestion latency measured, and (b) rebuilds
  the same thing.
- **Owner question 2: which English.**
  - (a) en-US
  - (b) en-GB
  - (c) accept both spellings

  **Recommendation:** (c). The repository writes both (`behavior` 177, `behaviour` 94), and (c)
  flags the fewest words (166 distinct against 182).
- **Decided 2026-09-26: research recommendation.** English only. Permissive dictionaries exist for
  English, Dutch and Russian, and Hebrew exists only as AGPL-3.0 hspell, so Hebrew words are skipped,
  never marked.
- **Decided 2026-09-26: research recommendation.** Code files are not checked by default. In our
  plans, a US dictionary still flags 1.5% of prose words. Code would be noisier, and the composer is
  why this plan exists.
- **Stop condition.** If step 2's typing test shows input-latency regressions that the verdict
  cache cannot remove, move tokenization into the worker before continuing.
- **Risk.** A replacement word arriving through the menu must be one `edit` with its own undo step.
  It must not go through `syncText`.
