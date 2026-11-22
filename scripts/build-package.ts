import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'

type PackageManifest = {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly exports?: Record<string, ExportTarget>
}

type ExportTarget =
  | string
  | {
      readonly default?: string
      readonly import?: string
      readonly types?: string
    }

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageDir = path.resolve(Bun.argv[2] ?? '.')
const packageJsonPath = path.join(packageDir, 'package.json')
const sourceRoot = path.join(packageDir, 'src')
const distRoot = path.join(packageDir, 'dist')

const manifest = await readManifest()
const entries = entriesFromExports(manifest.exports)

if (Object.keys(entries).length === 0) {
  throw new Error(`${manifest.name} has no TypeScript package exports to build`)
}

await rm(distRoot, { recursive: true, force: true })
// CSS lands before the JS that imports it, so a watching dev server never sees
// a dist where index.js exists and its `import './style.css'` cannot resolve.
await copyCss()
await buildJavaScript()
await emitDeclarations()

async function readManifest(): Promise<PackageManifest> {
  const content = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(content) as PackageManifest
}

function entriesFromExports(exportsField: PackageManifest['exports']): Record<string, string> {
  if (!exportsField) return {}

  const entries: Record<string, string> = {}
  for (const [exportPath, target] of Object.entries(exportsField)) {
    const source = sourceTarget(target)
    if (!source) continue
    if (!source.endsWith('.ts') && !source.endsWith('.tsx')) continue

    entries[entryName(exportPath, source)] = path.resolve(packageDir, source)
  }
  return entries
}

function sourceTarget(target: ExportTarget): string | null {
  if (typeof target === 'string') return sourceTargetFromRuntimeTarget(target)
  return sourceTargetFromRuntimeTarget(target.import ?? target.default ?? null)
}

function sourceTargetFromRuntimeTarget(target: string | null): string | null {
  if (!target) return null
  if (target.startsWith('./src/')) return target
  if (!target.startsWith('./dist/')) return target

  const source = target.replace(/^\.\/dist\//, './src/')
  if (!source.endsWith('.js')) return source

  const base = source.slice(0, -3)
  return existsSync(path.resolve(packageDir, `${base}.ts`)) ? `${base}.ts` : `${base}.tsx`
}

function entryName(exportPath: string, source: string): string {
  if (exportPath === '.') return 'index'

  const sourceName = source.replace(/^\.\/src\//, '').replace(/\.tsx?$/, '')
  return sourceName.replaceAll(path.sep, '/')
}

async function buildJavaScript(): Promise<void> {
  const workerReferences: string[] = []
  await build({
    assetsInclude: ['**/*.wasm'],
    // Relative, so an emitted worker URL resolves from the module that constructs it.
    base: './',
    build: {
      assetsInlineLimit: 0,
      emptyOutDir: false,
      lib: {
        entry: entries,
        formats: ['es'],
      },
      minify: false,
      outDir: distRoot,
      rollupOptions: {
        external: externalDependency,
        output: {
          assetFileNames: 'assets/[name][extname]',
          chunkFileNames: 'chunks/[name]-[hash].js',
          // Package managers exclude node_modules even when it is nested inside dist.
          entryFileNames: packageModuleFileName,
          preserveModules: true,
          preserveModulesRoot: sourceRoot,
          sourcemapExcludeSources: true,
        },
      },
      sourcemap: true,
      target: 'es2023',
    },
    configFile: false,
    logLevel: 'warn',
    plugins: [
      externalizeCssImports(),
      emitBinaryAssets(),
      canonicalModuleWorkers(workerReferences),
    ],
    publicDir: false,
    root: packageDir,
    worker: {
      format: 'es',
      plugins: () => [patchWebTreeSitterUrls(), emitBinaryAssets()],
      rollupOptions: {
        external: [],
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'web-tree-sitter',
                test: /[/\\]web-tree-sitter[/\\]/,
              },
            ],
          },
          sourcemapExcludeSources: true,
        },
      },
    },
  })
  await assertWorkersAreCanonical(workerReferences)
}

// Vite library mode forces data-URI inlining regardless of `assetsInlineLimit`, inflating binary
// payloads by ~33% raw (~45% gzip / ~54% Brotli) and preventing `WebAssembly.instantiateStreaming`.
// Emitting binary `?url` assets as real files keeps `new URL(..., import.meta.url)` resolvable in
// Node, Bun, browsers, and downstream Vite consumers without embedding host paths in dist.
function emitBinaryAssets(): Plugin {
  const suffix = '?singapore-binary-url'
  const pattern = /\.(?:wasm|gz)\?url$/
  return {
    name: 'singapore-emit-binary-assets',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!pattern.test(id)) return null
      const bare = id.slice(0, -'?url'.length)
      const resolved = await this.resolve(bare, importer, { skipSelf: true })
      if (!resolved) return null
      return `${resolved.id}${suffix}`
    },
    async load(id) {
      if (!id.endsWith(suffix)) return null
      const filePath = id.slice(0, -suffix.length)
      const source = await readFile(filePath)
      const referenceId = this.emitFile({
        type: 'asset',
        name: path.basename(filePath),
        source,
      })
      if (!filePath.endsWith('.wasm')) {
        return `export default import.meta.ROLLUP_FILE_URL_${referenceId};\n`
      }
      // In Node, `new URL(..., import.meta.url).href` produces a `file:` URL string that
      // `web-tree-sitter`'s `Language.load(wasmUrl)` forwards to `fetch()` (which rejects `file:`).
      // Converting `file:` URLs with Node's `fileURLToPath` lets `Language.load()` read the
      // emitted `.wasm` file via `fs.readFile` (including Windows drive and UNC paths) while
      // keeping `http(s):` streaming URLs untouched in browsers and bundled web workers.
      return (
        `const url = import.meta.ROLLUP_FILE_URL_${referenceId};\n` +
        `export default typeof process !== 'undefined' && process.versions?.node && url.startsWith('file:')\n` +
        `  ? (process.getBuiltinModule?.('node:url')?.fileURLToPath(url) ??\n` +
        `    (() => {\n` +
        `      const parsed = new URL(url);\n` +
        `      const decoded = decodeURIComponent(parsed.pathname);\n` +
        `      return parsed.hostname && parsed.hostname !== 'localhost'\n` +
        `        ? \`\\\\\\\\\${parsed.hostname}\${decoded.replaceAll('/', '\\\\')}\`\n` +
        `        : decoded.replace(/^\\/([A-Za-z]:\\/)/, '$1');\n` +
        `    })())\n` +
        `  : url;\n`
      )
    },
  }
}

// `web-tree-sitter` calls `new URL(".", import.meta.url)` only to derive a base directory URL
// (which Vite otherwise resolves to `web-tree-sitter.js` itself and inlines a second 148 KB copy),
// and `new URL("web-tree-sitter.wasm", import.meta.url)` which Vite library mode base64-inlines.
function patchWebTreeSitterUrls(): Plugin {
  const baseDirTarget = 'new URL(".", import.meta.url)'
  const baseDirReplacement = 'new URL(/* @vite-ignore */ ".", import.meta.url)'
  const wasmUrlTarget = 'new URL("web-tree-sitter.wasm", import.meta.url).href'
  const wasmUrlReplacement = '__singaporeWebTreeSitterWasmUrl'
  const wasmUrlImport =
    'import __singaporeWebTreeSitterWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";'

  return {
    name: 'singapore-patch-web-tree-sitter-urls',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('web-tree-sitter')) return null
      const hasBaseDir = code.includes(baseDirTarget)
      const hasWasmUrl = code.includes(wasmUrlTarget)
      if (!hasBaseDir && !hasWasmUrl) return null

      const replacements: (readonly [string, string])[] = []
      if (hasBaseDir) replacements.push([baseDirTarget, baseDirReplacement])
      if (hasWasmUrl) replacements.push([wasmUrlTarget, wasmUrlReplacement])
      return replaceLinesWithSourceMap(
        code,
        id,
        replacements,
        hasWasmUrl ? wasmUrlImport : undefined,
      )
    },
  }
}

function encodeVlq(value: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1
  do {
    let digit = vlq & 31
    vlq >>>= 5
    if (vlq > 0) digit |= 32
    encoded += chars[digit]
  } while (vlq > 0)
  return encoded
}

type TrimmedReplacement = {
  readonly target: string
  readonly prefix: number
  readonly suffix: number
  readonly replacement: string
}

type LineHit = {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

function trimReplacement(target: string, replacement: string): TrimmedReplacement {
  let prefix = 0
  const minLength = Math.min(target.length, replacement.length)
  while (prefix < minLength && target[prefix] === replacement[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < minLength - prefix &&
    target[target.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    target,
    prefix,
    suffix,
    replacement: replacement.slice(prefix, replacement.length - suffix),
  }
}

function findLineHits(line: string, trimmed: readonly TrimmedReplacement[]): LineHit[] {
  const hits: LineHit[] = []
  for (const item of trimmed) {
    let searchFrom = 0
    while (searchFrom < line.length) {
      const start = line.indexOf(item.target, searchFrom)
      if (start === -1) break
      hits.push({
        start: start + item.prefix,
        end: start + item.target.length - item.suffix,
        replacement: item.replacement,
      })
      searchFrom = start + item.target.length
    }
  }
  hits.sort((left, right) => left.start - right.start)
  return hits
}

function replaceLinesWithSourceMap(
  code: string,
  sourceId: string,
  replacements: readonly (readonly [string, string])[],
  appendLine?: string,
): {
  readonly code: string
  readonly map: {
    readonly version: 3
    readonly sources: readonly string[]
    readonly names: readonly string[]
    readonly mappings: string
  }
} {
  const trimmed = replacements.map(([target, replacement]) => trimReplacement(target, replacement))
  const originalLines = code.split('\n')
  const outputLines: string[] = []
  const mappingLines: string[] = []
  let prevSource = 0
  let prevOrigLine = 0
  let prevOrigCol = 0

  for (let lineIndex = 0; lineIndex < originalLines.length; lineIndex += 1) {
    const line = originalLines[lineIndex]!
    const hits = findLineHits(line, trimmed)

    const segments: string[] = []
    let prevGenCol = 0
    const addSegment = (genCol: number, origCol: number): void => {
      segments.push(
        encodeVlq(genCol - prevGenCol) +
          encodeVlq(0 - prevSource) +
          encodeVlq(lineIndex - prevOrigLine) +
          encodeVlq(origCol - prevOrigCol),
      )
      prevGenCol = genCol
      prevSource = 0
      prevOrigLine = lineIndex
      prevOrigCol = origCol
    }

    const addUnchangedSpan = (genStart: number, origStart: number, length: number): void => {
      for (let offset = 0; offset < length; offset += 1) {
        addSegment(genStart + offset, origStart + offset)
      }
    }

    if (hits.length === 0) {
      outputLines.push(line)
      addUnchangedSpan(0, 0, line.length)
      mappingLines.push(segments.join(','))
      continue
    }

    let built = ''
    let cursor = 0
    for (const hit of hits) {
      if (hit.start < cursor) continue
      if (hit.start > cursor) {
        addUnchangedSpan(built.length, cursor, hit.start - cursor)
        built += line.slice(cursor, hit.start)
      }
      addSegment(built.length, hit.start)
      built += hit.replacement
      cursor = hit.end
    }
    if (cursor < line.length) {
      addUnchangedSpan(built.length, cursor, line.length - cursor)
      built += line.slice(cursor)
    }
    outputLines.push(built)
    mappingLines.push(segments.join(','))
  }

  if (appendLine !== undefined) {
    outputLines.push(appendLine)
    mappingLines.push('')
  }

  return {
    code: outputLines.join('\n'),
    map: {
      version: 3,
      sources: [sourceId],
      names: [],
      mappings: mappingLines.join(';'),
    },
  }
}

function packageModuleFileName(chunk: { readonly name: string }): string {
  const marker = 'node_modules/'
  const dependencyStart = chunk.name.lastIndexOf(marker)
  if (dependencyStart === -1) return `${chunk.name}.js`
  return `vendor/${chunk.name.slice(dependencyStart + marker.length)}.js`
}

function externalDependency(id: string, importer?: string): boolean {
  if (isSourceImport(id)) return false
  if (isWorkerImport(id, importer)) return false

  return externalPackageNames().has(packageNameFromSpecifier(id))
}

function isSourceImport(id: string): boolean {
  if (id.startsWith('.')) return true
  if (id.startsWith('/')) return true
  if (id.endsWith('.wasm') || id.endsWith('.gz')) return true
  return id.includes('?')
}

function isWorkerImport(id: string, importer?: string): boolean {
  if (id.includes('?worker')) return false
  if (!importer) return false
  return importer.includes('.worker.')
}

function externalPackageNames(): ReadonlySet<string> {
  return new Set(
    Object.keys(manifest.dependencies ?? {}).concat(
      Object.keys(manifest.peerDependencies ?? {}),
      Object.keys(manifest.optionalDependencies ?? {}),
    ),
  )
}

function packageNameFromSpecifier(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier

  const [scope, name] = specifier.split('/')
  return `${scope}/${name}`
}

function externalizeCssImports(): Plugin {
  return {
    name: 'singapore-externalize-css-imports',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith('.css')) return null
      if (!importer) return null

      const resolved = await this.resolve(id, importer)
      if (!resolved) return null

      return { id: resolved.id, external: true }
    },
  }
}

// Vite emits a library worker as `new URL("" + new URL(x, import.meta.url).href, …)` behind a
// vite-ignore, which a consumer's bundler reads as a plain asset. The canonical form gets bundled.
function canonicalModuleWorkers(workerReferences: string[]): Plugin {
  return {
    name: 'singapore-canonical-module-workers',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue

        output.code = output.code.replace(emittedWorkerPattern(), (_match, workerPath: string) => {
          const relativePath = explicitlyRelative(JSON.parse(workerPath) as string)
          workerReferences.push(`${output.fileName} -> ${relativePath}`)
          return `new Worker(new URL(${JSON.stringify(relativePath)}, import.meta.url), { type: "module" })`
        })
      }
    },
  }
}

function explicitlyRelative(workerPath: string): string {
  if (workerPath.startsWith('.')) return workerPath
  return `./${workerPath}`
}

function emittedWorkerPattern(): RegExp {
  return /new Worker\(\s*new URL\(\s*\/\* @vite-ignore \*\/\s*(?:"" \+ )?new URL\(("[^"]+"), import\.meta\.url\)\.href,\s*"" \+ import\.meta\.url\s*\),\s*\{\s*type: "module"\s*\}\s*\)/g
}

async function assertWorkersAreCanonical(workerReferences: readonly string[]): Promise<void> {
  const sources = await moduleWorkerSources(sourceRoot)
  if (sources.length === workerReferences.length) return

  throw new Error(
    `Every module worker must be emitted as new Worker(new URL(…, import.meta.url)).\nSource:\n${sources.join('\n')}\nEmitted:\n${workerReferences.join('\n')}`,
  )
}

async function moduleWorkerSources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const sources: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isTypeScriptModule(entry.name)) continue
    if (isTestModule(entry.name)) continue

    const file = path.join(entry.parentPath, entry.name)
    const code = await readFile(file, 'utf8')
    for (const match of code.matchAll(workerConstructorPattern())) {
      sources.push(`${path.relative(packageDir, file)} -> ${match[1]}`)
    }
  }
  return sources.sort()
}

function isTypeScriptModule(name: string): boolean {
  if (name.endsWith('.ts')) return true
  return name.endsWith('.tsx')
}

function isTestModule(name: string): boolean {
  return /\.test\.tsx?$/.test(name)
}

function workerConstructorPattern(): RegExp {
  return /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"](\.\/[^'"]+\.worker\.ts)['"]\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type\s*:\s*['"]module['"]\s*,?\s*\}\s*\)/g
}

async function emitDeclarations(): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'singapore-dts-'))
  const tsconfigPath = path.join(tempDir, 'tsconfig.json')

  try {
    await writeFile(tsconfigPath, declarationTsconfig())
    await run(['bun', 'x', 'tsc', '-p', tsconfigPath], repositoryRoot)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function declarationTsconfig(): string {
  return JSON.stringify(
    {
      extends: path.join(repositoryRoot, 'tsconfig.json'),
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: true,
        // Packages with `.tsx` sources; the root config omits it because most have none.
        jsx: 'react-jsx',
        noEmit: false,
        outDir: distRoot,
        rootDir: sourceRoot,
      },
      include: [path.join(sourceRoot, '**/*')],
    },
    null,
    2,
  )
}

async function copyCss(): Promise<void> {
  await copyCssDirectory(sourceRoot)
}

async function copyCssDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const source = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await copyCssDirectory(source)
      continue
    }

    if (!entry.name.endsWith('.css')) continue

    const target = path.join(distRoot, path.relative(sourceRoot, source))
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target)
  }
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: 'inherit',
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return

  throw new Error(`Command failed: ${command.join(' ')}`)
}
