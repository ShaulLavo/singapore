import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A temporary directory owned by one test run. The first call in a run creates it and removes it
 * when the process exits, after `beforeRemove` has had the chance to export anything worth keeping.
 * The path travels in an environment variable, so workers that load the same config reuse it and
 * never remove it. Two runs never share a directory. Only a hard kill leaves one behind.
 */
export function runTempDir(name: string, beforeRemove?: (directory: string) => void): string {
  const key = `SINGAPORE_RUN_TMP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const existing = process.env[key]
  if (existing && existsSync(existing)) return existing

  const directory = mkdtempSync(join(tmpdir(), `singapore-${name}-`))
  process.env[key] = directory
  process.once('exit', () => {
    try {
      beforeRemove?.(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return directory
}
