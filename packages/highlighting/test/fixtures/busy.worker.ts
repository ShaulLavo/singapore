import { DocumentWorkerReader } from '@singapore-editor/core/internal/document-worker'
import type { TreeSitterWorkerRequest } from '../../../tree-sitter/src/treeSitter/types'

const reader = new DocumentWorkerReader()

self.onmessage = ({ data: request }: MessageEvent<TreeSitterWorkerRequest>) => {
  if (request.payload.type === 'highlightOpen') {
    self.postMessage({ busy: true })
    for (;;) {}
  }
  if (request.payload.type === 'source') {
    self.postMessage({ id: request.id, ok: true, result: reader.apply(request.payload.command) })
    return
  }
  if (request.payload.type === 'highlightTheme') {
    self.postMessage({ id: request.id, ok: true, result: { theme: { backgroundColor: 'ready' } } })
    return
  }
  self.postMessage({ id: request.id, ok: true })
}
