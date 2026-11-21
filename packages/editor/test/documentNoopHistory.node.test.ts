import { expect, it } from 'vitest'
import { createEditorBufferSession, createEditorTextBuffer } from '../src/public/document'

it.each(['redo', 'checkout'] as const)('ends typing at no-op %s', (command) => {
  const buffer = createEditorTextBuffer('')
  const session = createEditorBufferSession(buffer)
  session.applyText('a')
  const change =
    command === 'redo'
      ? session.redo()
      : buffer.checkoutHistoryState(buffer.getHistoryGraph().currentId, session.view)
  expect(change.kind).toBe('none')
  session.applyText('b')
  expect(session.undo().textSnapshot.materializeFullText()).toBe('a')
})
