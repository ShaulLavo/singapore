import '../../src/treeSitter/treeSitter.worker'

// The worker budgets slice work by wall clock (see sliceLimits.ts), so a slow machine can answer
// 'over-budget' for work a test expects to be colored. Tests that check colors run this worker
// with a frozen clock: elapsed time is always zero, the time budgets never expire, and a hung
// request is left to the test runner's own timeout. The text, predicate, query-work and capture
// limits are not time based and still run unchanged in the real worker.
const frozen = performance.now()
Object.defineProperty(performance, 'now', { configurable: true, value: () => frozen })
