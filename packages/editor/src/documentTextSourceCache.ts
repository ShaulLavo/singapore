import type { PieceBufferId } from '@singapore-editor/textbuffer'
import type { PieceTableBuffers } from '@singapore-editor/textbuffer/internal/pieceTableTypes'
import { TextSourceIndex } from './textMeasurements'

// One cache per document lineage, not per version. Editing and undo keep reuse intact.
const sourceIndexes = new WeakMap<object, Map<PieceBufferId, TextSourceIndex>>()

export function getDocumentTextSourceIndex(
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  text: string,
): TextSourceIndex {
  let indexes = sourceIndexes.get(buffers.identity)
  if (!indexes) {
    indexes = new Map()
    sourceIndexes.set(buffers.identity, indexes)
  }
  let source = indexes.get(buffer)
  // Undo branches may reuse a buffer ID for different text. Retained ranges keep the old index.
  if (source?.text !== text) {
    source = new TextSourceIndex(text)
    indexes.set(buffer, source)
  }
  return source
}
