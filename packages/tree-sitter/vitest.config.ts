import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { runTempDir } from '../../scripts/run-temp-dir.ts'

const require = createRequire(import.meta.url)
const packageDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(packageDir, '../..')
// A directory owned by this run, removed when it exits. Workers that load the config reuse it.
const screenshotDirectory = runTempDir('tree-sitter-screenshots')
const languagePackageDir = resolve(packageDir, '../tree-sitter-languages')
const servedDependencyRoots = uniqueItems(
  [
    '@shaulavo/tree-sitter-scope-compat',
    'web-tree-sitter',
    'tree-sitter-md',
    'tree-sitter-css',
    'tree-sitter-html',
    'tree-sitter-javascript',
    'tree-sitter-json',
    'tree-sitter-typescript',
  ]
    .map(dependencyAllowRoot)
    .filter((root): root is string => Boolean(root)),
)

export default defineConfig({
  optimizeDeps: {
    include: [
      '@singapore-editor/core > @shaulavo/hotkeys > @tanstack/store',
      '@singapore-editor/core > diff',
      'tree-sitter-md',
      'web-tree-sitter',
    ],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      allow: [workspaceRoot, screenshotDirectory].concat(servedDependencyRoots),
    },
  },
  test: {
    browser: {
      headless: true,
      screenshotDirectory,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    environment: 'happy-dom',
  },
})

function dependencyAllowRoot(packageName: string): string | null {
  const packageJsonPath = resolveDependency(`${packageName}/package.json`)
  const resolvedPath = packageJsonPath ?? resolveDependency(packageName)
  if (!resolvedPath) return null

  const packageRoot = packageJsonPath
    ? dirname(packageJsonPath)
    : packageRootForResolvedPath(resolvedPath, packageName)
  return bunStoreRoot(packageRoot) ?? packageRoot
}

function packageRootForResolvedPath(resolvedPath: string, packageName: string): string {
  const marker = `${sep}node_modules${sep}${packageName}${sep}`
  const index = resolvedPath.lastIndexOf(marker)
  if (index === -1) return dirname(resolvedPath)

  return resolvedPath.slice(0, index + marker.length - 1)
}

function resolveDependency(specifier: string): string | null {
  try {
    return require.resolve(specifier, { paths: [packageDir, languagePackageDir] })
  } catch {
    return null
  }
}

function bunStoreRoot(packageRoot: string): string | null {
  const marker = `${sep}node_modules${sep}.bun${sep}`
  const index = packageRoot.indexOf(marker)
  if (index === -1) return null
  return packageRoot.slice(0, index + marker.length - 1)
}

function uniqueItems<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items))
}
