/** Stable O(N) 32-bit radix ordering over non-negative parser offsets, with an O(N) sorted fast path. */
export function radixOrderByOffset<T>(
  values: readonly T[],
  offset: (value: T) => number,
): readonly T[] {
  const length = values.length
  if (length <= 1) return values
  const keys = new Uint32Array(length)
  let sorted = true
  let maxKey = 0
  for (let i = 0; i < length; i++) {
    const key = offset(values[i]!) >>> 0
    keys[i] = key
    if (key > maxKey) maxKey = key
    if (i > 0 && keys[i - 1]! > key) sorted = false
  }
  if (sorted) return values

  let order = new Uint32Array(length)
  for (let i = 0; i < length; i++) order[i] = i
  let next = new Uint32Array(length)
  const counts = new Uint32Array(256)
  for (let shift = 0; shift < 32 && (shift === 0 || maxKey >>> shift > 0); shift += 8) {
    counts.fill(0)
    for (let i = 0; i < length; i++) counts[(keys[order[i]!]! >>> shift) & 255]!++
    let start = 0
    for (let bucket = 0; bucket < 256; bucket++) {
      const count = counts[bucket]!
      counts[bucket] = start
      start += count
    }
    for (let i = 0; i < length; i++) {
      const idx = order[i]!
      next[counts[(keys[idx]! >>> shift) & 255]!++] = idx
    }
    ;[order, next] = [next, order]
  }
  return Array.from(order, (index) => values[index]!)
}
