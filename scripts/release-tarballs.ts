import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareBrowserConsumer, releaseConsumerTools } from './release-consumer'

const EXPECTED_PACKAGE_DIRS = [
  'packages/collab',
  'packages/collaboration',
  'packages/diff',
  'packages/editor',
  'packages/file-animation',
  'packages/find',
  'packages/gutters',
  'packages/highlighting',
  'packages/lsp',
  'packages/lsp-plugin',
  'packages/markdown',
  'packages/minimap',
  'packages/paged',
  'packages/panes',
  'packages/plugin-ui',
  'packages/react',
  'packages/scope-lines',
  'packages/solid',
  'packages/spellcheck',
  'packages/textbuffer',
  'packages/tree-sitter',
  'packages/tree-sitter-languages',
  'packages/typescript-lsp',
] as const

const RELEASE_MANIFEST = 'release-manifest.json'
const CHECKSUMS_FILE = 'SHA256SUMS'
const RELEASE_TAG_PREFIX = 'singapore-'
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const args = new Set(Bun.argv.slice(2))
const outputDir = path.resolve(repositoryRoot, argValue('--out') ?? 'release')
const requestedCommit = argValue('--commit') ?? process.env.GITHUB_SHA ?? null
const requestedTag = argValue('--tag') ?? process.env.GITHUB_REF_NAME ?? null
const validateOnly = args.has('--validate-only')

if (args.has('--qualify-only')) {
  await validateArtifacts(outputDir, requestedCommit, requestedTag)
  const packages = await readPackageInfos()
  const manifest = await readReleaseManifest(outputDir)
  await testCleanConsumer(outputDir, manifest.packages, packages)
} else if (validateOnly) {
  await validateArtifacts(outputDir, requestedCommit, requestedTag)
} else {
  await createReleaseArtifacts(outputDir, requestedCommit, requestedTag)
}

interface PackageJson {
  readonly name: string
  readonly version: string
  readonly peerDependencies?: Record<string, string>
}

interface PackageInfo {
  readonly directory: string
  readonly manifest: PackageJson
}

interface ReleasePackage {
  readonly directory: string
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly sha256: string
  readonly releaseUrl: string
}

interface ReleaseManifest {
  readonly format: 'singapore-package-release'
  readonly formatVersion: 1
  readonly repository: 'ShaulLavo/singapore'
  readonly commit: string
  readonly tag: string
  readonly packageCount: number
  readonly checksums: typeof CHECKSUMS_FILE
  readonly packages: readonly ReleasePackage[]
}

async function createReleaseArtifacts(
  output: string,
  expectedCommit: string | null,
  requestedReleaseTag: string | null,
): Promise<void> {
  await prepareOutputDirectory(output)
  const packages = await readPackageInfos()
  const commit = await git(['rev-parse', 'HEAD'])
  const tag = requestedReleaseTag ?? `${RELEASE_TAG_PREFIX}${commit}`

  assertCommit(commit, expectedCommit)
  assertReleaseTag(commit, tag)

  await run(['bun', 'run', 'build', '--', '--filter=./packages/*'], repositoryRoot)

  const releasePackages: ReleasePackage[] = []
  for (const packageInfo of packages) {
    const filename = filenameFor(packageInfo.manifest)
    const tarballPath = await packPackage(packageInfo.directory, filename, output)
    const sha256 = await sha256For(tarballPath)
    releasePackages.push({
      directory: packageInfo.directory,
      name: packageInfo.manifest.name,
      version: packageInfo.manifest.version,
      filename,
      sha256,
      releaseUrl: releaseUrl(tag, filename),
    })
  }

  await testCleanConsumer(output, releasePackages, packages)
  await writeReleaseManifest(output, { commit, tag, packages: releasePackages })
  await writeChecksums(output, releasePackages)
  await validateArtifacts(output, commit, tag)

  console.log(`Release artifacts verified: ${releasePackages.length} packages for ${tag}`)
}

async function validateArtifacts(
  output: string,
  expectedCommit: string | null,
  requestedReleaseTag: string | null,
): Promise<void> {
  const packages = await readPackageInfos()
  const manifest = await readReleaseManifest(output)
  const commit = await git(['rev-parse', 'HEAD'])
  const tag = requestedReleaseTag ?? `${RELEASE_TAG_PREFIX}${commit}`

  assertCommit(commit, expectedCommit)
  assertReleaseTag(commit, tag)
  if (manifest.commit !== commit) {
    throw new Error(`Release manifest commit ${manifest.commit} does not match ${commit}`)
  }
  if (manifest.tag !== tag) {
    throw new Error(`Release manifest tag ${manifest.tag} does not match ${tag}`)
  }
  if (manifest.packageCount !== EXPECTED_PACKAGE_DIRS.length) {
    throw new Error(`Release manifest contains ${manifest.packageCount} packages`)
  }
  if (manifest.checksums !== CHECKSUMS_FILE) {
    throw new Error(`Release manifest must use ${CHECKSUMS_FILE}`)
  }
  if (manifest.repository !== 'ShaulLavo/singapore') {
    throw new Error(`Release manifest repository is ${manifest.repository}`)
  }

  assertPackageSet(packages, manifest.packages, tag)
  await assertChecksums(output, manifest.packages)
  console.log(`Validated ${manifest.packageCount} packages, commit ${commit}, tag ${tag}`)
}

async function readPackageInfos(): Promise<readonly PackageInfo[]> {
  const actualDirectories = (
    await readdir(path.join(repositoryRoot, 'packages'), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort()
  const expectedDirectories = EXPECTED_PACKAGE_DIRS.toSorted()

  assertEqualArrays(actualDirectories, expectedDirectories, 'package directories')

  const packages: PackageInfo[] = []
  for (const directory of expectedDirectories) {
    const manifestPath = path.join(repositoryRoot, directory, 'package.json')
    const manifest = parsePackageJson(await readFile(manifestPath, 'utf8'), manifestPath)
    packages.push({ directory, manifest })
  }
  return packages
}

async function prepareOutputDirectory(output: string): Promise<void> {
  await mkdir(output, { recursive: true })
  const entries = await readdir(output, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (
      !entry.name.endsWith('.tgz') &&
      entry.name !== RELEASE_MANIFEST &&
      entry.name !== CHECKSUMS_FILE
    ) {
      continue
    }
    await rm(path.join(output, entry.name), { force: true })
  }
}

async function packPackage(directory: string, filename: string, output: string): Promise<string> {
  const before = new Set((await readdir(output)).filter((entry) => entry.endsWith('.tgz')))
  await run(
    ['bun', 'pm', 'pack', '--cwd', directory, '--destination', output, '--quiet'],
    repositoryRoot,
  )
  const created = (await readdir(output))
    .filter((entry) => entry.endsWith('.tgz') && !before.has(entry))
    .sort()

  if (created.length !== 1 || created[0] !== filename) {
    throw new Error(
      `Expected ${filename} from ${directory}, created ${created.join(', ') || 'nothing'}`,
    )
  }
  return path.join(output, filename)
}

async function testCleanConsumer(
  output: string,
  releasePackages: readonly ReleasePackage[],
  packages: readonly PackageInfo[],
): Promise<void> {
  const consumer = await mkdtemp(path.join(tmpdir(), 'singapore-release-consumer-'))
  const packageNames = new Set(packages.map((packageInfo) => packageInfo.manifest.name))
  const peerDependencies = externalPeerDependencies(packages, packageNames)

  try {
    const dependencies = Object.fromEntries(
      releasePackages.map((releasePackage) => [
        releasePackage.name,
        pathToFileURL(path.join(output, releasePackage.filename)).href,
      ]),
    )
    await writeFile(
      path.join(consumer, 'package.json'),
      `${JSON.stringify(
        {
          name: 'singapore-release-consumer',
          private: true,
          type: 'module',
          dependencies,
          devDependencies: { ...peerDependencies, ...(await releaseConsumerTools()) },
          overrides: dependencies,
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(path.join(consumer, 'smoke.mjs'), smokeScript(releasePackages, packages))
    await prepareBrowserConsumer(consumer)
    await run(['bun', 'install', '--no-progress'], consumer)
    await run(['bun', 'smoke.mjs'], consumer)
    await run(['bun', 'x', '--no-install', 'vite', 'build', '--configLoader', 'native'], consumer)
    await run(['node', 'browser.mjs'], consumer)
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

function smokeScript(
  releasePackages: readonly ReleasePackage[],
  packages: readonly PackageInfo[],
): string {
  const versions = Object.fromEntries(
    packages.map((packageInfo) => [packageInfo.manifest.name, packageInfo.manifest.version]),
  )
  const packageNames = releasePackages.map((releasePackage) => releasePackage.name)
  return (
    `import { readFile } from 'node:fs/promises'\n` +
    `import path from 'node:path'\n\n` +
    `const packages = ${JSON.stringify(releasePackages)}\n` +
    `const internalVersions = ${JSON.stringify(versions)}\n` +
    `const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies']\n` +
    `for (const releasePackage of packages) {\n` +
    `  const module = await import(releasePackage.name)\n` +
    `  if (!module || typeof module !== 'object') throw new Error(\`Empty module: \${releasePackage.name}\`)\n` +
    `  const packagePath = path.join('node_modules', releasePackage.name, 'package.json')\n` +
    `  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))\n` +
    `  if (manifest.name !== releasePackage.name || manifest.version !== releasePackage.version) {\n` +
    `    throw new Error(\`Unexpected manifest for \${releasePackage.name}\`)\n` +
    `  }\n` +
    `  for (const section of dependencySections) {\n` +
    `    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {\n` +
    `      if (!Object.hasOwn(internalVersions, name)) continue\n` +
    `      if (specifier.startsWith('workspace:')) throw new Error(\`Unresolved workspace dependency: \${name}\`)\n` +
    `      if (specifier !== internalVersions[name]) throw new Error(\`Unexpected internal dependency: \${name}@\${specifier}\`)\n` +
    `    }\n` +
    `  }\n` +
    `  console.log(\`imported \${releasePackage.name}\`)\n` +
    `}\n` +
    `console.log(\`verified \${packages.length} package entry points\`)\n` +
    `// Keep the generated source tied to the complete release set.\n` +
    `if (packages.map((item) => item.name).join('\0') !== ${JSON.stringify(packageNames.join('\0'))}) throw new Error('Package set changed')\n`
  )
}

function externalPeerDependencies(
  packages: readonly PackageInfo[],
  internalNames: ReadonlySet<string>,
): Record<string, string> {
  const peers: Record<string, string> = {}
  for (const packageInfo of packages) {
    for (const [name, range] of Object.entries(packageInfo.manifest.peerDependencies ?? {})) {
      if (internalNames.has(name)) continue
      peers[name] = range
    }
  }
  return peers
}

async function writeReleaseManifest(
  output: string,
  input: {
    readonly commit: string
    readonly tag: string
    readonly packages: readonly ReleasePackage[]
  },
): Promise<void> {
  const manifest: ReleaseManifest = {
    format: 'singapore-package-release',
    formatVersion: 1,
    repository: 'ShaulLavo/singapore',
    commit: input.commit,
    tag: input.tag,
    packageCount: input.packages.length,
    checksums: CHECKSUMS_FILE,
    packages: input.packages,
  }
  await writeFile(path.join(output, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function writeChecksums(output: string, packages: readonly ReleasePackage[]): Promise<void> {
  const lines = packages
    .toSorted((first, second) => first.filename.localeCompare(second.filename))
    .map((releasePackage) => `${releasePackage.sha256}  ${releasePackage.filename}`)
  await writeFile(path.join(output, CHECKSUMS_FILE), `${lines.join('\n')}\n`)
}

async function readReleaseManifest(output: string): Promise<ReleaseManifest> {
  const content = await readFile(path.join(output, RELEASE_MANIFEST), 'utf8')
  return parseReleaseManifest(content)
}

function parsePackageJson(content: string, source: string): PackageJson {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`Invalid package manifest: ${source}`)
  }
  return {
    name: value.name,
    version: value.version,
    peerDependencies: parseStringMap(value.peerDependencies, source),
  }
}

function parseReleaseManifest(content: string): ReleaseManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error(`Invalid release manifest in ${RELEASE_MANIFEST}`)
  if (value.format !== 'singapore-package-release' || value.formatVersion !== 1) {
    throw new Error(`Unsupported release manifest format in ${RELEASE_MANIFEST}`)
  }
  if (
    value.repository !== 'ShaulLavo/singapore' ||
    typeof value.commit !== 'string' ||
    typeof value.tag !== 'string' ||
    typeof value.packageCount !== 'number' ||
    value.checksums !== CHECKSUMS_FILE ||
    !Array.isArray(value.packages)
  ) {
    throw new Error(`Invalid release manifest in ${RELEASE_MANIFEST}`)
  }
  return {
    format: 'singapore-package-release',
    formatVersion: 1,
    repository: 'ShaulLavo/singapore',
    commit: value.commit,
    tag: value.tag,
    packageCount: value.packageCount,
    checksums: CHECKSUMS_FILE,
    packages: value.packages.map((item) => parseReleasePackage(item)),
  }
}

function parseReleasePackage(value: unknown): ReleasePackage {
  if (
    !isRecord(value) ||
    typeof value.directory !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.filename !== 'string' ||
    typeof value.sha256 !== 'string' ||
    typeof value.releaseUrl !== 'string'
  ) {
    throw new Error(`Invalid package entry in ${RELEASE_MANIFEST}`)
  }
  return {
    directory: value.directory,
    name: value.name,
    version: value.version,
    filename: value.filename,
    sha256: value.sha256,
    releaseUrl: value.releaseUrl,
  }
}

function parseStringMap(value: unknown, source: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error(`Invalid dependency map in ${source}`)
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') throw new Error(`Invalid dependency map in ${source}`)
    result[key] = entryValue
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertPackageSet(
  packages: readonly PackageInfo[],
  releasePackages: readonly ReleasePackage[],
  tag: string,
): void {
  const expected = packages.map(
    (packageInfo) =>
      `${packageInfo.directory}|${packageInfo.manifest.name}|${packageInfo.manifest.version}`,
  )
  const actual = releasePackages.map(
    (releasePackage) =>
      `${releasePackage.directory}|${releasePackage.name}|${releasePackage.version}`,
  )
  assertEqualArrays(actual, expected, 'release package set')

  const filenames = releasePackages.map((releasePackage) => releasePackage.filename)
  if (new Set(filenames).size !== filenames.length)
    throw new Error('Release package filenames are not unique')
  for (const releasePackage of releasePackages) {
    if (releasePackage.releaseUrl !== releaseUrl(tag, releasePackage.filename)) {
      throw new Error(`Invalid release URL for ${releasePackage.name}`)
    }
  }
}

async function assertChecksums(output: string, packages: readonly ReleasePackage[]): Promise<void> {
  const checksumsPath = path.join(output, CHECKSUMS_FILE)
  const lines = (await readFile(checksumsPath, 'utf8')).trimEnd().split('\n')
  const expectedFiles = packages.map((releasePackage) => releasePackage.filename).toSorted()
  const actualFiles: string[] = []
  const actualHashes = new Map<string, string>()

  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) throw new Error(`Invalid checksum line: ${line}`)
    const [, hash, filename] = match
    if (actualHashes.has(filename)) throw new Error(`Duplicate checksum for ${filename}`)
    actualFiles.push(filename)
    actualHashes.set(filename, hash)
  }

  assertEqualArrays(actualFiles.toSorted(), expectedFiles, CHECKSUMS_FILE)
  for (const releasePackage of packages) {
    const filePath = path.join(output, releasePackage.filename)
    const actualHash = await sha256For(filePath)
    if (actualHash !== releasePackage.sha256) {
      throw new Error(`Checksum mismatch for ${releasePackage.filename}`)
    }
    if (actualHash !== actualHashes.get(releasePackage.filename)) {
      throw new Error(`${CHECKSUMS_FILE} does not match ${releasePackage.filename}`)
    }
  }

  const actualTarballs = (await readdir(output))
    .filter((entry) => entry.endsWith('.tgz'))
    .toSorted()
  assertEqualArrays(actualTarballs, expectedFiles, 'release tarballs')
}

function assertCommit(actual: string, expected: string | null): void {
  if (expected && actual !== expected)
    throw new Error(`Release commit ${actual} does not match ${expected}`)
}

function assertReleaseTag(commit: string, tag: string): void {
  const expectedTag = `${RELEASE_TAG_PREFIX}${commit}`
  if (tag !== expectedTag) throw new Error(`Release tag must be ${expectedTag}, got ${tag}`)
}

function assertEqualArrays(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
    return
  throw new Error(
    `${label} mismatch\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`,
  )
}

function filenameFor(manifest: PackageJson): string {
  return `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
}

function releaseUrl(tag: string, filename: string): string {
  return `https://github.com/ShaulLavo/singapore/releases/download/${tag}/${filename}`
}

async function sha256For(filePath: string): Promise<string> {
  const content = await Bun.file(filePath).arrayBuffer()
  return createHash('sha256').update(new Uint8Array(content)).digest('hex')
}

function argValue(name: string): string | null {
  const index = Bun.argv.indexOf(name)
  if (index === -1) return null
  const value = Bun.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

async function git(command: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git'].concat(command), {
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode === 0) return stdout.trim()
  throw new Error(`git ${command.join(' ')} failed: ${stderr.trim()}`)
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: 'inherit',
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return
  throw new Error(`Command failed in ${cwd}: ${command.join(' ')}`)
}
