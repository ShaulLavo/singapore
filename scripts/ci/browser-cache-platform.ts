import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const expectedKey =
  'playwright-v2-${{ runner.os }}-${{ steps.playwright.outputs.platform }}-${{ steps.playwright.outputs.version }}-${{ github.job }}'
const platformOutput = 'platform=${ID}-${VERSION_ID}-${{ runner.arch }}'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}

function browserCaches(source: string): { job: string; run: string; key: string }[] {
  const jobs = record(record(Bun.YAML.parse(source)).jobs)
  return ['core', 'packages'].map((job) => {
    const steps = record(jobs[job]).steps
    assert.ok(Array.isArray(steps), `${job} must have steps`)
    const records = steps.map(record)
    const platformIndex = records.findIndex((step) => step.id === 'playwright')
    const cacheIndex = records.findIndex(
      (step) => record(step.with ?? {}).path === '~/.cache/ms-playwright',
    )
    assert.ok(
      platformIndex >= 0 && cacheIndex > platformIndex,
      `${job} must compute the platform before restoring browsers`,
    )
    const run = records[platformIndex].run
    assert.equal(typeof run, 'string')
    assert.ok(
      typeof run === 'string' && run.includes('. /etc/os-release'),
      `${job} must read the hosted distribution`,
    )
    assert.ok(
      run.includes(platformOutput),
      `${job} browser platform must include distribution ID, version and runner architecture`,
    )
    const cache = record(records[cacheIndex].with)
    assert.equal(
      cache.key,
      expectedKey,
      `${job} browser cache must use its distribution/architecture output`,
    )
    assert.equal(
      cache['restore-keys'],
      undefined,
      `${job} must not restore older or cross-distribution browser keys`,
    )
    return { job, run, key: expectedKey }
  })
}

function fixtureKey(
  cache: { job: string; run: string; key: string },
  directory: string,
  version: string,
  architecture: string,
): string {
  const osRelease = join(directory, `${cache.job}-${version}-${architecture}.release`)
  const output = `${osRelease}.output`
  writeFileSync(osRelease, `ID=ubuntu\nVERSION_ID=${version}\n`)
  const run = cache.run
    .replace('/etc/os-release', `'${osRelease}'`)
    .replaceAll('${{ runner.arch }}', architecture)
  execFileSync('bash', ['-euo', 'pipefail', '-c', run], {
    cwd: resolve(root, 'packages/editor'),
    env: { ...process.env, GITHUB_OUTPUT: output },
    stdio: 'pipe',
  })
  const values = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  )
  assert.equal(values.platform, `ubuntu-${version}-${architecture}`)
  assert.match(values.version, /^\d+\.\d+\.\d+$/)
  return cache.key
    .replaceAll('${{ runner.os }}', 'Linux')
    .replaceAll('${{ steps.playwright.outputs.platform }}', values.platform)
    .replaceAll('${{ steps.playwright.outputs.version }}', values.version)
    .replaceAll('${{ github.job }}', cache.job)
}

const caches = browserCaches(workflow)
assert.throws(() =>
  browserCaches(workflow.replaceAll(platformOutput, 'platform=${ID}-${{ runner.arch }}')),
)
assert.throws(() =>
  browserCaches(workflow.replaceAll(platformOutput, 'platform=${VERSION_ID}-${{ runner.arch }}')),
)
assert.throws(() =>
  browserCaches(workflow.replaceAll(platformOutput, 'platform=${ID}-${VERSION_ID}')),
)
assert.throws(() =>
  browserCaches(workflow.replaceAll('${{ steps.playwright.outputs.platform }}-', '')),
)
assert.throws(() =>
  browserCaches(
    workflow.replaceAll(
      '          key: playwright-v2-',
      '          restore-keys: playwright-Linux-\n          key: playwright-v2-',
    ),
  ),
)

const scratch = mkdtempSync(join(tmpdir(), 'sg-cache-'))
try {
  const keys = caches.flatMap((cache) =>
    ['24.04', '26.04'].flatMap((version) =>
      ['X64', 'ARM64'].map((architecture) => fixtureKey(cache, scratch, version, architecture)),
    ),
  )
  assert.equal(
    new Set(keys).size,
    8,
    'Every job/distribution/architecture combination needs a distinct browser cache',
  )
  console.log(keys.join('\n'))
  console.log(
    'Browser cache platform checks passed, including five source mutations and eight shell fixtures',
  )
} finally {
  rmSync(scratch, { recursive: true })
}
