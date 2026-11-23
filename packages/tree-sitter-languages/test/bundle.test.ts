import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { build, type Rollup } from 'vite'

// The built package is what apps bundle; the test task builds it first.
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

// Vite emits a grammar's .wasm when it loads the module that references it, even when tree-shaking
// drops the code, so an app that only highlights TypeScript must not load other languages' modules.
async function emittedGrammars(entry: string): Promise<string[]> {
  return grammarNames(await emittedFiles(entry))
}

function grammarNames(files: readonly string[]): string[] {
  return files
    .filter((name) => name.endsWith('.wasm'))
    .map((name) =>
      name
        .split('/')
        .at(-1)!
        .replace(/-[\w-]{8}\.wasm$/, '.wasm'),
    )
    .toSorted()
}

async function emittedFiles(entry: string): Promise<string[]> {
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
  return output.output.map((file) => file.fileName)
}

it('emits only the grammars a typeScript() app can load, in one chunk per language', async () => {
  const files = await emittedFiles(
    `import { typeScript } from '${dist}typescript.js'\nconsole.log(typeScript())`,
  )
  expect(grammarNames(files)).toEqual([
    'tree-sitter-jsdoc.wasm',
    'tree-sitter-regex.wasm',
    'tree-sitter-typescript.wasm',
  ])
  // The entry chunk, then one lazy chunk per language holding its grammar URL and queries.
  const chunks = files
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.replace(/-[\w-]{8}\.js$/, '.js'))
  expect(chunks.toSorted()).toEqual([
    'assets/_virtual-entry.js',
    'assets/jsdoc.assets.generated.js',
    'assets/regex.assets.generated.js',
    'assets/typescript.assets.generated.js',
  ])
}, 60_000)

it('emits no grammar from the root entry', async () => {
  const grammars = await emittedGrammars(
    `import { TREE_SITTER_LANGUAGE_METADATA } from '${dist}index.js'\nconsole.log(TREE_SITTER_LANGUAGE_METADATA)`,
  )
  expect(grammars).toEqual([])
}, 60_000)

it('emits every grammar for the catalog', async () => {
  const grammars = await emittedGrammars(
    `import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '${dist}catalog.generated.js'\nconsole.log(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)`,
  )
  const manifest = JSON.parse(
    readFileSync(new URL('../languages.json', import.meta.url), 'utf8'),
  ) as {
    languages: readonly {
      readonly wasm: string
      readonly extraWasm?: Readonly<Record<string, string>>
    }[]
  }
  // File names, not ids: `shellscript` ships `tree-sitter-bash.wasm`.
  const expected = manifest.languages.flatMap((language) =>
    [language.wasm]
      .concat(Object.values(language.extraWasm ?? {}))
      .map((file) => file.split('/').at(-1)!),
  )
  expect(grammars).toEqual(expected.toSorted())
}, 60_000)
