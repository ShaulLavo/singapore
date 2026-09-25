import { describe, expect, test } from 'vitest'
import {
  anchorAt,
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  insertIntoPieceTable,
  materializePieceTableFullText,
  resolveAnchor,
  resolveAnchorLinear,
} from './index'
import { compactPieceTableTombstones } from './compaction'
import { validatePieceTreeInvariants } from './inspection'
import type { PieceTableEdit, PieceTableSnapshot, RealAnchor } from './pieceTableTypes'

const randomSource = (seed: number) => {
  let state = seed >>> 0
  return (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % limit
  }
}

const tokens = ['x', 'hello ', '\n', '😀', 'paste me in here ', 'ab\ncd', '\ud83d']

const expectValid = (snapshot: PieceTableSnapshot): void => {
  expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
}

const compact = (snapshot: PieceTableSnapshot) => {
  const result = compactPieceTableTombstones(snapshot)
  expect(result.unverified).toBe(0)
  return result
}

const churn = (snapshot: PieceTableSnapshot, at: number, text: string): PieceTableSnapshot =>
  deleteFromPieceTable(insertIntoPieceTable(snapshot, at, text), at, text.length)

describe('compacting a run of tombstones', () => {
  test('one paragraph replaced over and over leaves a bounded run', () => {
    let snapshot = createPieceTableSnapshot('prefix suffix')
    const anchors: RealAnchor[] = []
    for (let cycle = 0; cycle < 400; cycle++) {
      snapshot = insertIntoPieceTable(snapshot, 7, `paragraph ${cycle}\n`)
      anchors.push(anchorAt(snapshot, 9, 'left'), anchorAt(snapshot, 9, 'right'))
      snapshot = deleteFromPieceTable(snapshot, 7, `paragraph ${cycle}\n`.length)
    }
    const before = anchors.map((anchor) => resolveAnchor(snapshot, anchor))
    expect(snapshot.pieceCount).toBe(402)

    const result = compact(snapshot)
    expect(result.runs).toBe(1)
    expect(snapshot.pieceCount).toBeLessThanOrEqual(4)
    expect(anchors.map((anchor) => resolveAnchor(snapshot, anchor))).toEqual(before)
    expect(materializePieceTableFullText(snapshot)).toBe('prefix suffix')
    expectValid(snapshot)

    // New text in the gap still lands where bias says, for anchors of every age.
    const typed = insertIntoPieceTable(snapshot, 7, 'NEW')
    for (const [at, anchor] of anchors.entries()) {
      expect(resolveAnchor(typed, anchor)).toEqual({
        offset: at % 2 === 0 ? 7 : 10,
        liveness: 'deleted',
      })
    }
  })

  test('keeps the snapshot object, its text and every visible piece', () => {
    let snapshot = createPieceTableSnapshot('one two three four')
    for (let cycle = 0; cycle < 20; cycle++) snapshot = churn(snapshot, 4, 'abc')
    const identity = snapshot
    const length = snapshot.length
    compact(snapshot)
    expect(snapshot).toBe(identity)
    expect(snapshot.length).toBe(length)
    expect(materializePieceTableFullText(snapshot)).toBe('one two three four')
    expectValid(snapshot)
  })

  test('deleted original text keeps original offsets resolving', () => {
    let snapshot = createPieceTableSnapshot('0123456789abcdefghij')
    const anchors = [3, 4, 5, 6, 7, 8, 12].flatMap((at) => [
      anchorAt(snapshot, at, 'left'),
      anchorAt(snapshot, at, 'right'),
    ])
    snapshot = deleteFromPieceTable(snapshot, 3, 2)
    snapshot = insertIntoPieceTable(snapshot, 3, 'X')
    snapshot = deleteFromPieceTable(snapshot, 3, 1)
    snapshot = deleteFromPieceTable(snapshot, 3, 3)
    snapshot = insertIntoPieceTable(snapshot, 3, 'YY')
    snapshot = deleteFromPieceTable(snapshot, 3, 2)
    const before = anchors.map((anchor) => resolveAnchor(snapshot, anchor))
    compact(snapshot)
    expect(anchors.map((anchor) => resolveAnchor(snapshot, anchor))).toEqual(before)
    expectValid(snapshot)
  })
})

describe('compaction between edits', () => {
  test('order normalization next to stand-ins keeps their entries', () => {
    const build = () => {
      let snapshot = createPieceTableSnapshot('ab')
      for (let cycle = 0; cycle < 30; cycle++) snapshot = churn(snapshot, 1, `deleted ${cycle}`)
      return snapshot
    }
    let control = build()
    let candidate = build()
    const anchors = [0, 1, 2].flatMap((at) => [
      anchorAt(control, at, 'left'),
      anchorAt(control, at, 'right'),
    ])
    compact(candidate)
    // Inserting at one spot halves the same order gap until none is left.
    for (let edit = 0; edit < 200; edit++) {
      control = insertIntoPieceTable(control, 1, `${edit % 10}`)
      candidate = insertIntoPieceTable(candidate, 1, `${edit % 10}`)
      if (edit % 50 === 49) compact(candidate)
      anchors.push(anchorAt(control, 1 + (edit % 3), edit % 2 ? 'left' : 'right'))
    }
    for (const anchor of anchors) {
      expect(resolveAnchor(candidate, anchor)).toEqual(resolveAnchor(control, anchor))
    }
    expectValid(candidate)
  })

  test('a transient lineage edits a compacted snapshot by copying its nodes', () => {
    const options = { transient: true }
    let control = createPieceTableSnapshot('transient text here', options)
    let candidate = createPieceTableSnapshot('transient text here', options)
    const anchors: RealAnchor[] = []
    for (let cycle = 0; cycle < 60; cycle++) {
      control = insertIntoPieceTable(control, 10, `t${cycle}`)
      candidate = insertIntoPieceTable(candidate, 10, `t${cycle}`)
      anchors.push(anchorAt(control, 11, 'left'), anchorAt(control, 11, 'right'))
      control = deleteFromPieceTable(control, 10, `t${cycle}`.length)
      candidate = deleteFromPieceTable(candidate, 10, `t${cycle}`.length)
      if (cycle % 7 === 6) compact(candidate)
    }
    for (const anchor of anchors) {
      expect(resolveAnchor(candidate, anchor)).toEqual(resolveAnchor(control, anchor))
    }
    expectValid(candidate)
  })

  test('churn at several spots stays bounded by the spots, not the cycles', () => {
    let snapshot = createPieceTableSnapshot('alpha beta gamma delta epsilon\n'.repeat(8))
    const counts: number[] = []
    for (let cycle = 0; cycle < 2000; cycle++) {
      const at = [3, 40, 90, 150, 200][cycle % 5]!
      snapshot = churn(snapshot, at, cycle % 3 ? 'word ' : 'a whole line\n')
      if (cycle % 100 === 99) {
        compact(snapshot)
        counts.push(snapshot.pieceCount)
      }
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(counts[0]!)
    expect(Math.max(...counts)).toBeLessThan(40)
  })
})

type State = {
  readonly control: PieceTableSnapshot
  readonly candidate: PieceTableSnapshot
  readonly parent: State | null
}

type Held = { readonly anchor: RealAnchor; readonly origin: State }

const lineage = (state: State): Set<State> => {
  const states = new Set<State>()
  for (let at: State | null = state; at; at = at.parent) states.add(at)
  return states
}

const randomEdit = (
  random: (limit: number) => number,
  length: number,
  hot: number,
): PieceTableEdit[] => {
  const token = () => tokens[random(tokens.length)]!
  const kind = random(10)
  if (kind < 3) return [{ from: Math.min(hot, length), to: Math.min(hot, length), text: token() }]
  if (kind < 5) {
    const from = random(length + 1)
    return [{ from, to: from, text: token() }]
  }
  if (kind < 7) {
    const from = random(length + 1)
    return [{ from, to: Math.min(length, from + 1 + random(24)), text: '' }]
  }
  if (kind < 9) {
    const from = random(length + 1)
    return [{ from, to: Math.min(length, from + random(12)), text: token() }]
  }
  const first = random(length + 1)
  const second = Math.min(length, first + random(8))
  return [
    { from: first, to: first, text: token() },
    { from: second, to: Math.min(length, second + random(6)), text: random(2) ? token() : '' },
  ]
}

const expectSameResolution = (
  state: State,
  anchors: readonly Held[],
  label: string,
  linear: boolean,
): void => {
  for (const { anchor } of anchors) {
    const expected = resolveAnchor(state.control, anchor)
    expect(resolveAnchor(state.candidate, anchor), `${label} ${JSON.stringify(anchor)}`).toEqual(
      expected,
    )
    if (linear) {
      expect(resolveAnchorLinear(state.candidate, anchor), `${label} linear`).toEqual(expected)
    }
  }
}

// The candidate is compacted at random points, the control never. Both see the
// same edits, so every anchor must resolve alike in both after every step.
const runDifferential = (seed: number, steps: number, text: string): void => {
  const random = randomSource(seed)
  let state: State = {
    control: createPieceTableSnapshot(text),
    candidate: createPieceTableSnapshot(text),
    parent: null,
  }
  const history: State[] = [state]
  let anchors: Held[] = []
  let hot = 17
  for (let step = 1; step <= steps; step++) {
    for (let made = 0; made < 2; made++) {
      const at = random(state.control.length + 1)
      const bias = random(2) ? 'left' : 'right'
      const anchor = anchorAt(state.control, at, bias)
      expect(anchorAt(state.candidate, at, bias)).toEqual(anchor)
      anchors.push({ anchor, origin: state })
    }
    if (random(40) === 0) hot = random(state.control.length + 1)
    const edits = randomEdit(random, state.control.length, hot)
    state = {
      control: applyBatchToPieceTable(state.control, edits),
      candidate: applyBatchToPieceTable(state.candidate, edits),
      parent: state,
    }
    const label = `seed ${seed} step ${step} ${JSON.stringify(edits)}`
    expect(materializePieceTableFullText(state.candidate), label).toBe(
      materializePieceTableFullText(state.control),
    )
    if (random(6) === 0) compact(state.candidate)
    expectSameResolution(state, anchors, label, step % 20 === 0)
    history.push(state)

    // Undo to an older state and carry on from there. Anchors made on the
    // abandoned branch name buffers the new branch will number again.
    if (random(30) === 0) {
      state = history[random(history.length)]!
      if (random(2)) compact(state.candidate)
      const kept = lineage(state)
      anchors = anchors.filter((held) => kept.has(held.origin))
      expectSameResolution(state, anchors, `${label} after undo`, false)
    }
    if (anchors.length > 400) anchors = anchors.filter((_, at) => at % 2 === 0)
  }
  compact(state.candidate)
  expectSameResolution(state, anchors, `seed ${seed} final`, true)
  expectValid(state.candidate)
}

describe('deleted anchors against an uncompacted control', () => {
  test.each(Array.from({ length: 16 }, (_, at) => at + 1))(
    'resolve alike after every edit, seed %i',
    (seed) => runDifferential(seed, 400, 'const value = "original text";\n'.repeat(4)),
    60_000,
  )

  test.each([101, 102])(
    'resolve alike over a long surrogate-heavy session, seed %i',
    (seed) => runDifferential(seed, 1500, '😀 a\nb 😀'.repeat(12)),
    120_000,
  )
})
