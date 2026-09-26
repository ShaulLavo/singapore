# @singapore-editor/spellcheck

English spellcheck engine for text the editor paints itself. A worker holds the dictionary; the
page creates one `SpellcheckService` and shares it between editors.

US and British spellings are both accepted, plus software vocabulary. The dictionary is built from
SCOWL and cspell's word lists by `bun run build:dictionaries`; see `THIRD_PARTY_NOTICES`.

## Usage

```ts
import { SpellcheckService, tokenizeSpellWords } from '@singapore-editor/spellcheck'

const spellcheck = new SpellcheckService()
const text = 'the list settles befor the cursor'
const words = tokenizeSpellWords(text)
const misspelled = new Set(await spellcheck.check(words.map((word) => word.word)))
const marks = words.filter((word) => misspelled.has(word.word))
const suggestions = await spellcheck.suggest('befor') // ['before', …]
spellcheck.setAcceptedWords(['fregat'])
spellcheck.dispose()
```

## Exports

- `SpellcheckService`: `check(words)`, `suggest(word, limit)`, `setAcceptedWords(words)` and
  `dispose()`. The worker starts on the first request.
- `tokenizeSpellWords(text, { mode, excluded })`: the words to check, with offsets. It skips
  acronyms, camelCase, words with digits or `_`, non-English words, URLs, email addresses, paths and
  the `excluded` ranges. `mode: 'code'` splits camelCase and snake_case instead.
