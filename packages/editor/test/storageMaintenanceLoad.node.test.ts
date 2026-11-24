import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Each test imports a fresh copy of the module, so the maintainer has not been loaded yet.
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
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
})
