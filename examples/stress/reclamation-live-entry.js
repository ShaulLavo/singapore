import { Editor } from '@singapore-editor/core/editor'
import { createEditorTextBuffer, createEditorBufferSession } from '@singapore-editor/core/document'
import '@singapore-editor/core/style.css'

const buffer = createEditorTextBuffer('prefix suffix')

function keptUnits(workload, cycle) {
  if (workload === 'survivors') return 64
  if (workload === 'mixed' && cycle % 4 === 0) return 1024
  return 0
}
const session = createEditorBufferSession(buffer)
const editors = [0, 1].map((index) => {
  const host = document.createElement('div')
  host.id = `editor-${index}`
  host.style.cssText = 'width:700px;height:160px'
  document.body.append(host)
  const editor = new Editor(host)
  editor.attachSession(createEditorBufferSession(buffer), { documentId: 'reclamation.txt' })
  return editor
})

window.reclamationLive = {
  buffer,
  editors,
  // aligned: one fully deleted chunk per cycle, the collector's best case.
  // survivors: 1 KiB inserts that keep 64 units each, so every chunk stays partly live.
  // mixed: 1 KiB inserts, three of four deleted whole.
  churn(cycles, workload) {
    const started = performance.now()
    let deletedUnits = 0
    for (let cycle = 0; cycle < cycles; cycle++) {
      const size = workload === 'aligned' ? 16384 : 1024
      const text = cycle.toString().padStart(8, '0') + 'x'.repeat(size - 8)
      const kept = keptUnits(workload, cycle)
      session.applyEdits([{ from: 7, to: 7, text }])
      if (kept === text.length) continue
      session.applyEdits([{ from: 7 + kept, to: 7 + text.length, text: '' }])
      deletedUnits += text.length - kept
    }
    session.applyEdits([{ from: 7, to: 7, text: '!' }])
    return {
      churnMs: performance.now() - started,
      revision: buffer.getRevision(),
      deletedUnits,
      text: buffer.materializeFullText(),
    }
  },
  undoRedo() {
    const texts = []
    while (buffer.canUndo()) {
      texts.push(buffer.materializeFullText())
      buffer.undo()
    }
    const count = texts.length
    while (buffer.canRedo()) {
      buffer.redo()
      if (buffer.materializeFullText() !== texts.pop()) return { valid: false, count }
    }
    return { valid: texts.length === 0, count }
  },
  prepareInput() {
    editors[0].setSelection(0, 0)
    editors[0].focus()
  },
  dispose() {
    for (const editor of editors) editor.dispose()
  },
}
