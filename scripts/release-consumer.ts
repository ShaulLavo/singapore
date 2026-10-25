import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

export async function releaseConsumerTools(): Promise<Record<string, string>> {
  const vite = await installedVersion('node_modules/vite/package.json')
  const playwright = await installedVersion('packages/tree-sitter/node_modules/@playwright/test/package.json')
  const runtime: unknown = JSON.parse(await readFile(path.join(root, 'packages/tree-sitter/package.json'), 'utf8'))
  if (!runtime || typeof runtime !== 'object' || !('dependencies' in runtime))
    throw new Error('Missing parser dependencies')
  const dependencies = runtime.dependencies
  if (!dependencies || typeof dependencies !== 'object' || !('web-tree-sitter' in dependencies) || typeof dependencies['web-tree-sitter'] !== 'string')
    throw new Error('Missing parser runtime pin')
  return { vite, '@playwright/test': playwright, 'web-tree-sitter': dependencies['web-tree-sitter'] }
}

export async function prepareBrowserConsumer(consumer: string): Promise<void> {
  await cp(path.join(root, 'scripts/release-consumer'), consumer, { recursive: true })
  const fixtures = path.join(root, 'packages/tree-sitter-languages/test/fixtures')
  await cp(path.join(fixtures, 'native.ts'), path.join(consumer, 'native.ts'))
  await cp(path.join(fixtures, 'sql.ts'), path.join(consumer, 'sql.ts'))
  await writeFile(path.join(consumer, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.ts"></script></body></html>\n')
}

async function installedVersion(relativePath: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string')
    throw new Error(`Missing installed tool version: ${relativePath}`)
  return manifest.version
}
