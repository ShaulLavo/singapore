import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const expectedKey =
  'playwright-v3-${{ runner.os }}-${{ steps.playwright.outputs.platform }}-${{ steps.playwright.outputs.editor }}-${{ steps.playwright.outputs.site }}'
const platformOutput = 'platform=${ID}-${VERSION_ID}-${{ runner.arch }}'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}

function platformCommand(source: string): string {
  const jobs = record(record(Bun.YAML.parse(source)).jobs)
  const steps = record(jobs.ci).steps
  assert.ok(Array.isArray(steps), 'CI must have steps')
  const records = steps.map(record)
  const platformIndex = records.findIndex((step) => step.id === 'playwright')
  const cacheIndex = records.findIndex(
    (step) => record(step.with ?? {}).path === '~/.cache/ms-playwright',
  )
  assert.ok(
    platformIndex >= 0 && cacheIndex > platformIndex,
    'CI must compute the platform before restoring browsers',
  )
  const run = records[platformIndex].run
  assert.ok(typeof run === 'string' && run.includes('. /etc/os-release'))
  assert.ok(
    run.includes(platformOutput),
    'Browser platform must include distro, version and architecture',
  )
  const cache = record(records[cacheIndex].with)
  assert.equal(
    cache.key,
    expectedKey,
    'Browser cache must use the platform and both Playwright versions',
  )
  assert.equal(cache['restore-keys'], undefined, 'Browser cache requires an exact key match')
  return run
}

function fixtureKey(
  command: string,
  directory: string,
  version: string,
  architecture: string,
): string {
  const osRelease = join(directory, `${version}-${architecture}.release`)
  const output = `${osRelease}.output`
  writeFileSync(osRelease, `ID=ubuntu\nVERSION_ID=${version}\n`)
  const run = command
    .replace('/etc/os-release', `'${osRelease}'`)
    .replaceAll('${{ runner.arch }}', architecture)
  execFileSync('bash', ['-euo', 'pipefail', '-c', run], {
    cwd: root,
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
  assert.match(values.editor, /^\d+\.\d+\.\d+$/)
  assert.match(values.site, /^\d+\.\d+\.\d+$/)
  return expectedKey
    .replaceAll('${{ runner.os }}', 'Linux')
    .replaceAll('${{ steps.playwright.outputs.platform }}', values.platform)
    .replaceAll('${{ steps.playwright.outputs.editor }}', values.editor)
    .replaceAll('${{ steps.playwright.outputs.site }}', values.site)
}

const command = platformCommand(workflow)
assert.throws(() =>
  platformCommand(workflow.replaceAll(platformOutput, 'platform=${ID}-${{ runner.arch }}')),
)
assert.throws(() =>
  platformCommand(workflow.replaceAll(platformOutput, 'platform=${VERSION_ID}-${{ runner.arch }}')),
)
assert.throws(() =>
  platformCommand(workflow.replaceAll(platformOutput, 'platform=${ID}-${VERSION_ID}')),
)
for (const output of ['platform', 'editor', 'site']) {
  assert.throws(() =>
    platformCommand(workflow.replace('-${{ steps.playwright.outputs.' + output + ' }}', '')),
  )
}
assert.throws(() =>
  platformCommand(
    workflow.replace(
      '          key: playwright-v3-',
      '          restore-keys: playwright-Linux-\n          key: playwright-v3-',
    ),
  ),
)

const scratch = mkdtempSync(join(tmpdir(), 'sg-cache-'))
try {
  const keys = ['24.04', '26.04'].flatMap((version) =>
    ['X64', 'ARM64'].map((architecture) => fixtureKey(command, scratch, version, architecture)),
  )
  assert.equal(
    new Set(keys).size,
    4,
    'Every distribution and architecture combination needs a distinct browser cache',
  )
  console.log(keys.join('\n'))
  console.log(
    'Browser cache platform checks passed, including seven source mutations and four shell fixtures',
  )
} finally {
  rmSync(scratch, { recursive: true })
}
