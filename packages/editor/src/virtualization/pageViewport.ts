import { clipsOverflow, contentReadingBounds } from './contentLayout'

export type PageViewportMetrics = {
  readonly top: number
  readonly height: number
}

export function readPageViewport(element: HTMLElement, nativeHeight?: number): PageViewportMetrics {
  const rect = element.getBoundingClientRect()
  if (rect.height === 0) return { top: 0, height: 0 }
  const offsetHeight = element.offsetHeight
  const scale = offsetHeight > 0 ? rect.height / offsetHeight : 1
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const origin =
    rect.top +
    (Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop)) * scale
  const contentEnd =
    rect.bottom -
    (Number.parseFloat(style.borderBottomWidth) + Number.parseFloat(style.paddingBottom)) * scale
  const limit =
    nativeHeight === undefined ? contentEnd : Math.min(contentEnd, origin + nativeHeight * scale)
  const bounds = contentReadingBounds(element)
  const top = Math.min(limit, Math.max(origin, bounds.top))
  const bottom = Math.min(limit, bounds.bottom)
  const visibleLeft = Math.max(rect.left, bounds.left)
  const clipped = Math.min(rect.right, bounds.right) <= visibleLeft
  if (
    clipped &&
    (nativeHeight !== undefined || !overflowReachesClip(element, rect, visibleLeft, bounds.right))
  )
    return { top: 0, height: 0 }
  return {
    top: Math.max(0, top - origin) / scale,
    height: Math.max(0, bottom - top) / scale,
  }
}

function overflowReachesClip(
  element: HTMLElement,
  rect: DOMRect,
  visibleLeft: number,
  clipRight: number,
): boolean {
  if (clipRight <= visibleLeft || element.offsetWidth <= 0) return false
  return rect.left + (element.scrollWidth * rect.width) / element.offsetWidth > visibleLeft
}

export function observePageViewport(
  element: HTMLElement,
  synchronize: () => void,
  hide: () => void,
  ignoreOwnScroll = false,
): () => void {
  const window = element.ownerDocument.defaultView
  if (!window) return () => {}

  const visual = window.visualViewport
  const onScroll = (event: Event) => {
    const target = event.target
    if (ignoreOwnScroll && target === element) return
    if (target instanceof window.Node && !target.contains(element)) return
    synchronize()
  }
  const listeners = () => {
    const controller = new AbortController()
    const { signal } = controller
    window.addEventListener('scroll', onScroll, { capture: true, passive: true, signal })
    window.addEventListener('resize', synchronize, { passive: true, signal })
    visual?.addEventListener('scroll', synchronize, { passive: true, signal })
    visual?.addEventListener('resize', synchronize, { passive: true, signal })
    const resize = observeClippingAncestors(element, window, synchronize)
    if (resize) signal.addEventListener('abort', () => resize.disconnect(), { once: true })
    return controller
  }
  let active: AbortController | null = null
  const observer =
    typeof window.IntersectionObserver === 'undefined'
      ? null
      : new window.IntersectionObserver(([entry]) => {
          if (entry?.isIntersecting || readPageViewport(element).height > 0) {
            active ??= listeners()
            synchronize()
            return
          }
          active?.abort()
          active = null
          hide()
        })
  if (observer) observer.observe(element)
  else active = listeners()
  return () => {
    observer?.disconnect()
    active?.abort()
  }
}

function observeClippingAncestors(
  element: HTMLElement,
  window: Window & typeof globalThis,
  synchronize: () => void,
): ResizeObserver | null {
  if (!window.ResizeObserver) return null
  const observer = new window.ResizeObserver(synchronize)
  const root = element.ownerDocument.scrollingElement
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor === root) continue
    const style = window.getComputedStyle(ancestor)
    if (clipsOverflow(style.overflowX) || clipsOverflow(style.overflowY)) observer.observe(ancestor)
  }
  return observer
}
