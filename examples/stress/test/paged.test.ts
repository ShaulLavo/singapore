import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'

const run = promisify(execFile)
const proof = fileURLToPath(new URL('../paged.ts', import.meta.url))

test(
  'Chromium opens, scrolls, copies, and closes a paged source on demand',
  { timeout: 120_000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'singapore-paged-test-'))
    try {
      await run(
        'node',
        [proof, '--modes', 'demand,indexed', '--output', join(scratch, 'result.json')],
        {
          timeout: 100_000,
          env: { ...process.env, TMPDIR: scratch },
        },
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
)
