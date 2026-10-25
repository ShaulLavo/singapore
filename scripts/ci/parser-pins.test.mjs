import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { publishPins } from './parser-pins.mjs'

function githubFixture() {
  const data = JSON.parse(
    readFileSync(new URL('./fixtures/parser-pins.json', import.meta.url), 'utf8'),
  )
  const state = { ...data, pulls: [], writes: [], reads: [] }
  const api = {
    pages: async (endpoint) => {
      state.reads.push(endpoint)
      const url = new URL(`https://fixture.invalid/${endpoint}`)
      assert.equal(url.pathname, '/pulls')
      const head = url.searchParams.get('head')
      return state.pulls.filter(
        (pull) =>
          pull.state === 'open' && `${state.repository.split('/')[0]}:${pull.head.ref}` === head,
      )
    },
    write: async (endpoint, method, body) => {
      state.writes.push({ endpoint, method, body })
      if (endpoint === 'pulls') {
        const number = Math.max(41, ...state.pulls.map((pull) => pull.number)) + 1
        const pull = {
          ...structuredClone(state.pull),
          ...body,
          number,
          base: structuredClone(state.pull.base),
          head: { ...state.pull.head, ref: body.head },
        }
        state.pulls.push(pull)
        return { number }
      }
      assert.equal(method, 'PATCH')
      const pull = state.pulls.find((pull) => endpoint === `pulls/${pull.number}`)
      assert.ok(pull)
      Object.assign(pull, body)
      return pull
    },
  }
  return { state, api }
}

function publicationFixture() {
  let root
  onTestFinished(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })
  root = mkdtempSync(path.join(tmpdir(), 'parser-pin-publish-'))
  const directory = path.join(root, 'checkout')
  mkdirSync(directory)
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null'].concat(args), {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  git('init', '--bare', '-q', path.join(root, 'origin.git'))
  git('init', '-b', 'main', '-q')
  git('config', 'user.name', 'fixture')
  git('config', 'user.email', 'fixture@example.com')
  git('remote', 'add', 'origin', path.join(root, 'origin.git'))
  const manifest = 'packages/tree-sitter/package.json'
  mkdirSync(path.dirname(path.join(directory, manifest)), { recursive: true })
  const before = JSON.stringify({
    dependencies: {
      'web-tree-sitter': `github:ShaulLavo/tree-sitter-x#${'0'.repeat(40)}`,
      'tree-sitter-md': `github:ShaulLavo/tree-sitter-md#${'0'.repeat(40)}`,
    },
  })
  writeFileSync(path.join(directory, manifest), before)
  const secondary = path.join(directory, 'packages/other/package.json')
  mkdirSync(path.dirname(secondary), { recursive: true })
  writeFileSync(secondary, before)
  git('add', '.')
  git('commit', '-qm', 'initial')
  const base = git('rev-parse', 'HEAD')
  const metadata = { base, runtime: 'a'.repeat(40), markdown: 'b'.repeat(40) }
  const updated = before
    .replace(/tree-sitter-x#0{40}/g, `tree-sitter-x#${metadata.runtime}`)
    .replace(/tree-sitter-md#0{40}/g, `tree-sitter-md#${metadata.markdown}`)
  writeFileSync(path.join(directory, manifest), updated)
  const patch = `${git('diff')}\n`
  writeFileSync(path.join(directory, manifest), before)
  const fixture = githubFixture()
  const publish = (options = {}) =>
    publishPins({
      api: fixture.api,
      repository: fixture.state.repository,
      directory,
      patch,
      metadata,
      ...options,
    })
  return { ...fixture, root, directory, git, metadata, patch, publish, manifest, before }
}

function nextUpdate(fixture, runtime = 'd'.repeat(40), markdown = 'e'.repeat(40)) {
  const before = fixture.git('show', `HEAD:${fixture.manifest}`)
  const updated = before
    .replace(/tree-sitter-x#[0-9a-f]{40}/g, `tree-sitter-x#${runtime}`)
    .replace(/tree-sitter-md#[0-9a-f]{40}/g, `tree-sitter-md#${markdown}`)
  writeFileSync(path.join(fixture.directory, fixture.manifest), updated)
  const patch = `${fixture.git('diff')}\n`
  writeFileSync(path.join(fixture.directory, fixture.manifest), before)
  return { patch, metadata: { base: fixture.git('rev-parse', 'HEAD'), runtime, markdown } }
}

test('same and newer pins reuse one PR and fast-forward its branch', async () => {
  const fixture = publicationFixture()
  const first = await fixture.publish()
  expect(first.branch).toBe('tree-sitter-x/updates')
  expect(await fixture.publish()).toEqual(first)
  const updated = await fixture.publish(nextUpdate(fixture))
  expect(updated.number).toBe(first.number)
  expect(updated.head).not.toBe(first.head)
  expect(fixture.git('merge-base', first.head, updated.head)).toBe(first.head)
  expect(fixture.state.pulls).toHaveLength(1)
})

test('a main change is included while the rolling branch stays fast-forward', async () => {
  const fixture = publicationFixture()
  const first = await fixture.publish()
  writeFileSync(path.join(fixture.directory, 'main.txt'), 'new main content')
  fixture.git('add', 'main.txt')
  fixture.git('commit', '-qm', 'advance main')
  const updated = await fixture.publish(nextUpdate(fixture))
  expect(fixture.git('show', `${updated.head}:main.txt`)).toBe('new main content')
  expect(fixture.git('merge-base', first.head, updated.head)).toBe(first.head)
  expect(updated.number).toBe(first.number)
})

test.each([false, true])(
  'updates after manual squash merge with deleted branch %s',
  async (deleted) => {
    const fixture = publicationFixture()
    const first = await fixture.publish()
    fixture.git('merge', '--squash', first.head)
    fixture.git('commit', '-qm', 'manually merge update')
    fixture.state.pulls[0].state = 'closed'
    if (deleted) fixture.git('push', '-q', 'origin', '--delete', first.branch)
    const updated = await fixture.publish(nextUpdate(fixture))
    expect(updated.number).not.toBe(first.number)
    expect(fixture.state.pulls.filter((pull) => pull.state === 'open')).toHaveLength(1)
  },
)

test('an empty update creates no PR or branch', async () => {
  const fixture = publicationFixture()
  expect(await fixture.publish({ patch: '' })).toBeNull()
  expect(fixture.state.writes).toEqual([])
  expect(fixture.git('ls-remote', 'origin')).toBe('')
})

test('a generated patch cannot change manifest scripts', async () => {
  const fixture = publicationFixture()
  const manifest = path.join(fixture.directory, fixture.manifest)
  const changed = JSON.parse(fixture.before)
  changed.scripts = { test: 'untrusted-command' }
  writeFileSync(manifest, JSON.stringify(changed))
  const patch = `${fixture.git('diff')}\n`
  writeFileSync(manifest, fixture.before)
  await expect(
    publishPins({
      api: fixture.api,
      repository: fixture.state.repository,
      directory: fixture.directory,
      patch,
      metadata: fixture.metadata,
    }),
  ).rejects.toThrow('Manifest edits must contain only parser pin replacements')
  expect(fixture.state.writes).toEqual([])
})

test.each(['tree-sitter-x', 'tree-sitter-md'])('rejects a different %s pin', async (parser) => {
  const fixture = publicationFixture()
  const secondary = path.join(fixture.directory, 'packages/other/package.json')
  const changed = fixture.before
    .replace(/tree-sitter-x#0{40}/g, `tree-sitter-x#${fixture.metadata.runtime}`)
    .replace(/tree-sitter-md#0{40}/g, `tree-sitter-md#${fixture.metadata.markdown}`)
  writeFileSync(
    secondary,
    changed.replace(
      `${parser}#${parser === 'tree-sitter-x' ? fixture.metadata.runtime : fixture.metadata.markdown}`,
      `${parser}#${'c'.repeat(40)}`,
    ),
  )
  await expect(
    publishPins({
      api: fixture.api,
      repository: fixture.state.repository,
      directory: fixture.directory,
      patch: `${fixture.git('diff')}\n`,
      metadata: fixture.metadata,
    }),
  ).rejects.toThrow('exact metadata SHAs')
})

test('all changed package manifests accept the exact metadata pins', async () => {
  const fixture = publicationFixture()
  const changed = fixture.before
    .replace(/tree-sitter-x#0{40}/g, `tree-sitter-x#${fixture.metadata.runtime}`)
    .replace(/tree-sitter-md#0{40}/g, `tree-sitter-md#${fixture.metadata.markdown}`)
  for (const manifest of [fixture.manifest, 'packages/other/package.json'])
    writeFileSync(path.join(fixture.directory, manifest), changed)
  const result = await publishPins({
    api: fixture.api,
    repository: fixture.state.repository,
    directory: fixture.directory,
    patch: `${fixture.git('diff')}\n`,
    metadata: fixture.metadata,
  })
  expect(result.number).toBe(42)
})
