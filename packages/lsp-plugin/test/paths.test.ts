import { describe, expect, it } from 'vitest'
import {
  documentUriToFileName,
  fileNameToDocumentUri,
  fileUriToPath,
  pathOrUriToDocumentUri,
  pathToFileUri,
  sameFileUri,
  sourcePathToFileName,
} from '../src/paths'

describe('language server path helpers', () => {
  it('maps repo paths to VFS file names', () => {
    expect(sourcePathToFileName('packages/editor/src/editor.ts')).toBe(
      '/packages/editor/src/editor.ts',
    )
    expect(sourcePathToFileName('/packages/editor/src/editor.ts')).toBe(
      '/packages/editor/src/editor.ts',
    )
  })

  it('round-trips file names through file URIs', () => {
    const uri = fileNameToDocumentUri('/src/a file.ts')

    expect(uri).toBe('file:///src/a%20file.ts')
    expect(documentUriToFileName(uri)).toBe('/src/a file.ts')
  })

  it('escapes every reserved character the way Node language servers do', () => {
    const fileName = "/app/(shop)/[id]/it's here!/@types/a+b*.ts"
    const uri = fileNameToDocumentUri(fileName)

    expect(uri).toBe('file:///app/%28shop%29/%5Bid%5D/it%27s%20here%21/%40types/a%2Bb%2A.ts')
    expect(documentUriToFileName(uri)).toBe(fileName)
  })

  it('gives one spelling to a file URI however its sender escaped it', () => {
    expect(pathOrUriToDocumentUri('file:///app/(shop)/page.tsx')).toBe(
      'file:///app/%28shop%29/page.tsx',
    )
    expect(pathOrUriToDocumentUri('file:///app/%28shop%29/page.tsx')).toBe(
      'file:///app/%28shop%29/page.tsx',
    )
  })

  it('keeps a POSIX path exact through its URI, backslash included', () => {
    const path = '/home/project/odd\\name (1)/@scope/a b.ts'
    const uri = pathToFileUri(path)

    expect(uri).toBe('file:///home/project/odd%5Cname%20%281%29/%40scope/a%20b.ts')
    expect(fileUriToPath(uri)).toBe(path)
  })

  it('keeps dot segments, which only the file tree can resolve once symlinks are involved', () => {
    const path = '/work/link/../a.ts'

    expect(fileUriToPath(pathToFileUri(path))).toBe(path)
    expect(fileUriToPath('file:///work/./link/%2E%2E/a.ts')).toBe('/work/./link/../a.ts')
    expect(sameFileUri('file:///work/link/../a.ts', 'file:///work/a.ts')).toBe(false)
  })

  it('keeps leading slashes, which an empty authority leaves to the path', () => {
    const path = '//project/a.ts'
    const uri = pathToFileUri(path)

    expect(uri).toBe('file:////project/a.ts')
    expect(fileUriToPath(uri)).toBe(path)
    expect(fileUriToPath(pathToFileUri('///deep//a.ts'))).toBe('///deep//a.ts')
    expect(fileUriToPath('file://project/a.ts')).toBeNull()
  })

  it('reads the short local form and drops a query or fragment', () => {
    expect(fileUriToPath('file:/work/a.ts')).toBe('/work/a.ts')
    expect(fileUriToPath('FILE:///work/a.ts#L10')).toBe('/work/a.ts')
    expect(fileUriToPath('file:///work/a.ts?version=2')).toBe('/work/a.ts')
  })

  it('has no path for a URI whose segment would decode to a separator', () => {
    expect(fileUriToPath('file:///work/a%2Fb.ts')).toBeNull()
    expect(fileUriToPath('file:///work/a%00b.ts')).toBeNull()
  })

  it('has no local path for another host, another scheme or a broken escape', () => {
    expect(fileUriToPath('file://server/share/a.ts')).toBeNull()
    expect(fileUriToPath('untitled:Untitled-1')).toBeNull()
    expect(fileUriToPath('file:///a%E0%A4%A.ts')).toBeNull()
  })

  it('recognizes one file under different escapings and nothing else', () => {
    expect(sameFileUri('file:///app/(shop)/page.tsx', 'file:///app/%28shop%29/page.tsx')).toBe(true)
    expect(sameFileUri('file:///app/%28shop%29/page.tsx', 'file:///app/%28Shop%29/page.tsx')).toBe(
      false,
    )
    expect(sameFileUri('file:///a%5Cb.ts', 'file:///a/b.ts')).toBe(false)
    expect(sameFileUri('file://server/a.ts', 'file:///a.ts')).toBe(false)
    expect(sameFileUri('untitled:1', 'untitled:1')).toBe(true)
  })

  it('normalizes source paths and file URIs to document URIs', () => {
    expect(pathOrUriToDocumentUri('src/index.ts')).toBe('file:///src/index.ts')
    expect(pathOrUriToDocumentUri('file:///src/a%20file.ts')).toBe('file:///src/a%20file.ts')
  })
})
