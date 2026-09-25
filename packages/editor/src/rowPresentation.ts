export type EditorRowPresentation = {
  readonly element: HTMLElement
  readonly signal: AbortSignal
  dispose(): void
}

const presentations = new WeakMap<HTMLElement, Set<AbortController>>()

export function acquireRowPresentation(element: HTMLElement): EditorRowPresentation {
  const controller = new AbortController()
  const handles = presentations.get(element) ?? new Set<AbortController>()
  handles.add(controller)
  presentations.set(element, handles)
  return {
    element,
    signal: controller.signal,
    dispose() {
      handles.delete(controller)
      controller.abort()
      if (handles.size === 0 && presentations.get(element) === handles)
        presentations.delete(element)
    },
  }
}

export function invalidateRowPresentations(element: HTMLElement): void {
  const handles = presentations.get(element)
  if (!handles) return
  presentations.delete(element)
  for (const controller of handles) controller.abort()
}
