import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

const root = new URL('./node_modules/@singapore-editor/tree-sitter-languages/', import.meta.url)
const expected = JSON.parse(
  await readFile(new URL('./notices.expected.json', import.meta.url), 'utf8'),
)
const files = ['NOTICE'].concat(
  (await readdir(new URL('notices/', root))).map((name) => `notices/${name}`),
)
assert.deepEqual(files.sort(), Object.keys(expected).sort(), 'Packed grammar notice inventory')
for (const file of files) {
  const content = await readFile(new URL(file, root))
  assert(content.length > 0, `Packed grammar notice is empty: ${file}`)
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    expected[file],
    `Packed grammar notice differs: ${file}`,
  )
}
console.log(`verified ${files.length} packed grammar notices: ${files.join(', ')}`)
