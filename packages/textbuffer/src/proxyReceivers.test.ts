import { describe, expect, test } from 'vitest'
import { createPieceTableSnapshot, createPieceTableWalker, insertIntoPieceTable } from './index'

// Reactive stores (Solid's createMutable, Vue's reactive, MobX) wrap objects in a Proxy and call
// their methods with the proxy as `this`. Public objects must keep working that way, which rules
// out ECMAScript `#private` members on them: a proxy fails the private brand check.
const forward = <T extends object>(target: T): T => new Proxy(target, {})

describe('public objects behind a Proxy', () => {
  test('a walker reads the same text through a forwarding proxy', () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot('xyz'), 1, 'ab')
    const read = (walker: ReturnType<typeof createPieceTableWalker>) => {
      const codes: number[] = []
      while (!walker.exhausted()) codes.push(walker.next())
      return String.fromCharCode(...codes)
    }
    expect(read(createPieceTableWalker(snapshot))).toBe('xabyz')

    const proxied = forward(createPieceTableWalker(snapshot))
    expect(read(proxied)).toBe('xabyz')

    proxied.seek(2)
    expect(proxied.offset()).toBe(2)
    expect(proxied.remaining()).toBe(3)
    expect(proxied.chunk()?.text).toBeTypeOf('string')
  })
})
