import { expect, it } from 'vitest'
import ts from 'typescript'
import { ProjectHost } from '../src/worker/projectHost'

it('renames one symbol through its package alias and canonical source', () => {
  const files = new Map([
    ['/repo/src/lib.ts', 'export const value = 1'],
    ['/repo/node_modules/pkg/index.ts', 'export const value = 1'],
    ['/repo/node_modules/pkg/package.json', '{"types":"index.ts"}'],
    ['/repo/main.ts', 'import { value } from "pkg"; value'],
  ])
  const project = new ProjectHost(
    files,
    ['/repo/src/lib.ts', '/repo/main.ts'],
    { noLib: true, moduleResolution: ts.ModuleResolutionKind.Node10 },
    { '/repo/node_modules/pkg/index.ts': '/repo/src/lib.ts' },
  )
  const locations = project.languageService.findRenameLocations(
    '/repo/src/lib.ts',
    13,
    false,
    false,
  )
  expect(locations?.map((location) => location.fileName)).toEqual([
    '/repo/src/lib.ts',
    '/repo/main.ts',
    '/repo/main.ts',
  ])
})
