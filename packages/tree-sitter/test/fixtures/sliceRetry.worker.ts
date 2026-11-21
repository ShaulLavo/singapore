import '../../src/treeSitter/treeSitter.worker'

const fetchAsset = globalThis.fetch
let failed = false
globalThis.fetch = (input, init) => {
  if (!failed && String(input).endsWith('#slice-retry-fixture')) {
    failed = true
    return Promise.resolve(new Response('Try again', { status: 503 }))
  }
  return fetchAsset(input, init)
}
