// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('retains default palette registrations in a production bundle', () => {
  const script = `import { build } from 'vite';
    const result = await build({ configFile: false, logLevel: 'silent', build: {
      write: false, minify: false, lib: {entry: process.cwd() + '/src/index.ts', formats: ['es']},
      rollupOptions: {external: id => !id.startsWith('.') && !id.startsWith('/')}
    }});
    for (const build of Array.isArray(result) ? result : [result]) {
      for (const output of build.output) if (output.type === 'chunk') console.log(output.code);
    }`
  const output = execFileSync('bun', ['--input-type=module', '-e', script], {
    cwd: '../diff',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  expect(output).toContain('#5ecc71')
  expect(output).toContain('diff.')
})
