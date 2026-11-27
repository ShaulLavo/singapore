import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOnigWasmFromUrl } from '../../src/shiki/onigWasm'

// Minimal valid WebAssembly module header (`\0asm` version 1).
const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

describe('loadOnigWasmFromUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('streams instantiation when served with application/wasm over HTTP', async () => {
    const response = new Response(MINIMAL_WASM, {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    })
    const fetchMock = vi.fn(() => Promise.resolve(response))
    const streamingResult = {
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    }
    const streamingSpy = vi
      .spyOn(WebAssembly, 'instantiateStreaming')
      .mockResolvedValue(streamingResult)
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadOnigWasmFromUrl('https://example.test/assets/onig.wasm', {})

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/assets/onig.wasm')
    expect(streamingSpy).toHaveBeenCalledWith(response, {})
    expect(result).toBe(streamingResult)
  })

  it('falls back to arrayBuffer instantiation when content-type is not application/wasm', async () => {
    const response = new Response(MINIMAL_WASM, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    )
    const streamingSpy = vi.spyOn(WebAssembly, 'instantiateStreaming')

    const result = await loadOnigWasmFromUrl('https://example.test/assets/onig.wasm', {})

    expect(streamingSpy).not.toHaveBeenCalled()
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance)
  })

  it('rejects with status details when fetching onig.wasm fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    )

    await expect(loadOnigWasmFromUrl('https://example.test/assets/onig.wasm', {})).rejects.toThrow(
      /404/,
    )
  })

  it('reads local paths via node:fs/promises when running under Node/Bun', async () => {
    const readFile = vi.fn(() => Promise.resolve(MINIMAL_WASM))
    vi.stubGlobal('process', {
      versions: { node: '22.0.0' },
      getBuiltinModule: (id: string) => (id === 'node:fs/promises' ? { readFile } : undefined),
    })

    const result = await loadOnigWasmFromUrl('/tmp/onig.wasm', {})

    expect(readFile).toHaveBeenCalledWith('/tmp/onig.wasm')
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance)
  })
})
