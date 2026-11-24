import { afterEach, expect, it } from 'vitest'
import { resolveTreeSitterLanguageContribution } from '../src'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'

const clients = new Set<TreeSitterWorkerClient>()
afterEach(async () => {
  for (const client of clients) await client.dispose()
  clients.clear()
})

/** A real syntax worker that reports each download it starts. */
function workerThatReportsDownloads(): { client: TreeSitterWorkerClient; fetched: string[] } {
  const fetched: string[] = []
  const client = new TreeSitterWorkerClient({
    workerFactory: () => {
      const worker = new Worker(new URL('./fixtures/fetchLog.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.addEventListener('message', (event: MessageEvent<{ fetched?: unknown }>) => {
        if (typeof event.data?.fetched === 'string') fetched.push(event.data.fetched)
      })
      return worker
    },
  })
  clients.add(client)
  return { client, fetched }
}

const grammar = async (id: string) =>
  resolveTreeSitterLanguageContribution(
    TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((contribution) => contribution.id === id)!,
  )

it('starts downloading a grammar when it is registered, before a document asks for it', async () => {
  const { client, fetched } = workerThatReportsDownloads()
  const typescript = await grammar('typescript')

  await client.registerLanguages([typescript])

  // No document exists. The grammar is the largest download on the way to the first colors, and
  // it is under way by the time the registration is answered.
  expect(fetched).toContain(typescript.wasmUrl)
})

it('downloads each registered grammar once, also when a document then uses it', async () => {
  const { client, fetched } = workerThatReportsDownloads()
  const typescript = await grammar('typescript')

  await client.registerLanguages([typescript])
  await client.warmLanguages([typescript])

  expect(fetched.filter((url) => url === typescript.wasmUrl)).toHaveLength(1)
})
