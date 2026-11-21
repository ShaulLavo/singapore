import type { RevealBlock } from './revealBlock'

export function revealContentRow(row: HTMLElement, requested: RevealBlock): void {
  let block: ScrollLogicalPosition = 'nearest'
  if (requested !== 'center-if-outside') block = requested
  if (requested === 'center-if-outside' && !contentRowIsVisible(row)) block = 'center'
  row.scrollIntoView({ block, inline: 'nearest' })
}

function contentRowIsVisible(row: HTMLElement): boolean {
  const bounds = row.getBoundingClientRect()
  const reading = contentReadingBounds(row)
  return bounds.top >= reading.top && bounds.bottom <= reading.bottom
}

export function contentReadingBounds(element: HTMLElement): {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
} {
  const window = element.ownerDocument.defaultView!
  const viewport = window.visualViewport
  let left = viewport?.offsetLeft ?? 0
  let right = left + (viewport?.width ?? window.innerWidth)
  let top = viewport?.offsetTop ?? 0
  let bottom = top + (viewport?.height ?? window.innerHeight)
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor === element.ownerDocument.scrollingElement) continue
    const style = window.getComputedStyle(ancestor)
    const clipsX = clipsOverflow(style.overflowX)
    const clipsY = clipsOverflow(style.overflowY)
    if (!clipsX && !clipsY) continue
    const box = ancestor.getBoundingClientRect()
    if (clipsX) {
      const scale = ancestor.offsetWidth > 0 ? box.width / ancestor.offsetWidth : 1
      left = Math.max(left, box.left + ancestor.clientLeft * scale)
      right = Math.min(right, box.left + (ancestor.clientLeft + ancestor.clientWidth) * scale)
    }
    if (clipsY) {
      const scale = ancestor.offsetHeight > 0 ? box.height / ancestor.offsetHeight : 1
      top = Math.max(top, box.top + ancestor.clientTop * scale)
      bottom = Math.min(bottom, box.top + (ancestor.clientTop + ancestor.clientHeight) * scale)
    }
  }
  return { left, right, top, bottom }
}

export function clipsOverflow(overflow: string): boolean {
  return (
    overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden' || overflow === 'clip'
  )
}
