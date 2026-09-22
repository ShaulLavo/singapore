import { scrollElementPadding } from './virtualizedTextViewHelpers'

const bounds = new WeakMap<HTMLElement, ReturnType<typeof measure>>()

function measure(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1
  const padding = scrollElementPadding(element)
  return {
    scale,
    left: rect.left + padding.left * scale,
    top: rect.top + padding.top * scale,
    right: rect.right - padding.right * scale,
    bottom: rect.bottom - padding.bottom * scale,
  }
}

export function pointViewport(element: HTMLElement) {
  const cached = bounds.get(element)
  if (cached) return cached
  const measured = measure(element)
  bounds.set(element, measured)
  element.ownerDocument.defaultView?.requestAnimationFrame(() => bounds.delete(element))
  return measured
}
