// Subpath imports: Rolldown keeps every differ that the package index re-exports, because it
// ignores the sideEffects flag in jsdiff's nested libesm/package.json.
//
// This lives apart from the conflict parser for the same reason: the line differ this reaches
// constructs itself when its module loads, which no bundler can prove harmless, so whatever
// imports this module downloads jsdiff. The editor parses and resolves conflicts on every
// document; only a host that writes a conflict document needs this.
import { structuredPatch } from 'diff/lib/patch/create.js'

export type CreateMergeConflictDocumentTextOptions = {
  readonly localPath: string
  readonly localText: string
  readonly remotePath?: string | null
  readonly remoteText: string | null
}

type ParsedPatchFile = {
  readonly hunks?: readonly ParsedPatchHunk[]
}

type ParsedPatchHunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

type LineSlice = {
  readonly start: number
  readonly end: number
  readonly text: string
}

const LOCAL_CONFLICT_LABEL_PREFIX = 'Local: '
const REMOTE_CONFLICT_LABEL_PREFIX = 'Remote: '

export function createMergeConflictDocumentText(
  options: CreateMergeConflictDocumentTextOptions,
): string {
  const remotePath = options.remotePath ?? options.localPath
  if (options.remoteText === null) return wholeFileConflictDocument(options, remotePath)
  if (options.localText === options.remoteText) return options.localText

  const hunks = changedPatchHunks(options, remotePath)
  if (hunks.length === 0) return options.localText

  return mergeConflictDocumentFromHunks(options, remotePath, hunks)
}

function wholeFileConflictDocument(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
): string {
  return conflictBlock(
    localConflictLabel(options.localPath),
    options.localText,
    remoteConflictLabel(remotePath),
    '',
  )
}

function changedPatchHunks(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
): readonly ParsedPatchHunk[] {
  const patch = structuredPatch(
    options.localPath,
    remotePath,
    options.localText,
    options.remoteText ?? '',
    undefined,
    undefined,
    { context: 0 },
  ) as ParsedPatchFile

  return patch.hunks ?? []
}

function mergeConflictDocumentFromHunks(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
  hunks: readonly ParsedPatchHunk[],
): string {
  const localLines = splitTextLineSlices(options.localText)
  const remoteLines = splitTextLineSlices(options.remoteText ?? '')
  const chunks: string[] = []
  let localOffset = 0

  for (const hunk of hunks) {
    const local = textSliceForHunk(options.localText, localLines, hunk.oldStart, hunk.oldLines)
    const remote = textSliceForHunk(
      options.remoteText ?? '',
      remoteLines,
      hunk.newStart,
      hunk.newLines,
    )
    chunks.push(options.localText.slice(localOffset, local.start))
    chunks.push(
      conflictBlock(
        localConflictLabel(options.localPath),
        local.text,
        remoteConflictLabel(remotePath),
        remote.text,
      ),
    )
    localOffset = local.end
  }

  chunks.push(options.localText.slice(localOffset))
  return chunks.join('')
}

function conflictBlock(
  localLabel: string,
  localText: string,
  remoteLabel: string,
  remoteText: string,
): string {
  return [
    `<<<<<<< ${localLabel}\n`,
    markerSectionText(localText),
    '=======\n',
    markerSectionText(remoteText),
    `>>>>>>> ${remoteLabel}\n`,
  ].join('')
}

function markerSectionText(text: string): string {
  if (text.length === 0) return ''
  if (text.endsWith('\n')) return text
  return `${text}\n`
}

function textSliceForHunk(
  text: string,
  lines: readonly LineSlice[],
  startLine: number,
  lineCount: number,
): LineSlice {
  const startIndex = Math.max(0, startLine - 1)
  const start = lines[startIndex]?.start ?? text.length
  if (lineCount === 0) return { start, end: start, text: '' }

  const endIndex = startIndex + lineCount - 1
  const end = lines[endIndex]?.end ?? text.length
  return {
    start,
    end,
    text: text.slice(start, end),
  }
}

function splitTextLineSlices(text: string): readonly LineSlice[] {
  const lines: LineSlice[] = []
  let start = 0
  while (start < text.length) {
    const end = nextLineEnd(text, start)
    lines.push({ start, end, text: text.slice(start, end) })
    start = end
  }

  return lines
}

function nextLineEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start)
  if (newline === -1) return text.length
  return newline + 1
}

function localConflictLabel(path: string): string {
  return `${LOCAL_CONFLICT_LABEL_PREFIX}${markerLabelPath(path)}`
}

function remoteConflictLabel(path: string): string {
  return `${REMOTE_CONFLICT_LABEL_PREFIX}${markerLabelPath(path)}`
}

function markerLabelPath(path: string): string {
  return path.replace(/[\r\n]+/g, ' ')
}
