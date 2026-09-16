import assert from 'node:assert/strict'

// Levels: empty tree = 0, root-only tree = 1. Depths: root = 0.
export function measureTree(root) {
  const seen = new Set()
  const stack = root ? [[root, 0]] : []
  const depthCounts = []
  let pieces = 0
  let visiblePieces = 0
  let storedLength = 0
  let visibleLength = 0
  let depthSum = 0
  let visibleDepthSum = 0
  let textDepthSum = 0
  while (stack.length) {
    const [node, depth] = stack.pop()
    // VS Code's shared NIL sentinel has a null piece and cyclic child links.
    if (node === null || node.piece === null) continue
    assert(node.piece && typeof node.piece === 'object', 'Invalid tree node')
    assert(!seen.has(node), 'Cycle or repeated node within one tree')
    seen.add(node)
    const piece = node.piece
    assert(Number.isSafeInteger(piece.length) && piece.length > 0, 'Invalid piece length')
    pieces += 1
    storedLength += piece.length
    depthSum += depth
    depthCounts[depth] = (depthCounts[depth] ?? 0) + 1
    if (piece.visible !== false) {
      visiblePieces += 1
      visibleLength += piece.length
      visibleDepthSum += depth
      textDepthSum += depth * piece.length
    }
    for (const child of [node.left, node.right]) {
      if (child) stack.push([child, depth + 1])
    }
  }
  const height = depthCounts.length
  let cumulative = 0
  let p95Depth = 0
  for (let depth = 0; depth < depthCounts.length; depth += 1) {
    cumulative += depthCounts[depth]
    if (cumulative >= Math.ceil(pieces * 0.95)) {
      p95Depth = depth
      break
    }
  }
  return {
    pieces,
    visiblePieces,
    tombstones: pieces - visiblePieces,
    storedLength,
    visibleLength,
    height,
    minimumHeight: pieces ? Math.ceil(Math.log2(pieces + 1)) : 0,
    heightOverLog2: pieces ? height / Math.log2(pieces + 1) : null,
    meanDepth: pieces ? depthSum / pieces : null,
    p95Depth: pieces ? p95Depth : null,
    meanVisibleDepth: visiblePieces ? visibleDepthSum / visiblePieces : null,
    meanTextDepth: visibleLength ? textDepthSum / visibleLength : null,
    depthCounts,
  }
}

export function measureBuffer(buffer) {
  if (buffer.snapshot) {
    const sequence = measureTree(buffer.snapshot.root)
    const reverse = measureTree(buffer.snapshot.reverseIndexRoot)
    assert.equal(sequence.pieces, buffer.snapshot.pieceCount, 'Snapshot piece count')
    assert.equal(sequence.visibleLength, buffer.length(), 'Snapshot visible length')
    for (const field of ['pieces', 'visiblePieces', 'storedLength', 'visibleLength']) {
      assert.equal(sequence[field], reverse[field], `Reverse-index ${field}`)
    }
    return { sequence, reverse }
  }
  assert(buffer.tree && 'root' in buffer.tree, 'Control root unavailable')
  const sequence = measureTree(buffer.tree.root)
  assert.equal(sequence.visibleLength, buffer.length(), 'Control visible length')
  return { sequence }
}
