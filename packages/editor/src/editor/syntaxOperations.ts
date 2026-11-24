import {
  createEditorHighlighterOperation as createHighlighterOperation,
  createEditorStructuralOperation as createStructuralOperation,
  defineHighlighterOperation as defineHighlighter,
  defineStructuralOperation as defineStructural,
} from './operationDefinitions'
import { installEditorSyntaxController } from './syntaxController'

// What syntax and highlighter providers are built with. Each installs the syntax controller, so the
// controller ships in the bundle of whatever builds a provider and is already loaded when an editor
// is handed one; an editor that only ever shows text never loads it. The operation classes stay free
// of the controller because the controller is built on them.

export const defineStructuralOperation: typeof defineStructural = (create) => {
  installEditorSyntaxController()
  return defineStructural(create)
}

export const defineHighlighterOperation: typeof defineHighlighter = (create) => {
  installEditorSyntaxController()
  return defineHighlighter(create)
}

export const createEditorStructuralOperation: typeof createStructuralOperation = (create) => {
  installEditorSyntaxController()
  return createStructuralOperation(create)
}

export const createEditorHighlighterOperation: typeof createHighlighterOperation = (create) => {
  installEditorSyntaxController()
  return createHighlighterOperation(create)
}
