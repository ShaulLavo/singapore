import '../../src/treeSitter/treeSitter.worker'

// The worker budgets slice work by wall clock (see sliceLimits.ts). Tests that need the work to
// finish on any machine run this worker with a stretched clock, so a 40 ms budget stands for
// 40 ms / scale of real time. A scale above 1 shrinks the budgets instead, which simulates a
// machine that many times slower. The scale arrives as the worker's name. The production worker
// and its limits are not touched.
const scale = Number(self.name)
if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Worker name must be a clock scale')

const originalNow = performance.now.bind(performance)
const origin = originalNow()
Object.defineProperty(performance, 'now', {
  configurable: true,
  value: () => origin + (originalNow() - origin) * scale,
})
