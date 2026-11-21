const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

export function decode(bytes: Uint8Array) {
  return decoder.decode(bytes)
}

function width(lead: number) {
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 1
}

function continuation(byte: number) {
  return byte >= 0x80 && byte <= 0xbf
}

function accepts(lead: number, byte: number, index: number) {
  if (!continuation(byte)) return false
  if (index !== 1) return true
  if (lead === 0xe0) return byte >= 0xa0
  if (lead === 0xed) return byte <= 0x9f
  if (lead === 0xf0) return byte >= 0x90
  if (lead === 0xf4) return byte <= 0x8f
  return true
}

// A malformed sequence consumes its valid prefix and leaves the offending byte for the next scalar.
function scalar(bytes: Uint8Array, start: number) {
  const lead = bytes[start]!
  const size = width(lead)
  let end = start + 1
  while (end < start + size && end < bytes.length && accepts(lead, bytes[end]!, end - start)) end++
  return { end, units: size === 4 && end - start === 4 ? 2 : 1 }
}

export function completePrefix(bytes: Uint8Array) {
  let leadAt = bytes.length - 1
  while (leadAt >= Math.max(0, bytes.length - 3) && continuation(bytes[leadAt]!)) leadAt--
  if (leadAt < Math.max(0, bytes.length - 3)) return bytes.length
  const size = width(bytes[leadAt]!)
  if (leadAt + size <= bytes.length) return bytes.length
  return scalar(bytes, leadAt).end === bytes.length ? leadAt : bytes.length
}

export function clipBytes(bytes: Uint8Array, units: number) {
  let end = 0
  let used = 0
  while (end < bytes.length && used < units) {
    const next = scalar(bytes, end)
    if (used + next.units > units) break
    used += next.units
    end = next.end
  }
  return { end, units: used }
}

export function alignedOffset(bytes: Uint8Array, target: number) {
  let offset = 0
  while (offset < target && offset < bytes.length) offset = scalar(bytes, offset).end
  return offset
}

export function joinBytes(first: Uint8Array, second: Uint8Array) {
  if (!first.length) return second
  if (!second.length) return first
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)
  return joined
}
