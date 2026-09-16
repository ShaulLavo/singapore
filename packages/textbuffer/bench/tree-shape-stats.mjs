import assert from 'node:assert/strict'

// Depth counts real nodes: empty = 0, root = 1. Upstream NIL has a null piece.
export function measureTree(root) {
  const stack = root ? [[root, 1]] : []
  const seen = new Set()
  const depths = []
  let nodes = 0
  let tombstones = 0
  let totalDepth = 0
  let visibleDepth = 0
  let visibleLength = 0
  let height = 0
  while (stack.length) {
    const [node, depth] = stack.pop()
    if (!node?.piece) continue
    assert(!seen.has(node), 'Cycle or repeated child in tree')
    seen.add(node)
    nodes += 1
    totalDepth += depth
    depths[depth] = (depths[depth] ?? 0) + 1
    height = Math.max(height, depth)
    if (node.piece.visible === false) tombstones += 1
    else {
      visibleDepth += depth
      visibleLength += node.piece.length
    }
    if (node.left) stack.push([node.left, depth + 1])
    if (node.right) stack.push([node.right, depth + 1])
  }
  const visiblePieces = nodes - tombstones
  let cumulative = 0
  let p95Depth = 0
  for (let depth = 1; depth < depths.length; depth += 1) {
    cumulative += depths[depth] ?? 0
    if (cumulative >= Math.ceil(nodes * 0.95)) {
      p95Depth = depth
      break
    }
  }
  return {
    nodes,
    visiblePieces,
    tombstones,
    visibleLength,
    height,
    meanDepth: nodes ? totalDepth / nodes : 0,
    p95Depth,
    visiblePieceMeanDepth: visiblePieces ? visibleDepth / visiblePieces : 0,
    heightOverLog2: nodes ? height / Math.log2(nodes + 1) : null,
  }
}

export function checkpointAt(operation, count, every) {
  return operation === 0 || operation === count || operation % every === 0 ||
    (operation > 0 && Number.isInteger(Math.log2(operation)))
}

export function stressFixtures(count) {
  assert(Number.isSafeInteger(count) && count > 0, 'Positive edit count required')
  return ['prepend', 'fixed-offset-inserts', 'alternating-ends', 'hotspot-replacements'].map(
    (name) => {
      const initial = 'abc'
      let expected = initial
      const operations = []
      for (let index = 0; index < count; index += 1) {
        const from = name === 'prepend' ? 0 : name === 'alternating-ends'
          ? index % 2 ? expected.length : 0 : 1
        const to = name === 'hotspot-replacements' ? from + 1 : from
        const text = index % 2 ? 'x' : 'y'
        operations.push({ kind: 'edit', from, to, text })
        expected = expected.slice(0, from) + text + expected.slice(to)
      }
      return { name, initial, expected, operations, setup: [], mode: 'edit' }
    },
  )
}
