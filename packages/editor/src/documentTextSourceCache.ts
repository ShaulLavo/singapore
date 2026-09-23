import type { PieceBufferId } from '@singapore-editor/textbuffer'
import type { PieceTableBuffers } from '@singapore-editor/textbuffer/internal/pieceTableTypes'
import { bufferTextOwner } from '@singapore-editor/textbuffer/internal/buffers'
import { TextSourceIndex } from './textMeasurements'

// Retained chunks share measurements; reclaiming a chunk releases its cached text too.
const sourceIndexes = new WeakMap<object, TextSourceIndex>()

export function getDocumentTextSourceIndex(
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  text: string,
): TextSourceIndex {
  const owner = bufferTextOwner(buffers, buffer)
  let source = sourceIndexes.get(owner)
  // Tail extents and divergent branches can expose different text through the same owner.
  if (source?.text !== text) {
    source = new TextSourceIndex(text)
    sourceIndexes.set(owner, source)
  }
  return source
}
