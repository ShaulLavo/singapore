import { nativeMain } from 'waffle/testing/page-runner'
import { singaporeIphoneAdapter } from './adapter'

process.exitCode = await nativeMain(singaporeIphoneAdapter, process.argv.slice(2), {
  scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
  port: 'ephemeral',
})
