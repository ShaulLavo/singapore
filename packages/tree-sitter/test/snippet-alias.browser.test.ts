import { afterEach, expect, it } from 'vitest'
import { Editor } from '@singapore-editor/core/editor'
import { EDITOR_SNIPPET_TOKENS_FEATURE } from '@singapore-editor/core/extensions'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/index'
import { createTreeSitterLanguagePlugin } from '../src'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

// Hover markdown fences code by a short name: the TypeScript server writes ```ts.
it('tokenizes a snippet named by a language alias', async () => {
  const host = document.createElement('div')
  host.style.height = '200px'
  document.body.append(host)
  const editor = new Editor(host, {
    plugins: [createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)],
  })
  cleanups.push(() => {
    editor.dispose()
    host.remove()
  })
  const feature = editor.getFeature(EDITOR_SNIPPET_TOKENS_FEATURE)!
  const text = 'const twice = (n: number): number => n * 2'

  const byAlias = await feature.tokenize(text, 'ts')
  const byId = await feature.tokenize(text, 'typescript')

  expect(byId.length).toBeGreaterThan(0)
  expect(byAlias).toEqual(byId)
}, 30_000)
