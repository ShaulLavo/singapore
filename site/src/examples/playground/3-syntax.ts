import { Editor } from '@singapore-editor/core/editor'
import { createTreeSitterLanguagePlugin } from '@singapore-editor/tree-sitter'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '@singapore-editor/tree-sitter-languages'
import { MAIN_TS } from './sample'

export function mountPlayground(element: HTMLElement): Editor {
  const editor = new Editor(element, {
    theme: { type: 'dark', backgroundColor: '#23211d', foregroundColor: '#d6d1c6' },
    plugins: [createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)],
  })
  editor.openDocument({ documentId: '/src/main.ts', text: MAIN_TS, languageId: 'typescript' })
  return editor
}
