import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIRS = [
  'packages/textbuffer',
  'packages/lsp',
  'packages/panes',
  'packages/collab',
  'packages/editor',
  'packages/plugin-ui',
  'packages/collaboration',
  'packages/diff',
  'packages/file-animation',
  'packages/find',
  'packages/gutters',
  'packages/lsp-plugin',
  'packages/markdown',
  'packages/minimap',
  'packages/paged',
  'packages/react',
  'packages/scope-lines',
  'packages/solid',
  'packages/spellcheck',
  'packages/tree-sitter',
  'packages/tree-sitter-languages',
  'packages/highlighting',
  'packages/typescript-lsp',
] as const

interface PackageManifest {
  readonly name: string
  readonly version: string
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(Bun.argv.slice(2))
const dryRun = args.has('--dry-run')
const skipBuild = args.has('--skip-build')
const tag = argValue('--tag') ?? 'latest'
const access = argValue('--access') ?? 'public'
const registry = argValue('--registry') ?? 'https://registry.npmjs.org/'
const fromPackage = argValue('--from')

if (!dryRun && process.env.CI !== 'true') {
  await assertPublishPrerequisites()
}

if (!skipBuild) {
  await buildPackages()
}

let foundFromPackage = fromPackage === null
for (const packageDir of PACKAGE_DIRS) {
  const manifest = await readManifest(packageDir)
  if (!foundFromPackage) {
    if (!isFromPackage(packageDir, manifest)) continue
    foundFromPackage = true
  }

  await publishPackage(packageDir, manifest)
}
if (!foundFromPackage) throw new Error(`No package matched --from ${fromPackage}`)

async function buildPackages(): Promise<void> {
  await run(['bun', 'run', 'build'])
}

function argValue(name: string): string | null {
  const index = Bun.argv.indexOf(name)
  if (index === -1) return null

  return Bun.argv[index + 1] ?? null
}

async function publishPackage(packageDir: string, manifest: PackageManifest): Promise<void> {
  const packageSpec = specFor(manifest)
  if (await isPackagePublished(manifest)) {
    console.log(`${packageSpec} is already published, skipping`)
    return
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'singapore-package-'))

  try {
    const tarballPath = await packPackage(packageDir, tempDir)
    await publishTarball(tarballPath)
    await waitForPublishedPackage(manifest)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
  const packagePath = path.join(repositoryRoot, packageDir, 'package.json')
  const content = await readFile(packagePath, 'utf8')
  return JSON.parse(content) as PackageManifest
}

function isFromPackage(packageDir: string, manifest: PackageManifest): boolean {
  if (fromPackage === manifest.name) return true
  return fromPackage === packageDir
}

async function packPackage(packageDir: string, destination: string): Promise<string> {
  await run(['bun', 'pm', 'pack', '--cwd', packageDir, '--destination', destination, '--quiet'])

  const files = await readdir(destination)
  const tarball = files.find((file) => file.endsWith('.tgz'))
  if (!tarball) throw new Error(`No tarball was created for ${packageDir}`)

  return path.join(destination, tarball)
}

async function publishTarball(tarballPath: string): Promise<void> {
  const command = [
    'npm',
    'publish',
    tarballPath,
    '--registry',
    registry,
    '--tag',
    tag,
    '--access',
    access,
  ]
  if (process.env.GITHUB_ACTIONS === 'true') {
    command.push('--provenance')
  } else if (dryRun) {
    command.push('--provenance=false')
  }

  await run(dryRun ? command.concat(['--dry-run']) : command)
}

async function assertPublishPrerequisites(): Promise<void> {
  const username = await npmUsername()
  const packageScope = await publishScope()
  if (username === packageScope) return
  if (await isNpmOrgMember(packageScope, username)) return

  throw new Error(
    `npm user ${username} cannot publish @${packageScope}/* packages. ` +
      `Create the npm org/user "${packageScope}" or add ${username} to that org, then rerun.`,
  )
}

async function npmUsername(): Promise<string> {
  const result = await runCaptured(['npm', 'whoami', '--registry', registry])
  if (result.exitCode === 0) return result.stdout.trim()

  throw new Error(
    'npm is not logged in for publishing. Run `npm login --registry https://registry.npmjs.org/`, then rerun.',
  )
}

async function publishScope(): Promise<string> {
  const manifest = await readManifest(PACKAGE_DIRS[0])
  const match = /^@([^/]+)\//.exec(manifest.name)
  if (match) return match[1]

  throw new Error(`Expected ${manifest.name} to be a scoped package name`)
}

async function isNpmOrgMember(scope: string, username: string): Promise<boolean> {
  const result = await runCaptured(['npm', 'org', 'ls', scope, username, '--registry', registry])
  return result.exitCode === 0
}

async function waitForPublishedPackage(manifest: PackageManifest): Promise<void> {
  if (dryRun) return

  const packageSpec = specFor(manifest)
  if (await isPackageVisible(packageSpec)) return
  await Bun.sleep(1000)
  if (await isPackageVisible(packageSpec)) return
  console.log(`${packageSpec} publish completed; continuing without waiting on CDN propagation`)
}

function specFor(manifest: PackageManifest): string {
  return `${manifest.name}@${manifest.version}`
}

async function isPackageVisible(packageSpec: string): Promise<boolean> {
  const process = Bun.spawn(['npm', 'view', packageSpec, 'version', '--registry', registry], {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const exitCode = await process.exited
  return exitCode === 0
}

async function isPackagePublished(manifest: PackageManifest): Promise<boolean> {
  return isPackageVisible(specFor(manifest))
}

async function runCaptured(
  command: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const process = Bun.spawn(command, {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ])
  return { exitCode, stdout }
}

async function run(command: readonly string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdin: 'inherit',
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return

  throw new Error(`Command failed: ${command.join(' ')}`)
}
