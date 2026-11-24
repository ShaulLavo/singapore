import { createTreeSource, disposeTreeSources } from './factories/source'
import { afterEach, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { resolveTreeSitterLanguageContribution } from '../src/treeSitter/registry'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import workerSource from '../src/treeSitter/treeSitter.worker.ts?raw'

/**
 * Worker time for one visible-range highlight request on a 50,000-line file, per phase and per
 * 100 KB of range, next to whole-document highlighting scaled to 100 KB. Run on demand with
 * `bun run bench:range`; it writes medians and every sample to `.vitest/range-query-profile.json`
 * in this package, and is not part of the browser test list.
 */
afterEach(() => disposeTreeSources())

const browserTest = it.skipIf(typeof Worker === 'undefined')
const RANGE_UNITS = 100_000
const RUNS = 7
const PHASES = [
  'treeSitter.queryRange',
  'treeSitter.highlightQueryAndPredicates',
  'treeSitter.captureNormalization',
  'treeSitter.structuralWalk',
  'treeSitter.foldQueryAndPredicates',
  'treeSitter.captureSorting',
  'treeSitter.overlapResolution',
  'treeSitter.packing',
] as const

browserTest(
  'profiles range highlight requests on a 50,000-line TypeScript file',
  async () => {
    const text = repeatToLines(workerSource, 50_000)
    const backend = new TreeSitterWorkerClient()
    await backend.registerLanguages(
      await Promise.all(
        ['typescript', 'jsdoc', 'regex'].map((id) =>
          resolveTreeSitterLanguageContribution(
            TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((language) => language.id === id)!,
          ),
        ),
      ),
    )
    const source = createTreeSource(backend.sourceEndpoint, text)
    const document = {
      documentId: 'range-profile.ts',
      languageId: 'typescript',
      snapshotVersion: 1,
    }
    const request = { ...document, runtimeSessionId: 'range-profile-2' }
    const samples: Record<string, number[]> = {}
    const fullDocument: Record<string, number[]> = {}
    try {
      // Whole-document highlighting, scaled to 100 KB, is the per-byte cost a range should match.
      // The first parse warms the worker; the range requests then use the last session's tree.
      for (let session = 0; session < 3; session += 1) {
        const prepared = await source.prepare()
        const result = await backend.parse({
          ...document,
          runtimeSessionId: `range-profile-${session}`,
          source: prepared.reference,
          includeHighlights: true,
          includeCaptures: false,
        })
        await prepared.dispose()
        if (session === 0) continue
        for (const { name, durationMs } of result?.timings ?? [])
          (fullDocument[name] ??= []).push((durationMs * RANGE_UNITS) / text.length)
      }

      const starts = [0.02, 0.2, 0.4, 0.6, 0.8].map((at) => Math.floor(text.length * at))
      for (let run = -1; run < RUNS; run += 1) {
        for (const startIndex of starts) {
          const result = await backend.queryRange({
            ...request,
            includeHighlights: true,
            includeCaptures: false,
            range: { startIndex, endIndex: startIndex + RANGE_UNITS },
          })
          expect(result?.degraded ?? []).toEqual([])
          expect(result?.tokensPacked?.starts.length).toBeGreaterThan(1_000)
          if (run < 0) continue
          for (const { name, durationMs } of result?.timings ?? [])
            (samples[name] ??= []).push(durationMs)
        }
      }
    } finally {
      source.dispose()
      await backend.dispose()
    }

    const medians = Object.fromEntries(PHASES.map((name) => [name, median(samples[name] ?? [])]))
    const fullDocumentPerRange = Object.fromEntries(
      Object.entries(fullDocument).map(([name, values]) => [name, median(values)]),
    )
    await commands.writeFile(
      '.vitest/range-query-profile.json',
      JSON.stringify(
        {
          textLength: text.length,
          rangeUnits: RANGE_UNITS,
          medians,
          fullDocumentPerRange,
          samples,
        },
        null,
        2,
      ),
    )
    expect(samples['treeSitter.queryRange']).toHaveLength(RUNS * 5)
  },
  300_000,
)

const repeatToLines = (text: string, lines: number): string => {
  const sourceLines = text.split('\n')
  return Array.from({ length: lines }, (_, index) => sourceLines[index % sourceLines.length]).join(
    '\n',
  )
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}
