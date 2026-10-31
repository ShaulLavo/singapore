import { Editor } from '@singapore-editor/core/editor'
import { createTreeSitterLanguagePlugin } from '@singapore-editor/tree-sitter'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '@singapore-editor/tree-sitter-languages'
import { createLineGutterPlugin } from '@singapore-editor/gutters'
import { createEditorFindPlugin } from '@singapore-editor/find'
import { createTypeScriptLspPlugin } from '@singapore-editor/typescript-lsp'
import { MAIN_TS, MATH_TS } from './sample'

export function mountPlayground(element: HTMLElement): Editor {
  const typescript = createTypeScriptLspPlugin()
  typescript.setWorkspaceFiles([{ path: '/src/math.ts', text: MATH_TS }])
  const editor = new Editor(element, {
    theme: { type: 'dark', backgroundColor: '#23211d', foregroundColor: '#d6d1c6' },
    plugins: [
      createTreeSitterLanguagePlugin(TREE_SITTER_LANGUAGE_CONTRIBUTIONS),
      createLineGutterPlugin(),
      createEditorFindPlugin(),
      typescript,
    ],
  })
  editor.openDocument({ documentId: '/src/main.ts', text: MAIN_TS, languageId: 'typescript' })
  return editor
}
