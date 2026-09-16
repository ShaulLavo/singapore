import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// One-shot, guarded migration. All transformations are validated before any source is written.
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const packagePath = 'packages/textbuffer'
const sourcePath = 'packages/editor/src/pieceTable'
assert(!existsSync(path.join(root, packagePath)), 'packages/textbuffer already exists; refusing to overwrite it')
const read = (name) => readFileSync(path.join(root, name), 'utf8')
const writes = new Map()
const deletions = []
const json = (value) => JSON.stringify(value, null, 2) + '\n'

const guardedFiles = {
  'packages/editor/src/pieceTable/buffers.ts': '0803ca6f5aaa95c069f98fdda5504231ceb52182',
  'packages/editor/src/pieceTable/pieceTableTypes.ts': '006528b0c079cb286de614d2e31ab9073d4af5ec',
  'packages/editor/src/documentTextSnapshot.ts': '2f69b1c3c6c4bbf9575d283fb0dceadb4cb4b542',
  'packages/editor/src/editor/performanceDiagnostics.ts': '0fb33bc334b1de5ef46936e8e3767fecc7215ce6',
  'packages/editor/src/textMeasurements.test.ts': 'f8d5df2d4d645caae69813bf6b0b9ec0b16e90c3',
}
for (const [name, expected] of Object.entries(guardedFiles)) {
  const bytes = readFileSync(path.join(root, name))
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.equal(actual, expected, `${name} changed since the extraction was reviewed`)
}

function replaceOnce(text, before, after, label) {
  assert.equal(text.split(before).length, 2, `Expected exactly one ${label}`)
  return text.replace(before, after)
}

const files = readdirSync(path.join(root, sourcePath)).sort()
assert.equal(files.length, 23, 'Piece-table file inventory changed; review the migration')
for (const name of files) {
  assert(name.endsWith('.ts'), `Unexpected source entry: ${name}`)
  let source = read(`${sourcePath}/${name}`)
  if (name === 'pieceTableTypes.ts') {
    source = replaceOnce(source, "import type { TextSourceIndex } from '../textMeasurements'\n", '', 'measurement type import')
    source = replaceOnce(source, '  readonly textIndexes: Map<PieceBufferId, TextSourceIndex>\n',
      '  // Shared across this document lineage, including divergent persistent versions.\n  // Hosts can key WeakMap sidecars by this identity without putting UI caches in storage.\n  readonly identity: object\n', 'measurement cache field')
  }
  if (name === 'buffers.ts') {
    source = replaceOnce(source, "import { recordEditorPerformanceDiagnostic } from '../editor/performanceDiagnostics'",
      "import { recordTextBufferDiagnostic } from './diagnostics'", 'diagnostic import')
    source = replaceOnce(source, "recordEditorPerformanceDiagnostic('textSnapshot.sourceIndex',",
      "recordTextBufferDiagnostic('sourceIndex',", 'diagnostic call')
    source = replaceOnce(source, '    textIndexes: new Map(),', '    identity: {},', 'lineage initialization')
  }
  writes.set(`${packagePath}/src/${name}`, source)
  if (name.endsWith('.test.ts')) {
    deletions.push(`${sourcePath}/${name}`)
  } else {
    const target = name === 'index.ts' ? '@singapore-editor/textbuffer' : `@singapore-editor/textbuffer/internal/${name.slice(0, -3)}`
    writes.set(`${sourcePath}/${name}`, `// Transitional import path; the implementation lives in the textbuffer package.\nexport * from '${target}'\n`)
  }
}

writes.set(`${packagePath}/src/diagnostics.ts`, `/** A lazy, opt-in diagnostic bridge. The standalone buffer has no default sink. */
export type TextBufferDiagnosticSink = (
  name: 'sourceIndex',
  detail: () => Readonly<Record<string, unknown>>,
) => void

let diagnosticSink: TextBufferDiagnosticSink | undefined

export function setTextBufferDiagnosticSink(sink: TextBufferDiagnosticSink | undefined): void {
  diagnosticSink = sink
}

export function recordTextBufferDiagnostic(
  name: 'sourceIndex',
  detail: () => Readonly<Record<string, unknown>>,
): void {
  diagnosticSink?.(name, detail)
}
`)

writes.set(`${packagePath}/src/debug.ts`, `// Opt-in inspection; this module is not reachable from the main entry point.
export { debugPieceTable } from './pieceTable'
export type { PieceBufferId, PieceTableSnapshot } from './pieceTableTypes'
export { validatePieceTreeInvariants } from './inspection'
export type { PieceTreeIssue, PieceTreeIssueKind, PieceTreeValidation } from './inspection'
export { createPieceTreeInspectionSession } from './inspectionSession'
export type {
  PieceInspectionNode, PieceTreeInspection, PieceNodeChange, PieceTreeComparison,
  PieceInspectionOptions,
} from './inspectionSession'
export { formatPieceTree, formatPieceTreeInspection, formatPieceInspectionNode } from './inspectionFormat'
`)

writes.set(`${packagePath}/src/index.ts`, writes.get(`${packagePath}/src/index.ts`) + `
export type { CreatePieceTableSnapshotOptions } from './snapshot'
export type { PieceTableBufferOptions } from './buffers'
export { snapBatchEditRanges } from './edits'
`)

writes.set('packages/editor/src/documentTextSourceCache.ts', `import type { PieceBufferId, PieceTableBuffers } from './pieceTable/pieceTableTypes'
import { TextSourceIndex } from './textMeasurements'

// One cache per document lineage, not per version. Editing and undo keep reuse intact.
const sourceIndexes = new WeakMap<object, Map<PieceBufferId, TextSourceIndex>>()

export function getDocumentTextSourceIndex(
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  text: string,
): TextSourceIndex {
  let indexes = sourceIndexes.get(buffers.identity)
  if (!indexes) {
    indexes = new Map()
    sourceIndexes.set(buffers.identity, indexes)
  }
  let source = indexes.get(buffer)
  // Undo branches may reuse a buffer ID for different text. Retained ranges keep the old index.
  if (source?.text !== text) {
    source = new TextSourceIndex(text)
    indexes.set(buffer, source)
  }
  return source
}
`)

let document = read('packages/editor/src/documentTextSnapshot.ts')
document = "import { getDocumentTextSourceIndex } from './documentTextSourceCache'\n" + document
document = replaceOnce(document, `    let source = snapshot.buffers.textIndexes.get(buffer)
    // Undo can reuse an ID for different text; retained ranges keep their immutable old index.
    if (source?.text !== text) {
      source = new TextSourceIndex(text)
      snapshot.buffers.textIndexes.set(buffer, source)
    }`, '    const source = getDocumentTextSourceIndex(snapshot.buffers, buffer, text)', 'document measurement cache')
writes.set('packages/editor/src/documentTextSnapshot.ts', document)

let measurementsTest = read('packages/editor/src/textMeasurements.test.ts')
measurementsTest = "import { getDocumentTextSourceIndex } from './documentTextSourceCache'\n" + measurementsTest
measurementsTest = replaceOnce(measurementsTest, `    const source = buffer
      .getSnapshot()
      .buffers.textIndexes.get(buffer.getSnapshot().buffers.original)`, `    const source = getDocumentTextSourceIndex(
      buffer.getSnapshot().buffers,
      buffer.getSnapshot().buffers.original,
      original,
    )`, 'first source identity assertion')
measurementsTest = replaceOnce(measurementsTest,
  '      buffer.getSnapshot().buffers.textIndexes.get(buffer.getSnapshot().buffers.original),',
  `      getDocumentTextSourceIndex(
        buffer.getSnapshot().buffers,
        buffer.getSnapshot().buffers.original,
        original,
      ),`, 'retained source identity assertion')
writes.set('packages/editor/src/textMeasurements.test.ts', measurementsTest)

const diagnosticsPath = 'packages/editor/src/editor/performanceDiagnostics.ts'
writes.set(diagnosticsPath,
  "import { setTextBufferDiagnosticSink } from '@singapore-editor/textbuffer/diagnostics'\n\n" + read(diagnosticsPath) + `
// Adapt storage diagnostics here; the storage package never imports editor modules.
setTextBufferDiagnosticSink((name, detail) => {
  recordEditorPerformanceDiagnostic('textSnapshot.' + name, detail)
})
`)

const editorManifest = JSON.parse(read('packages/editor/package.json'))
assert(!editorManifest.dependencies['@singapore-editor/textbuffer'], 'Textbuffer dependency already exists')
editorManifest.dependencies['@singapore-editor/textbuffer'] = 'workspace:*'
writes.set('packages/editor/package.json', json(editorManifest))

const runtimeExport = (name) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js`, default: `./dist/${name}.js` })
writes.set(`${packagePath}/package.json`, json({
  name: '@singapore-editor/textbuffer', version: '0.1.0', type: 'module', sideEffects: false,
  description: 'Persistent treap-backed text buffer with snapshots, stable anchors, and line mapping',
  files: ['dist', 'README.md'],
  exports: { '.': runtimeExport('index'), './debug': runtimeExport('debug'), './diagnostics': runtimeExport('diagnostics'), './internal/*': runtimeExport('*') },
  scripts: {
    build: 'node scripts/build.mjs', typecheck: 'tsc --noEmit', test: 'vitest run',
    'test:package': 'node test/package-smoke.mjs',
    verify: 'bun run typecheck && bun run build && bun run test && bun run test:package',
    lint: 'oxlint .', format: 'oxfmt --write .', 'format:check': 'oxfmt --check .',
  },
  devDependencies: { oxfmt: '0.54.0', oxlint: '1.69.0', typescript: '~6.0.3', vitest: '^4.1.11' },
  packageManager: 'bun@1.3.14',
}))
writes.set(`${packagePath}/tsconfig.json`, json({
  compilerOptions: {
    target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023'], types: [],
    strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, noEmit: true,
  },
  include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'],
}))
writes.set(`${packagePath}/tsconfig.build.json`, json({
  extends: './tsconfig.json', compilerOptions: { noEmit: false, declaration: true, rootDir: 'src', outDir: 'dist' },
}))
writes.set(`${packagePath}/vitest.config.ts`, `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
`)
writes.set(`${packagePath}/.gitignore`, 'node_modules/\ndist/\ncoverage/\n')
writes.set(`${packagePath}/.oxfmtrc.json`, read('.oxfmtrc.json'))

writes.set(`${packagePath}/scripts/build.mjs`, `import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.build.json'), ts.sys.readFile)
if (configFile.error) fail([configFile.error])
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
if (config.errors.length) fail(config.errors)
const program = ts.createProgram(config.fileNames, config.options)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) fail(diagnostics)
rmSync(path.join(root, 'dist'), { recursive: true, force: true })
const result = program.emit(undefined, (filename, text) => {
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, rewriteImports(filename, text))
})
if (result.emitSkipped || result.diagnostics.length) fail(result.diagnostics)

function fail(diagnostics) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name,
    getNewLine: () => '\\n',
  }))
  throw new Error('Textbuffer build failed')
}

// TypeScript's bundler resolution accepts extensionless imports. Published ESM must not require it.
function rewriteImports(filename, text) {
  if (!filename.endsWith('.js') && !filename.endsWith('.d.ts')) return text
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  const replacements = []
  function visit(node) {
    let literal
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0]
    if (literal && ts.isStringLiteralLike(literal)) {
      const specifier = literal.text
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
        replacements.push({ start: literal.getStart(source) + 1, end: literal.getEnd() - 1, text: specifier + '.js' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end)
  }
  return text
}
`)

writes.set(`${packagePath}/src/boundary.test.ts`, `import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBatchToPieceTable, createPieceTableSnapshot, insertIntoPieceTable, materializePieceTableFullText } from './index'
import { recordTextBufferDiagnostic, setTextBufferDiagnosticSink } from './diagnostics'

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))
afterEach(() => setTextBufferDiagnosticSink(undefined))

describe('standalone storage boundary', () => {
  it('has no runtime or type imports outside its source directory', () => {
    for (const filename of readdirSync(sourceRoot)) {
      if (!filename.endsWith('.ts') || filename.endsWith('.test.ts')) continue
      const text = readFileSync(path.join(sourceRoot, filename), 'utf8')
      for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
        expect(imported.fileName.startsWith('.'), filename + ': ' + imported.fileName).toBe(true)
        const target = path.resolve(sourceRoot, imported.fileName)
        expect(path.relative(sourceRoot, target).startsWith('..'), filename + ': ' + imported.fileName).toBe(false)
      }
    }
  })

  it('shares a lineage key across versions, not across independent documents', () => {
    const original = createPieceTableSnapshot('abc')
    const left = insertIntoPieceTable(original, 0, 'L')
    const right = insertIntoPieceTable(original, 0, 'R')
    expect(left.buffers.identity).toBe(original.buffers.identity)
    expect(right.buffers.identity).toBe(original.buffers.identity)
    expect(createPieceTableSnapshot('abc').buffers.identity).not.toBe(original.buffers.identity)
    expect(materializePieceTableFullText(original)).toBe('abc')
    expect(materializePieceTableFullText(left)).toBe('Labc')
    expect(materializePieceTableFullText(right)).toBe('Rabc')
    expect('textIndexes' in original.buffers).toBe(false)
  })

  it('keeps diagnostics lazy and disabled by default', () => {
    const detail = vi.fn(() => ({ scannedCodeUnits: 10 }))
    recordTextBufferDiagnostic('sourceIndex', detail)
    expect(detail).not.toHaveBeenCalled()
    const sink = vi.fn((name, fields) => ({ name, detail: fields() }))
    setTextBufferDiagnosticSink(sink)
    recordTextBufferDiagnostic('sourceIndex', detail)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('matches a string oracle through deterministic edits and retains old snapshots', () => {
    let state = 123456789
    const random = (max) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % max
    }
    let expected = 'alpha\\nbeta'
    let snapshot = createPieceTableSnapshot(expected)
    const retained = []
    for (let index = 0; index < 1000; index += 1) {
      if (index % 100 === 0) retained.push({ snapshot, text: expected })
      const from = random(expected.length + 1)
      const to = from + random(expected.length - from + 1)
      const text = ['x', '\\n', 'word', ''][random(4)]
      snapshot = applyBatchToPieceTable(snapshot, [{ from, to, text }])
      expected = expected.slice(0, from) + text + expected.slice(to)
      expect(materializePieceTableFullText(snapshot)).toBe(expected)
    }
    for (const previous of retained) expect(materializePieceTableFullText(previous.snapshot)).toBe(previous.text)
  })
})
`)

writes.set(`${packagePath}/test/package-smoke.mjs`, `import assert from 'node:assert/strict'
import { createPieceTableSnapshot, insertIntoPieceTable, materializePieceTableFullText } from '@singapore-editor/textbuffer'
import { validatePieceTreeInvariants } from '@singapore-editor/textbuffer/debug'
import { setTextBufferDiagnosticSink } from '@singapore-editor/textbuffer/diagnostics'
import { getBufferText } from '@singapore-editor/textbuffer/internal/buffers'

const original = createPieceTableSnapshot('abc\\n😀')
const changed = insertIntoPieceTable(original, 1, 'X')
assert.equal(materializePieceTableFullText(original), 'abc\\n😀')
assert.equal(materializePieceTableFullText(changed), 'aXbc\\n😀')
assert.equal(getBufferText(original.buffers, original.buffers.original), 'abc\\n😀')
assert.equal(typeof validatePieceTreeInvariants, 'function')
assert.equal(typeof setTextBufferDiagnosticSink, 'function')
console.log('Published ESM entry points and persistent snapshot smoke test passed')
`)

writes.set(`${packagePath}/README.md`, `# Singapore Textbuffer

Persistent, treap-backed text storage extracted from Singapore. This package owns text,
edits, line/offset mapping, persistent snapshots, stable anchors, and snapshot diffing.
It does not own rendering, display measurements, selections, or undo grouping.

## Development

\`bun install\`, then \`bun run verify\`. The test suite runs in Node, without a DOM.
The TypeScript configuration deliberately excludes DOM and Node ambient types from production source.
There are no runtime dependencies. The build uses only this package's TypeScript dependency.

## API

~~~ts
import { createPieceTableSnapshot, insertIntoPieceTable, materializePieceTableFullText } from '@singapore-editor/textbuffer'

const before = createPieceTableSnapshot('hello')
const after = insertIntoPieceTable(before, 5, ' world')
materializePieceTableFullText(before) // 'hello'
materializePieceTableFullText(after)  // 'hello world'
~~~

The existing functional API is retained. Offsets use UTF-16 code units; ingestion normalizes
line endings, and edits retain the existing surrogate-boundary repair behavior. Extraction
changes ownership, not tree balancing, tombstones, reverse indexes, or anchor semantics.

\`/debug\` exposes opt-in inspection. \`/diagnostics\` exposes a lazy, realm-wide diagnostic sink,
disabled by default. \`/internal/*\` is a transitional, unstable integration surface for Singapore;
new consumers should use the main entry point. Hosts may key WeakMap sidecars by
\`snapshot.buffers.identity\`, which identifies a document lineage, not an individual version.
Buffer IDs may be reused by divergent versions; a sidecar must also validate the exact text.

## Moving into a repository

This directory is self-contained: copy it without \`node_modules\` or \`dist\`, run \`bun install\`,
and commit the resulting standalone lockfile. No repository has been created or package published
by this source extraction. No license grant is introduced; settle licensing before publication.
Singapore should eventually consume a released version from the new repository, not a copied implementation.

## Comparing against VS Code

Pin both revisions and use one deterministic edit trace, one runtime, and one correctness oracle.
Report load, edits, line/range reads, position lookup, long-session memory, and retained snapshots
separately. Align line-ending and UTF-16 edit semantics before timing. Persistence and stable-anchor
workloads are additional capabilities, not automatically equivalent to a mutable buffer's read snapshot.
No performance claim or benchmark result is implied by this extraction.
`)

writes.set('docs/storage/textbuffer-extraction.md', `# Textbuffer extraction

The storage implementation lives in \`packages/textbuffer\`, which can build and test outside this workspace.
The former \`packages/editor/src/pieceTable\` modules are compatibility re-exports, not a second implementation.
The editor depends on \`@singapore-editor/textbuffer\` via \`workspace:*\` during this review stage.

Display measurement indexes now live in an editor-owned WeakMap keyed by the persistent document lineage.
Exact-text checks preserve correctness when undo branches reuse buffer IDs. Storage diagnostics call an
optional package-level sink; the editor adapts them to its existing diagnostic events.

The original piece-table unit test moved with the implementation. New tests cover package imports,
absence of outward dependencies, lazy diagnostics, lineage identity, and deterministic edit equivalence.
The existing editor measurement test still verifies reuse across edits, views, undo, and divergent branches.

Run \`bun install\`, \`bun run format\`, \`bun run format:check\`, \`bun run typecheck\`, and \`bun run test\`.
Validate the package independently with \`bun run --cwd packages/textbuffer verify\`.
Do not merge or publish until the recorded checks pass. Creating the separate GitHub repository,
choosing a license, and publishing the initial version are separate operations.
`)

// Reject accidental editor leakage before writing any file. Production imports in this engine are static.
for (const [name, text] of writes) {
  if (!name.startsWith(`${packagePath}/src/`) || name.endsWith('.test.ts')) continue
  assert(!text.includes("from '../"), `${name} still imports outside the storage package`)
  assert(!text.includes('recordEditorPerformanceDiagnostic'), `${name} still knows editor diagnostics`)
  assert(!text.includes('TextSourceIndex'), `${name} still knows display measurements`)
}
for (const [name, text] of writes) {
  const destination = path.join(root, name)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, text)
}
for (const name of deletions) rmSync(path.join(root, name))
console.log(`Extracted textbuffer: ${writes.size} files written, ${deletions.length} moved test removed from editor`)
console.log('Next: bun install; bun run format; bun run format:check; bun run typecheck; bun run test')
