import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createPieceTableSnapshot } from '@singapore-editor/textbuffer'
import { applyOperation, loadAdapter } from './adapters.mjs'
import { applyOracle, makeFixtures, profiles } from './fixtures.mjs'
import { benchRoot, fileHashes, packageRoot, pin, sha256, upstreamRoot } from './support.mjs'
import { checkpointAt, measureTree, stressFixtures } from './tree-shape-stats.mjs'

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'standard' }, seed: { type: 'string', default: '20260916' },
  'priority-seeds': { type: 'string', default: '0,1,7,42,20260916' }, every: { type: 'string', default: '25' },
  'stress-edits': { type: 'string' }, out: { type: 'string' },
} })
const config = profiles[values.profile]
assert(config, 'Choose --profile smoke or standard')
function integer(value, min, max, label) {
  assert(/^\d+$/.test(value ?? ''), `Invalid ${label}`)
  const number = Number(value)
  assert(Number.isSafeInteger(number) && number >= min && number <= max, `Invalid ${label}`)
  return number
}
const fixtureSeed = integer(values.seed, 0, 0xffffffff, 'fixture seed')
const prioritySeeds = values['priority-seeds'].split(',').map((value) => integer(value, 0, 0xffffffff, 'priority seed'))
assert.equal(new Set(prioritySeeds).size, prioritySeeds.length, 'Priority seeds must be unique')
const every = integer(values.every, 1, 1000000, 'checkpoint interval')
const stressEdits = values['stress-edits'] === undefined ? config.edits : integer(values['stress-edits'], 1, 1000000, 'stress edit count')
const destination = path.resolve(values.out ?? path.join(benchRoot, 'results', 'tree-shape'))
mkdirSync(destination, { recursive: true })
const fixtures = makeFixtures(values.profile, fixtureSeed).filter((item) => item.mode === 'edit')
fixtures.push(...stressFixtures(stressEdits))
const adapters = { singapore: await loadAdapter('singapore'), vscode: await loadAdapter('vscode') }
const rows = []
const runs = []
const git = (args) => execFileSync('git', args, { cwd: packageRoot, encoding: 'utf8' }).trim()
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), measurement: 'separate structural replay',
  depthConvention: 'real nodes on path; empty 0; root 1; upstream NIL excluded', profile: values.profile,
  fixtureSeed, prioritySeeds, every, stressEdits,
  provenance: {
    commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0,
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    sourceSha256: fileHashes(path.join(packageRoot, 'src'), (file) => !file.endsWith('.test.ts')),
    buildSha256: fileHashes(path.join(packageRoot, 'dist')),
    harnessSha256: fileHashes(benchRoot, (file) => /\.(mjs|py|json)$/.test(file)),
    upstream: JSON.parse(readFileSync(path.join(upstreamRoot, 'build.json'), 'utf8')),
  },
  fixtures: fixtures.map((fixture) => ({ name: fixture.name, operations: fixture.operations.length,
    initialLength: fixture.initial.length, finalLength: fixture.expected.length, traceSha256: sha256(JSON.stringify(fixture)) })),
  rows, runs,
}
assert.equal(report.provenance.upstream.commit, pin.commit, 'Run bench/prepare.mjs first')
function sample(buffer, expected, run, operation) {
  assert.equal(buffer.full(), expected, 'Checkpoint text differs from string oracle')
  const roots = run.engine === 'singapore'
    ? [['sequence', buffer.snapshot.root], ['reverse', buffer.snapshot.reverseIndexRoot]]
    : [['red-black', buffer.tree.root]]
  const measured = roots.map(([tree, root]) => {
    const metrics = measureTree(root)
    assert.equal(metrics.visibleLength, expected.length, 'Tree visible length differs')
    rows.push({ workload: run.workload, engine: run.engine, prioritySeed: run.prioritySeed, operation, tree, ...metrics })
    return metrics
  })
  if (run.engine === 'singapore') {
    assert.equal(measured[0].nodes, buffer.snapshot.pieceCount)
    assert.equal(measured[0].nodes, measured[1].nodes)
    assert.equal(measured[0].tombstones, measured[1].tombstones)
  }
}
for (const fixture of fixtures) {
  const variants = prioritySeeds.map((prioritySeed) => ({ engine: 'singapore', prioritySeed }))
  variants.push({ engine: 'vscode', prioritySeed: null })
  for (const variant of variants) {
    const run = { workload: fixture.name, status: 'running', applied: 0, ...variant }
    runs.push(run)
    try {
      const buffer = variant.engine === 'singapore'
        ? adapters.singapore.restore(createPieceTableSnapshot(fixture.initial, { prioritySeed: variant.prioritySeed }))
        : adapters.vscode.create(fixture.initial)
      const retained = []
      let expected = fixture.initial
      sample(buffer, expected, run, 0)
      for (let index = 0; index < fixture.operations.length; index += 1) {
        if (variant.engine === 'singapore' && index % Math.max(1, config.edits) === 0)
          retained.push({ snapshot: buffer.retain(), text: expected })
        applyOperation(buffer, fixture.operations[index])
        expected = applyOracle(expected, fixture.operations[index])
        run.applied = index + 1
        if (checkpointAt(run.applied, fixture.operations.length, every)) sample(buffer, expected, run, run.applied)
      }
      assert.equal(expected, fixture.expected)
      assert.deepEqual(buffer.issues(), [])
      for (const old of retained) assert.equal(adapters.singapore.retainedText(old.snapshot), old.text)
      run.status = 'passed'
    } catch (error) {
      run.status = 'failed'
      run.error = String(error.stack ?? error)
    }
    console.log(`${fixture.name} ${variant.engine} seed=${variant.prioritySeed}: ${run.status}`)
  }
}
writeFileSync(path.join(destination, 'tree-shape.json'), JSON.stringify(report, null, 2) + '\n')
const summary = ['# Tree shape', '', `Revision: \`${report.provenance.commit}\`. Profile: ${report.profile}.`,
  `Fixture seed: ${fixtureSeed}. Priority seeds: ${prioritySeeds.join(', ')}.`, '',
  'Height counts nodes: root = 1, empty = 0. P counts stored pieces, including tombstones.',
  'Each row below is one run at its final checkpoint. Failures are listed separately.', '',
  '| Workload | Tree | Priority seed | P | Tombstones | Height | Mean depth | p95 depth | H/log2(P+1) |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for (const run of runs.filter((item) => item.status === 'passed')) {
  const final = rows.filter((row) => row.workload === run.workload && row.engine === run.engine && row.prioritySeed === run.prioritySeed && row.operation === run.applied)
  for (const row of final) summary.push(`| ${row.workload} | ${row.tree} | ${row.prioritySeed ?? 'n/a'} | ${row.nodes} | ${row.tombstones} | ${row.height} | ${row.meanDepth.toFixed(2)} | ${row.p95Depth} | ${row.heightOverLog2?.toFixed(2) ?? 'n/a'} |`)
}
const failures = runs.filter((run) => run.status === 'failed')
for (const run of failures) summary.push('', `Failed: ${run.workload}, ${run.engine}, seed ${run.prioritySeed}, after ${run.applied} operations.`, '```text', run.error, '```')
writeFileSync(path.join(destination, 'report.md'), summary.join('\n') + '\n')
console.log(`${runs.length} runs; ${rows.length} tree checkpoints; ${failures.length} failures`)
if (failures.length) process.exitCode = 1
