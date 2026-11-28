import onigWasmUrl from 'shiki/onig.wasm?url'

type NodeFsPromises = {
  readFile(path: string | URL): Promise<Uint8Array>
}

type NodeProcessLike = {
  readonly versions?: { readonly node?: string }
  getBuiltinModule?: (id: string) => unknown
}

let cachedModule: Promise<WebAssembly.Module> | null = null

function nodeFsPromises(): NodeFsPromises | null {
  const proc = (globalThis as { readonly process?: NodeProcessLike }).process
  if (!proc?.versions?.node) return null
  const fs = proc.getBuiltinModule?.('node:fs/promises') as NodeFsPromises | undefined
  return typeof fs?.readFile === 'function' ? fs : null
}

function isLocalPath(url: string): boolean {
  if (url.startsWith('file:')) return true
  if (/^[a-zA-Z]:[\\/]/.test(url)) return true
  if (url.startsWith('\\\\')) return true
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) && !url.startsWith('//')
}

function resolveLocalTarget(url: string): string | URL {
  if (url.startsWith('file:')) return new URL(url)
  if (url.startsWith('/@fs/')) return url.slice('/@fs'.length)
  return url
}

function canStreamWasm(url: string, contentType: string): boolean {
  if (url.startsWith('data:')) return false
  if (typeof WebAssembly.compileStreaming !== 'function') return false
  // Node and the WebAssembly Web API reject parameterized or non-lowercase MIME headers.
  return contentType.trim() === 'application/wasm'
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

async function compileFromFetch(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch Oniguruma WASM (${response.status}): ${url}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (canStreamWasm(url, contentType)) {
    return WebAssembly.compileStreaming(response)
  }
  return WebAssembly.compile(await response.arrayBuffer())
}

/**
 * Compiles Oniguruma's WASM module before `@shikijs/engine-oniguruma`'s `loadWasm` runs,
 * so a transient fetch failure never permanently poisons Oniguruma's internal init promise.
 */
export function loadOnigWasmModule(): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule
  const pending = compileOnigWasmFromUrl(onigWasmUrl)
  cachedModule = pending
  void pending.catch(() => {
    if (cachedModule === pending) cachedModule = null
  })
  return pending
}

export async function compileOnigWasmFromUrl(url: string): Promise<WebAssembly.Module> {
  const fs = nodeFsPromises()
  if (fs && isLocalPath(url)) {
    const bytes = await fs.readFile(resolveLocalTarget(url))
    return WebAssembly.compile(toArrayBuffer(bytes))
  }
  return compileFromFetch(url)
}

export function instantiateOnigWasmModule(
  module: WebAssembly.Module,
): (importObject?: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return async (importObject) => ({
    instance: await WebAssembly.instantiate(module, importObject),
    module,
  })
}
