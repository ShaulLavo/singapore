import { Editor } from '@singapore-editor/core/editor'
import { MAIN_TS } from './sample'

export function mountPlayground(element: HTMLElement): Editor {
  const editor = new Editor(element)
  editor.openDocument({ documentId: '/src/main.ts', text: MAIN_TS, languageId: 'typescript' })
  return editor
}
