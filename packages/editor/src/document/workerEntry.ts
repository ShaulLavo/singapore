// The `internal/document-worker` entry: the worker-side reader, plus the operation helpers providers
// are built with. Those come from `syntaxOperations` so that a provider brings the syntax controller
// along; they are exported here rather than from the reader, which the analysis code imports.
export * from './workerReader'
export { defineHighlighterOperation, defineStructuralOperation } from '../editor/syntaxOperations'
export type { HighlighterOperationContext } from '../editor/operationDefinitions'
export type { EditorHighlighterRuntime } from '../syntax/highlighter'
