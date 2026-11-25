import type * as lsp from 'vscode-languageserver-protocol'

export function sourcePathToFileName(path: string): string {
  if (hasUriScheme(path)) return documentUriToFileName(path) ?? normalizeFileNamePath(path)
  return normalizeFileNamePath(path)
}

export function pathOrUriToDocumentUri(pathOrUri: string): lsp.DocumentUri {
  if (!hasUriScheme(pathOrUri)) return fileNameToDocumentUri(sourcePathToFileName(pathOrUri))

  const fileName = documentUriToFileName(pathOrUri)
  if (!fileName) return pathOrUri
  return fileNameToDocumentUri(fileName)
}

export function fileNameToDocumentUri(fileName: string): lsp.DocumentUri {
  const normalized = normalizeFileNamePath(fileName)
  return `file://${encodePathname(normalized)}`
}

export function documentUriToFileName(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return null
    return normalizeFileNamePath(decodeURIComponent(url.pathname))
  } catch {
    return null
  }
}

/**
 * The URI of an absolute POSIX path, kept exact: a backslash is part of a name, never a separator.
 * For a host whose document ids are paths in the file tree its language server reads.
 */
export function pathToFileUri(path: string): lsp.DocumentUri {
  return `file://${encodePathname(path)}`
}

/** `file:`, an optional `//authority`, then an absolute path; a query or fragment is dropped. */
const FILE_URI = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)/i

/**
 * The exact path of a local `file:` URI: segments are decoded and nothing else is touched, so
 * `..` stays for the file tree to resolve through its symlinks. Null for anything else, including
 * a file on another host and a segment that would decode to a separator.
 */
export function fileUriToPath(uri: string): string | null {
  const [, authority, encoded] = FILE_URI.exec(uri) ?? []
  // Everything after an empty authority is path, leading slashes included.
  if (encoded === undefined || authority) return null

  const segments = encoded.split('/').map(decodeSegment)
  return segments.includes(null) ? null : segments.join('/')
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment)
    return decoded.includes('/') || decoded.includes('\0') ? null : decoded
  } catch {
    return null
  }
}

/** Whether two URIs name one file, however each sender chose to escape its path. */
export function sameFileUri(left: lsp.DocumentUri, right: lsp.DocumentUri): boolean {
  if (left === right) return true

  const path = fileUriToPath(left)
  return path !== null && path === fileUriToPath(right)
}

function normalizeFileNamePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized) return '/'
  return `/${normalized}`
}

/**
 * The form `vscode-uri` produces, which Node language servers send back: everything but RFC 3986
 * unreserved characters is escaped. A server URI is matched to an open document as a string, so a
 * path such as `app/(shop)/page.tsx` has to leave here spelled the way it will return.
 */
function encodePathname(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, percentEncode))
    .join('/')
}

function percentEncode(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}
