import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { build, type Rollup } from 'vite'

const source = fileURLToPath(new URL('../src/', import.meta.url))

// Vite emits a grammar's .wasm when it loads the module that references it, even when tree-shaking
// drops the code, so an app that only highlights TypeScript must not load other languages' modules.
async function emittedGrammars(entry: string): Promise<string[]> {
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    root: source,
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
    `import { typeScript } from '${source}index.ts'\nconsole.log(typeScript())`,
  )
  expect(grammars).toContain('typescript')
  for (const unrelated of ['sql', 'c_sharp', 'cpp', 'rust', 'python', 'php', 'bash', 'mdx'])
    expect(grammars).not.toContain(unrelated)
}, 60_000)

it('emits every grammar for the catalog', async () => {
  const grammars = await emittedGrammars(
    `import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '${source}catalog.generated.ts'\nconsole.log(TREE_SITTER_LANGUAGE_CONTRIBUTIONS)`,
  )
  expect(grammars).toContain('sql')
  expect(grammars).toContain('typescript')
}, 60_000)
