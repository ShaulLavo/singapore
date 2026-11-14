import { mkdtemp, readdir, rmdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { runPageSuite, writeResult } from 'waffle/testing/page-runner'
import { PlaywrightDriver } from 'waffle/testing/page-runner/playwright'
import { singaporeIphoneAdapter } from './adapter'

const [flag, resultPath, ...extra] = process.argv.slice(2)
if (flag !== '--result' || !resultPath || !isAbsolute(resultPath) || extra.length) {
  throw new Error('Usage: test:iphone:webkit --result /absolute/result.json')
}
const scratch = await mkdtemp('/work/tmp/sni-')
async function removeScratchRoot(): Promise<void> {
  const remaining = await readdir(scratch)
  if (remaining.length)
    throw new Error(`Unconfirmed cleanup, retained ${scratch}: ${remaining.join(', ')}`)
  await rmdir(scratch)
}

try {
  const result = await runPageSuite(
    singaporeIphoneAdapter,
    (directory) => new PlaywrightDriver('webkit', directory),
    { scratchRoot: scratch, resultPath, port: 'ephemeral' },
  )
  await writeResult(resultPath, { execution: 'playwright-webkit', native: false, ...result })
  process.exitCode = result.exit
} finally {
  await removeScratchRoot()
}
