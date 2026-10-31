import { Editor } from '@singapore-editor/core/editor'
import { MAIN_TS } from './sample'

export function mountPlayground(element: HTMLElement): Editor {
  const editor = new Editor(element, {
    theme: { type: 'dark', backgroundColor: '#23211d', foregroundColor: '#d6d1c6' },
  })
  editor.openDocument({ documentId: '/src/main.ts', text: MAIN_TS, languageId: 'typescript' })
  return editor
}
