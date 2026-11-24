// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

type ConsumerChunk = {
  readonly entry: boolean
  /** Package modules in the chunk, as paths under `dist/`. */
  readonly modules: readonly string[]
  /** Chunks this one imports statically, which load with it. */
  readonly imports: readonly string[]
  readonly fileName: string
}

/** The chunks of a minified consumer of `source`, which may import the package's `dist/`. */
function consumerChunks(source: string): readonly ConsumerChunk[] {
  const script = `
    import { build } from 'vite';
    const entry = '\\0syntax-pipeline-consumer';
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'syntax-pipeline-consumer',
        resolveId(id) { if (id === entry) return id; },
        load(id) { if (id === entry) return ${JSON.stringify(source)}; }
      }],
      build: { write: false, minify: true, rollupOptions: {
        input: entry, preserveEntrySignatures: 'strict'
      } }
    });
    const chunks = (Array.isArray(result) ? result : [result])
      .flatMap(build => build.output)
      .filter(output => output.type === 'chunk')
      .map(chunk => ({
        entry: chunk.isEntry,
        fileName: chunk.fileName,
        imports: chunk.imports,
        modules: Object.keys(chunk.modules),
      }));
    console.log(JSON.stringify(chunks));
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return (JSON.parse(output) as ConsumerChunk[]).map((chunk) => ({
    ...chunk,
    modules: chunk.modules.filter((id) => id.startsWith(dist)).map((id) => id.slice(dist.length)),
  }))
}

/** Every package module that loads with the entry: its own and those of the chunks it imports. */
function loadedAtStart(chunks: readonly ConsumerChunk[]): readonly string[] {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const loaded = new Set<ConsumerChunk>()
  const visit = (chunk: ConsumerChunk | undefined): void => {
    if (!chunk || loaded.has(chunk)) return
    loaded.add(chunk)
    for (const name of chunk.imports) visit(byName.get(name))
  }
  for (const chunk of chunks) if (chunk.entry) visit(chunk)
  return Array.from(loaded).flatMap((chunk) => chunk.modules)
}

const CONTROLLER = 'editor/syntaxController.js'

it('leaves the syntax controller out of an editor given only text', () => {
  const chunks = consumerChunks(`
    import { Editor } from ${JSON.stringify(`${dist}editor.js`)};
    export function mount(element) {
      const editor = new Editor(element);
      editor.setText('const value = 1');
      editor.setTokens([{ start: 0, end: 5, style: { color: 'red' } }]);
      return editor;
    }
  `)
  const atStart = loadedAtStart(chunks)

  expect(atStart).toContain('editor/Editor.js')
  expect(atStart).toContain('editor/syntaxPipeline.js')
  // Document analysis stays: every buffer-backed document has a contribution receiver.
  expect(atStart).toContain('editor/documentAnalysis.js')
  expect(chunks.flatMap((chunk) => chunk.modules)).not.toContain(CONTROLLER)
})

it('loads the syntax controller with a highlighter built by the public helper', () => {
  const chunks = consumerChunks(`
    import { Editor, createEditorHighlighterOperation } from ${JSON.stringify(`${dist}editor.js`)};
    export function mount(element) {
      const operation = createEditorHighlighterOperation(() => null);
      return new Editor(element, {
        plugins: [{ activate: (context) => [context.registerHighlighter({ operation })] }],
      });
    }
  `)

  expect(loadedAtStart(chunks)).toContain(CONTROLLER)
})

it('loads the syntax controller with a structural provider from the worker entry', () => {
  const chunks = consumerChunks(`
    import { Editor } from ${JSON.stringify(`${dist}editor.js`)};
    import { defineStructuralOperation } from ${JSON.stringify(`${dist}document/workerEntry.js`)};
    export function mount(element) {
      const operation = defineStructuralOperation(() => null);
      return new Editor(element, {
        plugins: [{ activate: (context) => [context.registerSyntaxProvider({ operation })] }],
      });
    }
  `)

  expect(loadedAtStart(chunks)).toContain(CONTROLLER)
})
