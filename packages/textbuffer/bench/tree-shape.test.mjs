import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkpointAt, measureTree, stressFixtures } from './tree-shape-stats.mjs'

const node = (left = null, right = null, visible = true, length = 1) => ({
  piece: { visible, length }, left, right,
})

test('empty trees and upstream cyclic NIL count as zero', () => {
  const nil = { piece: null }
  nil.left = nil
  nil.right = nil
  assert.equal(measureTree(null).height, 0)
  assert.equal(measureTree(nil).nodes, 0)
  assert.equal(measureTree(nil).heightOverLog2, null)
})

test('root has depth one; balanced tree has three levels', () => {
  assert.equal(measureTree(node()).height, 1)
  const stats = measureTree(node(node(node(), node()), node(node(), node())))
  assert.equal(stats.nodes, 7)
  assert.equal(stats.height, 3)
  assert.equal(stats.meanDepth, 17 / 7)
  assert.equal(stats.p95Depth, 3)
  assert.equal(stats.heightOverLog2, 1)
})

test('depth percentile uses the nearest rank across nodes', () => {
  let root = null
  for (let index = 0; index < 20; index += 1) root = node(root)
  const stats = measureTree(root)
  assert.equal(stats.height, 20)
  assert.equal(stats.p95Depth, 19)
  assert.equal(stats.meanDepth, 10.5)
})

test('tombstones count toward height and piece count', () => {
  const stats = measureTree(node(node(null, null, false, 9), node(null, null, true, 4)))
  assert.equal(stats.nodes, 3)
  assert.equal(stats.tombstones, 1)
  assert.equal(stats.visiblePieces, 2)
  assert.equal(stats.visibleLength, 5)
  assert.equal(stats.visiblePieceMeanDepth, 1.5)
  assert.equal(stats.height, 2)
})

test('iterative measurement handles a 20000-node chain', () => {
  let root = null
  for (let index = 0; index < 20000; index += 1) root = node(root)
  assert.equal(measureTree(root).height, 20000)
})

test('cycles and duplicate children fail explicitly', () => {
  const root = node()
  root.right = root
  assert.throws(() => measureTree(root), /Cycle/)
  const shared = node()
  assert.throws(() => measureTree(node(shared, shared)), /repeated child/)
})

test('checkpoints include initial, powers of two, interval and final', () => {
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => i).filter((i) => checkpointAt(i, 11, 5)),
    [0, 1, 2, 4, 5, 8, 10, 11],
  )
})

test('stress traces are deterministic and match their string oracle', () => {
  assert.deepEqual(stressFixtures(80), stressFixtures(80))
  for (const fixture of stressFixtures(80)) {
    let text = fixture.initial
    for (const op of fixture.operations) {
      assert(op.from >= 0 && op.to >= op.from && op.to <= text.length)
      text = text.slice(0, op.from) + op.text + text.slice(op.to)
    }
    assert.equal(text, fixture.expected)
    assert.equal(text.length, fixture.name === 'hotspot-replacements' ? 3 : 83)
  }
})
