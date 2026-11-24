import '../../src/treeSitter/treeSitter.worker'

// Tells the page about every download the worker starts, so a test can see when one begins.
// The worker client ignores messages that answer no request of its own.
const scope = globalThis as unknown as { postMessage(message: unknown): void }
const download = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  scope.postMessage({ fetched: input instanceof Request ? input.url : String(input) })
  return download(input, init)
}) as typeof fetch
