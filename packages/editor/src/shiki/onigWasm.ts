import onigWasmUrl from 'shiki/onig.wasm?url'

type NodeFsPromises = {
  readFile(path: string | URL): Promise<Uint8Array>
}

type NodeProcessLike = {
  readonly versions?: { readonly node?: string }
  getBuiltinModule?: (id: string) => unknown
}

function nodeFsPromises(): NodeFsPromises | null {
  const proc = (globalThis as { readonly process?: NodeProcessLike }).process
  if (!proc?.versions?.node) return null
  const fs = proc.getBuiltinModule?.('node:fs/promises') as NodeFsPromises | undefined
  return typeof fs?.readFile === 'function' ? fs : null
}

function isLocalPath(url: string): boolean {
  if (url.startsWith('file:')) return true
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) && !url.startsWith('//')
}

function resolveLocalTarget(url: string): string | URL {
  if (url.startsWith('file:')) return new URL(url)
  if (url.startsWith('/@fs/')) return url.slice('/@fs'.length)
  return url
}

function canStreamWasm(url: string, contentType: string): boolean {
  if (url.startsWith('data:')) return false
  if (typeof WebAssembly.instantiateStreaming !== 'function') return false
  return /^application\/wasm(?:$|;|\s)/i.test(contentType.trim())
}

async function instantiateFromFetch(
  url: string,
  importObject?: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch Oniguruma WASM (${response.status}): ${url}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (canStreamWasm(url, contentType)) {
    return WebAssembly.instantiateStreaming(response, importObject)
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), importObject)
}

/**
 * Loads and instantiates Oniguruma's WASM binary from the emitted `onig.wasm` asset.
 * Uses `WebAssembly.instantiateStreaming` in browsers when served with `application/wasm`,
 * falls back to `arrayBuffer()` otherwise, and reads directly from disk in Node/Bun.
 */
export async function loadOnigWasm(
  importObject?: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return loadOnigWasmFromUrl(onigWasmUrl, importObject)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}

export async function loadOnigWasmFromUrl(
  url: string,
  importObject?: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const fs = nodeFsPromises()
  if (fs && isLocalPath(url)) {
    const bytes = await fs.readFile(resolveLocalTarget(url))
    return WebAssembly.instantiate(toArrayBuffer(bytes), importObject)
  }
  return instantiateFromFetch(url, importObject)
}
