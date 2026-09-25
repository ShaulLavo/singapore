// Tombstone compaction against an uncompacted control over many seeded sessions.
// Both apply the same edits; the candidate is compacted at random points, and
// every held anchor must resolve alike in both after every edit.
import {
  anchorAt,
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  materializePieceTableFullText,
  resolveAnchor,
  resolveAnchorLinear,
} from '../../packages/textbuffer/dist/index.js'
import { compactPieceTableTombstones } from '../../packages/textbuffer/dist/compaction.js'
import { validatePieceTreeInvariants } from '../../packages/textbuffer/dist/inspection.js'

const seeds = Number(process.argv[2] ?? 400)
const steps = Number(process.argv[3] ?? 800)
const tokens = ['x', 'hello ', '\n', '😀', 'paste me in here ', 'ab\ncd', '\ud83d', '\ude00']
const texts = [
  'const value = "original text";\n'.repeat(4),
  '😀 a\nb 😀'.repeat(12),
  '',
  'x',
  'line\n'.repeat(200),
]

function randomSource(seed) {
  let state = seed >>> 0
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % limit
  }
}

// `hot` edits repeat at one offset, which builds long runs and exhausts order gaps.
function randomEdits(random, length, hot, hotShare) {
  const token = () => tokens[random(tokens.length)]
  const kind = random(10)
  if (kind < hotShare)
    return [{ from: Math.min(hot, length), to: Math.min(hot, length), text: token() }]
  const from = random(length + 1)
  if (kind < 5) return [{ from, to: from, text: token() }]
  if (kind < 7)
    return [{ from, to: Math.min(length, from + 1 + random(random(4) ? 24 : 200)), text: '' }]
  if (kind < 9) return [{ from, to: Math.min(length, from + random(12)), text: token() }]
  const edits = []
  for (let at = from, count = 0; count < 1 + random(4) && at <= length; count++) {
    const to = Math.min(length, at + random(6))
    edits.push({ from: at, to, text: random(2) ? token() : '' })
    at = to + random(10)
  }
  return edits
}

function same(left, right) {
  return left.offset === right.offset && left.liveness === right.liveness
}

function lineage(state) {
  const states = new Set()
  for (let at = state; at; at = at.parent) states.add(at)
  return states
}

const totals = { seeds, steps, failures: [], compactions: 0, tombstones: 0, unverified: 0 }

function compact(snapshot) {
  const result = compactPieceTableTombstones(snapshot)
  totals.compactions++
  totals.tombstones += result.tombstones
  totals.unverified += result.unverified
}

function checkAnchors(state, anchors, step, linear) {
  for (const { anchor } of anchors) {
    const expected = resolveAnchor(state.control, anchor)
    if (!same(resolveAnchor(state.candidate, anchor), expected))
      throw new Error(`step ${step}: ${JSON.stringify(anchor)} resolves unlike the control`)
    if (linear && !same(resolveAnchorLinear(state.candidate, anchor), expected))
      throw new Error(`step ${step}: linear reference disagrees for ${JSON.stringify(anchor)}`)
  }
}

function runSeed(seed) {
  const random = randomSource(seed * 7919)
  const text = texts[seed % texts.length]
  const hotShare = random(5)
  let state = {
    control: createPieceTableSnapshot(text),
    candidate: createPieceTableSnapshot(text),
    parent: null,
  }
  const history = [state]
  let anchors = []
  let hot = 0
  for (let step = 1; step <= steps; step++) {
    for (let made = 0; made < 2; made++) {
      const at = random(state.control.length + 1)
      anchors.push({
        anchor: anchorAt(state.control, at, random(2) ? 'left' : 'right'),
        origin: state,
      })
    }
    if (random(40) === 0) hot = random(state.control.length + 1)
    const edits = randomEdits(random, state.control.length, hot, hotShare)
    state = {
      control: applyBatchToPieceTable(state.control, edits),
      candidate: applyBatchToPieceTable(state.candidate, edits),
      parent: state,
    }
    if (
      materializePieceTableFullText(state.candidate) !==
      materializePieceTableFullText(state.control)
    )
      throw new Error(`step ${step}: text differs`)
    if (random(5) === 0) compact(state.candidate)
    checkAnchors(state, anchors, step, step % 50 === 0)
    if (step % 50 === 0 && validatePieceTreeInvariants(state.candidate).issues.length > 0)
      throw new Error(`step ${step}: invariant issues`)
    history.push(state)
    if (random(30) === 0) {
      state = history[random(history.length)]
      if (random(2)) compact(state.candidate)
      const kept = lineage(state)
      anchors = anchors.filter((held) => kept.has(held.origin))
    }
    if (anchors.length > 300) anchors = anchors.filter((_, at) => at % 2 === 0)
  }
}

for (let seed = 1; seed <= seeds && totals.failures.length < 5; seed++) {
  try {
    runSeed(seed)
  } catch (error) {
    totals.failures.push({ seed, error: String(error) })
  }
}
console.log(
  JSON.stringify(
    { ...totals, runtime: `Node ${process.version}`, measuredAt: new Date().toISOString() },
    null,
    2,
  ),
)
if (totals.failures.length > 0 || totals.unverified > 0) process.exitCode = 1
