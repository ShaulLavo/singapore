import {
  BUILTIN_PACKS,
  FONT_STYLE_BOLD,
  FONT_STYLE_ITALIC,
  FONT_STYLE_STRIKETHROUGH,
  FONT_STYLE_UNDERLINE,
  ScopeCompat,
  getBuiltinPack,
  highlightTreeWithFallback,
  resolveZedPlusScopes,
  type ScopeHighlightSession,
  type ScopePack,
  type ScopeResult,
  type ScopeTheme,
  type StyledResult,
  type TextEdit as ScopeTextEdit,
} from '@shaulavo/tree-sitter-scope-compat'
import scopeCompatWasmUrl from '@shaulavo/tree-sitter-scope-compat/scope-compat.wasm?url'
import cssPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/css/css.scm?raw'
import goPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/go/go.scm?raw'
import htmlPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/html/html.scm?raw'
import javascriptCommonPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/shared/javascript-common.scm?raw'
import javascriptPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/javascript/javascript.scm?raw'
import jsonPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/json/json.scm?raw'
import jsxPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/jsx/jsx.scm?raw'
import pythonPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/python/python.scm?raw'
import rustPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/rust/rust.scm?raw'
import shellscriptPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/shellscript/shellscript.scm?raw'
import tomlPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/toml/toml.scm?raw'
import typescriptCommonPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/shared/typescript-common.scm?raw'
import typescriptPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/typescript/typescript.scm?raw'
import tsxPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/tsx/tsx.scm?raw'
import yamlPackQuery from '@shaulavo/tree-sitter-scope-compat/packs/yaml/yaml.scm?raw'
import {
  Edit,
  TextBuffer,
  heap,
  loadExtension,
  type Language,
  type Parser,
  type Query,
  type Tree,
} from 'web-tree-sitter'
import type { TextEdit } from '@singapore-editor/core/document'
import {
  editorThemeFromVscodeTheme,
  type EditorTheme,
  type VscodeThemeRegistration,
} from '@singapore-editor/core/rendering'
import type { EditorTokenStyle, PackedEditorTokens } from '@singapore-editor/core/syntax'
import type {
  TreeSitterCapture,
  TreeSitterHighlightResult,
  TreeSitterInputEdit,
  TreeSitterLanguageId,
} from './types'

const MAX_COMPILED_THEMES = 32
const BYTE_ORDER_MARK = 0xfeff
const LINE_SEPARATOR = 0x2028
const PARAGRAPH_SEPARATOR = 0x2029

const PACK_QUERY_SOURCES: Readonly<Record<string, string>> = {
  css: cssPackQuery,
  go: goPackQuery,
  html: htmlPackQuery,
  javascript: `${javascriptCommonPackQuery}\n${javascriptPackQuery}`,
  json: jsonPackQuery,
  jsx: `${javascriptCommonPackQuery}\n${jsxPackQuery}`,
  python: pythonPackQuery,
  rust: rustPackQuery,
  shellscript: shellscriptPackQuery,
  toml: tomlPackQuery,
  tsx: `${typescriptCommonPackQuery}\n${tsxPackQuery}`,
  typescript: `${typescriptCommonPackQuery}\n${typescriptPackQuery}`,
  yaml: yamlPackQuery,
}

const FALLBACK_SCOPE_INFO: Readonly<
  Record<string, { readonly rootScope: string; readonly scopeSuffix: string }>
> = {
  astro: { rootScope: 'source.astro', scopeSuffix: '.astro' },
  c: { rootScope: 'source.c', scopeSuffix: '.c' },
  cpp: { rootScope: 'source.cpp', scopeSuffix: '.cpp' },
  csharp: { rootScope: 'source.cs', scopeSuffix: '.cs' },
  java: { rootScope: 'source.java', scopeSuffix: '.java' },
  jsdoc: { rootScope: 'comment.block.documentation.js', scopeSuffix: '.jsdoc' },
  lua: { rootScope: 'source.lua', scopeSuffix: '.lua' },
  markdown: { rootScope: 'text.html.markdown', scopeSuffix: '.markdown' },
  mdx: { rootScope: 'source.mdx', scopeSuffix: '.mdx' },
  php: { rootScope: 'source.php', scopeSuffix: '.php' },
  regex: { rootScope: 'source.regexp', scopeSuffix: '.regexp' },
  sql: { rootScope: 'source.sql', scopeSuffix: '.sql' },
  svelte: { rootScope: 'source.svelte', scopeSuffix: '.svelte' },
}

type MaskedLine = {
  readonly start: number
  readonly end: number
}

type SanitizedSource = {
  readonly text: string
  readonly maskedLines: readonly MaskedLine[]
  readonly hadSpecialChars: boolean
}

type CompiledPackEntry = {
  readonly pack: ScopePack
  readonly language: Language
  refCount: number
  retired: boolean
}

type ScopeDocumentState = {
  readonly runtimeSessionId: string
  readonly languageId: TreeSitterLanguageId
  readonly packId: string | null
  readonly packEntry: CompiledPackEntry | null
  readonly maxLineLength: number
  readonly missingLanguages: readonly TreeSitterLanguageId[]
  sourcePointKey: string
  themeRevision: string
  themeRegistration: VscodeThemeRegistration
  text: string
  maskedLines: readonly MaskedLine[]
  hadSpecialChars: boolean
  buffer: TextBuffer | null
  tree: Tree | null
  session: ScopeHighlightSession | null
  scopeResult: ScopeResult
}

export type ScopeThemeRuntime = {
  readonly language: Language
  readonly parser: Parser
  readonly highlightQuery: Query | null
  readonly hasInjections: boolean
}

export type ScopeLayerInput = {
  readonly languageId: TreeSitterLanguageId
  readonly depth: number
  readonly language: Language
  readonly parser: Parser
  readonly ranges: readonly {
    readonly startIndex: number
    readonly endIndex: number
    readonly startPosition: { readonly row: number; readonly column: number }
    readonly endPosition: { readonly row: number; readonly column: number }
  }[]
}

export type ScopeMultiLayerData = {
  readonly layers: readonly ScopeLayerInput[]
  readonly captures: readonly TreeSitterCapture[]
  readonly missingLanguages: readonly TreeSitterLanguageId[]
}

export type ScopeOpenInput = {
  readonly runtimeSessionId: string
  readonly languageId: TreeSitterLanguageId
  readonly packLanguageId?: string
  readonly sourcePointKey: string
  readonly text: string
  readonly themeRevision: string
  readonly themeRegistration: VscodeThemeRegistration
  readonly maxLineLength: number
  readonly ensureRuntime: (languageId: TreeSitterLanguageId) => Promise<ScopeThemeRuntime | null>
  readonly collectMultiLayer: <T>(
    languageId: TreeSitterLanguageId,
    text: string,
    consume: (data: ScopeMultiLayerData) => T,
  ) => Promise<T>
}

export type ScopeEditInput = ScopeOpenInput & {
  readonly previousPointKey: string
  readonly edits: readonly TextEdit[]
  readonly inputEdits: readonly TreeSitterInputEdit[]
}

export type ScopeRecolorInput = {
  readonly runtimeSessionId: string
  readonly themeRevision: string
  readonly themeRegistration: VscodeThemeRegistration
  readonly maxLineLength?: number
}

let compatPromise: Promise<ScopeCompat> | null = null
let wasmModulePromise: Promise<WebAssembly.Module> | null = null
const compiledPacks = new Map<string, CompiledPackEntry>()
const compiledThemes = new Map<string, ScopeTheme>()
const scopeDocuments = new Map<string, ScopeDocumentState>()

const loadScopeCompatWasmModule = async (): Promise<WebAssembly.Module> => {
  if (wasmModulePromise) return wasmModulePromise
  const pending = compileScopeCompatWasm(scopeCompatWasmUrl).catch((error) => {
    wasmModulePromise = null
    throw error
  })
  wasmModulePromise = pending
  return pending
}

const compileScopeCompatWasm = async (url: string): Promise<WebAssembly.Module> => {
  const bytes = await readLocalWasmBytes(url)
  if (bytes) return WebAssembly.compile(bytes)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch scope-compat WASM (${response.status})`)
  }
  const buffer = await response.arrayBuffer()
  return WebAssembly.compile(buffer)
}

const readLocalWasmBytes = async (url: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  const runtime = globalThis as {
    readonly process?: {
      readonly versions?: { readonly node?: string }
      readonly getBuiltinModule?: (id: string) => unknown
    }
  }
  if (!runtime.process?.versions?.node) return null
  if (/^https?:/i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) return null

  const fsPromises = runtime.process.getBuiltinModule?.('node:fs/promises') as
    | { readonly readFile?: (path: string) => Promise<Uint8Array> }
    | undefined
  if (!fsPromises?.readFile) return null
  const filePath = url.startsWith('file:') ? decodeFileUrl(url, runtime.process) : url
  const raw = await fsPromises.readFile(filePath)
  const copy = new Uint8Array(raw.byteLength)
  copy.set(raw)
  return copy
}

const decodeFileUrl = (
  url: string,
  nodeProcess: { readonly getBuiltinModule?: (id: string) => unknown },
): string => {
  const nodeUrl = nodeProcess.getBuiltinModule?.('node:url') as
    | { readonly fileURLToPath?: (input: string) => string }
    | undefined
  if (nodeUrl?.fileURLToPath) return nodeUrl.fileURLToPath(url)
  return decodeURIComponent(new URL(url).pathname)
}

export const ensureScopeCompat = async (): Promise<ScopeCompat> => {
  if (compatPromise) return compatPromise
  const pending = loadScopeCompatWasmModule()
    .then((module) => ScopeCompat.load({ loadExtension, heap }, module))
    .catch((error) => {
      compatPromise = null
      throw error
    })
  compatPromise = pending
  return pending
}

export const resolveScopePackId = (
  languageId: TreeSitterLanguageId,
  packLanguageId?: string,
): string | null => {
  if (packLanguageId) {
    const requested = getBuiltinPack(packLanguageId)
    if (requested && Object.hasOwn(PACK_QUERY_SOURCES, requested.languageId)) {
      return requested.languageId
    }
  }
  const builtin = getBuiltinPack(languageId)
  if (!builtin || !Object.hasOwn(PACK_QUERY_SOURCES, builtin.languageId)) return null
  return builtin.languageId
}

const releaseCompiledPackIfUnused = (entry: CompiledPackEntry): void => {
  if (!entry.retired || entry.refCount > 0 || entry.pack.disposed) return
  entry.pack.dispose()
}

const getCompiledPack = (
  compat: ScopeCompat,
  packId: string,
  language: Language,
): CompiledPackEntry => {
  const existing = compiledPacks.get(packId)
  if (existing && existing.language === language && !existing.pack.disposed) {
    return existing
  }
  if (existing) {
    compiledPacks.delete(packId)
    existing.retired = true
    releaseCompiledPackIfUnused(existing)
  }
  const metadata = BUILTIN_PACKS[packId]!
  const query = PACK_QUERY_SOURCES[packId]!
  const pack = compat.compilePack(language, {
    languageId: metadata.languageId,
    rootScope: metadata.rootScope,
    scopeSuffix: metadata.scopeSuffix,
    query,
    localInvalidation: metadata.localInvalidation,
  })
  const entry: CompiledPackEntry = { pack, language, refCount: 0, retired: false }
  compiledPacks.set(packId, entry)
  return entry
}

const themeCacheKey = (themeRevision: string, themeRegistration: VscodeThemeRegistration): string =>
  `${themeRevision}\0${JSON.stringify(themeRegistration)}`

const getCompiledTheme = (
  compat: ScopeCompat,
  themeRevision: string,
  themeRegistration: VscodeThemeRegistration,
): ScopeTheme => {
  const key = themeCacheKey(themeRevision, themeRegistration)
  const existing = compiledThemes.get(key)
  if (existing && !existing.disposed) {
    compiledThemes.delete(key)
    compiledThemes.set(key, existing)
    return existing
  }
  const compiled = compat.compileTheme(themeRegistration)
  compiledThemes.set(key, compiled)
  if (compiledThemes.size > MAX_COMPILED_THEMES) {
    const oldest = compiledThemes.keys().next().value
    if (oldest !== undefined) {
      compiledThemes.get(oldest)?.dispose()
      compiledThemes.delete(oldest)
    }
  }
  return compiled
}

export const loadScopeTheme = async (
  themeRevision: string,
  themeRegistration: VscodeThemeRegistration,
): Promise<EditorTheme> => {
  const compat = await ensureScopeCompat()
  getCompiledTheme(compat, themeRevision, themeRegistration)
  return editorThemeFromVscodeTheme(themeRegistration)
}

export const openScopeDocument = async (
  input: ScopeOpenInput,
): Promise<TreeSitterHighlightResult> => {
  disposeScopeDocument(input.runtimeSessionId)
  const compat = await ensureScopeCompat()
  const editorTheme = editorThemeFromVscodeTheme(input.themeRegistration)
  const sanitized = sanitizeSourceText(input.text, input.maxLineLength)
  const state = await buildScopeDocumentState(compat, input, sanitized)
  // Re-clear in case an overlapping open installed a state while awaiting grammar/captures.
  disposeScopeDocument(input.runtimeSessionId)
  scopeDocuments.set(input.runtimeSessionId, state)
  // Acquire the compiled theme synchronously right before resolve so concurrent requests cannot evict it.
  const theme = getCompiledTheme(compat, input.themeRevision, input.themeRegistration)
  const styled = theme.resolve(state.scopeResult)
  const tokensPacked = styledResultToPackedTokens(styled, input.text, sanitized.maskedLines)
  return {
    tokensPacked,
    theme: editorTheme,
    untokenizedLines: sanitized.maskedLines.length,
    ...(state.missingLanguages.length > 0 ? { missingLanguages: state.missingLanguages } : {}),
  }
}

export const editScopeDocument = async (
  input: ScopeEditInput,
): Promise<TreeSitterHighlightResult> => {
  const existing = scopeDocuments.get(input.runtimeSessionId)
  if (!canIncrementallyUpdate(existing, input)) {
    return openScopeDocument(input)
  }
  const compat = await ensureScopeCompat()
  const runtime = await input.ensureRuntime(input.languageId)
  const current = scopeDocuments.get(input.runtimeSessionId)
  if (
    !runtime ||
    current !== existing ||
    !existing.buffer ||
    !existing.tree ||
    !existing.session ||
    !existing.packEntry ||
    existing.packEntry.language !== runtime.language ||
    existing.packEntry.pack.disposed
  ) {
    return openScopeDocument(input)
  }

  applyBufferEdits(existing.buffer, input.edits)
  for (const inputEdit of input.inputEdits) existing.tree.edit(new Edit(inputEdit))
  const nextTree = runtime.parser.parse(existing.buffer, existing.tree)
  if (!nextTree) return openScopeDocument(input)

  const changedRanges = existing.tree.getChangedRanges(nextTree)
  existing.tree.delete()
  existing.tree = nextTree
  const scopeEdits = toScopeTextEdits(input.edits)
  existing.scopeResult = existing.session.update(nextTree, existing.buffer, {
    edits: scopeEdits,
    changedRanges,
  })
  existing.sourcePointKey = input.sourcePointKey
  existing.text = input.text
  existing.themeRevision = input.themeRevision
  existing.themeRegistration = input.themeRegistration

  const theme = getCompiledTheme(compat, input.themeRevision, input.themeRegistration)
  const styled = theme.resolve(existing.scopeResult)
  const tokensPacked = styledResultToPackedTokens(styled, input.text, existing.maskedLines)
  return {
    tokensPacked,
    theme: editorThemeFromVscodeTheme(input.themeRegistration),
    untokenizedLines: 0,
  }
}

export const recolorScopeDocument = async (
  input: ScopeRecolorInput,
): Promise<TreeSitterHighlightResult | null> => {
  const existing = scopeDocuments.get(input.runtimeSessionId)
  if (!existing) return null
  if (input.maxLineLength !== undefined && input.maxLineLength !== existing.maxLineLength) {
    return null
  }
  const compat = await ensureScopeCompat()
  const current = scopeDocuments.get(input.runtimeSessionId)
  if (!current) return null
  if (input.maxLineLength !== undefined && input.maxLineLength !== current.maxLineLength) {
    return null
  }
  const theme = getCompiledTheme(compat, input.themeRevision, input.themeRegistration)
  current.themeRevision = input.themeRevision
  current.themeRegistration = input.themeRegistration
  const styled = theme.resolve(current.scopeResult)
  const tokensPacked = styledResultToPackedTokens(styled, current.text, current.maskedLines)
  return {
    tokensPacked,
    theme: editorThemeFromVscodeTheme(input.themeRegistration),
    untokenizedLines: current.maskedLines.length,
  }
}

export const disposeScopeDocument = (runtimeSessionId: string): void => {
  const state = scopeDocuments.get(runtimeSessionId)
  if (!state) return
  scopeDocuments.delete(runtimeSessionId)
  state.tree?.delete()
  state.buffer?.delete()
  state.session?.reset()
  if (state.packEntry) {
    state.packEntry.refCount = Math.max(0, state.packEntry.refCount - 1)
    releaseCompiledPackIfUnused(state.packEntry)
  }
}

export const disposeScopePacksForLanguage = (languageId: TreeSitterLanguageId): void => {
  for (const [sessionId, state] of Array.from(scopeDocuments.entries())) {
    if (state.languageId === languageId) disposeScopeDocument(sessionId)
  }
  const packIds = languageId === 'javascript' ? ['javascript', 'jsx'] : [languageId]
  for (const packId of packIds) {
    const entry = compiledPacks.get(packId)
    if (!entry) continue
    compiledPacks.delete(packId)
    entry.retired = true
    releaseCompiledPackIfUnused(entry)
  }
}

export const disposeAllScopeCompat = (): void => {
  for (const sessionId of Array.from(scopeDocuments.keys())) {
    disposeScopeDocument(sessionId)
  }
  for (const entry of compiledPacks.values()) {
    entry.retired = true
    releaseCompiledPackIfUnused(entry)
  }
  compiledPacks.clear()
  for (const theme of compiledThemes.values()) theme.dispose()
  compiledThemes.clear()
  compatPromise = null
}

export const inspectScopeCompatRetention = () => ({
  documentCount: scopeDocuments.size,
  packCount: compiledPacks.size,
  themeCount: compiledThemes.size,
})

const canIncrementallyUpdate = (
  existing: ScopeDocumentState | undefined,
  input: ScopeEditInput,
): existing is ScopeDocumentState => {
  if (!existing) return false
  if (existing.languageId !== input.languageId) return false
  if (existing.sourcePointKey !== input.previousPointKey) return false
  if (existing.maxLineLength !== input.maxLineLength) return false
  if (
    !existing.packId ||
    !existing.packEntry ||
    existing.packEntry.pack.disposed ||
    !existing.buffer ||
    !existing.tree ||
    !existing.session
  ) {
    return false
  }
  if (existing.hadSpecialChars || existing.maskedLines.length > 0) return false
  if (input.edits.length === 0 || input.inputEdits.length === 0) return false
  if (editsHaveSpecialChars(input.edits)) return false
  return !hasLineOverLimit(input.text, input.maxLineLength)
}

const editsHaveSpecialChars = (edits: readonly TextEdit[]): boolean => {
  for (const edit of edits) {
    if (containsSpecialLineChar(edit.text)) return true
  }
  return false
}

const containsSpecialLineChar = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === BYTE_ORDER_MARK || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) {
      return true
    }
    if (code === 13 && text.charCodeAt(index + 1) !== 10) return true
  }
  return false
}

const hasLineOverLimit = (text: string, maxLineLength: number): boolean => {
  let lineLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10 || code === 13) {
      lineLength = 0
      continue
    }
    lineLength += 1
    if (lineLength > maxLineLength) return true
  }
  return false
}

const applyBufferEdits = (buffer: TextBuffer, edits: readonly TextEdit[]): void => {
  const ordered = edits.toSorted((left, right) => right.from - left.from || right.to - left.to)
  for (const edit of ordered) {
    buffer.edit(edit.from, edit.to, edit.text)
  }
}

const toScopeTextEdits = (edits: readonly TextEdit[]): readonly ScopeTextEdit[] =>
  edits.map((edit) => ({ from: edit.from, to: edit.to, insertLength: edit.text.length }))

const buildScopeDocumentState = async (
  compat: ScopeCompat,
  input: ScopeOpenInput,
  sanitized: SanitizedSource,
): Promise<ScopeDocumentState> => {
  const packId = resolveScopePackId(input.languageId, input.packLanguageId)
  const runtime =
    input.languageId === 'markdown' ? null : await input.ensureRuntime(input.languageId)
  if (packId && runtime && !shouldUseMultiLayerFallback(input.languageId, runtime)) {
    return buildPackDocumentState(compat, input, sanitized, packId, runtime)
  }
  if (runtime && runtime.highlightQuery && !runtime.hasInjections) {
    return buildSingleLayerFallbackState(input, sanitized, runtime)
  }
  const scopeInfo = fallbackScopeInfo(input.languageId)
  const collected = await input.collectMultiLayer(input.languageId, sanitized.text, (data) => ({
    scopeResult: buildScopeResultFromMultiLayer(
      compat,
      data,
      sanitized.text,
      scopeInfo.rootScope,
      scopeInfo.scopeSuffix,
    ),
    missingLanguages: data.missingLanguages,
  }))
  return createFallbackState(input, sanitized, collected.scopeResult, collected.missingLanguages)
}

const shouldUseMultiLayerFallback = (
  languageId: TreeSitterLanguageId,
  runtime: ScopeThemeRuntime,
): boolean => languageId === 'html' && runtime.hasInjections

const buildPackDocumentState = (
  compat: ScopeCompat,
  input: ScopeOpenInput,
  sanitized: SanitizedSource,
  packId: string,
  runtime: ScopeThemeRuntime,
): ScopeDocumentState => {
  const packEntry = getCompiledPack(compat, packId, runtime.language)
  const buffer = new TextBuffer(sanitized.text)
  const tree = runtime.parser.parse(buffer)
  if (!tree) {
    buffer.delete()
    throw new Error(`Tree-sitter failed to parse ${input.languageId}`)
  }
  let session: ScopeHighlightSession | null = null
  let scopeResult: ScopeResult
  try {
    session = compat.createSession(packEntry.pack, packEntry.pack.languageId)
    scopeResult = session.update(tree, buffer)
  } catch (error) {
    session?.reset()
    tree.delete()
    buffer.delete()
    throw error
  }
  packEntry.refCount += 1
  return {
    runtimeSessionId: input.runtimeSessionId,
    languageId: input.languageId,
    packId,
    packEntry,
    maxLineLength: input.maxLineLength,
    missingLanguages: [],
    sourcePointKey: input.sourcePointKey,
    themeRevision: input.themeRevision,
    themeRegistration: input.themeRegistration,
    text: input.text,
    maskedLines: sanitized.maskedLines,
    hadSpecialChars: sanitized.hadSpecialChars,
    buffer,
    tree,
    session,
    scopeResult,
  }
}

const buildSingleLayerFallbackState = (
  input: ScopeOpenInput,
  sanitized: SanitizedSource,
  runtime: ScopeThemeRuntime,
): ScopeDocumentState => {
  const tree = runtime.parser.parse(sanitized.text)
  if (!tree) throw new Error(`Tree-sitter failed to parse ${input.languageId}`)
  try {
    const scopeInfo = fallbackScopeInfo(input.languageId)
    const scopeResult = highlightTreeWithFallback(runtime.highlightQuery!, tree, sanitized.text, {
      rootScope: scopeInfo.rootScope,
      scopeSuffix: scopeInfo.scopeSuffix,
    })
    return createFallbackState(input, sanitized, scopeResult)
  } finally {
    tree.delete()
  }
}

const createFallbackState = (
  input: ScopeOpenInput,
  sanitized: SanitizedSource,
  scopeResult: ScopeResult,
  missingLanguages: readonly TreeSitterLanguageId[] = [],
): ScopeDocumentState => ({
  runtimeSessionId: input.runtimeSessionId,
  languageId: input.languageId,
  packId: null,
  packEntry: null,
  maxLineLength: input.maxLineLength,
  missingLanguages,
  sourcePointKey: input.sourcePointKey,
  themeRevision: input.themeRevision,
  themeRegistration: input.themeRegistration,
  text: input.text,
  maskedLines: sanitized.maskedLines,
  hadSpecialChars: sanitized.hadSpecialChars,
  buffer: null,
  tree: null,
  session: null,
  scopeResult,
})

const fallbackScopeInfo = (
  languageId: string,
): { readonly rootScope: string; readonly scopeSuffix: string } => {
  const builtin = getBuiltinPack(languageId)
  if (builtin && typeof builtin === 'object' && typeof builtin.rootScope === 'string') {
    return { rootScope: builtin.rootScope, scopeSuffix: builtin.scopeSuffix }
  }
  const known = Object.hasOwn(FALLBACK_SCOPE_INFO, languageId)
    ? FALLBACK_SCOPE_INFO[languageId]
    : undefined
  if (known) return known
  const safe = languageId.replace(/[^A-Za-z0-9_-]/g, '') || 'text'
  return { rootScope: `source.${safe}`, scopeSuffix: `.${safe}` }
}

/**
 * Keeps exact 1-to-1 UTF-16 code-unit offsets while normalizing BOM, lone CR, and U+2028/U+2029
 * for Tree-sitter parsing and masking lines that exceed `maxLineLength`.
 */
const sanitizeSourceText = (text: string, maxLineLength: number): SanitizedSource => {
  const maskedLines: MaskedLine[] = []
  let hadSpecialChars = false
  let parts: string[] | null = null
  let copiedUntil = 0
  let index = 0
  const length = text.length

  while (index < length) {
    const lineStart = index
    let lineEnd = index
    let lineNeedsRewrite = false
    while (lineEnd < length) {
      const code = text.charCodeAt(lineEnd)
      if (code === 10 || code === 13) break
      if (code === BYTE_ORDER_MARK || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) {
        lineNeedsRewrite = true
        hadSpecialChars = true
      }
      lineEnd += 1
    }
    const lineLen = lineEnd - lineStart
    const isMasked = lineLen > maxLineLength
    if (isMasked) maskedLines.push({ start: lineStart, end: lineEnd })

    if (isMasked || lineNeedsRewrite) {
      parts ??= []
      if (lineStart > copiedUntil) parts.push(text.slice(copiedUntil, lineStart))
      parts.push(
        isMasked ? ' '.repeat(lineLen) : rewriteSpecialLineChars(text.slice(lineStart, lineEnd)),
      )
      copiedUntil = lineEnd
    }

    if (lineEnd >= length) break
    const sepCode = text.charCodeAt(lineEnd)
    if (sepCode === 13 && lineEnd + 1 < length && text.charCodeAt(lineEnd + 1) === 10) {
      index = lineEnd + 2
      continue
    }
    if (sepCode === 13) {
      hadSpecialChars = true
      parts ??= []
      if (lineEnd > copiedUntil) parts.push(text.slice(copiedUntil, lineEnd))
      parts.push('\n')
      copiedUntil = lineEnd + 1
    }
    index = lineEnd + 1
  }

  if (!parts) return { text, maskedLines, hadSpecialChars }
  if (copiedUntil < length) parts.push(text.slice(copiedUntil))
  return { text: parts.join(''), maskedLines, hadSpecialChars }
}

const rewriteSpecialLineChars = (line: string): string => {
  let out = ''
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index)
    if (code === BYTE_ORDER_MARK) {
      out += ' '
      continue
    }
    if (code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) {
      out += '\n'
      continue
    }
    out += line[index]!
  }
  return out
}

type CaptureSpan = {
  readonly from: number
  readonly to: number
  readonly origFrom: number
  readonly origTo: number
  readonly depth: number
  readonly order: number
  readonly scopeIds: readonly number[]
}

const buildScopeResultFromMultiLayer = (
  compat: ScopeCompat,
  data: ScopeMultiLayerData,
  source: string,
  rootScope: string,
  defaultSuffix: string,
): ScopeResult => {
  const sourceLength = source.length
  const window = Object.freeze({ start: 0, end: sourceLength })
  if (sourceLength === 0) {
    return Object.freeze({
      sourceLength: 0,
      window,
      segments: new Uint32Array(0),
      paths: Object.freeze([Object.freeze([])]),
      scopes: Object.freeze([rootScope]),
    })
  }

  const scopes = [rootScope]
  const scopeIds = new Map<string, number>([[rootScope, 0]])
  const boundaries = new Set<number>([0, sourceLength])
  const spans: CaptureSpan[] = []
  const packHandledLayers = collectWave1LayerSpans(
    compat,
    data.layers,
    source,
    scopes,
    scopeIds,
    boundaries,
    spans,
  )
  appendFallbackCaptureSpans(
    data.captures,
    packHandledLayers,
    sourceLength,
    defaultSuffix,
    scopes,
    scopeIds,
    boundaries,
    spans,
  )
  spans.sort(compareCaptureSpan)
  const separators = collectLineSeparators(source, boundaries)
  const points = Array.from(boundaries).sort((left, right) => left - right)
  return sweepCaptureSpans(sourceLength, window, points, spans, separators, scopes)
}

const layerIdentityKey = (languageId: string, depth: number): string => `${languageId}\0${depth}`

const collectWave1LayerSpans = (
  compat: ScopeCompat,
  layers: readonly ScopeLayerInput[],
  source: string,
  scopes: string[],
  scopeIds: Map<string, number>,
  boundaries: Set<number>,
  spans: CaptureSpan[],
): Set<string> => {
  const handled = new Set<string>()
  const eligible = layers.filter((layer) => resolveScopePackId(layer.languageId) !== null)
  if (eligible.length === 0) return handled

  const buffer = new TextBuffer(source)
  try {
    let order = 0
    for (const layer of eligible) {
      const packId = resolveScopePackId(layer.languageId)
      if (!packId) continue
      const packEntry = getCompiledPack(compat, packId, layer.language)
      order = appendPackLayerSpans(
        compat,
        packEntry.pack,
        layer,
        buffer,
        source.length,
        order,
        scopes,
        scopeIds,
        boundaries,
        spans,
      )
      handled.add(layerIdentityKey(layer.languageId, layer.depth))
    }
  } finally {
    buffer.delete()
  }
  return handled
}

const appendPackLayerSpans = (
  compat: ScopeCompat,
  pack: ScopePack,
  layer: ScopeLayerInput,
  buffer: TextBuffer,
  sourceLength: number,
  startOrder: number,
  scopes: string[],
  scopeIds: Map<string, number>,
  boundaries: Set<number>,
  spans: CaptureSpan[],
): number => {
  const includedRanges = layer.ranges.filter((range) => range.startIndex < range.endIndex)
  if (includedRanges.length === 0) return startOrder
  const layerTree = layer.parser.parse(buffer, null, { includedRanges })
  if (!layerTree) return startOrder
  let order = startOrder
  try {
    for (const range of includedRanges) {
      const start = Math.max(0, range.startIndex)
      const end = Math.min(sourceLength, range.endIndex)
      if (start >= end) continue
      const result = compat.highlightTree(pack, layerTree, buffer, { window: { start, end } })
      order = appendScopeResultSpans(
        result,
        start,
        end,
        layer.depth,
        order,
        scopes,
        scopeIds,
        boundaries,
        spans,
      )
    }
  } finally {
    layerTree.delete()
  }
  return order
}

const appendScopeResultSpans = (
  result: ScopeResult,
  rangeStart: number,
  rangeEnd: number,
  depth: number,
  startOrder: number,
  scopes: string[],
  scopeIds: Map<string, number>,
  boundaries: Set<number>,
  spans: CaptureSpan[],
): number => {
  let order = startOrder
  const { segments, paths, scopes: resultScopes } = result
  for (let index = 0; index < segments.length; index += 3) {
    const from = Math.max(rangeStart, segments[index]!)
    const to = Math.min(rangeEnd, segments[index + 1]!)
    if (from >= to) continue
    const path = paths[segments[index + 2]!]
    if (!path || path.length === 0) continue
    const mapped = path.map((id) => internScope(resultScopes[id]!, scopes, scopeIds))
    spans.push({
      from,
      to,
      origFrom: from,
      origTo: to,
      depth,
      order: order++,
      scopeIds: mapped,
    })
    boundaries.add(from)
    boundaries.add(to)
  }
  return order
}

const appendFallbackCaptureSpans = (
  captures: readonly TreeSitterCapture[],
  packHandledLayers: ReadonlySet<string>,
  sourceLength: number,
  defaultSuffix: string,
  scopes: string[],
  scopeIds: Map<string, number>,
  boundaries: Set<number>,
  spans: CaptureSpan[],
): void => {
  const baseOrder = spans.length
  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index]!
    const depth = capture.injectionDepth ?? 0
    if (capture.languageId && packHandledLayers.has(layerIdentityKey(capture.languageId, depth))) {
      continue
    }
    const from = Math.max(0, capture.startIndex)
    const to = Math.min(sourceLength, capture.endIndex)
    if (from >= to) continue
    const suffix = capture.languageId
      ? fallbackScopeInfo(capture.languageId).scopeSuffix
      : defaultSuffix
    const resolved = resolveZedPlusScopes(capture.captureName, suffix)
    if (resolved.length === 0) continue
    const ids = resolved.map((scope) => internScope(scope, scopes, scopeIds))
    spans.push({
      from,
      to,
      origFrom: capture.startIndex,
      origTo: capture.endIndex,
      depth,
      order: baseOrder + index,
      scopeIds: ids,
    })
    boundaries.add(from)
    boundaries.add(to)
  }
}

const compareCaptureSpan = (left: CaptureSpan, right: CaptureSpan): number =>
  left.from - right.from ||
  left.depth - right.depth ||
  left.origFrom - right.origFrom ||
  right.origTo - left.origTo ||
  left.order - right.order

const internScope = (scope: string, scopes: string[], scopeIds: Map<string, number>): number => {
  const existing = scopeIds.get(scope)
  if (existing !== undefined) return existing
  const id = scopes.length
  scopes.push(scope)
  scopeIds.set(scope, id)
  return id
}

const collectLineSeparators = (source: string, boundaries: Set<number>): Map<number, number> => {
  const separators = new Map<number, number>()
  let cursor = 0
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor)
    if (code === 10) {
      separators.set(cursor, cursor + 1)
      boundaries.add(cursor)
      boundaries.add(cursor + 1)
      cursor += 1
      continue
    }
    if (code === 13 && cursor + 1 < source.length && source.charCodeAt(cursor + 1) === 10) {
      separators.set(cursor, cursor + 2)
      boundaries.add(cursor)
      boundaries.add(cursor + 2)
      cursor += 2
      continue
    }
    cursor += 1
  }
  return separators
}

const sweepCaptureSpans = (
  sourceLength: number,
  window: { readonly start: number; readonly end: number },
  points: readonly number[],
  spans: readonly CaptureSpan[],
  separators: ReadonlyMap<number, number>,
  scopes: readonly string[],
): ScopeResult => {
  const paths: (readonly number[])[] = [Object.freeze([]), Object.freeze([0])]
  const pathIndex = new Map<string, number>([
    ['', 0],
    ['0', 1],
  ])
  const active: CaptureSpan[] = []
  const rawSegments: number[] = []
  let spanIndex = 0
  let separatorEnd = -1

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!
    const to = points[index + 1]!
    pruneExpiredSpans(active, from)
    spanIndex = advanceActiveSpans(active, spans, spanIndex, from)
    const sep = separators.get(from)
    if (sep !== undefined) separatorEnd = sep
    const pathId = from < separatorEnd ? 0 : buildActivePath(active, paths, pathIndex)
    const len = rawSegments.length
    if (len > 0 && rawSegments[len - 2] === from && rawSegments[len - 1] === pathId) {
      rawSegments[len - 2] = to
      continue
    }
    rawSegments.push(from, to, pathId)
  }

  return Object.freeze({
    sourceLength,
    window,
    segments: Uint32Array.from(rawSegments),
    paths: Object.freeze(paths),
    scopes: Object.freeze(scopes),
  })
}

const pruneExpiredSpans = (active: CaptureSpan[], from: number): void => {
  let write = 0
  for (let read = 0; read < active.length; read += 1) {
    const span = active[read]!
    if (span.to > from) active[write++] = span
  }
  active.length = write
}

const advanceActiveSpans = (
  active: CaptureSpan[],
  spans: readonly CaptureSpan[],
  index: number,
  from: number,
): number => {
  let cursor = index
  while (cursor < spans.length && spans[cursor]!.from <= from) {
    const span = spans[cursor]!
    if (span.to > from) active.push(span)
    cursor += 1
  }
  return cursor
}

const buildActivePath = (
  active: readonly CaptureSpan[],
  paths: (readonly number[])[],
  pathIndex: Map<string, number>,
): number => {
  if (active.length === 0) return 1
  const stack = [0]
  for (const span of active) {
    for (const id of span.scopeIds) {
      if (stack[stack.length - 1] !== id) stack.push(id)
    }
  }
  const key = stack.join(',')
  const existing = pathIndex.get(key)
  if (existing !== undefined) return existing
  const id = paths.length
  paths.push(Object.freeze(stack))
  pathIndex.set(key, id)
  return id
}

type StylePaletteBuilder = {
  readonly styles: EditorTokenStyle[]
  readonly styleIdByResolvedIndex: Int32Array
  readonly defaultStyleId: number
}

const buildStylePalette = (styled: StyledResult): StylePaletteBuilder => {
  const styles: EditorTokenStyle[] = []
  const byKey = new Map<string, number>()
  const intern = (fg: number, bg: number, mask: number): number => {
    const effectiveBg = bg !== 0 && bg !== styled.defaultBackgroundRgba ? bg : 0
    const key = `${fg}:${effectiveBg}:${mask}`
    const existing = byKey.get(key)
    if (existing !== undefined) return existing
    const style = buildEditorTokenStyle(fg, effectiveBg, mask)
    if (!style) return -1
    const id = styles.length
    styles.push(style)
    byKey.set(key, id)
    return id
  }

  const count = styled.foregroundRgba.length
  const styleIdByResolvedIndex = new Int32Array(count)
  for (let index = 0; index < count; index += 1) {
    styleIdByResolvedIndex[index] = intern(
      styled.foregroundRgba[index]!,
      styled.backgroundRgba[index]!,
      styled.fontMask[index]!,
    )
  }
  const defaultStyleId = intern(styled.defaultForegroundRgba, 0, 0)
  return { styles, styleIdByResolvedIndex, defaultStyleId }
}

const buildEditorTokenStyle = (
  fg: number,
  bg: number,
  fontMask: number,
): EditorTokenStyle | null => {
  const style: EditorTokenStyle = {}
  if (fg !== 0) style.color = formatRgbaHex(fg)
  if (bg !== 0) style.backgroundColor = formatRgbaHex(bg)
  if (fontMask & FONT_STYLE_ITALIC) style.fontStyle = 'italic'
  if (fontMask & FONT_STYLE_BOLD) style.fontWeight = 700
  const decorations: string[] = []
  if (fontMask & FONT_STYLE_UNDERLINE) decorations.push('underline')
  if (fontMask & FONT_STYLE_STRIKETHROUGH) decorations.push('line-through')
  if (decorations.length > 0) style.textDecoration = decorations.join(' ')
  return Object.keys(style).length > 0 ? style : null
}

const formatRgbaHex = (rgba: number): string => {
  const unsigned = rgba >>> 0
  const alpha = unsigned & 0xff
  if (alpha === 0xff) {
    return `#${(unsigned >>> 8).toString(16).padStart(6, '0').toUpperCase()}`
  }
  return `#${unsigned.toString(16).padStart(8, '0').toUpperCase()}`
}

const styledResultToPackedTokens = (
  styled: StyledResult,
  originalText: string,
  maskedLines: readonly MaskedLine[],
): PackedEditorTokens => {
  const palette = buildStylePalette(styled)
  const emitted: number[] = []
  let maskedIndex = 0
  const segments = styled.segments

  for (let index = 0; index < segments.length; index += 3) {
    const segFrom = segments[index]!
    const segTo = segments[index + 1]!
    const styleId = palette.styleIdByResolvedIndex[segments[index + 2]!]!
    if (segFrom >= segTo) continue

    while (maskedIndex < maskedLines.length && maskedLines[maskedIndex]!.end <= segFrom) {
      emitMaskedLine(emitted, maskedLines[maskedIndex]!, palette.defaultStyleId)
      maskedIndex += 1
    }

    maskedIndex = emitSegmentSplitByLineEndings(
      emitted,
      originalText,
      segFrom,
      segTo,
      styleId,
      maskedLines,
      maskedIndex,
      palette.defaultStyleId,
    )
  }

  while (maskedIndex < maskedLines.length) {
    emitMaskedLine(emitted, maskedLines[maskedIndex]!, palette.defaultStyleId)
    maskedIndex += 1
  }

  const count = emitted.length / 3
  const starts = new Uint32Array(count)
  const ends = new Uint32Array(count)
  const styleIds = new Uint32Array(count)
  let previousStart = -Infinity
  let previousEnd = -Infinity
  let maxEnd = 0
  let sortedByStart = true
  let nonOverlapping = true
  let monotonicEnd = true

  for (let tokenIndex = 0; tokenIndex < count; tokenIndex += 1) {
    const base = tokenIndex * 3
    const start = emitted[base]!
    const end = emitted[base + 1]!
    if (start < previousStart) sortedByStart = false
    if (start < previousEnd) nonOverlapping = false
    if (end < maxEnd) monotonicEnd = false
    starts[tokenIndex] = start
    ends[tokenIndex] = end
    styleIds[tokenIndex] = emitted[base + 2]!
    previousStart = start
    previousEnd = end
    if (end > maxEnd) maxEnd = end
  }

  return {
    starts,
    ends,
    styleIds,
    styles: palette.styles,
    monotonicEnd,
    nonOverlapping,
    sortedByStart,
  }
}

const emitMaskedLine = (emitted: number[], line: MaskedLine, defaultStyleId: number): void => {
  if (defaultStyleId < 0 || line.start >= line.end) return
  emitted.push(line.start, line.end, defaultStyleId)
}

const emitSegmentSplitByLineEndings = (
  emitted: number[],
  text: string,
  from: number,
  to: number,
  styleId: number,
  maskedLines: readonly MaskedLine[],
  startMaskedIndex: number,
  defaultStyleId: number,
): number => {
  let cursor = from
  let maskedIndex = startMaskedIndex
  while (cursor < to) {
    const code = text.charCodeAt(cursor)
    if (code === 10 || code === 13) {
      cursor += 1
      continue
    }
    while (maskedIndex < maskedLines.length && maskedLines[maskedIndex]!.end <= cursor) {
      emitMaskedLine(emitted, maskedLines[maskedIndex]!, defaultStyleId)
      maskedIndex += 1
    }
    const masked = maskedLines[maskedIndex]
    if (masked && cursor >= masked.start && cursor < masked.end) {
      if (cursor === masked.start) {
        emitMaskedLine(emitted, masked, defaultStyleId)
        maskedIndex += 1
      }
      cursor = Math.min(to, masked.end)
      continue
    }
    const runStart = cursor
    const limit = masked && masked.start > runStart ? Math.min(to, masked.start) : to
    while (cursor < limit) {
      const ch = text.charCodeAt(cursor)
      if (ch === 10 || ch === 13) break
      cursor += 1
    }
    if (cursor > runStart && styleId >= 0) pushCoalescedToken(emitted, runStart, cursor, styleId)
  }
  return maskedIndex
}

const pushCoalescedToken = (
  emitted: number[],
  start: number,
  end: number,
  styleId: number,
): void => {
  const len = emitted.length
  if (len > 0 && emitted[len - 2] === start && emitted[len - 1] === styleId) {
    emitted[len - 2] = end
    return
  }
  emitted.push(start, end, styleId)
}
