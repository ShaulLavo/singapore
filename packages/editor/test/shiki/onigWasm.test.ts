import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOnigWasmFromUrl } from '../../src/shiki/onigWasm'

// Minimal valid WebAssembly module header (`\0asm` version 1).
const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

describe('compileOnigWasmFromUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('streams compilation when served with exact application/wasm over HTTP', async () => {
    const response = new Response(MINIMAL_WASM, {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    })
    const fetchMock = vi.fn(() => Promise.resolve(response))
    const compiled = await WebAssembly.compile(MINIMAL_WASM)
    const streamingSpy = vi.spyOn(WebAssembly, 'compileStreaming').mockResolvedValue(compiled)
    vi.stubGlobal('fetch', fetchMock)

    const result = await compileOnigWasmFromUrl('https://example.test/assets/onig.wasm')

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/assets/onig.wasm')
    expect(streamingSpy).toHaveBeenCalledWith(response)
    expect(result).toBe(compiled)
  })

  it.each(['application/octet-stream', 'application/wasm; charset=utf-8', 'APPLICATION/WASM'])(
    'falls back to arrayBuffer compilation when content-type is %s',
    async (contentType) => {
      const response = new Response(MINIMAL_WASM, {
        status: 200,
        headers: { 'content-type': contentType },
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(response)),
      )
      const streamingSpy = vi.spyOn(WebAssembly, 'compileStreaming')

      const result = await compileOnigWasmFromUrl('https://example.test/assets/onig.wasm')

      expect(streamingSpy).not.toHaveBeenCalled()
      expect(result).toBeInstanceOf(WebAssembly.Module)
    },
  )

  it('rejects with status details when fetching onig.wasm fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
    )

    await expect(compileOnigWasmFromUrl('https://example.test/assets/onig.wasm')).rejects.toThrow(
      /503/,
    )
  })

  it.each(['/tmp/onig.wasm', 'C:\\Users\\dev\\assets\\onig.wasm', '\\\\server\\share\\onig.wasm'])(
    'reads local path %s via node:fs/promises when running under Node/Bun',
    async (localPath) => {
      const readFile = vi.fn(() => Promise.resolve(MINIMAL_WASM))
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('process', {
        versions: { node: '22.0.0' },
        getBuiltinModule: (id: string) => (id === 'node:fs/promises' ? { readFile } : undefined),
      })

      const result = await compileOnigWasmFromUrl(localPath)

      expect(readFile).toHaveBeenCalledWith(localPath)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toBeInstanceOf(WebAssembly.Module)
    },
  )

  it('retries after a transient WASM fetch failure without poisoning the cached module', async () => {
    vi.resetModules()
    const { loadOnigWasmModule } = await import('../../src/shiki/onigWasm')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(MINIMAL_WASM, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('process', undefined)

    await expect(loadOnigWasmModule()).rejects.toThrow(/503/)
    const recovered = await loadOnigWasmModule()
    expect(recovered).toBeInstanceOf(WebAssembly.Module)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
