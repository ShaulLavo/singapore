import {
  createEditorTextBuffer,
  createEditorBufferSession,
  type TextEdit,
} from '@singapore-editor/core/document'
import { createEditorDocumentAnalysis } from '@singapore-editor/core/editor'
import {
  defineDocumentOperation,
  DocumentWorkerReader,
  type DocumentSourceEndpoint,
  type DocumentSourceConnection,
  type DocumentContributionSource,
} from '@singapore-editor/core/internal/document-worker'
import type { EditorSyntaxResult } from '@singapore-editor/core/syntax'
import { TreeSitterSyntaxSession, type TreeSitterSyntaxSessionOptions } from '../../src/session'

/**
 * Resolves once the session has published the result its complete analysis ends with. A
 * range-mode session answers first from what it has, and says `partial` until then.
 */
export function completeResult(runtime: TreeSitterSyntaxSession): Promise<void> {
  if (!awaitsCompleteAnalysis(runtime.getResult())) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribeResults((_read, result) => {
      if (awaitsCompleteAnalysis(result)) return
      unsubscribe()
      resolve()
    })
  })
}

/** A partial result that its complete analysis has not answered yet, with a result or without. */
export function awaitsCompleteAnalysis(result: EditorSyntaxResult): boolean {
  const analysis = result.projection.analysis
  return analysis?.kind === 'partial' && !analysis.background
}

const disposers = new Set<() => void>()
export function disposeTreeDocuments() {
  for (const dispose of disposers) dispose()
  disposers.clear()
}

export function createSourceEndpoint(): DocumentSourceEndpoint {
  const reader = new DocumentWorkerReader()
  let registration = 0
  const connection: DocumentSourceConnection = {
    generation: 1,
    nextRegistration: () => ++registration,
    send: async (command) => reader.apply(command),
    release: (identity) => {
      reader.apply({ kind: 'release', identity })
    },
  }
  return { connect: async () => connection }
}

export function createTreeDocument(
  options: Omit<TreeSitterSyntaxSessionOptions, 'source' | 'initialRead'> & {
    readonly text: string
  },
) {
  const buffer = createEditorTextBuffer(options.text)
  const view = createEditorBufferSession(buffer)
  const analysis = createEditorDocumentAnalysis({ buffer, documentId: options.documentId })
  const created: { runtime: TreeSitterSyntaxSession; source: DocumentContributionSource }[] = []
  const operation = defineDocumentOperation(
    (context) => {
      const runtime = new TreeSitterSyntaxSession({ ...context, ...options })
      created.push({ runtime, source: context.source })
      return runtime
    },
    () => true,
  )
  const lease = analysis.contributions.retain(operation, null)
  const owned = created[0]
  if (!lease || !owned)
    throw new TypeError('The fixture must bind one private runtime to its canonical owner')
  const run = () => {
    const owner = analysis.contributions.pin()
    if (!owner) throw new TypeError('The live fixture must issue its current revision')
    const read = owned.source.read(owner.revision)
    owner.dispose()
    if (!read) throw new TypeError('The issued canonical read must remain available')
    return owned.runtime.analyze(read)
  }
  const dispose = () => {
    lease.dispose()
    analysis.dispose()
    disposers.delete(dispose)
  }
  disposers.add(dispose)
  return {
    buffer,
    view,
    analysis,
    runtime: owned.runtime,
    run,
    edit: (edits: readonly TextEdit[]) => {
      view.applyEdits(edits)
      return run()
    },
    dispose,
  }
}
