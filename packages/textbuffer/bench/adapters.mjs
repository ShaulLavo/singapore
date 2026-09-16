import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { upstreamRoot } from './support.mjs'

export async function loadAdapter(name, roots = {}) {
  if (name === 'singapore') return singaporeAdapter(roots.singapore)
  if (name === 'vscode') return vscodeAdapter(roots.vscode)
  throw new Error(`Unknown engine: ${name}`)
}

async function singaporeAdapter(root) {
  const target = (file, specifier) => (root ? pathToFileURL(path.join(root, file)).href : specifier)
  const api = await import(target('index.js', '@singapore-editor/textbuffer'))
  const { lineStartOffset } = await import(
    target('positions.js', '@singapore-editor/textbuffer/internal/positions')
  )
  const { validatePieceTreeInvariants } = await import(
    target('debug.js', '@singapore-editor/textbuffer/debug')
  )
  function wrap(snapshot) {
    return {
      get snapshot() {
        return snapshot
      },
      length: () => snapshot.length,
      lineCount: () => (snapshot.root?.subtreeLineBreaks ?? 0) + 1,
      edit(edit) {
        if (edit.to > edit.from)
          snapshot = api.deleteFromPieceTable(snapshot, edit.from, edit.to - edit.from)
        if (edit.text.length) snapshot = api.insertIntoPieceTable(snapshot, edit.from, edit.text)
      },
      batch(edits) {
        snapshot = api.applyBatchToPieceTable(snapshot, edits)
      },
      line(row) {
        const start = lineStartOffset(snapshot, row)
        const count = (snapshot.root?.subtreeLineBreaks ?? 0) + 1
        const end = row + 1 < count ? lineStartOffset(snapshot, row + 1) - 1 : snapshot.length
        return api.readPieceTableTextRange(snapshot, start, end)
      },
      range: (from, to) => api.readPieceTableTextRange(snapshot, from, to),
      point: (offset) => api.offsetToPoint(snapshot, offset),
      offset: (point) => api.pointToOffset(snapshot, point),
      full: () => api.materializePieceTableFullText(snapshot),
      retain: () => snapshot,
      anchor: (offset, bias) => api.anchorAt(snapshot, offset, bias),
      resolve: (anchor) => api.resolveAnchor(snapshot, anchor),
      resolveLinear: (anchor) => api.resolveAnchorLinear(snapshot, anchor),
      issues: () => validatePieceTreeInvariants(snapshot).issues,
      stats: () => ({ pieces: snapshot.pieceCount, chunks: snapshot.buffers.chunks.size }),
    }
  }
  return {
    create: (text) => wrap(api.createPieceTableSnapshot(text)),
    restore: wrap,
    retainedText: api.materializePieceTableFullText,
  }
}

function vscodeAdapter(root) {
  const require = createRequire(import.meta.url)
  const { PieceTreeTextBufferBuilder } = require(
    path.join(root ?? path.join(upstreamRoot, 'dist'), 'pieceTreeBuilder.js'),
  )
  return {
    create(text) {
      const builder = new PieceTreeTextBufferBuilder()
      builder.acceptChunk(text)
      // The fixture contract is already LF-only. Upstream's const enum LF = 1.
      const tree = builder.finish(true).create(1)
      function range(from, to) {
        const start = tree.getPositionAt(from)
        const end = tree.getPositionAt(to)
        return tree.getValueInRange({
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        })
      }
      function edit(change) {
        if (change.to > change.from) tree.delete(change.from, change.to - change.from)
        if (change.text.length) tree.insert(change.from, change.text, true)
      }
      return {
        get tree() {
          return tree
        },
        length: () => tree.getLength(),
        lineCount: () => tree.getLineCount(),
        edit,
        batch(edits) {
          for (const change of edits.toSorted((a, b) => b.from - a.from || b.to - a.to))
            edit(change)
        },
        line: (row) => tree.getLineContent(row + 1),
        range,
        point(offset) {
          const position = tree.getPositionAt(offset)
          return { row: position.lineNumber - 1, column: position.column - 1 }
        },
        offset: (point) => tree.getOffsetAt(point.row + 1, point.column + 1),
        full: () => range(0, tree.getLength()),
        issues: () => [],
        stats: () => ({}),
      }
    },
  }
}

export function applyOperation(buffer, operation) {
  if (operation.kind === 'edit') {
    buffer.edit(operation)
    return null
  }
  if (operation.kind === 'batch') {
    buffer.batch(operation.edits)
    return null
  }
  if (operation.kind === 'line') return buffer.line(operation.row)
  if (operation.kind === 'range') return buffer.range(operation.from, operation.to)
  if (operation.kind === 'offset') return buffer.point(operation.offset)
  if (operation.kind === 'point') return buffer.offset(operation.point)
  if (operation.kind === 'full') return buffer.full()
  throw new Error(`Unknown operation: ${operation.kind}`)
}
