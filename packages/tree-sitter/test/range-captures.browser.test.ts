import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, Query, type Node, type Range, type Tree } from 'web-tree-sitter'
import parserWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
// The runtime's own bundle: a large real JavaScript file with JSDoc and regex literals. The package
// exports map hides it, so it is read by path.
import javascriptSource from '../node_modules/web-tree-sitter/web-tree-sitter.js?raw'
import {
  packEditorTokens,
  treeSitterCapturesToEditorTokens,
  type PackedEditorTokens,
} from '@singapore-editor/core/syntax'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/catalog.generated'
import { resolveTreeSitterLanguageContribution } from '../src'
import type { TreeSitterLanguageDescriptor } from '../src/treeSitter/registry'
import type { TreeSitterCapture } from '../src/treeSitter/types'
import { __treeSitterWorkerInternalsForTests } from '../src/treeSitter/treeSitter.worker.ts'
import workerSource from '../src/treeSitter/treeSitter.worker.ts?raw'
import capturesSource from '../../editor/src/syntax/captures.ts?raw'
import frameworksMarkdown from '../../../site/src/content/docs/docs/guides/frameworks.md?raw'
import designMarkdown from '../../textbuffer/docs/design.md?raw'

const { collectCaptures, flattenLayerSlices, rangeSlices } = __treeSitterWorkerInternalsForTests

type SyntaxRange = { readonly startIndex: number; readonly endIndex: number }
type LoadedLanguage = {
  readonly descriptor: TreeSitterLanguageDescriptor
  readonly language: Language
}
type Layer = {
  readonly languageId: string
  readonly depth: number
  readonly tree: Tree
  readonly loaded: LoadedLanguage
  /** The regions an injected tree covers; empty for the root. */
  readonly ranges: readonly Range[]
}
type SliceLayer = Parameters<typeof flattenLayerSlices>[0]
type SliceRuntime = Parameters<typeof flattenLayerSlices>[1]
type SliceResult = Parameters<typeof flattenLayerSlices>[2]
// The worker answers a range longer than this in slices.
const SLICE_UNITS = 8_192

const languages = new Map<string, Promise<LoadedLanguage>>()
const trees: Tree[] = []
const parser = { current: null as Parser | null }

beforeAll(async () => {
  await Parser.init({ locateFile: () => parserWasmUrl })
  parser.current = new Parser()
})

afterAll(() => {
  for (const tree of trees.splice(0)) tree.delete()
  parser.current?.delete()
})

/**
 * Range highlights used to come from `query.captures`, which yields captures in document order.
 * This is that implementation, kept as the reference the faster path must reproduce token for
 * token: a capture per name per span, first arrival wins, sorted the way a range result is.
 */
const referenceRangeCaptures = (
  tree: Tree,
  query: Query,
  languageId: string,
  range: SyntaxRange,
): TreeSitterCapture[] => {
  const captures: TreeSitterCapture[] = []
  const seen = new Set<string>()
  for (const capture of query.captures(tree.rootNode, range)) {
    const { startIndex, endIndex } = capture.node
    const key = `${startIndex}:${endIndex}:${capture.name}`
    if (seen.has(key) || startIndex >= endIndex) continue
    if (startIndex >= range.endIndex || endIndex <= range.startIndex) continue
    seen.add(key)
    captures.push({ startIndex, endIndex, captureName: capture.name, languageId })
  }

  return captures.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
}

describe('range highlight captures', () => {
  it.each([
    {
      name: 'TypeScript worker source',
      languageId: 'typescript',
      text: workerSource,
      injected: ['jsdoc', 'regex'],
    },
    {
      name: 'TypeScript overlap resolution source',
      languageId: 'typescript',
      text: capturesSource,
      injected: ['jsdoc'],
    },
    {
      name: 'JavaScript runtime bundle',
      languageId: 'javascript',
      text: javascriptSource,
      injected: ['jsdoc', 'regex'],
    },
    {
      name: 'Markdown guide with fenced code',
      languageId: 'markdown',
      text: frameworksMarkdown,
      injected: ['tsx'],
    },
    {
      name: 'Markdown design notes',
      languageId: 'markdown',
      text: designMarkdown,
      injected: ['typescript'],
    },
  ])(
    'match query.captures token for token in the $name',
    async ({ languageId, text, injected }) => {
      const layers = await parseLayers(languageId, text)
      const highlighted = layers.filter((layer) => layer.loaded.descriptor.highlightQuerySource)
      for (const id of injected)
        expect(layers.some((layer) => layer.languageId === id && layer.depth > 0)).toBe(true)

      let compared = 0
      let slicedRanges = 0
      for (const range of rangesAcross(text.length)) {
        const reference: TreeSitterCapture[] = []
        const actual: TreeSitterCapture[] = []
        for (const layer of highlighted) {
          const runtime = highlightRuntime(layer.loaded)
          const next = collectCaptures(layer.tree, runtime, cancellationContext(), range)
          const query = runtime.highlightQuery!
          const expected = referenceRangeCaptures(layer.tree, query, layer.languageId, range)
          expect(next, `${layer.languageId} ${range.startIndex}-${range.endIndex}`).toEqual(
            expected,
          )
          compared += expected.length
          appendWithDepth(reference, expected, layer.depth)
          appendWithDepth(actual, next, layer.depth)
        }
        expect(packedTokens(actual)).toEqual(packedTokens(reference))
        if (range.endIndex - range.startIndex > SLICE_UNITS)
          slicedRanges += await expectSlicedAnswerMatches(highlighted, range)
      }
      expect(compared).toBeGreaterThan(1_000)
      // Markdown has no highlight query of its own, and its fences are shorter than a slice.
      if (languageId !== 'markdown') expect(slicedRanges).toBeGreaterThan(0)
    },
  )

  // Query shapes the shipped queries barely exercise, where the capture iterator differs from
  // completed matches: a capture from a match that never finishes, alternatives of one pattern on
  // one span, quantifiers, several captures on one node, and string delimiters.
  it.each([
    { name: 'a delimiter whose match never completes', query: '(string "\\"" @keyword "\\"")' },
    {
      name: 'alternatives of one pattern on one span',
      query:
        '[(call_expression (identifier) @variable (arguments)) (call_expression (identifier) @function (arguments "("))]',
    },
    {
      name: 'quantified captures',
      query:
        '(arguments (identifier)+ @variable.parameter) (array (number)* @number) (formal_parameters (identifier)? @variable)',
    },
    {
      name: 'several captures on one node',
      query:
        '(identifier) @variable @function ((identifier) @constant (#match? @constant "^[A-Z]"))',
    },
    {
      name: 'string and template delimiters',
      query:
        '(string "\\"" @punctuation.delimiter) (string "\'" @punctuation.special) (template_string "`" @string.special) (string) @string (template_substitution "${" @punctuation.special)',
    },
    {
      name: 'a predicate over a later capture',
      query:
        '(call_expression function: (identifier) @function arguments: (arguments) @punctuation.bracket (#eq? @function "foo"))',
    },
    {
      name: 'every shape at once',
      query: [
        '(string "\\"" @keyword "\\"")',
        '[(call_expression (identifier) @variable (arguments)) (call_expression (identifier) @function (arguments "("))]',
        '(arguments (identifier)+ @variable.parameter)',
        '(identifier) @variable @function',
        '(string) @string',
        '(template_string "`" @string.special)',
      ].join('\n'),
    },
  ])('match query.captures token for token for $name', async ({ query }) => {
    const javascript = await loadLanguage('javascript')
    const loaded = {
      language: javascript.language,
      descriptor: { ...javascript.descriptor, highlightQuerySource: query },
    }
    const text = QUERY_SHAPE_SOURCE
    const tree = parseWith(loaded, text)
    let compared = 0
    for (const range of everyWindow(text.length)) {
      const runtime = highlightRuntime(loaded)
      const next = collectCaptures(tree, runtime, cancellationContext(), range)
      const expected = referenceRangeCaptures(tree, runtime.highlightQuery!, 'javascript', range)
      expect(next, `${range.startIndex}-${range.endIndex}`).toEqual(expected)
      expect(packedTokens(next.slice())).toEqual(packedTokens(expected.slice()))
      compared += expected.length
    }
    expect(compared).toBeGreaterThan(0)

    // The same shapes repeated past one slice, answered slice by slice.
    const long = (QUERY_SHAPE_SOURCE + '\n').repeat(Math.ceil((3 * SLICE_UNITS) / text.length))
    const layer = { languageId: 'javascript', depth: 0, tree: parseWith(loaded, long), loaded }
    const sliced = await expectSlicedAnswerMatches([{ ...layer, ranges: [] }], {
      startIndex: 0,
      endIndex: long.length,
    })
    expect(sliced).toBe(1)
  })
})

const QUERY_SHAPE_SOURCE = [
  '"hi"',
  "const MAX = 'x', items = [1, 2, 3], none = []",
  'foo(a)',
  'bar(alpha, beta, Gamma)',
  'function f(x) { return `a ${x} "b" ${MAX}` }',
  'obj.method("q", `t`)',
].join('\n')

/** Every window of a few lengths at every offset, so each token edge falls inside and outside. */
const everyWindow = (length: number): SyntaxRange[] => {
  const ranges: SyntaxRange[] = [{ startIndex: 0, endIndex: length }]
  for (let startIndex = 0; startIndex < length; startIndex += 1) {
    for (const size of [1, 3, 17]) {
      ranges.push({ startIndex, endIndex: Math.min(length, startIndex + size) })
    }
  }

  return ranges
}

/**
 * A long range is answered slice by slice, each capture kept by the slice holding its start. The
 * worker's sliced answer must equal the reference run over the same slices with the same rule.
 * Returns 1 when some layer was cut into more than one slice.
 */
const expectSlicedAnswerMatches = async (
  layers: readonly Layer[],
  range: SyntaxRange,
): Promise<number> => {
  const reference: TreeSitterCapture[] = []
  const actual: TreeSitterCapture[] = []
  let sliced = 0
  for (const layer of layers) {
    const sliceLayer = toSliceLayer(layer)
    const slices = rangeSlices(sliceLayer, range)
    if (slices.length > 1) sliced = 1
    const runtime = highlightRuntime(layer.loaded)
    const result = emptySliceResult()
    await flattenLayerSlices(sliceLayer, runtime, result, cancellationContext(), {
      options: { range, includeHighlights: true, includeCaptures: true },
      pacing: { isCurrent: () => true, resumedAt: performance.now() },
      slices,
    })
    appendItemsTo(actual, result.captures)
    for (const [sliceIndex, slice] of slices.entries()) {
      const expected = referenceRangeCaptures(
        layer.tree,
        runtime.highlightQuery!,
        layer.languageId,
        slice,
      ).filter((capture) => ownedBySlice(capture, slice, sliceIndex))
      appendWithDepth(reference, expected, layer.depth)
    }
  }
  reference.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  actual.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  expect(actual, `sliced ${range.startIndex}-${range.endIndex}`).toEqual(reference)
  expect(packedTokens(actual)).toEqual(packedTokens(reference))
  return sliced
}

/** The worker's rule: the first slice keeps what reaches into it, later slices what starts in them. */
const ownedBySlice = (capture: SyntaxRange, slice: SyntaxRange, sliceIndex: number): boolean => {
  if (capture.startIndex >= slice.endIndex) return false
  if (sliceIndex === 0) return capture.endIndex > slice.startIndex
  return capture.startIndex >= slice.startIndex
}

const toSliceLayer = (layer: Layer): SliceLayer =>
  ({
    id: layer.languageId,
    key: layer.languageId,
    kind: layer.depth === 0 ? 'root' : 'injection',
    parentId: null,
    parentLanguageId: null,
    languageId: layer.languageId,
    depth: layer.depth,
    tree: layer.tree,
    ranges: layer.ranges,
  }) as unknown as SliceLayer

const emptySliceResult = (): SliceResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  degraded: [],
  tokens: [],
})

const appendItemsTo = (target: TreeSitterCapture[], items: readonly TreeSitterCapture[]): void => {
  for (const item of items) target.push(item)
}

const appendWithDepth = (
  target: TreeSitterCapture[],
  captures: readonly TreeSitterCapture[],
  depth: number,
): void => {
  for (const capture of captures)
    target.push(depth === 0 ? capture : { ...capture, injectionDepth: depth })
}

const packedTokens = (captures: TreeSitterCapture[]): PackedEditorTokens => {
  captures.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  return packEditorTokens(treeSitterCapturesToEditorTokens(captures))
}

/** Whole document, windows the viewport asks for at many offsets, and windows that cut tokens. */
const rangesAcross = (length: number): SyntaxRange[] => {
  const ranges: SyntaxRange[] = [{ startIndex: 0, endIndex: length }]
  const step = Math.max(1, Math.floor(length / 24))
  for (let start = 0; start < length; start += step) {
    for (const size of [7, 333, 4_096, 21_566]) {
      const startIndex = Math.min(length, start + (size % 13))
      ranges.push({ startIndex, endIndex: Math.min(length, startIndex + size) })
    }
  }

  return ranges
}

/** One runtime per language, as the worker keeps; the sliced path also runs its fold query. */
const highlightRuntime = (loaded: LoadedLanguage): SliceRuntime => {
  const cached = runtimes.get(loaded)
  if (cached) return cached
  const runtime = {
    descriptor: loaded.descriptor,
    language: loaded.language,
    parser: parser.current,
    highlightQuery: null,
    foldQuery: null,
    injectionQuery: null,
    mergeUnitQuery: null,
  } as unknown as SliceRuntime
  runtimes.set(loaded, runtime)
  return runtime
}
const runtimes = new Map<LoadedLanguage, SliceRuntime>()

const cancellationContext = (): Parameters<typeof collectCaptures>[2] => ({
  startedAt: performance.now(),
  budgetMs: 60_000,
  flag: null,
})

const loadLanguage = async (id: string): Promise<LoadedLanguage> => {
  const existing = languages.get(id)
  if (existing) return existing
  const contribution = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find(
    (candidate) => candidate.id === id || candidate.aliases?.includes(id),
  )
  if (!contribution) throw new Error(`No Tree-sitter language for ${id}`)
  const loading = resolveTreeSitterLanguageContribution(contribution).then(async (descriptor) => ({
    descriptor,
    language: await Language.load(descriptor.wasmUrl),
  }))
  languages.set(id, loading)
  return loading
}

const parseWith = (loaded: LoadedLanguage, text: string, includedRanges?: Range[]): Tree => {
  const current = parser.current!
  current.setLanguage(loaded.language)
  const tree = current.parse(text, null, includedRanges ? { includedRanges } : undefined)!
  trees.push(tree)
  return tree
}

/**
 * The root tree and one tree per injection, the way the worker layers them: JSDoc comments and
 * regex literals inside TypeScript and JavaScript, and fenced code inside Markdown.
 */
const parseLayers = async (languageId: string, text: string): Promise<Layer[]> => {
  const loaded = await loadLanguage(languageId)
  const root: Layer = { languageId, depth: 0, tree: parseWith(loaded, text), loaded, ranges: [] }
  if (languageId === 'markdown') return [root].concat(await fenceLayers(loaded, root.tree, text))
  return [root].concat(await injectionLayers(root, text))
}

/** One tree per injected language over all of its regions, which keeps hundreds of comments cheap. */
const injectionLayers = async (parent: Layer, text: string): Promise<Layer[]> => {
  const source = parent.loaded.descriptor.injectionQuerySource
  if (!source) return []
  const query = new Query(parent.loaded.language, source)
  const regions = new Map<string, Range[]>()
  try {
    for (const match of query.matches(parent.tree.rootNode)) {
      const languageId = match.setProperties?.['injection.language']
      const content = match.captures.find((capture) => capture.name === 'injection.content')?.node
      if (!languageId || !content) continue
      const ranges = regions.get(languageId) ?? []
      ranges.push(rangeOf(content))
      regions.set(languageId, ranges)
    }
  } finally {
    query.delete()
  }

  const layers: Layer[] = []
  for (const [languageId, ranges] of regions) {
    const loaded = await loadLanguage(languageId)
    ranges.sort((left, right) => left.startIndex - right.startIndex)
    const tree = parseWith(loaded, text, ranges)
    layers.push({ languageId: loaded.descriptor.id, depth: parent.depth + 1, tree, loaded, ranges })
  }

  return layers
}

const fenceLayers = async (
  markdown: LoadedLanguage,
  tree: Tree,
  text: string,
): Promise<Layer[]> => {
  const query = new Query(
    markdown.language,
    '(fenced_code_block (info_string) @info (code_fence_content) @content)',
  )
  const layers: Layer[] = []
  try {
    for (const match of query.matches(tree.rootNode)) {
      const [info, content] = match.captures.map((capture) => capture.node)
      if (!info || !content) continue
      const languageId = info.text.trim().split(/\s/)[0]!.toLowerCase()
      const loaded = await loadLanguage(languageId).catch(() => null)
      if (!loaded) continue
      const ranges = [rangeOf(content)]
      const fence: Layer = {
        languageId: loaded.descriptor.id,
        depth: 1,
        tree: parseWith(loaded, text, ranges),
        loaded,
        ranges,
      }
      layers.push(fence)
      appendLayers(layers, await injectionLayers(fence, text))
    }
  } finally {
    query.delete()
  }

  return layers
}

const appendLayers = (target: Layer[], layers: readonly Layer[]): void => {
  for (const layer of layers) target.push(layer)
}

const rangeOf = (node: Node): Range => ({
  startIndex: node.startIndex,
  endIndex: node.endIndex,
  startPosition: node.startPosition,
  endPosition: node.endPosition,
})
