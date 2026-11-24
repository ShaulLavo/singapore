import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAINTAINER = '../src/textStorageMaintainer'

// Each test imports a fresh copy of the module, so the maintainer has not been loaded yet.
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.doUnmock(MAINTAINER)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function freshMaintenance() {
  const { TextStorageMaintenance } = await import('../src/textStorageMaintenance')
  const { createEditorTextBuffer } = await import('../src/documentSession')
  const snapshot = createEditorTextBuffer('abc').getSnapshot()
  return new TextStorageMaintenance(
    () => [snapshot],
    () => snapshot,
  )
}

/** The first import attempt rejects; later ones load the real module. Returns the attempt count. */
function failFirstLoad() {
  let attempts = 0
  vi.doMock(MAINTAINER, async (importOriginal) => {
    if (attempts++ === 0) throw new Error('chunk unavailable')
    return importOriginal()
  })
  return () => attempts
}

/**
 * The first load answers with no maintainer, as a canceled `vite:preloadError` does; later ones
 * answer with the real one. A loaded mock is cached, so each attempt reads the export again.
 */
function emptyFirstLoad() {
  let attempts = 0
  vi.doMock(MAINTAINER, async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/textStorageMaintainer')>()
    return {
      get maintainStorage() {
        return attempts++ === 0 ? undefined : real.maintainStorage
      },
    }
  })
  return () => attempts
}

async function settleImports() {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

describe('storage maintenance before its maintainer loads', () => {
  it('runs the requested pass once the maintainer arrives', async () => {
    const maintenance = await freshMaintenance()
    maintenance.request(0, true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.dynamicImportSettled()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await vi.runAllTimersAsync()
    expect(maintenance.getStats().completed).toBe(1)
  })

  it('drops a pass suspended while the maintainer loads, and runs it again on resume', async () => {
    const maintenance = await freshMaintenance()
    maintenance.request(0, true)
    maintenance.suspend()
    await vi.dynamicImportSettled()
    await vi.runAllTimersAsync()
    expect(maintenance.getStats().completed).toBe(0)
    maintenance.resume()
    await vi.runAllTimersAsync()
    expect(maintenance.getStats().completed).toBe(1)
  })

  it('lets a suspended buffer go while the load is still pending', async () => {
    vi.doMock(MAINTAINER, () => new Promise(() => {}))
    const { TextStorageMaintenance } = await import('../src/textStorageMaintenance')
    const { createEditorTextBuffer } = await import('../src/documentSession')
    const release = () => {
      const snapshot = createEditorTextBuffer('x'.repeat(4096)).getSnapshot()
      const maintenance = new TextStorageMaintenance(
        () => [snapshot],
        () => snapshot,
      )
      maintenance.request(0, true)
      maintenance.suspend()
      return new WeakRef(maintenance)
    }
    const ref = release()
    setFlagsFromString('--expose_gc')
    const gc = runInNewContext('gc') as () => void
    await vi.advanceTimersByTimeAsync(0)
    gc()
    expect(ref.deref()).toBeUndefined()
  })

  it('keeps a save-requested pass through a failed load and retries after a backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const attempts = failFirstLoad()
    const maintenance = await freshMaintenance()
    maintenance.request(0, true)
    await settleImports()
    expect(attempts()).toBe(1)
    // An edit right after the failure waits out the backoff instead of importing again.
    maintenance.request(0)
    await settleImports()
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    maintenance.request(0)
    await vi.waitFor(() => expect(maintenance.getStats().completed).toBe(1))
    expect(attempts()).toBe(2)
  })

  it('treats a load that resolves with nothing as a failure, without retrying at once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const attempts = emptyFirstLoad()
    const maintenance = await freshMaintenance()
    maintenance.request(0, true)
    await settleImports()
    maintenance.request(0, true)
    await settleImports()
    expect(attempts()).toBe(1)
    expect(maintenance.getStats().completed).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    maintenance.request(0)
    await vi.waitFor(() => expect(maintenance.getStats().completed).toBe(1))
    expect(attempts()).toBe(2)
  })
})
