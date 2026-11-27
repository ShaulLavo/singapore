---
'@singapore-editor/core': patch
---

Paint `.editor-virtualized-selection-layer` at `z-index: -1` inside an isolated `.editor-virtualized-row` stacking context so opaque `selectionColor` and `inactiveSelectionColor` values render above row backgrounds and strictly behind code text, CSS highlights, inline widgets, and hidden-character markers. Layer `.editor-virtualized-caret-layer` at `z-index: 1` so carets remain visible above row backgrounds and opaque selections.
