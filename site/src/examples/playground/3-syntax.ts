import { Editor } from '@singapore-editor/core/editor'
import { editorThemeFromVscodeTheme } from '@singapore-editor/core/shiki'
import { createTreeSitterLanguagePlugin } from '@singapore-editor/tree-sitter'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '@singapore-editor/tree-sitter-languages'
import '@singapore-editor/core/style.css'
import { MAIN_TS } from './sample'

export function mountPlayground(element: HTMLElement): Editor {
  const editor = new Editor(element, {
    theme: editorThemeFromVscodeTheme({
      type: 'dark',
      colors: { 'editor.background': '#18202b', 'editor.foreground': '#dce5ef' },
    }),
    plugins: [createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)],
  })
  editor.openDocument({ documentId: '/src/main.ts', text: MAIN_TS, languageId: 'typescript' })
  return editor
}
