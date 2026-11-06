import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from '../../packages/editor/node_modules/vitest/dist/index.js'
import { checkCoverage, describeCoverage, readCoverage, type Coverage } from './test-projects.ts'

let actual: Coverage
beforeAll(async () => {
  actual = await readCoverage()
  console.info(describeCoverage(actual))
}, 120_000)

test('ordinary CI owns every required project and file exactly once', () => {
  expect(checkCoverage(actual)).toEqual([])
})

test('TypeScript source-worker synchronization and parity have ordinary CI owners', () => {
  const required = actual.projects.filter(
    (project) => project.directory === 'packages/typescript-lsp',
  )
  expect(
    required.filter((project) => project.engine !== 'node').map((project) => project.engine),
  ).toEqual(['chromium', 'firefox', 'webkit'])
  expect(
    checkCoverage({
      ...actual,
      projects: required,
      invocations: actual.invocations.filter(
        (item) => item.directory === 'packages/typescript-lsp',
      ),
    }),
  ).toEqual([])
})

test('Tree-sitter document source sharing and restart files have one ordinary owner', () => {
  const projects = actual.projects.filter((project) => project.directory === 'packages/tree-sitter')
  expect(projects.flatMap((project) => project.files)).toContain(
    'test/document-runtime.browser.test.ts',
  )
  expect(projects.flatMap((project) => project.files)).toContain(
    'test/documentWork.browser.test.ts',
  )
  expect(
    checkCoverage({
      ...actual,
      projects,
      invocations: actual.invocations.filter((item) => item.directory === 'packages/tree-sitter'),
    }),
  ).toEqual([])
})

function fixture(): Coverage {
  return {
    projects: [
      {
        directory: 'package',
        config: 'vitest.config.ts',
        name: 'browser',
        engine: 'chromium',
        policy: { kind: 'required' },
        files: ['test/worker.browser.test.ts'],
      },
    ],
    invocations: [
      {
        owner: 'ci/packages/test',
        directory: 'package',
        config: 'vitest.config.ts',
        name: 'browser',
        engine: 'chromium',
        files: ['test/worker.browser.test.ts'],
      },
    ],
    errors: [],
    workflow: '',
  }
}

test('rejects an omitted required project', () => {
  const graph = fixture()
  graph.invocations = []
  expect(checkCoverage(graph).join('\n')).toContain('unowned')
})

test('rejects unknown project and engine selections', () => {
  const graph = fixture()
  graph.invocations[0].name = 'unknown'
  expect(checkCoverage(graph).join('\n')).toContain('unknown project')
  graph.invocations[0].name = 'browser'
  graph.invocations[0].engine = 'firefox'
  expect(checkCoverage(graph).join('\n')).toContain('unknown project')
})

test('rejects double ownership, including a nested aggregate and a direct invocation', () => {
  const graph = fixture()
  graph.invocations.push({ ...graph.invocations[0], owner: 'ci/packages/direct test:browser' })
  expect(checkCoverage(graph).join('\n')).toContain('2 owners')
})

test.each(['scheduled', 'diagnostic'] as const)(
  'keeps deliberate %s projects out of ordinary CI',
  (kind) => {
    const graph = fixture()
    graph.projects[0].policy = {
      kind,
      reason: 'Explicit separate qualification',
      owner: 'separate-workflow/test',
    }
    graph.invocations = []
    expect(checkCoverage(graph)).toEqual([])
    graph.invocations = fixture().invocations
    expect(checkCoverage(graph).join('\n')).toContain('not ordinary CI')
  },
)

test('rejects empty required projects and empty invocation selections', () => {
  const graph = fixture()
  graph.projects[0].files = []
  graph.invocations[0].files = []
  expect(checkCoverage(graph).join('\n')).toContain('empty')
})

test('source mutations cannot silently remove the TypeScript browser route', async () => {
  expect(actual.workflow).toContain(
    'bun run test:browser -- --concurrency=1 --filter=@singapore-editor/typescript-lsp',
  )
  const graph = await readCoverage({
    workflow: actual.workflow.replace(
      'bun run test:browser -- --concurrency=1 --filter=@singapore-editor/typescript-lsp',
      'echo omitted TypeScript browser tests',
    ),
  })
  expect(checkCoverage(graph).join('\n')).toContain('unowned')
}, 120_000)

test('adding a direct Tree-sitter call duplicates the real nested browser route', async () => {
  const workflow = actual.workflow.replace(
    '      - name: Test (no browser)',
    '      - name: Duplicate browser run\n        run: bun run --cwd packages/tree-sitter test:browser\n\n      - name: Test (no browser)',
  )
  const graph = await readCoverage({ workflow })
  expect(checkCoverage(graph).join('\n')).toContain('2 owners')
}, 120_000)

const treeScripts: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../packages/tree-sitter/package.json', import.meta.url), 'utf8'),
).scripts

test('removing an actual Tree-sitter browser filename fails admission', async () => {
  const script = treeScripts['test:browser'].replace(' test/documentWork.browser.test.ts', '')
  expect(script === treeScripts['test:browser']).toBe(false)
  const graph = await readCoverage({
    scripts: { 'packages/tree-sitter': { 'test:browser': script } },
  })
  expect(checkCoverage(graph).join('\n')).toContain(
    'unowned packages/tree-sitter/vitest.config.ts:chromium:chromium/test/documentWork.browser.test.ts',
  )
}, 120_000)

test('a duplicated nested browser script fails admission', async () => {
  const graph = await readCoverage({
    scripts: { 'packages/tree-sitter': { test: treeScripts.test + ' && bun run test:browser' } },
  })
  expect(checkCoverage(graph).join('\n')).toContain('2 owners')
}, 120_000)

test('unknown workspace selection fails closed', async () => {
  await expect(
    readCoverage({
      workflow: actual.workflow.replace(
        '--filter=@singapore-editor/core',
        '--filter=@singapore-editor/unknown',
      ),
    }),
  ).rejects.toThrow('Unknown workspace filter')
}, 120_000)

test('a group cannot become unfiltered or lose its serial package limit', async () => {
  const workflow = actual.workflow.replace(
    'bun run test:browser -- --concurrency=1 --filter=@singapore-editor/typescript-lsp',
    'bun run test:browser',
  )
  await expect(readCoverage({ workflow })).rejects.toThrow('explicitly select workspaces')
  await expect(
    readCoverage({ workflow: actual.workflow.replaceAll('--concurrency=1', '') }),
  ).rejects.toThrow('--concurrency=1')
}, 120_000)

test('unsupported test flags and recursive package scripts fail closed', async () => {
  await expect(
    readCoverage({
      workflow: actual.workflow.replace(
        '--filter=@singapore-editor/core',
        '--filter=@singapore-editor/core --only',
      ),
    }),
  ).rejects.toThrow('Unsupported Turbo test arguments')
  await expect(
    readCoverage({ scripts: { 'packages/tree-sitter': { 'test:browser': 'bun run test' } } }),
  ).rejects.toThrow('Recursive test script')
}, 120_000)

test('source-derived Firefox selection rejects the Chromium-only document-source file', () => {
  const firefox = actual.invocations.find(
    (item) => item.directory === 'packages/typescript-lsp' && item.engine === 'firefox',
  )
  expect(Boolean(firefox)).toBe(true)
  if (!firefox) return
  const invocations = actual.invocations.concat([
    { ...firefox, files: ['test/documentSource.browser.test.ts'] },
  ])
  expect(checkCoverage({ ...actual, invocations }).join('\n')).toContain(
    'unknown file/engine selection packages/typescript-lsp/vitest.browser.config.ts:firefox:firefox/test/documentSource.browser.test.ts',
  )
})

test('nested Bun forwarding cannot silently exclude a required browser file', async () => {
  const script = treeScripts.test.replace(
    'bun run test:browser',
    'bun run test:browser --exclude test/documentWork.browser.test.ts',
  )
  expect(script === treeScripts.test).toBe(false)
  await expect(
    readCoverage({ scripts: { 'packages/tree-sitter': { test: script } } }),
  ).rejects.toThrow('Unsupported nested test arguments')
}, 120_000)

test('Tree-sitter node discovery matches the real CLI and preserves dependency exclusions', async () => {
  expect(treeScripts.test.split(' && ')[0]).toBe("vitest run --exclude '**/*.browser.test.ts'")
  const directory = fileURLToPath(new URL('../../packages/tree-sitter/', import.meta.url))
  const scratch = mkdtempSync(resolve(tmpdir(), 'singapore-ci-cli-'))
  const output = resolve(scratch, 'files.json')
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--bun',
        resolve(directory, 'node_modules/vitest/vitest.mjs'),
        'list',
        '--exclude',
        '**/*.browser.test.ts',
        '--filesOnly',
        `--json=${output}`,
      ],
      { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    const listed: unknown = JSON.parse(readFileSync(output, 'utf8'))
    if (!Array.isArray(listed)) throw new Error('Expected a CLI file list')
    const files = listed
      .map((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !('file' in entry) ||
          typeof entry.file !== 'string'
        ) {
          throw new Error('Expected a CLI file entry')
        }
        return relative(directory, entry.file)
      })
      .sort()
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
    const project = actual.projects.find(
      (project) => project.directory === 'packages/tree-sitter' && project.engine === 'node',
    )
    expect(project?.files).toEqual(files)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 120_000)
