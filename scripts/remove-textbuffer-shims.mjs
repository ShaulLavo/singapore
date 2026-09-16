import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const oldRoot = path.join(root, 'packages/editor/src/pieceTable')
const bufferRoot = path.join(root, 'packages/textbuffer/src')
const packageName = '@singapore-editor/textbuffer'
const read = (file) => readFileSync(file, 'utf8')
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const shims = readdirSync(oldRoot).sort()
assert.equal(shims.length, 22, 'Review changed shim inventory before migration')
for (const name of shims) {
  assert.match(read(path.join(oldRoot, name)), /^\/\/ Transitional import path; the implementation lives in the textbuffer package\.\nexport \* from '@singapore-editor\/textbuffer[^']*'\n$/)
}
const nestedInstructions = files.filter((file) => file.endsWith('/AGENTS.md') && /^(packages|examples|scripts|docs)\//.test(file))
assert.deepEqual(nestedInstructions, [], 'Read nested repository instructions before continuing')

const program = ts.createProgram(readdirSync(bufferRoot).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => path.join(bufferRoot, name)), {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true,
})
const checker = program.getTypeChecker()
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
const symbolsFor = (name) => {
  const source = program.getSourceFile(path.join(bufferRoot, name + '.ts'))
  assert(source, 'Missing textbuffer source: ' + name)
  const symbol = checker.getSymbolAtLocation(source)
  assert(symbol, 'Missing module symbol: ' + name)
  return checker.getExportsOfModule(symbol)
}
const unalias = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
const preferred = new Map()
for (const [file, target] of [['index', packageName], ['debug', packageName + '/debug'], ['diagnostics', packageName + '/diagnostics']]) {
  for (const symbol of symbolsFor(file)) {
    const resolved = unalias(symbol)
    if (!preferred.has(resolved)) preferred.set(resolved, { target, name: symbol.name })
  }
}
const oldModule = (filename, specifier) => {
  if (!specifier.startsWith('.')) return null
  let absolute = path.resolve(path.dirname(filename), specifier).replace(/\.(?:ts|js)$/, '')
  if (absolute === oldRoot) absolute += '/index'
  if (!absolute.startsWith(oldRoot + path.sep)) return null
  const module = path.relative(oldRoot, absolute)
  assert(shims.includes(module + '.ts'), 'Unknown old import: ' + filename + ': ' + specifier)
  return module
}
const exactTarget = (module) => module === 'index' ? packageName : packageName + '/internal/' + module
const namedTarget = (module, name) => {
  const symbol = symbolsFor(module).find((candidate) => candidate.name === name)
  assert(symbol, 'Missing export: ' + module + ':' + name)
  return preferred.get(unalias(symbol)) ?? { target: exactTarget(module), name }
}
const writes = new Map()
const dependencies = new Map()
const counts = { files: 0, declarations: 0, imports: {} }

for (const relative of files) {
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(relative) || relative.startsWith('packages/editor/src/pieceTable/') || relative === 'scripts/remove-textbuffer-shims.mjs') continue
  const filename = path.join(root, relative)
  const text = read(filename)
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  const replacements = []
  const consumed = new Set()
  const imports = new Map()
  let firstImport = null
  const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, source)
  const put = (node, value) => replacements.push({ start: node.getStart(source), end: node.end, text: value })

  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) continue
    const module = oldModule(filename, node.moduleSpecifier.text)
    if (module === null) continue
    counts.declarations += 1
    consumed.add(node.moduleSpecifier)
    assert(!node.attributes, 'Review import attributes: ' + relative)
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      assert(!node.importClause.name, 'Unexpected default import: ' + relative)
      firstImport ??= node
      for (const entry of node.importClause.namedBindings.elements) {
        const imported = (entry.propertyName ?? entry.name).text
        const selected = namedTarget(module, imported)
        const group = imports.get(selected.target) ?? []
        group.push({ imported: selected.name, local: entry.name.text, type: node.importClause.isTypeOnly || entry.isTypeOnly })
        imports.set(selected.target, group)
      }
      put(node, '')
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const groups = new Map()
      for (const entry of node.exportClause.elements) {
        const selected = namedTarget(module, (entry.propertyName ?? entry.name).text)
        const group = groups.get(selected.target) ?? []
        group.push(ts.factory.createExportSpecifier(entry.isTypeOnly, selected.name === entry.name.text ? undefined : ts.factory.createIdentifier(selected.name), entry.name))
        groups.set(selected.target, group)
      }
      put(node, Array.from(groups, ([target, entries]) => print(ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, ts.factory.createNamedExports(entries), ts.factory.createStringLiteral(target), undefined))).join('\n'))
    } else {
      // Namespace imports, star exports and side-effect imports keep the exact module namespace.
      put(node.moduleSpecifier, JSON.stringify(exactTarget(module)))
    }
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node) && !consumed.has(node)) {
      const parent = node.parent
      const isModule = ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)
        || ts.isCallExpression(parent) && parent.arguments[0] === node
          && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(parent.expression) && parent.expression.text === 'require'
            || ts.isPropertyAccessExpression(parent.expression) && ['mock', 'doMock', 'unmock', 'doUnmock'].includes(parent.expression.name.text))
      if (isModule) {
        const module = oldModule(filename, node.text)
        if (module !== null) put(node, JSON.stringify(exactTarget(module)))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (firstImport) {
    const declarations = []
    for (const [target, entries] of imports) {
      const unique = new Map()
      for (const entry of entries) {
        const previous = unique.get(entry.local)
        assert(!previous || previous.imported === entry.imported, 'Conflicting local import: ' + relative)
        unique.set(entry.local, { ...entry, type: entry.type && (previous?.type ?? true) })
      }
      const values = Array.from(unique.values()).sort((a, b) => a.imported.localeCompare(b.imported))
      const allTypes = values.every((entry) => entry.type)
      const named = values.map((entry) => ts.factory.createImportSpecifier(!allTypes && entry.type, entry.local === entry.imported ? undefined : ts.factory.createIdentifier(entry.imported), ts.factory.createIdentifier(entry.local)))
      declarations.push(print(ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(allTypes, undefined, ts.factory.createNamedImports(named)), ts.factory.createStringLiteral(target), undefined)))
      counts.imports[target] = (counts.imports[target] ?? 0) + values.length
    }
    replacements.find((entry) => entry.start === firstImport.getStart(source)).text = declarations.join('\n')
  }
  if (!replacements.length) continue
  let result = text
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end)
  writes.set(relative, result)
  counts.files += 1
  let owner = path.dirname(filename)
  while (owner !== root && !existsSync(path.join(owner, 'package.json'))) owner = path.dirname(owner)
  const manifestPath = path.relative(root, path.join(owner, 'package.json'))
  const production = relative.includes('/src/') && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
  dependencies.set(manifestPath, production || dependencies.get(manifestPath) === true)
}

for (const [relative, production] of dependencies) {
  const manifest = JSON.parse(read(path.join(root, relative)))
  if (manifest.name === packageName || manifest.dependencies?.[packageName] || manifest.peerDependencies?.[packageName]) continue
  const section = production ? 'dependencies' : 'devDependencies'
  if (manifest[section]?.[packageName]) continue
  manifest[section] = { ...manifest[section], [packageName]: 'workspace:*' }
  writes.set(relative, JSON.stringify(manifest, null, 2) + '\n')
}

// Update live local source references, without rewriting pinned performance evidence.
for (const relative of files) {
  if (!relative.endsWith('.md') || relative.startsWith('docs/performance/') || relative.startsWith('docs/architecture/phase-0/') || relative.startsWith('references/')) continue
  const text = read(path.join(root, relative))
  const updated = text.replaceAll('packages/editor/src/pieceTable/', 'packages/textbuffer/src/')
  if (updated !== text) writes.set(relative, updated)
}
let agents = writes.get('AGENTS.md') ?? read(path.join(root, 'AGENTS.md'))
agents = agents.replace('| `packages/editor` | Core editor: piece table, CSS Highlight API renderer, and Shiki highlighter | `src/pieceTable/pieceTable.ts`, `src/pieceTable/pieceTableTypes.ts`, `src/editor.ts`, `src/tokens.ts`, `src/shiki/*` |', '| `packages/editor` | Core editor: document sessions, CSS Highlight API renderer, and Shiki highlighter | `src/editor.ts`, `src/documentSession.ts`, `src/tokens.ts`, `src/shiki/*` |\n| `packages/textbuffer` | Persistent text storage, snapshots, anchors, and line mapping | `src/index.ts`, `src/pieceTableTypes.ts`, `src/tree.ts` |')
writes.set('AGENTS.md', agents)
let extraction = read(path.join(root, 'docs/storage/textbuffer-extraction.md'))
extraction = extraction.replace('The former `packages/editor/src/pieceTable` modules are compatibility re-exports, not a second implementation.', 'Editor source, tests, and benchmarks import `@singapore-editor/textbuffer` directly.\nThe old editor-local piece-table directory and all compatibility re-exports have been removed.')
writes.set('docs/storage/textbuffer-extraction.md', extraction)
let readme = read(path.join(root, 'packages/textbuffer/README.md'))
readme = readme.replace('`/internal/*` is a transitional, unstable integration surface for Singapore;', '`/internal/*` exposes implementation modules for tightly coupled integration and tests;')
readme = readme.replace('new consumers should use the main entry point.', 'these are not a stable public API. Ordinary consumers use the main entry point directly.')
writes.set('packages/textbuffer/README.md', readme)

writes.set('packages/editor/test/textbufferImports.node.test.ts', `import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const removedDirectory = path.join(root, 'packages/editor/src', 'pieceTable')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.turbo', 'coverage'].includes(entry.name)) return []
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(filename)
    return /\\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [filename] : []
  })
}

describe('direct textbuffer imports', () => {
  test('does not restore an editor-local piece-table facade', () => {
    expect(existsSync(removedDirectory)).toBe(false)
  })

  test('has no source, test, or benchmark imports through the removed directory', () => {
    const violations: string[] = []
    for (const directory of ['packages', 'examples', 'scripts']) {
      for (const filename of sourceFiles(path.join(root, directory))) {
        const source = readFileSync(filename, 'utf8')
        for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
          if (!imported.fileName.startsWith('.')) continue
          const resolved = path.resolve(path.dirname(filename), imported.fileName)
          if (resolved === removedDirectory || resolved.startsWith(removedDirectory + path.sep)) {
            violations.push(path.relative(root, filename) + ': ' + imported.fileName)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
`)

for (const [relative, text] of writes) {
  const filename = path.join(root, relative)
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, text)
}
for (const name of shims) rmSync(path.join(oldRoot, name))
rmSync(oldRoot, { recursive: true })
console.log(JSON.stringify({ ...counts, deletedShims: shims.length, changedManifests: Array.from(dependencies.keys()) }, null, 2))
console.log(execFileSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' }))
