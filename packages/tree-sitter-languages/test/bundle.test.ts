import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { build, type Rollup } from 'vite'

// The built package is what apps bundle; the test task builds it first.
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

// Vite emits a grammar's .wasm when it loads the module that references it, even when tree-shaking
// drops the code, so an app that only highlights TypeScript must not load other languages' modules.
async function emittedGrammars(entry: string): Promise<string[]> {
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    root: dist,
    build: {
      write: false,
      rollupOptions: {
        input: 'virtual:entry',
        external: (id) => id.startsWith('@singapore-editor/'),
      },
    },
    plugins: [
      {
        name: 'virtual-entry',
        resolveId: (id) => (id === 'virtual:entry' ? '\0virtual-entry' : undefined),
        load: (id) => (id === '\0virtual-entry' ? entry : undefined),
      },
    ],
  })) as Rollup.RollupOutput
  return output.output
    .map((file) => file.fileName)
    .filter((name) => name.endsWith('.wasm'))
    .map((name) => /tree-sitter-([a-z_-]+?)-[\w-]{8}\.wasm$/.exec(name)?.[1] ?? name)
    .toSorted()
}

it('emits only the grammars a typeScript() app can load', async () => {
  const grammars = await emittedGrammars(
    `import { typeScript } from '${dist}index.js'\nconsole.log(typeScript())`,
  )
  // The root entry's own exports name these languages; none of the others may appear.
  expect(grammars).toEqual([
    'astro',
    'css',
    'html',
    'javascript',
    'jsdoc',
    'json',
    'markdown',
    'regex',
    'tsx',
    'typescript',
  ])
}, 60_000)

it('emits every grammar for the catalog', async () => {
  const grammars = await emittedGrammars(
    `import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '${dist}catalog.generated.js'\nconsole.log(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)`,
  )
  const manifest = JSON.parse(
    readFileSync(new URL('../languages.json', import.meta.url), 'utf8'),
  ) as { languages: readonly unknown[] }
  expect(grammars).toHaveLength(manifest.languages.length)
}, 60_000)
