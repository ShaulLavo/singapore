import assert from 'node:assert/strict'

export function treeShape(root) {
  if (!root?.piece) return { nodes: 0, visible: 0, invisible: 0, maxDepth: 0, meanDepth: 0, p95Depth: 0 }

  let nodes = 0
  let visible = 0
  let invisible = 0
  let maxDepth = 0
  let depthTotal = 0
  const depths = []
  const stack = [[root, 1]]

  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (!node?.piece) continue
    nodes += 1
    if (node.piece.visible === false) invisible += 1
    else visible += 1
    maxDepth = Math.max(maxDepth, depth)
    depthTotal += depth
    depths.push(depth)
    if (node.left?.piece) stack.push([node.left, depth + 1])
    if (node.right?.piece) stack.push([node.right, depth + 1])
  }

  depths.sort((a, b) => a - b)
  return {
    nodes,
    visible,
    invisible,
    maxDepth,
    meanDepth: depthTotal / nodes,
    p95Depth: depths[Math.ceil(depths.length * 0.95) - 1],
  }
}

export function logarithmicReference(nodes) {
  return Math.log2(nodes + 1)
}

export function normalizedHeight(shape) {
  const reference = logarithmicReference(shape.nodes)
  return reference === 0 ? 0 : shape.maxDepth / reference
}

export function checkpointIndexes(operationCount, requested = 64) {
  assert(Number.isSafeInteger(operationCount) && operationCount >= 0)
  assert(Number.isSafeInteger(requested) && requested > 0)
  if (operationCount === 0) return [0]
  const indexes = new Set([0, operationCount])
  for (let index = 1; index < requested; index += 1)
    indexes.add(Math.round((operationCount * index) / requested))
  return [...indexes].sort((a, b) => a - b)
}

export function shapePoint(engine, workload, seed, operation, shape, extra = {}) {
  return {
    engine,
    workload,
    seed,
    operation,
    pieces: shape.nodes,
    visiblePieces: shape.visible,
    tombstones: shape.invisible,
    maxDepth: shape.maxDepth,
    meanDepth: shape.meanDepth,
    p95Depth: shape.p95Depth,
    log2Pieces: logarithmicReference(shape.nodes),
    normalizedHeight: normalizedHeight(shape),
    ...extra,
  }
}
