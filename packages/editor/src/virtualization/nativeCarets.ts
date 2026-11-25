import type { VirtualizedTextChunkTextPart } from './virtualizedTextViewTypes'

export const PROPORTIONAL_INTACT_NODE_CEILING = 5_000

/** Positions belong to the intact connected row, including insertion points inside ligatures. */
export function createNativeCarets(
  element: HTMLElement,
  nodeOrParts: Text | readonly VirtualizedTextChunkTextPart[],
  scale: () => number = () => 1,
) {
  const parts = Array.isArray(nodeOrParts) ? nodeOrParts : null
  const singleNode = parts ? null : (nodeOrParts as Text)
  const length = parts ? (parts.at(-1)?.localEnd ?? 0) : singleNode!.length
  const positions = new Map<number, number>()
  // An empty collapsed Range has no text box in Chromium and WebKit.
  if (length === 0) positions.set(0, 0)
  const range = element.ownerDocument.createRange()
  const position = (column: number): number => {
    const known = positions.get(column)
    if (known !== undefined) return known
    if (singleNode) {
      range.setStart(singleNode, column)
    } else if (parts && parts.length > 0) {
      const part = textPartAtColumn(parts, column)
      range.setStart(part.node, Math.max(0, Math.min(part.node.length, column - part.localStart)))
    } else {
      positions.set(column, 0)
      return 0
    }
    range.collapse(true)
    const x = (range.getBoundingClientRect().left - element.getBoundingClientRect().left) / scale()
    positions.set(column, x)
    return x
  }
  return {
    position,
    columnAt(pixels: number, bias: 'before' | 'after'): number {
      let low = 0
      let high = length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (position(middle) <= pixels) low = middle
        else high = middle - 1
      }
      if (bias === 'after' && low < length && position(low) < pixels) return low + 1
      return low
    },
  }
}

function textPartAtColumn(
  parts: readonly VirtualizedTextChunkTextPart[],
  column: number,
): VirtualizedTextChunkTextPart {
  let low = 0
  let high = parts.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (parts[middle]!.localEnd < column) low = middle + 1
    else high = middle
  }
  return parts[low]!
}

export type NativeCarets = ReturnType<typeof createNativeCarets>
