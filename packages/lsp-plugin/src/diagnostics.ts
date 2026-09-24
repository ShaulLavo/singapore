import { lspPositionToOffsetInSnapshot, type LspTextDocumentSnapshot } from '@singapore-editor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

export type LanguageServerDiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

/** A tag layer paints on top of the severity wash, so a deprecated hint is still a hint. */
export type LanguageServerDiagnosticHighlightLayer = LanguageServerDiagnosticSeverity | 'deprecated'

export type LanguageServerDiagnosticHighlightGroups = Readonly<
  Record<LanguageServerDiagnosticHighlightLayer, readonly DiagnosticHighlightRange[]>
>

type DiagnosticHighlightRange = {
  readonly start: number
  readonly end: number
}

const ERROR = 1
const WARNING = 2
const INFORMATION = 3
const HINT = 4

const DIAGNOSTIC_TAG_DEPRECATED = 2

export function summarizeDiagnostics(
  uri: lsp.DocumentUri | null,
  version: number | null,
  diagnostics: readonly lsp.Diagnostic[],
): {
  readonly uri: lsp.DocumentUri | null
  readonly version: number | null
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly counts: {
    readonly error: number
    readonly warning: number
    readonly information: number
    readonly hint: number
    readonly total: number
  }
} {
  const counts = { error: 0, warning: 0, information: 0, hint: 0 }
  for (const diagnostic of diagnostics) counts[severityForDiagnostic(diagnostic)] += 1
  return {
    uri,
    version,
    diagnostics,
    counts: {
      ...counts,
      total: diagnostics.length,
    },
  }
}

export function diagnosticHighlightGroups(
  document: LspTextDocumentSnapshot,
  diagnostics: readonly lsp.Diagnostic[],
): LanguageServerDiagnosticHighlightGroups {
  const groups = emptyHighlightGroups()

  for (const diagnostic of diagnostics) {
    const range = highlightRangeForDiagnostic(document, diagnostic)
    if (!range) continue
    groups[severityForDiagnostic(diagnostic)].push(range)
    if (diagnostic.tags?.includes(DIAGNOSTIC_TAG_DEPRECATED)) groups.deprecated.push(range)
  }

  return groups
}

function highlightRangeForDiagnostic(
  document: LspTextDocumentSnapshot,
  diagnostic: lsp.Diagnostic,
): DiagnosticHighlightRange | null {
  const start = lspPositionToOffsetInSnapshot(document, diagnostic.range.start)
  const end = lspPositionToOffsetInSnapshot(document, diagnostic.range.end)
  if (end > start) return { start, end }
  return expandEmptyRange(document.textSnapshot.length, start)
}

function expandEmptyRange(length: number, offset: number): DiagnosticHighlightRange | null {
  if (length === 0) return null
  if (offset < length) return { start: offset, end: offset + 1 }
  if (offset > 0) return { start: offset - 1, end: offset }
  return null
}

function emptyHighlightGroups(): Record<
  LanguageServerDiagnosticHighlightLayer,
  DiagnosticHighlightRange[]
> {
  return {
    error: [],
    warning: [],
    information: [],
    hint: [],
    deprecated: [],
  }
}

function severityForDiagnostic(diagnostic: lsp.Diagnostic): LanguageServerDiagnosticSeverity {
  if (diagnostic.severity === WARNING) return 'warning'
  if (diagnostic.severity === INFORMATION) return 'information'
  if (diagnostic.severity === HINT) return 'hint'
  if (diagnostic.severity === ERROR) return 'error'
  return 'error'
}
